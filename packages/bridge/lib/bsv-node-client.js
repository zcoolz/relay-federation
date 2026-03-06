import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'

/**
 * BSVNodeClient — connects to BSV nodes via the Bitcoin P2P protocol
 * for direct header synchronization.
 *
 * Handles: TCP connection, version/verack handshake, getheaders,
 * headers parsing, inv/ping/pong, reconnect with backoff.
 *
 * Events:
 *   'headers'      — { headers: [{ height, hash, prevHash, timestamp, bits, nonce, version, merkleRoot }] }
 *   'connected'    — { host, port }
 *   'handshake'    — { version, userAgent, startHeight }
 *   'disconnected' — { host, port }
 *   'error'        — Error
 */

// BSV mainnet magic bytes (little-endian on wire)
const MAGIC = Buffer.from('e3e1f3e8', 'hex')
const PROTOCOL_VERSION = 70015
const USER_AGENT = '/relay-federation:0.1/'
const HEADER_BYTES = 80
const MSG_HEADER_SIZE = 24

const DEFAULT_SEEDS = ['seed.bitcoinsv.io']
const DEFAULT_PORT = 8333

// Default checkpoint: block 930,000
const DEFAULT_CHECKPOINT = {
  height: 930000,
  hash: '00000000000000001c2e04e4375cfa4b46588aa27795b2c7f8d4d34cb568a382',
  prevHash: '000000000000000015ec9abde40c7537fc422e5af81b6028ac376d7cf23bd0c8'
}

/** Double SHA-256 */
function sha256d (data) {
  const h1 = createHash('sha256').update(data).digest()
  return createHash('sha256').update(h1).digest()
}

/** Reverse a buffer (for hash display conversion) */
function reverseBuffer (buf) {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[buf.length - 1 - i]
  }
  return out
}

/** Convert display hash (hex string) to internal byte order buffer */
function hashToInternal (hexStr) {
  return reverseBuffer(Buffer.from(hexStr, 'hex'))
}

/** Convert internal byte order buffer to display hash (hex string) */
function internalToHash (buf) {
  return reverseBuffer(buf).toString('hex')
}

/** Read a variable-length integer from buffer at offset. Returns { value, size } */
function readVarInt (buf, offset) {
  const first = buf[offset]
  if (first < 0xfd) return { value: first, size: 1 }
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), size: 3 }
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), size: 5 }
  // 0xff — 8 byte, but we'll only use lower 32 bits (safe for counts)
  return { value: Number(buf.readBigUInt64LE(offset + 1)), size: 9 }
}

/** Write a variable-length integer to buffer. Returns bytes written. */
function writeVarInt (buf, offset, value) {
  if (value < 0xfd) {
    buf[offset] = value
    return 1
  }
  if (value <= 0xffff) {
    buf[offset] = 0xfd
    buf.writeUInt16LE(value, offset + 1)
    return 3
  }
  if (value <= 0xffffffff) {
    buf[offset] = 0xfe
    buf.writeUInt32LE(value, offset + 1)
    return 5
  }
  buf[offset] = 0xff
  buf.writeBigUInt64LE(BigInt(value), offset + 1)
  return 9
}

/** Write a network address (26 bytes: 8 services + 16 ip + 2 port) */
function writeNetAddr (buf, offset, services = 1n, ip = '127.0.0.1', port = 8333) {
  buf.writeBigUInt64LE(services, offset)
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  buf.fill(0, offset + 8, offset + 20)
  buf[offset + 18] = 0xff
  buf[offset + 19] = 0xff
  const parts = ip.split('.').map(Number)
  buf[offset + 20] = parts[0] || 0
  buf[offset + 21] = parts[1] || 0
  buf[offset + 22] = parts[2] || 0
  buf[offset + 23] = parts[3] || 0
  buf.writeUInt16BE(port, offset + 24) // port is big-endian
  return 26
}

