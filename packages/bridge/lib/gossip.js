import { EventEmitter } from 'node:events'
import { signHash, verifyHash } from '@relay-federation/common/crypto'

/**
 * GossipManager — peer discovery via WebSocket gossip protocol.
 *
 * Replaces HTTP-based registry scanning with pure P2P peer discovery.
 * Three message types:
 *
 *   getpeers   — "tell me who you know"
 *   peers      — response with list of known peers
 *   announce   — "I'm alive" (signed, propagated to all peers)
 *
 * Announcements are signed with the bridge's private key to prevent
 * impersonation. Each announcement includes a timestamp — stale
 * announcements (older than maxAge) are discarded.
 *
 * Events:
 *   'peer:discovered'  — { pubkeyHex, endpoint, meshId }
 *   'peers:response'   — { peers: Array }
 */
export class GossipManager extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} opts
   * @param {import('@bsv/sdk').PrivateKey} opts.privKey — Bridge private key for signing
   * @param {string} opts.pubkeyHex — Our compressed pubkey hex
   * @param {string} opts.endpoint — Our advertised WSS endpoint
   * @param {string} [opts.meshId='indelible'] — Mesh identifier
   * @param {number} [opts.announceIntervalMs=60000] — Re-announce interval
   * @param {number} [opts.maxAge=300000] — Max age for announcements (5 min)
   * @param {number} [opts.maxPeersResponse=50] — Max peers in a response
   */
  constructor (peerManager, opts) {
    super()
    this.peerManager = peerManager
    this._privKey = opts.privKey
    this._pubkeyHex = opts.pubkeyHex
    this._endpoint = opts.endpoint
    this._meshId = opts.meshId || 'indelible'
    this._announceIntervalMs = opts.announceIntervalMs || 60000
    this._maxAge = opts.maxAge || 300000
    this._maxPeersResponse = opts.maxPeersResponse || 50

    /** @type {Map<string, { pubkeyHex: string, endpoint: string, meshId: string, lastSeen: number }>} */
    this._directory = new Map()

    /** @type {Set<string>} recently seen announce hashes (dedup) */
    this._seenAnnounces = new Set()

    this._announceTimer = null

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._handleMessage(pubkeyHex, message)
    })
  }

  /**
   * Start periodic announcements.
   */
  start () {
    // Announce immediately
    this._broadcastAnnounce()
    // Then on interval
    this._announceTimer = setInterval(() => {
      this._broadcastAnnounce()
    }, this._announceIntervalMs)
    if (this._announceTimer.unref) this._announceTimer.unref()
  }

  /**
   * Stop periodic announcements.
   */
  stop () {
    if (this._announceTimer) {
      clearInterval(this._announceTimer)
      this._announceTimer = null
    }
  }

  /**
   * Request peer list from a specific peer.
   * @param {string} pubkeyHex — peer to ask
   */
  requestPeers (pubkeyHex) {
    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({ type: 'getpeers' })
    }
  }

  /**
   * Request peer lists from all connected peers.
   */
  requestPeersFromAll () {
    this.peerManager.broadcast({ type: 'getpeers' })
  }

  /**
   * Get the current peer directory.
   * @returns {Array<{ pubkeyHex: string, endpoint: string, meshId: string, lastSeen: number }>}
   */
  getDirectory () {
    const now = Date.now()
    const result = []
    for (const [, entry] of this._directory) {
      if (now - entry.lastSeen < this._maxAge) {
        result.push({ ...entry })
      }
    }
    return result
  }

  /**
   * Get directory size (excluding stale entries).
   * @returns {number}
   */
  directorySize () {
    return this.getDirectory().length
  }

  /**
   * Manually add a peer to the directory (e.g., seed peers from config).
   * @param {{ pubkeyHex: string, endpoint: string, meshId?: string }} peer
   */
  addSeed (peer) {
    this._directory.set(peer.pubkeyHex, {
      pubkeyHex: peer.pubkeyHex,
      endpoint: peer.endpoint,
      meshId: peer.meshId || this._meshId,
      lastSeen: Date.now()
    })
  }

  /** @private */
  _handleMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'getpeers':
        this._onGetPeers(pubkeyHex)
        break
      case 'peers':
        this._onPeers(pubkeyHex, message)
        break
      case 'announce':
        this._onAnnounce(pubkeyHex, message)
        break
    }
  }

  /** @private */
  _onGetPeers (pubkeyHex) {
    const peers = this.getDirectory()
      .filter(p => p.pubkeyHex !== pubkeyHex) // don't send them back to themselves
      .slice(0, this._maxPeersResponse)

    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({ type: 'peers', peers })
    }
  }

  /** @private */
  _onPeers (pubkeyHex, message) {
    if (!Array.isArray(message.peers)) return

    for (const peer of message.peers) {
      if (!peer.pubkeyHex || !peer.endpoint) continue
      if (peer.pubkeyHex === this._pubkeyHex) continue // skip self

      const isNew = !this._directory.has(peer.pubkeyHex)

      this._directory.set(peer.pubkeyHex, {
        pubkeyHex: peer.pubkeyHex,
        endpoint: peer.endpoint,
        meshId: peer.meshId || 'unknown',
        lastSeen: Date.now()
      })

      if (isNew) {
        this.emit('peer:discovered', {
          pubkeyHex: peer.pubkeyHex,
          endpoint: peer.endpoint,
          meshId: peer.meshId || 'unknown'
        })
      }
    }

    this.emit('peers:response', { peers: message.peers, from: pubkeyHex })
  }

  /** @private */
  _onAnnounce (sourcePubkey, message) {
    if (!message.pubkeyHex || !message.endpoint || !message.timestamp || !message.signature) return

    // Dedup — don't process the same announcement twice
    const announceId = `${message.pubkeyHex}:${message.timestamp}`
    if (this._seenAnnounces.has(announceId)) return
    this._seenAnnounces.add(announceId)

    // Trim dedup set if it gets too large
    if (this._seenAnnounces.size > 10000) {
      const arr = [...this._seenAnnounces]
      this._seenAnnounces = new Set(arr.slice(arr.length - 5000))
    }

    // Check age
    const age = Date.now() - message.timestamp
    if (age > this._maxAge || age < -30000) return // too old or too far in the future

    // Verify signature
    const payload = `${message.pubkeyHex}:${message.endpoint}:${message.meshId || ''}:${message.timestamp}`
    const dataHex = Buffer.from(payload, 'utf8').toString('hex')

    try {
      const valid = verifyHash(dataHex, message.signature, message.pubkeyHex)
      if (!valid) return
    } catch {
      return // invalid signature format
    }

    // Skip self
    if (message.pubkeyHex === this._pubkeyHex) return

    const isNew = !this._directory.has(message.pubkeyHex)

    this._directory.set(message.pubkeyHex, {
      pubkeyHex: message.pubkeyHex,
      endpoint: message.endpoint,
      meshId: message.meshId || 'unknown',
      lastSeen: Date.now()
    })

    if (isNew) {
      this.emit('peer:discovered', {
        pubkeyHex: message.pubkeyHex,
        endpoint: message.endpoint,
        meshId: message.meshId || 'unknown'
      })
    }

    // Re-broadcast to all peers except source
    this.peerManager.broadcast(message, sourcePubkey)
  }

  /** @private */
  _broadcastAnnounce () {
    const timestamp = Date.now()
    const payload = `${this._pubkeyHex}:${this._endpoint}:${this._meshId}:${timestamp}`
    const dataHex = Buffer.from(payload, 'utf8').toString('hex')
    const signature = signHash(dataHex, this._privKey)

    const message = {
      type: 'announce',
      pubkeyHex: this._pubkeyHex,
      endpoint: this._endpoint,
      meshId: this._meshId,
      timestamp,
      signature
    }

    // Add to our own dedup set
    this._seenAnnounces.add(`${this._pubkeyHex}:${timestamp}`)

    this.peerManager.broadcast(message)
  }
}
