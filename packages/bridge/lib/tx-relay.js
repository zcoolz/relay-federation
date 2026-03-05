import { EventEmitter } from 'node:events'

/**
 * TxRelay — relays transactions between peers.
 *
 * Uses the INV/GETDATA pattern (like Bitcoin P2P):
 * 1. Peer announces a txid via tx_announce
 * 2. If we haven't seen it, we request the full tx via tx_request
 * 3. Peer responds with the raw tx hex via tx message
 * 4. We store it and re-announce to other peers
 *
 * Message types:
 *   tx_announce — { type, txid }
 *   tx_request  — { type, txid }
 *   tx          — { type, txid, rawHex }
 *
 * Events:
 *   'tx:new' — { txid, rawHex } — new transaction received or submitted
 */
export class TxRelay extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} [opts]
   * @param {number} [opts.maxMempool=1000] — Max txs in local mempool
   */
  constructor (peerManager, opts = {}) {
    super()
    this.peerManager = peerManager
    /** @type {Map<string, string>} txid → rawHex */
    this.mempool = new Map()
    /** @type {Set<string>} txids we've already seen (dedup) */
    this.seen = new Set()
    this._maxMempool = opts.maxMempool || 1000

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._handleMessage(pubkeyHex, message)
    })
  }

  /**
   * Submit a new tx for relay to all peers.
   * @param {string} txid
   * @param {string} rawHex
   * @returns {number} Number of peers the announce was sent to
   */
  broadcastTx (txid, rawHex) {
    if (this.seen.has(txid)) return 0
    this.seen.add(txid)
    this._storeTx(txid, rawHex)
    this.emit('tx:new', { txid, rawHex })
    return this.peerManager.broadcast({ type: 'tx_announce', txid })
  }

  /**
   * Get a tx from the local mempool.
   * @param {string} txid
   * @returns {string|null} rawHex or null
   */
  getTx (txid) {
    return this.mempool.get(txid) || null
  }

  /** @private */
  _storeTx (txid, rawHex) {
    if (this.mempool.size >= this._maxMempool) {
      const oldest = this.mempool.keys().next().value
      this.mempool.delete(oldest)
    }
    this.mempool.set(txid, rawHex)
  }

  /** @private */
  _handleMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'tx_announce':
        this._onTxAnnounce(pubkeyHex, message)
        break
      case 'tx_request':
        this._onTxRequest(pubkeyHex, message)
        break
      case 'tx':
        this._onTx(pubkeyHex, message)
        break
    }
  }

  /** @private */
  _onTxAnnounce (pubkeyHex, msg) {
    if (this.seen.has(msg.txid)) return
    this.seen.add(msg.txid)
    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({ type: 'tx_request', txid: msg.txid })
    }
  }

  /** @private */
  _onTxRequest (pubkeyHex, msg) {
    const rawHex = this.mempool.get(msg.txid)
    if (rawHex) {
      const conn = this.peerManager.peers.get(pubkeyHex)
      if (conn) {
        conn.send({ type: 'tx', txid: msg.txid, rawHex })
      }
    }
  }

  /** @private */
  _onTx (pubkeyHex, msg) {
    if (!msg.txid || !msg.rawHex) return
    if (this.mempool.has(msg.txid)) return
    this._storeTx(msg.txid, msg.rawHex)
    this.emit('tx:new', { txid: msg.txid, rawHex: msg.rawHex })
    // Re-announce to all peers except the source
    this.peerManager.broadcast({ type: 'tx_announce', txid: msg.txid }, pubkeyHex)
  }
}
