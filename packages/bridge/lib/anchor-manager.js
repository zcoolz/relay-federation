import { EventEmitter } from 'node:events'

const DEFAULT_MIN_ANCHORS = 2
const DEFAULT_RECONNECT_INTERVAL_MS = 30000 // 30 seconds
const DEFAULT_LOW_SCORE_THRESHOLD = 0.3

/**
 * AnchorManager — ensures minimum connections to well-known anchor bridges.
 *
 * Anchors are hardcoded in config. This manager:
 * - Ensures at least N anchor connections are maintained
 * - Auto-reconnects to anchors on disconnect
 * - Allows dropping low-scoring anchors (with warning)
 * - Does NOT make anchors immune to scoring
 *
 * Emits:
 *   'anchor:connect'    — { pubkeyHex, endpoint }
 *   'anchor:disconnect' — { pubkeyHex, endpoint }
 *   'anchor:low_score'  — { pubkeyHex, score } — warning, anchor scoring below threshold
 */
export class AnchorManager extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} [opts]
   * @param {Array<{ pubkeyHex: string, endpoint: string }>} [opts.anchors=[]] — anchor bridge list
   * @param {number} [opts.minAnchors=2] — minimum anchor connections to maintain
   * @param {number} [opts.reconnectIntervalMs=30000] — how often to check anchor connections
   * @param {number} [opts.lowScoreThreshold=0.3] — score below which to warn about anchor
   */
  constructor (peerManager, opts = {}) {
    super()
    this.peerManager = peerManager
    this._anchors = opts.anchors || []
    this._minAnchors = opts.minAnchors ?? DEFAULT_MIN_ANCHORS
    this._reconnectIntervalMs = opts.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS
    this._lowScoreThreshold = opts.lowScoreThreshold ?? DEFAULT_LOW_SCORE_THRESHOLD
    this._reconnectTimer = null
    this._anchorSet = new Set(this._anchors.map(a => a.pubkeyHex))

    // Listen for disconnects to track anchor status
    this.peerManager.on('peer:disconnect', ({ pubkeyHex, endpoint }) => {
      if (this._anchorSet.has(pubkeyHex)) {
        this.emit('anchor:disconnect', { pubkeyHex, endpoint })
      }
    })

    this.peerManager.on('peer:connect', ({ pubkeyHex, endpoint }) => {
      if (this._anchorSet.has(pubkeyHex)) {
        this.emit('anchor:connect', { pubkeyHex, endpoint })
      }
    })
  }

  /**
   * Check if a pubkey is an anchor bridge.
   * @param {string} pubkeyHex
   * @returns {boolean}
   */
  isAnchor (pubkeyHex) {
    return this._anchorSet.has(pubkeyHex)
  }

  /**
   * Get the list of configured anchor bridges.
   * @returns {Array<{ pubkeyHex: string, endpoint: string }>}
   */
  getAnchors () {
    return [...this._anchors]
  }

  /**
   * Get count of currently connected anchor bridges.
   * @returns {number}
   */
  connectedAnchorCount () {
    let count = 0
    for (const anchor of this._anchors) {
      const conn = this.peerManager.peers.get(anchor.pubkeyHex)
      if (conn && conn.connected) count++
    }
    return count
  }

  /**
   * Connect to all configured anchors that we're not already connected to.
   * Respects maxPeers — if at capacity, still tries anchors (they're priority).
   *
   * @returns {number} Number of new connections initiated
   */
  ensureConnections () {
    let initiated = 0

    for (const anchor of this._anchors) {
      const existing = this.peerManager.peers.get(anchor.pubkeyHex)
      if (existing && existing.connected) continue

      // If we have a disconnected connection object, remove it first
      if (existing && !existing.connected) {
        this.peerManager.peers.delete(anchor.pubkeyHex)
      }

      const conn = this.peerManager.connectToPeer(anchor)
      if (conn) initiated++
    }

    return initiated
  }

  /**
   * Start periodic anchor connection monitoring.
   * Checks every reconnectIntervalMs and reconnects to missing anchors.
   */
  startMonitoring () {
    if (this._reconnectTimer) return

    this._reconnectTimer = setInterval(() => {
      const connected = this.connectedAnchorCount()
      if (connected < this._minAnchors) {
        this.ensureConnections()
      }
    }, this._reconnectIntervalMs)

    // Don't prevent process exit
    if (this._reconnectTimer.unref) {
      this._reconnectTimer.unref()
    }
  }

  /**
   * Stop periodic monitoring.
   */
  stopMonitoring () {
    if (this._reconnectTimer) {
      clearInterval(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  /**
   * Check anchor scores and emit warnings for low-scoring anchors.
   *
   * @param {import('./peer-scorer.js').PeerScorer} scorer
   * @returns {Array<{ pubkeyHex: string, score: number }>} Low-scoring anchors
   */
  checkAnchorScores (scorer) {
    const lowScoring = []

    for (const anchor of this._anchors) {
      const score = scorer.getScore(anchor.pubkeyHex)
      if (score < this._lowScoreThreshold) {
        lowScoring.push({ pubkeyHex: anchor.pubkeyHex, score })
        this.emit('anchor:low_score', { pubkeyHex: anchor.pubkeyHex, score })
      }
    }

    return lowScoring
  }
}
