import { EventEmitter } from 'node:events'
import { resolve4 } from 'node:dns/promises'
import { BSVPeer } from './bsv-peer.js'

/**
 * BSVNodeClient — multi-peer pool manager for BSV P2P connections.
 *
 * Manages a pool of BSVPeer connections for redundancy:
 * - DNS-only peer discovery (3 seeds, no WoC dependency)
 * - Connects to multiple BSV nodes simultaneously
 * - Broadcasts transactions to ALL connected peers
 * - Fetches transactions from first available peer
 * - Maintains peer pool with periodic health checks
 *
 * Ported from production Indelible SPV bridge (spv-client.js)
 * peer management, adapted for the open protocol (no third-party APIs).
 *
 * Events (proxied from all peers):
 *   'headers'      — { headers, count }
 *   'connected'    — { host, port }
 *   'handshake'    — { version, userAgent, startHeight }
 *   'disconnected' — { host, port }
 *   'error'        — Error
 *   'tx'           — { txid, rawHex }
 *   'tx:inv'       — { txids }
 */

const DEFAULT_SEEDS = [
  'seed.bitcoinsv.io',
  'seed.satoshisvision.network',
  'seed.cascharia.com'
]

const DEFAULT_PORT = 8333
const DEFAULT_MAX_PEERS = 8
const MAINTAIN_INTERVAL_MS = 60000

const DEFAULT_CHECKPOINT = {
  height: 930000,
  hash: '00000000000000001c2e04e4375cfa4b46588aa27795b2c7f8d4d34cb568a382',
  prevHash: '000000000000000015ec9abde40c7537fc422e5af81b6028ac376d7cf23bd0c8'
}

