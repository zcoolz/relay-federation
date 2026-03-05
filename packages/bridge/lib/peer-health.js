import { EventEmitter } from 'node:events'

const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000 // 24 hours
const DEFAULT_INACTIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Peer health tracker — monitors peer connectivity and applies
 * grace period logic + auto-deregistration detection.
 *
 * Rules:
 * - Tracks last-seen timestamp for each peer
 * - Grace period (24h): short outages don't count against peer score
 * - Inactive threshold (7d): peers unreachable for 7+ days are flagged inactive
 * - Inactive peers should be excluded from peer lists locally
 *
 * Emits:
 *   'peer:grace'    — { pubkeyHex, offlineSince } — peer entered grace period
 *   'peer:inactive' — { pubkeyHex, offlineSince } — peer flagged as inactive (7+ days offline)
 *   'peer:recovered' — { pubkeyHex } — peer came back online
 */
export class PeerHealth extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.gracePeriodMs=86400000] — 24 hours
   * @param {number} [opts.inactiveThresholdMs=604800000] — 7 days
   */
  constructor (opts = {}) {
    super()
    this._gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
    this._inactiveThresholdMs = opts.inactiveThresholdMs ?? DEFAULT_INACTIVE_THRESHOLD_MS

    /** @type {Map<string, { lastSeen: number, offlineSince: number|null, status: string }>} */
    this._peers = new Map()
  }

  /**
   * Record that we successfully communicated with a peer.
   * Resets offline tracking.
   * @param {string} pubkeyHex
   */
  recordSeen (pubkeyHex) {
    const prev = this._peers.get(pubkeyHex)
    const wasOffline = prev && prev.offlineSince !== null

    this._peers.set(pubkeyHex, {
      lastSeen: Date.now(),
      offlineSince: null,
      status: 'online'
    })

    if (wasOffline) {
      this.emit('peer:recovered', { pubkeyHex })
    }
  }

  /**
   * Record that a peer has disconnected or failed to respond.
   * Starts the offline timer if not already started.
   * @param {string} pubkeyHex
   */
  recordOffline (pubkeyHex) {
    const existing = this._peers.get(pubkeyHex)

    if (existing && existing.offlineSince !== null) {
      // Already tracking offline — don't reset the timer
      return
    }

    this._peers.set(pubkeyHex, {
      lastSeen: existing ? existing.lastSeen : 0,
      offlineSince: Date.now(),
      status: 'offline'
    })
  }

  /**
   * Check the health status of a peer.
   *
   * @param {string} pubkeyHex
   * @returns {'online'|'grace'|'inactive'|'unknown'}
   */
  getStatus (pubkeyHex) {
    const peer = this._peers.get(pubkeyHex)
    if (!peer) return 'unknown'
    if (peer.offlineSince === null) return 'online'

    const offlineDuration = Date.now() - peer.offlineSince

    if (offlineDuration >= this._inactiveThresholdMs) {
      return 'inactive'
    }

    if (offlineDuration >= this._gracePeriodMs) {
      return 'offline'
    }

    return 'grace'
  }

  /**
   * Check all peers and emit events for status changes.
   * Call this periodically (e.g. every 10 minutes).
   *
   * @returns {{ grace: string[], inactive: string[] }} Lists of pubkeys in each state
   */
  checkAll () {
    const grace = []
    const inactive = []

    for (const [pubkeyHex, peer] of this._peers) {
      if (peer.offlineSince === null) continue

      const status = this.getStatus(pubkeyHex)
      const prevStatus = peer.status

      if (status === 'inactive' && prevStatus !== 'inactive') {
        peer.status = 'inactive'
        inactive.push(pubkeyHex)
        this.emit('peer:inactive', { pubkeyHex, offlineSince: peer.offlineSince })
      } else if (status === 'grace' && prevStatus !== 'grace') {
        peer.status = 'grace'
        grace.push(pubkeyHex)
        this.emit('peer:grace', { pubkeyHex, offlineSince: peer.offlineSince })
      }
    }

    return { grace, inactive }
  }

  /**
   * Get the last-seen timestamp for a peer.
   * @param {string} pubkeyHex
   * @returns {number|null} Unix timestamp in ms, or null if unknown
   */
  getLastSeen (pubkeyHex) {
    const peer = this._peers.get(pubkeyHex)
    return peer ? peer.lastSeen : null
  }

  /**
   * Get all peers flagged as inactive (7+ days offline).
   * @returns {string[]} Array of pubkeyHex strings
   */
  getInactivePeers () {
    const result = []
    for (const [pubkeyHex] of this._peers) {
      if (this.getStatus(pubkeyHex) === 'inactive') {
        result.push(pubkeyHex)
      }
    }
    return result
  }

  /**
   * Check if scoring impact should be suppressed (grace period active).
   * During grace period, bad pings should NOT count against the peer.
   *
   * @param {string} pubkeyHex
   * @returns {boolean} true if peer is in grace period (suppress scoring)
   */
  isInGracePeriod (pubkeyHex) {
    return this.getStatus(pubkeyHex) === 'grace'
  }

  /**
   * Remove a peer from health tracking.
   * @param {string} pubkeyHex
   */
  removePeer (pubkeyHex) {
    this._peers.delete(pubkeyHex)
  }
}
