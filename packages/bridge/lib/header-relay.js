import { EventEmitter } from 'node:events'

/**
 * HeaderRelay — syncs block headers between peers.
 *
 * Uses the PeerManager's message infrastructure to:
 * - Announce our best header to new peers (triggered by hello handshake)
 * - Request missing headers from peers that are ahead
 * - Respond to header requests from peers that are behind
 * - Re-announce to all peers after syncing new headers
 *
 * Message types:
 *   header_announce — { type, height, hash }
 *   header_request  — { type, fromHeight }
 *   headers         — { type, headers: [{ height, hash, prevHash }] }
 *
 * Events:
 *   'header:sync'   — { pubkeyHex, added, bestHeight }
 *   'header:behind' — { pubkeyHex, theirHeight, ourHeight }
 */
export class HeaderRelay extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} [opts]
   * @param {number} [opts.maxBatch=500] — Max headers per response
   */
  constructor (peerManager, opts = {}) {
    super()
    this.peerManager = peerManager
    /** @type {Map<number, { height: number, hash: string, prevHash: string }>} */
    this.headers = new Map()
    this.bestHeight = -1
    this.bestHash = null
    this._maxBatch = opts.maxBatch || 500

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._handleMessage(pubkeyHex, message)
    })
  }

  /**
   * Add a single header to the local store.
   * @returns {boolean} true if added, false if duplicate or invalid
   */
  addHeader (header) {
    if (this.headers.has(header.height)) return false

    // Validate prevHash chain if we have the previous header
    if (header.height > 0 && this.headers.has(header.height - 1)) {
      const prev = this.headers.get(header.height - 1)
      if (prev.hash !== header.prevHash) return false
    }

    this.headers.set(header.height, header)
    if (header.height > this.bestHeight) {
      this.bestHeight = header.height
      this.bestHash = header.hash
    }
    return true
  }

  /**
   * Add multiple headers (sorts by height first).
   * @returns {number} count of headers added
   */
  addHeaders (headers) {
    let added = 0
    const sorted = [...headers].sort((a, b) => a.height - b.height)
    for (const h of sorted) {
      if (this.addHeader(h)) added++
    }
    return added
  }

  /** Get the best (highest) header, or null. */
  getBestHeader () {
    if (this.bestHeight < 0) return null
    return this.headers.get(this.bestHeight)
  }

  /** Get header at a specific height, or null. */
  getHeader (height) {
    return this.headers.get(height) || null
  }

  /** Get block hash at a specific height, or null. */
  getHashAtHeight (height) {
    const header = this.headers.get(height)
    return header ? header.hash : null
  }

  /**
   * Announce our best header to all connected peers.
   * @returns {number} peers notified
   */
  announceToAll () {
    return this.peerManager.broadcast({
      type: 'header_announce',
      height: this.bestHeight,
      hash: this.bestHash
    })
  }

  /** @private */
  _announceToPeer (pubkeyHex) {
    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({
        type: 'header_announce',
        height: this.bestHeight,
        hash: this.bestHash
      })
    }
  }

  /** @private */
  _handleMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'hello':
        // Inbound peer completed handshake — announce our best header
        this._announceToPeer(pubkeyHex)
        break
      case 'header_announce':
        this._onHeaderAnnounce(pubkeyHex, message)
        break
      case 'header_request':
        this._onHeaderRequest(pubkeyHex, message)
        break
      case 'headers':
        this._onHeaders(pubkeyHex, message)
        break
    }
  }

  /** @private */
  _onHeaderAnnounce (pubkeyHex, msg) {
    if (msg.height > this.bestHeight) {
      // We're behind — request missing headers
      const conn = this.peerManager.peers.get(pubkeyHex)
      if (conn) {
        conn.send({
          type: 'header_request',
          fromHeight: this.bestHeight + 1
        })
      }
      this.emit('header:behind', {
        pubkeyHex,
        theirHeight: msg.height,
        ourHeight: this.bestHeight
      })
    } else if (msg.height < this.bestHeight) {
      // We're ahead — announce back so they can sync from us
      this._announceToPeer(pubkeyHex)
    }
  }

  /** @private */
  _onHeaderRequest (pubkeyHex, msg) {
    const headers = []
    for (let h = msg.fromHeight; h <= this.bestHeight && headers.length < this._maxBatch; h++) {
      const header = this.headers.get(h)
      if (header) headers.push(header)
    }
    if (headers.length > 0) {
      const conn = this.peerManager.peers.get(pubkeyHex)
      if (conn) {
        conn.send({ type: 'headers', headers })
      }
    }
  }

  /** @private */
  _onHeaders (pubkeyHex, msg) {
    if (!Array.isArray(msg.headers)) return
    const added = this.addHeaders(msg.headers)
    if (added > 0) {
      this.emit('header:sync', {
        pubkeyHex,
        added,
        bestHeight: this.bestHeight,
        headers: msg.headers
      })
      // If we got a full batch, tell the source our new height so they send more
      if (msg.headers.length >= this._maxBatch) {
        this._announceToPeer(pubkeyHex)
      }
      // Re-announce to all peers except the source
      this.peerManager.broadcast({
        type: 'header_announce',
        height: this.bestHeight,
        hash: this.bestHash
      }, pubkeyHex)
    }
  }
}