export class BSVNodeClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.seeds] — DNS seeds (default: 3 BSV seeds)
   * @param {number} [opts.port] — BSV node port (default 8333)
   * @param {{ height, hash, prevHash }} [opts.checkpoint] — Starting checkpoint
   * @param {number} [opts.maxPeers] — Max concurrent peers (default 8)
   * @param {number} [opts.syncIntervalMs] — Header sync interval (default 30s)
   * @param {number} [opts.pingIntervalMs] — Keepalive interval (default 120s)
   */
  constructor (opts = {}) {
    super()
    this._seeds = opts.seeds || DEFAULT_SEEDS
    this._port = opts.port || DEFAULT_PORT
    this._checkpoint = opts.checkpoint || DEFAULT_CHECKPOINT
    this._maxPeers = opts.maxPeers || DEFAULT_MAX_PEERS
    this._syncIntervalMs = opts.syncIntervalMs || 30000
    this._pingIntervalMs = opts.pingIntervalMs || 120000

    /** @type {Map<string, BSVPeer>} host → peer */
    this._peers = new Map()
    this._destroyed = false
    this._maintainTimer = null

    // Track best height across all peers
    this._bestHeight = this._checkpoint.height
    this._bestHash = this._checkpoint.hash
  }

  /**
   * Discover BSV nodes via DNS seeds and connect to up to maxPeers.
   * Emits 'connected' and 'handshake' events as peers come online.
   * Does not block — connections established in background.
   */
  async connect () {
    if (this._destroyed) return

    const addresses = await this._discoverPeers()

    // Shuffle for load distribution
    for (let i = addresses.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [addresses[i], addresses[j]] = [addresses[j], addresses[i]]
    }

    // Try connecting to peers (fire-and-forget, events fire when ready)
    const targets = addresses.slice(0, this._maxPeers * 2)
    for (const addr of targets) {
      if (this.connectedCount >= this._maxPeers) break
      this._connectToPeer(addr.host, addr.port)
    }

    // Start maintenance timer
    this._maintainTimer = setInterval(() => this._maintainPeers(), MAINTAIN_INTERVAL_MS)
    if (this._maintainTimer.unref) this._maintainTimer.unref()
  }

  /**
   * Disconnect all peers and stop maintenance.
   */
  disconnect () {
    this._destroyed = true
    clearInterval(this._maintainTimer)
    for (const peer of this._peers.values()) {
      peer.disconnect()
    }
    this._peers.clear()
  }

  /**
   * Broadcast a raw transaction to ALL connected peers.
   * @param {string} rawTxHex
   * @returns {string} txid
   */
  broadcastTx (rawTxHex) {
    let txid = null
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        txid = peer.broadcastTx(rawTxHex)
      }
    }
    return txid
  }

  /**
   * Fetch a transaction from the first available peer.
   * @param {string} txid
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{ txid, rawHex }>}
   */
  getTx (txid, timeoutMs = 10000) {
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        return peer.getTx(txid, timeoutMs)
      }
    }
    return Promise.reject(new Error('not connected to BSV node'))
  }

  /**
   * Trigger header sync on connected peers.
   */
  syncHeaders () {
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        peer.syncHeaders()
        break // sync from one peer at a time
      }
    }
  }

  /**
   * Seed a header hash to all peers.
   * @param {number} height
   * @param {string} hash
   */
  seedHeader (height, hash) {
    for (const peer of this._peers.values()) {
      peer.seedHeader(height, hash)
    }
    if (height > this._bestHeight) {
      this._bestHeight = height
      this._bestHash = hash
    }
  }

  /** Best synced height across all peers */
  get bestHeight () { return this._bestHeight }
  /** Best synced hash */
  get bestHash () { return this._bestHash }

  /** Number of peers with completed handshake */
  get connectedCount () {
    let count = 0
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) count++
    }
    return count
  }

  /** List of connected peers with status info */
  get peerList () {
    const list = []
    for (const [host, peer] of this._peers) {
      list.push({
        host,
        connected: peer._connected,
        handshake: peer._handshakeComplete,
        bestHeight: peer._bestHeight,
        userAgent: peer._peerUserAgent
      })
    }
    return list
  }

  // ── Private: peer discovery ────────────────────────────────

  /**
   * Discover BSV node IPs from DNS seeds.
   * No WoC, no third-party APIs — pure DNS.
   */
  async _discoverPeers () {
    const seen = new Set()
    const peers = []

    for (const seed of this._seeds) {
      try {
        const addrs = await resolve4(seed)
        for (const addr of addrs) {
          if (!seen.has(addr)) {
            seen.add(addr)
            peers.push({ host: addr, port: this._port })
          }
        }
      } catch {
        // DNS resolution failed for this seed — try others
      }
    }

    return peers
  }

  // ── Private: peer management ───────────────────────────────

  /**
   * Connect to a single BSV peer. Fire-and-forget.
   * @param {string} host
   * @param {number} port
   */
  async _connectToPeer (host, port) {
    if (this._peers.has(host) || this._destroyed) return

    const peer = new BSVPeer({
      checkpoint: this._checkpoint,
      syncIntervalMs: this._syncIntervalMs,
      pingIntervalMs: this._pingIntervalMs
    })

    this._peers.set(host, peer)

    // Wire events — proxy to callers
    peer.on('headers', (data) => {
      // Update pool best height
      for (const h of data.headers) {
        if (h.height > this._bestHeight) {
          this._bestHeight = h.height
          this._bestHash = h.hash
        }
      }
      this.emit('headers', data)
    })

    peer.on('connected', (data) => this.emit('connected', data))
    peer.on('handshake', (data) => this.emit('handshake', data))

    peer.on('disconnected', (data) => {
      this._peers.delete(host)
      this.emit('disconnected', data)
    })

    peer.on('error', (err) => {
      // Don't crash the pool — just log
      this.emit('error', err)
    })

    peer.on('tx', (data) => this.emit('tx', data))
    peer.on('tx:inv', (data) => this.emit('tx:inv', data))

    try {
      await peer.connect(host, port)
    } catch {
      // Connection or handshake failed — remove from pool
      this._peers.delete(host)
    }
  }

  /**
   * Periodic maintenance: clean dead peers, reconnect if below target.
   */
  async _maintainPeers () {
    if (this._destroyed) return

    // Clean disconnected peers
    for (const [host, peer] of this._peers) {
      if (!peer._connected) {
        this._peers.delete(host)
      }
    }

    // Reconnect if below target
    if (this._peers.size < this._maxPeers) {
      try {
        const addresses = await this._discoverPeers()

        // Shuffle
        for (let i = addresses.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [addresses[i], addresses[j]] = [addresses[j], addresses[i]]
        }

        // Filter already-connected hosts
        const newAddrs = addresses.filter(a => !this._peers.has(a.host))

        for (const addr of newAddrs) {
          if (this._peers.size >= this._maxPeers) break
          this._connectToPeer(addr.host, addr.port)
        }
      } catch {
        // DNS failed during maintenance — try again next cycle
      }
    }
  }
}
