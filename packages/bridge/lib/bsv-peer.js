import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

/**
 * BSVPeer — single TCP connection to a BSV full node.
 *
 * Speaks the Bitcoin P2P protocol (version 70016) for:
 * - Header synchronisation via getheaders/headers
 * - Transaction broadcast via inv/getdata/tx (correct 3-step flow)
 * - Transaction fetch via getdata MSG_TX
 * - Keepalive via ping/pong
 *
 * Ported from production Indelible SPV bridge (p2p.js) with:
 * - Protocol version 70016 with protoconf
 * - User agent /Bitcoin SV:1.1.0/ (matches known clients)
 * - Correct inv-based broadcast (not raw tx push)
 * - Settled flag pattern on connect (no double-reject)
 * - ESM (not CJS)
 *
 * Events:
 *   'headers'      — { headers: [...], count }
 *   'connected'    — { host, port }
 *   'handshake'    — { version, userAgent, startHeight }
 *   'disconnected' — { host, port }
 *   'error'        — Error
 *   'tx'           — { txid, rawHex }
 *   'tx:inv'       — { txids }
 */

// BSV mainnet magic bytes
const MAGIC = Buffer.from('e3e1f3e8', 'hex')
const PROTOCOL_VERSION = 70016
const USER_AGENT = '/Bitcoin SV:1.1.0/'
const HEADER_BYTES = 80
const MSG_HEADER_SIZE = 24

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

/** Convert display hash to internal byte order buffer */
function hashToInternal (hexStr) {
  return reverseBuffer(Buffer.from(hexStr, 'hex'))
}

/** Convert internal byte order buffer to display hash */
function internalToHash (buf) {
  return reverseBuffer(buf).toString('hex')
}

/** Read a variable-length integer from buffer at offset */
function readVarInt (buf, offset) {
  const first = buf[offset]
  if (first < 0xfd) return { value: first, size: 1 }
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), size: 3 }
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), size: 5 }
  return { value: Number(buf.readBigUInt64LE(offset + 1)), size: 9 }
}

/** Write a variable-length integer to buffer */
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

/** Write a network address (26 bytes) */
function writeNetAddr (buf, offset, services = 1n, ip = '127.0.0.1', port = 8333) {
  buf.writeBigUInt64LE(services, offset)
  buf.fill(0, offset + 8, offset + 20)
  buf[offset + 18] = 0xff
  buf[offset + 19] = 0xff
  const parts = ip.split('.').map(Number)
  buf[offset + 20] = parts[0] || 0
  buf[offset + 21] = parts[1] || 0
  buf[offset + 22] = parts[2] || 0
  buf[offset + 23] = parts[3] || 0
  buf.writeUInt16BE(port, offset + 24)
  return 26
}

// Default checkpoint: block 930,000
const DEFAULT_CHECKPOINT = {
  height: 930000,
  hash: '00000000000000001c2e04e4375cfa4b46588aa27795b2c7f8d4d34cb568a382',
  prevHash: '000000000000000015ec9abde40c7537fc422e5af81b6028ac376d7cf23bd0c8'
}