export class BSVNodeClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.seeds] — DNS seeds to resolve
   * @param {number} [opts.port] — BSV node port (default 8333)
   * @param {{ height: number, hash: string, prevHash: string }} [opts.checkpoint] — Starting checkpoint
   * @param {number} [opts.syncIntervalMs] — How often to request new headers (default 30s)
   * @param {number} [opts.pingIntervalMs] — Keep-alive ping interval (default 120s)
   */
  constructor (opts = {}) {
    super()
    this._seeds = opts.seeds || DEFAULT_SEEDS
    this._port = opts.port || DEFAULT_PORT
    this._checkpoint = opts.checkpoint || DEFAULT_CHECKPOINT
    this._syncIntervalMs = opts.syncIntervalMs || 30000
    this._pingIntervalMs = opts.pingIntervalMs || 120000

    this._socket = null
    this._buffer = Buffer.alloc(0)
    this._connected = false
    this._handshakeComplete = false
    this._destroyed = false
    this._host = null

    this._reconnectDelay = 5000
    this._maxReconnectDelay = 60000
    this._reconnectTimer = null
    this._syncTimer = null
    this._pingTimer = null

    // Header tracking
    this._bestHeight = this._checkpoint.height
    this._bestHash = this._checkpoint.hash
    this._headerHashes = new Map() // height → display hash
    this._headerHashes.set(this._checkpoint.height, this._checkpoint.hash)
    if (this._checkpoint.prevHash) {
      this._headerHashes.set(this._checkpoint.height - 1, this._checkpoint.prevHash)
    }

    // Peer info
    this._peerVersion = 0
    this._peerUserAgent = ''
    this._peerStartHeight = 0

    this._syncing = false
  }

  /**
   * Connect to a BSV node. Resolves DNS seed, picks random IP.
   */
  async connect () {
    if (this._destroyed) return

    try {
      // Resolve DNS seed to get node IPs
      const seed = this._seeds[Math.floor(Math.random() * this._seeds.length)]
      const addresses = await lookup(seed, { all: true, family: 4 })

      if (!addresses.length) {
        throw new Error(`No addresses resolved for ${seed}`)
      }

      // Pick a random address
      const addr = addresses[Math.floor(Math.random() * addresses.length)]
      this._host = addr.address

      this._socket = createConnection({
        host: this._host,
        port: this._port
      })

      this._socket.on('connect', () => {
        this._connected = true
        this._reconnectDelay = 5000
        this.emit('connected', { host: this._host, port: this._port })
        this._sendVersion()
      })

      this._socket.on('data', (data) => {
        this._onData(data)
      })

      this._socket.on('close', () => {
        this._onDisconnect()
      })

      this._socket.on('error', (err) => {
        this.emit('error', err)
      })
    } catch (err) {
      this.emit('error', err)
      this._scheduleReconnect()
    }
  }

  /**
   * Disconnect and stop all timers.
   */
  disconnect () {
    this._destroyed = true
    clearTimeout(this._reconnectTimer)
    clearInterval(this._syncTimer)
    clearInterval(this._pingTimer)
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    this._connected = false
    this._handshakeComplete = false
  }

  /**
   * Request header sync from current best height.
   */
  syncHeaders () {
    if (!this._handshakeComplete || this._syncing) return
    this._syncing = true
    const locator = this._buildBlockLocator()
    this._sendGetHeaders(locator)
  }

  /**
   * Seed a known header hash (e.g. from checkpoint or prior sync).
   * @param {number} height
   * @param {string} hash — display-format hex
   */
  seedHeader (height, hash) {
    this._headerHashes.set(height, hash)
    if (height > this._bestHeight) {
      this._bestHeight = height
      this._bestHash = hash
    }
  }

  /** Current best height */
  get bestHeight () { return this._bestHeight }
  /** Current best hash (display format) */
  get bestHash () { return this._bestHash }

  // ── Private: connection management ─────────────────────────

  _onDisconnect () {
    const host = this._host
    this._connected = false
    this._handshakeComplete = false
    this._syncing = false
    clearInterval(this._syncTimer)
    clearInterval(this._pingTimer)
    this._syncTimer = null
    this._pingTimer = null
    this.emit('disconnected', { host, port: this._port })
    if (!this._destroyed) {
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect () {
    if (this._destroyed) return
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = setTimeout(() => {
      this.connect()
    }, this._reconnectDelay)
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay)
  }

  // ── Private: data parsing ──────────────────────────────────

  _onData (data) {
    this._buffer = Buffer.concat([this._buffer, data])

    while (this._buffer.length >= MSG_HEADER_SIZE) {
      // Find magic bytes
      const magicIdx = this._findMagic()
      if (magicIdx < 0) {
        // No magic found — discard buffer
        this._buffer = Buffer.alloc(0)
        return
      }
      if (magicIdx > 0) {
        // Discard bytes before magic
        this._buffer = this._buffer.subarray(magicIdx)
      }

      if (this._buffer.length < MSG_HEADER_SIZE) return // need more data

      // Parse message header
      const command = this._buffer.subarray(4, 16).toString('ascii').replace(/\0/g, '')
      const payloadLen = this._buffer.readUInt32LE(16)
      const checksum = this._buffer.subarray(20, 24)

      const totalLen = MSG_HEADER_SIZE + payloadLen
      if (this._buffer.length < totalLen) return // need more data

      const payload = this._buffer.subarray(MSG_HEADER_SIZE, totalLen)

      // Verify checksum
      const computed = sha256d(payload).subarray(0, 4)
      if (!computed.equals(checksum)) {
        // Bad checksum — skip this message header, try next
        this._buffer = this._buffer.subarray(4)
        continue
      }

      // Consume the message
      this._buffer = this._buffer.subarray(totalLen)

      try {
        this._handleMessage(command, payload)
      } catch (err) {
        this.emit('error', err)
      }
    }
  }

  _findMagic () {
    for (let i = 0; i <= this._buffer.length - 4; i++) {
      if (this._buffer[i] === MAGIC[0] &&
          this._buffer[i + 1] === MAGIC[1] &&
          this._buffer[i + 2] === MAGIC[2] &&
          this._buffer[i + 3] === MAGIC[3]) {
        return i
      }
    }
    return -1
  }

  // ── Private: message handling ──────────────────────────────

  _handleMessage (command, payload) {
    switch (command) {
      case 'version':
        this._onVersion(payload)
        break
      case 'verack':
        this._onVerack()
        break
      case 'headers':
        this._onHeaders(payload)
        break
      case 'inv':
        this._onInv(payload)
        break
      case 'ping':
        this._onPing(payload)
        break
      case 'sendheaders':
        // BSV nodes may send this — just acknowledge
        break
      case 'sendcmpct':
      case 'feefilter':
      case 'addr':
      case 'protoconf':
        // Ignore these
        break
    }
  }

  _onVersion (payload) {
    // Parse version message
    this._peerVersion = payload.readInt32LE(0)
    // services at offset 4 (8 bytes)
    // timestamp at offset 12 (8 bytes)
    // addr_recv at offset 20 (26 bytes)
    // addr_from at offset 46 (26 bytes)
    // nonce at offset 72 (8 bytes)
    const userAgentLen = readVarInt(payload, 80)
    this._peerUserAgent = payload.subarray(80 + userAgentLen.size, 80 + userAgentLen.size + userAgentLen.value).toString('ascii')
    const heightOffset = 80 + userAgentLen.size + userAgentLen.value
    if (heightOffset + 4 <= payload.length) {
      this._peerStartHeight = payload.readInt32LE(heightOffset)
    }

    // Send verack in response
    this._sendMessage('verack', Buffer.alloc(0))
  }

  _onVerack () {
    this._handshakeComplete = true
    this.emit('handshake', {
      version: this._peerVersion,
      userAgent: this._peerUserAgent,
      startHeight: this._peerStartHeight
    })

    // Start header sync
    this.syncHeaders()

    // Periodic sync for new blocks
    this._syncTimer = setInterval(() => {
      this.syncHeaders()
    }, this._syncIntervalMs)
    if (this._syncTimer.unref) this._syncTimer.unref()

    // Keep-alive pings
    this._pingTimer = setInterval(() => {
      this._sendPing()
    }, this._pingIntervalMs)
    if (this._pingTimer.unref) this._pingTimer.unref()
  }

  _onHeaders (payload) {
    this._syncing = false

    if (payload.length === 0) return

    const countInfo = readVarInt(payload, 0)
    const count = countInfo.value
    if (count === 0) return

    let offset = countInfo.size
    const headers = []

    for (let i = 0; i < count; i++) {
      if (offset + HEADER_BYTES > payload.length) break

      const rawHeader = payload.subarray(offset, offset + HEADER_BYTES)

      // Parse fields from 80-byte header
      const version = rawHeader.readInt32LE(0)
      const prevHashBuf = rawHeader.subarray(4, 36)
      const merkleRootBuf = rawHeader.subarray(36, 68)
      const timestamp = rawHeader.readUInt32LE(68)
      const bits = rawHeader.readUInt32LE(72)
      const nonce = rawHeader.readUInt32LE(76)

      // Compute block hash
      const blockHash = internalToHash(sha256d(rawHeader))
      const prevHash = internalToHash(prevHashBuf)

      // Determine height from prevHash lookup
      let height = -1
      for (const [h, hash] of this._headerHashes) {
        if (hash === prevHash) {
          height = h + 1
          break
        }
      }

      if (height < 0) {
        // Can't determine height — chain gap
        // Skip but don't break (might be able to chain later)
        offset += HEADER_BYTES
        // Skip varint tx_count
        if (offset < payload.length) {
          const txCount = readVarInt(payload, offset)
          offset += txCount.size
        }
        continue
      }

      // Store for chain linking
      this._headerHashes.set(height, blockHash)
      if (height > this._bestHeight) {
        this._bestHeight = height
        this._bestHash = blockHash
      }

      headers.push({
        height,
        hash: blockHash,
        prevHash,
        timestamp,
        bits,
        nonce,
        version,
        merkleRoot: internalToHash(merkleRootBuf)
      })

      offset += HEADER_BYTES

      // Skip varint tx_count (always 0 in headers message)
      if (offset < payload.length) {
        const txCount = readVarInt(payload, offset)
        offset += txCount.size
      }
    }

    if (headers.length > 0) {
      this.emit('headers', { headers, count: headers.length })

      // If we got a full batch (2000), there might be more
      if (count >= 2000) {
        this.syncHeaders()
      }
    }
  }

  _onInv (payload) {
    if (payload.length < 1) return

    const countInfo = readVarInt(payload, 0)
    let offset = countInfo.size
    let hasBlock = false

    for (let i = 0; i < countInfo.value; i++) {
      if (offset + 36 > payload.length) break
      const invType = payload.readUInt32LE(offset)
      // type 2 = MSG_BLOCK
      if (invType === 2) {
        hasBlock = true
      }
      offset += 36
    }

    // If a new block was announced, sync headers
    if (hasBlock) {
      this.syncHeaders()
    }
  }

  _onPing (payload) {
    // Respond with pong using the same nonce
    this._sendMessage('pong', payload)
  }

  // ── Private: message building ──────────────────────────────

  _sendMessage (command, payload) {
    if (!this._socket || !this._connected) return

    const header = Buffer.alloc(MSG_HEADER_SIZE)

    // Magic
    MAGIC.copy(header, 0)

    // Command (12 bytes, null-padded)
    const cmdBuf = Buffer.alloc(12)
    cmdBuf.write(command, 'ascii')
    cmdBuf.copy(header, 4)

    // Payload length
    header.writeUInt32LE(payload.length, 16)

    // Checksum
    const checksum = sha256d(payload).subarray(0, 4)
    checksum.copy(header, 20)

    this._socket.write(Buffer.concat([header, payload]))
  }

  _sendVersion () {
    const userAgentBuf = Buffer.from(USER_AGENT, 'ascii')
    const payloadSize = 4 + 8 + 8 + 26 + 26 + 8 + 1 + userAgentBuf.length + 4 + 1
    const payload = Buffer.alloc(payloadSize)
    let offset = 0

    // Protocol version
    payload.writeInt32LE(PROTOCOL_VERSION, offset); offset += 4

    // Services (NODE_NETWORK = 1)
    payload.writeBigUInt64LE(0n, offset); offset += 8 // we offer no services

    // Timestamp
    const now = BigInt(Math.floor(Date.now() / 1000))
    payload.writeBigUInt64LE(now, offset); offset += 8

    // addr_recv (the node we're connecting to)
    offset += writeNetAddr(payload, offset, 1n, this._host, this._port)

    // addr_from (us — doesn't matter much)
    offset += writeNetAddr(payload, offset, 0n, '0.0.0.0', 0)

    // Nonce
    randomBytes(8).copy(payload, offset); offset += 8

    // User agent (varint length + string)
    offset += writeVarInt(payload, offset, userAgentBuf.length)
    userAgentBuf.copy(payload, offset); offset += userAgentBuf.length

    // Start height
    payload.writeInt32LE(this._bestHeight, offset); offset += 4

    // Relay (false — we don't want tx relay)
    payload[offset] = 0; offset += 1

    this._sendMessage('version', payload.subarray(0, offset))
  }

  _sendGetHeaders (locatorHashes) {
    // version(4) + varint(count) + hashes(32 each) + stop_hash(32)
    const hashCount = locatorHashes.length
    const varIntBuf = Buffer.alloc(9)
    const varIntSize = writeVarInt(varIntBuf, 0, hashCount)

    const payloadSize = 4 + varIntSize + (hashCount * 32) + 32
    const payload = Buffer.alloc(payloadSize)
    let offset = 0

    // Protocol version
    payload.writeUInt32LE(PROTOCOL_VERSION, offset); offset += 4

    // Hash count
    varIntBuf.copy(payload, offset, 0, varIntSize); offset += varIntSize

    // Block locator hashes (internal byte order)
    for (const hash of locatorHashes) {
      const hashBuf = hashToInternal(hash)
      hashBuf.copy(payload, offset); offset += 32
    }

    // Stop hash (all zeros = give me everything)
    payload.fill(0, offset, offset + 32)

    this._sendMessage('getheaders', payload)
  }

  _sendPing () {
    const payload = Buffer.alloc(8)
    randomBytes(8).copy(payload)
    this._sendMessage('ping', payload)
  }

  // ── Private: block locator ─────────────────────────────────

  _buildBlockLocator () {
    const hashes = []
    let step = 1
    let height = this._bestHeight

    // Walk backwards from tip with exponential steps
    while (height >= this._checkpoint.height) {
      const hash = this._headerHashes.get(height)
      if (hash) {
        hashes.push(hash)
      }
      if (height === this._checkpoint.height) break
      height -= step
      if (height < this._checkpoint.height) {
        height = this._checkpoint.height
      }
      if (hashes.length > 10) {
        step *= 2
      }
    }

    // Always include checkpoint
    const cpHash = this._headerHashes.get(this._checkpoint.height)
    if (cpHash && hashes[hashes.length - 1] !== cpHash) {
      hashes.push(cpHash)
    }

    return hashes
  }
}
