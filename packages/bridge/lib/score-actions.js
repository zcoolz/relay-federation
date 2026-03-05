import { EventEmitter } from 'node:events'

const DEFAULT_DISCONNECT_THRESHOLD = 0.3
const DEFAULT_BLACKLIST_THRESHOLD = 0.1
const DEFAULT_BLACKLIST_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Score-based automatic actions.
 *
 * Listens to PeerScorer 'score:update' events and takes action:
 * - score < 0.3 → auto-disconnect peer
 * - score < 0.1 → blacklist peer for 24 hours
 *
 * Emits:
 *   'peer:disconnected' — { pubkeyHex, score, reason }
 *   'peer:blacklisted'  — { pubkeyHex, score, expiresAt }
 */
export class ScoreActions extends EventEmitter {
  /**
   * @param {import('./peer-scorer.js').PeerScorer} scorer
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} [opts]
   * @param {number} [opts.disconnectThreshold=0.3]
   * @param {number} [opts.blacklistThreshold=0.1]
   * @param {number} [opts.blacklistDurationMs=86400000] — 24 hours
   */
  constructor (scorer, peerManager, opts = {}) {
    super()
    this.scorer = scorer
    this.peerManager = peerManager
    this._disconnectThreshold = opts.disconnectThreshold ?? DEFAULT_DISCONNECT_THRESHOLD
    this._blacklistThreshold = opts.blacklistThreshold ?? DEFAULT_BLACKLIST_THRESHOLD
    this._blacklistDurationMs = opts.blacklistDurationMs ?? DEFAULT_BLACKLIST_DURATION_MS
    this._blacklist = new Map() // pubkeyHex → expiresAt (timestamp)

    this.scorer.on('score:update', ({ pubkeyHex, score }) => {
      this._evaluate(pubkeyHex, score)
    })
  }

  /**
   * Evaluate a peer's score and take action if below thresholds.
   * @param {string} pubkeyHex
   * @param {number} score
   */
  _evaluate (pubkeyHex, score) {
    if (score < this._blacklistThreshold) {
      this._blacklistPeer(pubkeyHex, score)
    } else if (score < this._disconnectThreshold) {
      this._disconnectPeer(pubkeyHex, score)
    }
  }

  /**
   * Disconnect a low-scoring peer.
   * @param {string} pubkeyHex
   * @param {number} score
   */
  _disconnectPeer (pubkeyHex, score) {
    this.peerManager.disconnectPeer(pubkeyHex)
    this.emit('peer:disconnected', {
      pubkeyHex,
      score,
      reason: 'low_score'
    })
  }

  /**
   * Blacklist a peer — disconnect and prevent reconnection for the blacklist duration.
   * @param {string} pubkeyHex
   * @param {number} score
   */
  _blacklistPeer (pubkeyHex, score) {
    const expiresAt = Date.now() + this._blacklistDurationMs

    this._blacklist.set(pubkeyHex, expiresAt)
    this.peerManager.disconnectPeer(pubkeyHex)

    this.emit('peer:blacklisted', {
      pubkeyHex,
      score,
      expiresAt
    })
  }

  /**
   * Check if a peer is currently blacklisted.
   * Automatically cleans up expired entries.
   *
   * @param {string} pubkeyHex
   * @returns {boolean}
   */
  isBlacklisted (pubkeyHex) {
    if (!this._blacklist.has(pubkeyHex)) return false

    const expiresAt = this._blacklist.get(pubkeyHex)
    if (Date.now() >= expiresAt) {
      this._blacklist.delete(pubkeyHex)
      return false
    }

    return true
  }

  /**
   * Get the blacklist expiry timestamp for a peer, or null.
   * @param {string} pubkeyHex
   * @returns {number|null}
   */
  getBlacklistExpiry (pubkeyHex) {
    if (!this.isBlacklisted(pubkeyHex)) return null
    return this._blacklist.get(pubkeyHex)
  }

  /**
   * Get all currently blacklisted peers.
   * @returns {Map<string, number>} pubkeyHex → expiresAt
   */
  getBlacklist () {
    // Clean up expired entries
    const now = Date.now()
    for (const [pubkey, expiresAt] of this._blacklist) {
      if (now >= expiresAt) this._blacklist.delete(pubkey)
    }
    return new Map(this._blacklist)
  }

  /**
   * Manually remove a peer from the blacklist.
   * @param {string} pubkeyHex
   */
  unblacklist (pubkeyHex) {
    this._blacklist.delete(pubkeyHex)
  }
}