export class BSVPeer extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {{ height: number, hash: string, prevHash: string }} [opts.checkpoint]
   * @param {number} [opts.syncIntervalMs] — Header sync interval (default 30s)
   * @param {number} [opts.pingIntervalMs] — Keepalive ping interval (default 120s)
   */
  constructor (opts = {}) {
    super()
    this._checkpoint = opts.checkpoint || DEFAULT_CHECKPOINT
    this._syncIntervalMs = opts.syncIntervalMs || 30000
    this._pingIntervalMs = opts.pingIntervalMs || 120000

    this._socket = null
    this._buffer = Buffer.alloc(0)
    this._connected = false
    this._handshakeComplete = false
    this._destroyed = false
    this._host = null
    this._port = null

    this._syncTimer = null
    this._pingTimer = null

    // Header tracking
    this._bestHeight = this._checkpoint.height
    this._bestHash = this._checkpoint.hash
    this._headerHashes = new Map()
    this._headerHashes.set(this._checkpoint.height, this._checkpoint.hash)
    if (this._checkpoint.prevHash) {
      this._headerHashes.set(this._checkpoint.height - 1, this._checkpoint.prevHash)
    }

    // Peer info
    this._peerVersion = 0
    this._peerUserAgent = ''
    this._peerStartHeight = 0

    this._syncing = false

    // Transaction tracking
    this._pendingTxRequests = new Map()
    this._pendingBroadcasts = new Map()

    // Block tracking
    this._pendingBlockRequests = new Map()
  }

  /**
   * Connect to a BSV node at host:port.
   * Returns a Promise that resolves on successful handshake.
   * Uses settled flag pattern to prevent double-reject.
   *
   * @param {string} host — IP address
   * @param {number} [port=8333]
   * @returns {Promise<{ version, userAgent, startHeight }>}
   */
  async connect (host, port = 8333) {
    if (this._destroyed) throw new Error('peer destroyed')
    this._host = host
    this._port = port

    return new Promise((resolve, reject) => {
      this._socket = createConnection({ host, port })

      this._socket.on('connect', () => {
        this._connected = true
        this.emit('connected', { host, port })
        this._sendVersion()
      })

      this._socket.on('data', (data) => this._onData(data))

      // Settled pattern: whichever fires first wins, others are no-ops
      const onError = (err) => {
        clearTimeout(timer)
        this.removeListener('handshake', onHandshake)
        this._connected = false
        reject(err)
      }

      const onHandshake = (info) => {
        clearTimeout(timer)
        if (this._socket) this._socket.removeListener('error', onError)
        // Replace with soft error handler post-handshake
        if (this._socket) {
          this._socket.on('error', (err) => {
            this.emit('error', err)
          })
        }
        resolve(info)
      }

      const onTimeout = () => {
        if (this._socket) this._socket.removeListener('error', onError)
        this.removeListener('handshake', onHandshake)
        this.disconnect()
        reject(new Error('Handshake timeout (10s)'))
      }

      this._socket.once('error', onError)
      this._socket.on('close', () => this._onDisconnect())
      this.once('handshake', onHandshake)
      const timer = setTimeout(onTimeout, 10000)
    })
  }

  /**
   * Disconnect and stop all timers.
   */
  disconnect () {
    this._destroyed = true
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
   * Seed a known header hash.
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

  /**
   * Request peer addresses from this peer (getaddr P2P message).
   * Peer responds with 'addr' message containing known node IPs.
   */
  requestAddr () {
    if (this._handshakeComplete) {
      this._sendMessage('getaddr', Buffer.alloc(0))
    }
  }

  /**
   * Fetch a transaction by txid from this peer.
   * @param {string} txid
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{ txid, rawHex }>}
   */
  getTx (txid, timeoutMs = 10000) {
    if (!this._handshakeComplete) {
      return Promise.reject(new Error('not connected to BSV node'))
    }
    if (this._pendingTxRequests.has(txid)) {
      return Promise.reject(new Error(`already fetching tx ${txid.slice(0, 16)}...`))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingTxRequests.delete(txid)
        reject(new Error(`timeout fetching tx ${txid.slice(0, 16)}...`))
      }, timeoutMs)

      this._pendingTxRequests.set(txid, { resolve, reject, timer })

      const payload = Buffer.alloc(37)
      payload[0] = 1
      payload.writeUInt32LE(1, 1)
      hashToInternal(txid).copy(payload, 5)
      this._sendMessage('getdata', payload)
    })
  }

  /**
   * Fetch a full block by hash from this peer.
   * Returns the raw block hex and parsed transactions.
   * @param {string} blockHash — block hash (display format)
   * @param {number} [timeoutMs=60000] — longer timeout for large blocks
   * @returns {Promise<{ blockHash, rawHex, txCount, transactions: Array<{ txid, rawHex }> }>}
   */
  getBlock (blockHash, timeoutMs = 60000) {
    if (!this._handshakeComplete) {
      return Promise.reject(new Error('not connected to BSV node'))
    }
    if (this._pendingBlockRequests.has(blockHash)) {
      return Promise.reject(new Error(`already fetching block ${blockHash.slice(0, 16)}...`))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingBlockRequests.delete(blockHash)
        reject(new Error(`timeout fetching block ${blockHash.slice(0, 16)}...`))
      }, timeoutMs)

      this._pendingBlockRequests.set(blockHash, { resolve, reject, timer })

      // Send getdata with MSG_BLOCK (type 2)
      const payload = Buffer.alloc(37)
      payload[0] = 1 // count = 1
      payload.writeUInt32LE(2, 1) // MSG_BLOCK = 2
      hashToInternal(blockHash).copy(payload, 5)
      this._sendMessage('getdata', payload)
    })
  }

  /**
   * Broadcast a raw transaction using correct inv/getdata/tx flow.
   * Sends inv announcement; peers respond with getdata; we serve the tx.
   *
   * @param {string} rawTxHex
   * @returns {string} txid (display format)
   */
  broadcastTx (rawTxHex) {
    const txBuffer = Buffer.from(rawTxHex, 'hex')
    const txid = internalToHash(sha256d(txBuffer))

    // Store so we can serve getdata requests from peers
    this._pendingBroadcasts.set(txid, rawTxHex)
    setTimeout(() => this._pendingBroadcasts.delete(txid), 60000)

    // Send inv to announce we have this tx
    const invPayload = Buffer.alloc(37)
    invPayload[0] = 1 // count = 1
    invPayload.writeUInt32LE(1, 1) // MSG_TX = 1
    hashToInternal(txid).copy(invPayload, 5)
    this._sendMessage('inv', invPayload)

    return txid
  }

  /** Current best height */
  get bestHeight () { return this._bestHeight }
  /** Current best hash */
  get bestHash () { return this._bestHash }
  /** Connected host */
  get host () { return this._host }

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
  }

  // ── Private: data parsing ──────────────────────────────────

  _onData (data) {
    this._buffer = Buffer.concat([this._buffer, data])

    while (this._buffer.length >= MSG_HEADER_SIZE) {
      const magicIdx = this._findMagic()
      if (magicIdx < 0) {
        this._buffer = Buffer.alloc(0)
        return
      }
      if (magicIdx > 0) {
        this._buffer = this._buffer.subarray(magicIdx)
      }

      if (this._buffer.length < MSG_HEADER_SIZE) return

      const command = this._buffer.subarray(4, 16).toString('ascii').replace(/\0/g, '')
      const payloadLen = this._buffer.readUInt32LE(16)
      const checksum = this._buffer.subarray(20, 24)

      const totalLen = MSG_HEADER_SIZE + payloadLen
      if (this._buffer.length < totalLen) return

      const payload = this._buffer.subarray(MSG_HEADER_SIZE, totalLen)

      const computed = sha256d(payload).subarray(0, 4)
      if (!computed.equals(checksum)) {
        this._buffer = this._buffer.subarray(4)
        continue
      }

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
      case 'tx':
        this._onTx(payload)
        break
      case 'block':
        this._onBlock(payload)
        break
      case 'notfound':
        this._onNotfound(payload)
        break
      case 'getdata':
        this._onGetdata(payload)
        break
      case 'addr':
        this._onAddr(payload)
        break
      case 'sendheaders':
      case 'sendcmpct':
      case 'feefilter':
      case 'protoconf':
      case 'authch':
      case 'authresp':
      case 'extmsg':
        break
    }
  }

  _onVersion (payload) {
    this._peerVersion = payload.readInt32LE(0)
    const userAgentLen = readVarInt(payload, 80)
    this._peerUserAgent = payload.subarray(80 + userAgentLen.size, 80 + userAgentLen.size + userAgentLen.value).toString('ascii')
    const heightOffset = 80 + userAgentLen.size + userAgentLen.value
    if (heightOffset + 4 <= payload.length) {
      this._peerStartHeight = payload.readInt32LE(heightOffset)
    }

    // Only connect to BSV nodes — reject BTC/BCH
    if (!this._peerUserAgent.includes('Bitcoin SV')) {
      this.disconnect()
      return
    }

    this._sendMessage('verack', Buffer.alloc(0))
  }

  _onVerack () {
    this._handshakeComplete = true

    // Send protoconf (protocol 70016+) — advertise max payload size
    this._sendProtoconf()

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

      const version = rawHeader.readInt32LE(0)
      const prevHashBuf = rawHeader.subarray(4, 36)
      const merkleRootBuf = rawHeader.subarray(36, 68)
      const timestamp = rawHeader.readUInt32LE(68)
      const bits = rawHeader.readUInt32LE(72)
      const nonce = rawHeader.readUInt32LE(76)

      const blockHash = internalToHash(sha256d(rawHeader))
      const prevHash = internalToHash(prevHashBuf)

      let height = -1
      for (const [h, hash] of this._headerHashes) {
        if (hash === prevHash) {
          height = h + 1
          break
        }
      }

      if (height < 0) {
        offset += HEADER_BYTES
        if (offset < payload.length) {
          const txCount = readVarInt(payload, offset)
          offset += txCount.size
        }
        continue
      }

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

      if (offset < payload.length) {
        const txCount = readVarInt(payload, offset)
        offset += txCount.size
      }
    }

    if (headers.length > 0) {
      this.emit('headers', { headers, count: headers.length })

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
    const txids = []

    for (let i = 0; i < countInfo.value; i++) {
      if (offset + 36 > payload.length) break
      const invType = payload.readUInt32LE(offset)
      const hashBuf = payload.subarray(offset + 4, offset + 36)

      if (invType === 2) {
        hasBlock = true
      } else if (invType === 1) {
        txids.push(internalToHash(hashBuf))
      }
      offset += 36
    }

    if (hasBlock) {
      this.syncHeaders()
    }

    if (txids.length > 0) {
      this.emit('tx:inv', { txids })
    }
  }

  _onPing (payload) {
    this._sendMessage('pong', payload)
  }

  _onAddr (payload) {
    if (payload.length < 1) return
    const countInfo = readVarInt(payload, 0)
    const count = countInfo.value
    let offset = countInfo.size
    const addrs = []

    for (let i = 0; i < count && offset + 30 <= payload.length; i++) {
      // 4 bytes timestamp + 8 bytes services + 16 bytes IP + 2 bytes port
      offset += 4 // skip timestamp
      offset += 8 // skip services

      // IPv4-mapped IPv6: last 4 bytes of 16-byte IP field
      const isIPv4 = payload[offset + 10] === 0xff && payload[offset + 11] === 0xff
      if (isIPv4) {
        const host = `${payload[offset + 12]}.${payload[offset + 13]}.${payload[offset + 14]}.${payload[offset + 15]}`
        offset += 16
        const port = payload.readUInt16BE(offset)
        offset += 2
        if (port === 8333 && host !== '0.0.0.0' && host !== '127.0.0.1') {
          addrs.push({ host, port })
        }
      } else {
        offset += 16 + 2 // skip IPv6 + port
      }
    }

    if (addrs.length > 0) {
      this.emit('addr', { addrs })
    }
  }

  _onTx (payload) {
    const txid = internalToHash(sha256d(payload))
    const rawHex = payload.toString('hex')
    this.emit('tx', { txid, rawHex })

    const pending = this._pendingTxRequests.get(txid)
    if (pending) {
      clearTimeout(pending.timer)
      this._pendingTxRequests.delete(txid)
      pending.resolve({ txid, rawHex })
    }
  }

  _onBlock (payload) {
    // Block format: 80-byte header + varint txCount + raw transactions
    if (payload.length < 80) return

    const header = payload.subarray(0, 80)
    const blockHash = internalToHash(sha256d(header))

    // Parse transaction count
    const txCountInfo = readVarInt(payload, 80)
    const txCount = txCountInfo.value
    let offset = 80 + txCountInfo.size

    // Parse each transaction
    const transactions = []
    for (let i = 0; i < txCount; i++) {
      if (offset >= payload.length) break

      // Parse transaction to find its length
      const txStart = offset
      offset = this._parseTxLength(payload, offset)
      if (offset === -1) break

      const txBuf = payload.subarray(txStart, offset)
      const txid = internalToHash(sha256d(txBuf))
      const rawHex = txBuf.toString('hex')
      transactions.push({ txid, rawHex })
    }

    this.emit('block', { blockHash, header: header.toString('hex'), transactions })

    const pending = this._pendingBlockRequests.get(blockHash)
    if (pending) {
      clearTimeout(pending.timer)
      this._pendingBlockRequests.delete(blockHash)
      pending.resolve({ blockHash, header: header.toString('hex'), transactions })
    }
  }

  // Parse transaction to find its end offset
  _parseTxLength (buf, start) {
    let offset = start

    // Version (4 bytes)
    if (offset + 4 > buf.length) return -1
    offset += 4

    // Input count
    const inCountInfo = readVarInt(buf, offset)
    if (offset + inCountInfo.size > buf.length) return -1
    offset += inCountInfo.size

    // Inputs
    for (let i = 0; i < inCountInfo.value; i++) {
      // prevTxid (32) + prevVout (4)
      if (offset + 36 > buf.length) return -1
      offset += 36

      // scriptSig length + scriptSig
      const scriptLenInfo = readVarInt(buf, offset)
      if (offset + scriptLenInfo.size > buf.length) return -1
      offset += scriptLenInfo.size
      if (offset + scriptLenInfo.value > buf.length) return -1
      offset += scriptLenInfo.value

      // sequence (4 bytes)
      if (offset + 4 > buf.length) return -1
      offset += 4
    }

    // Output count
    const outCountInfo = readVarInt(buf, offset)
    if (offset + outCountInfo.size > buf.length) return -1
    offset += outCountInfo.size

    // Outputs
    for (let i = 0; i < outCountInfo.value; i++) {
      // value (8 bytes)
      if (offset + 8 > buf.length) return -1
      offset += 8

      // scriptPubKey length + scriptPubKey
      const scriptLenInfo = readVarInt(buf, offset)
      if (offset + scriptLenInfo.size > buf.length) return -1
      offset += scriptLenInfo.size
      if (offset + scriptLenInfo.value > buf.length) return -1
      offset += scriptLenInfo.value
    }

    // locktime (4 bytes)
    if (offset + 4 > buf.length) return -1
    offset += 4

    return offset
  }

  _onNotfound (payload) {
    if (payload.length < 1) return
    const countInfo = readVarInt(payload, 0)
    let offset = countInfo.size

    for (let i = 0; i < countInfo.value; i++) {
      if (offset + 36 > payload.length) break
      const invType = payload.readUInt32LE(offset)
      const hashBuf = payload.subarray(offset + 4, offset + 36)
      offset += 36

      if (invType === 1) {
        const txid = internalToHash(hashBuf)
        const pending = this._pendingTxRequests.get(txid)
        if (pending) {
          clearTimeout(pending.timer)
          this._pendingTxRequests.delete(txid)
          pending.reject(new Error(`tx not found: ${txid.slice(0, 16)}...`))
        }
      } else if (invType === 2) {
        const blockHash = internalToHash(hashBuf)
        const pending = this._pendingBlockRequests.get(blockHash)
        if (pending) {
          clearTimeout(pending.timer)
          this._pendingBlockRequests.delete(blockHash)
          pending.reject(new Error(`block not found: ${blockHash.slice(0, 16)}...`))
        }
      }
    }
  }

  _onGetdata (payload) {
    if (payload.length < 1) return
    const countInfo = readVarInt(payload, 0)
    let offset = countInfo.size

    for (let i = 0; i < countInfo.value; i++) {
      if (offset + 36 > payload.length) break
      const invType = payload.readUInt32LE(offset)
      const hashBuf = payload.subarray(offset + 4, offset + 36)
      offset += 36

      if (invType === 1) {
        const txid = internalToHash(hashBuf)
        const rawHex = this._pendingBroadcasts.get(txid)
        if (rawHex) {
          this._sendMessage('tx', Buffer.from(rawHex, 'hex'))
        }
      }
    }
  }

  // ── Private: message building ──────────────────────────────

  _sendMessage (command, payload) {
    if (!this._socket || !this._connected) return

    const header = Buffer.alloc(MSG_HEADER_SIZE)
    MAGIC.copy(header, 0)
    const cmdBuf = Buffer.alloc(12)
    cmdBuf.write(command, 'ascii')
    cmdBuf.copy(header, 4)
    header.writeUInt32LE(payload.length, 16)
    const checksum = sha256d(payload).subarray(0, 4)
    checksum.copy(header, 20)

    this._socket.write(Buffer.concat([header, payload]))
  }

  _sendVersion () {
    const userAgentBuf = Buffer.from(USER_AGENT, 'ascii')
    const payloadSize = 4 + 8 + 8 + 26 + 26 + 8 + 1 + userAgentBuf.length + 4 + 1
    const payload = Buffer.alloc(payloadSize)
    let offset = 0

    payload.writeInt32LE(PROTOCOL_VERSION, offset); offset += 4
    payload.writeBigUInt64LE(0n, offset); offset += 8
    const now = BigInt(Math.floor(Date.now() / 1000))
    payload.writeBigUInt64LE(now, offset); offset += 8
    offset += writeNetAddr(payload, offset, 1n, this._host || '127.0.0.1', this._port || 8333)
    offset += writeNetAddr(payload, offset, 0n, '0.0.0.0', 0)
    randomBytes(8).copy(payload, offset); offset += 8
    offset += writeVarInt(payload, offset, userAgentBuf.length)
    userAgentBuf.copy(payload, offset); offset += userAgentBuf.length
    payload.writeInt32LE(this._bestHeight, offset); offset += 4
    payload[offset] = 0; offset += 1

    this._sendMessage('version', payload.subarray(0, offset))
  }

  /**
   * Send protoconf (protocol 70016+) — advertise max receive payload size.
   */
  _sendProtoconf () {
    const payload = Buffer.alloc(6)
    let offset = 0
    payload.writeUInt8(2, offset); offset += 1 // numberOfFields
    payload.writeUInt32LE(2 * 1024 * 1024, offset); offset += 4 // 2MB max
    payload.writeUInt8(0, offset) // empty streamPolicies
    this._sendMessage('protoconf', payload)
  }

  _sendGetHeaders (locatorHashes) {
    const hashCount = locatorHashes.length
    const varIntBuf = Buffer.alloc(9)
    const varIntSize = writeVarInt(varIntBuf, 0, hashCount)

    const payloadSize = 4 + varIntSize + (hashCount * 32) + 32
    const payload = Buffer.alloc(payloadSize)
    let offset = 0

    payload.writeUInt32LE(PROTOCOL_VERSION, offset); offset += 4
    varIntBuf.copy(payload, offset, 0, varIntSize); offset += varIntSize

    for (const hash of locatorHashes) {
      const hashBuf = hashToInternal(hash)
      hashBuf.copy(payload, offset); offset += 32
    }

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

    const cpHash = this._headerHashes.get(this._checkpoint.height)
    if (cpHash && hashes[hashes.length - 1] !== cpHash) {
      hashes.push(cpHash)
    }

    return hashes
  }
}
