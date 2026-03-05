import { EventEmitter } from 'node:events'

const WEIGHTS = {
  uptime: 0.3,
  responseTime: 0.2,
  dataAccuracy: 0.4,
  stakeAge: 0.1
}

// Response time normalization: 1.0 = <100ms, 0.0 = >5000ms
const RT_FLOOR = 100
const RT_CEIL = 5000

// Stake age normalization: log2(days) / 10, capped at 1.0
const STAKE_AGE_DIVISOR = 10

// Rolling windows
const DEFAULT_ACCURACY_WINDOW = 1000
const DEFAULT_UPTIME_WINDOW = 1000 // ~7 days at 10-min ping intervals

/**
 * Per-peer metrics bucket.
 */
function createMetrics () {
  return {
    // Uptime tracking
    pings: 0,
    pongs: 0,

    // Response time — rolling average
    latencies: [],

    // Data accuracy — rolling window of booleans (true = good)
    accuracyLog: [],

    // Stake age in days
    stakeAgeDays: 0
  }
}

/**
 * Peer scoring engine.
 *
 * Computes local reputation scores for each connected peer.
 * Formula: 0.3 * uptime + 0.2 * response_time + 0.4 * data_accuracy + 0.1 * stake_age
 *
 * Emits:
 *   'score:update' — { pubkeyHex, score, metrics }
 */
export class PeerScorer extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.accuracyWindow=1000] — rolling window size for data accuracy
   * @param {number} [opts.uptimeWindow=1000] — rolling window size for uptime pings
   * @param {number} [opts.latencyWindow=100] — rolling window size for latency samples
   */
  constructor (opts = {}) {
    super()
    this._peers = new Map() // pubkeyHex → metrics
    this._accuracyWindow = opts.accuracyWindow || DEFAULT_ACCURACY_WINDOW
    this._uptimeWindow = opts.uptimeWindow || DEFAULT_UPTIME_WINDOW
    this._latencyWindow = opts.latencyWindow || 100
  }

  /**
   * Get or create metrics for a peer.
   * @param {string} pubkeyHex
   * @returns {object}
   */
  _getMetrics (pubkeyHex) {
    if (!this._peers.has(pubkeyHex)) {
      this._peers.set(pubkeyHex, createMetrics())
    }
    return this._peers.get(pubkeyHex)
  }

  /**
   * Record a successful ping response.
   * @param {string} pubkeyHex
   * @param {number} latencyMs — round-trip time in milliseconds
   */
  recordPing (pubkeyHex, latencyMs) {
    const m = this._getMetrics(pubkeyHex)
    m.pings++
    m.pongs++

    // Trim uptime window
    if (m.pings > this._uptimeWindow) {
      // Approximate: scale down proportionally
      const ratio = m.pongs / m.pings
      m.pings = this._uptimeWindow
      m.pongs = Math.round(ratio * this._uptimeWindow)
    }

    // Record latency
    m.latencies.push(latencyMs)
    if (m.latencies.length > this._latencyWindow) {
      m.latencies.shift()
    }

    this._emitUpdate(pubkeyHex)
  }

  /**
   * Record a ping timeout (no response).
   * @param {string} pubkeyHex
   */
  recordPingTimeout (pubkeyHex) {
    const m = this._getMetrics(pubkeyHex)
    m.pings++

    // Trim uptime window
    if (m.pings > this._uptimeWindow) {
      const ratio = m.pongs / m.pings
      m.pings = this._uptimeWindow
      m.pongs = Math.round(ratio * this._uptimeWindow)
    }

    this._emitUpdate(pubkeyHex)
  }

  /**
   * Record a valid data relay (good header or tx).
   * @param {string} pubkeyHex
   */
  recordGoodData (pubkeyHex) {
    const m = this._getMetrics(pubkeyHex)
    m.accuracyLog.push(true)
    if (m.accuracyLog.length > this._accuracyWindow) {
      m.accuracyLog.shift()
    }
    this._emitUpdate(pubkeyHex)
  }

  /**
   * Record an invalid data relay (bad header or tx).
   * @param {string} pubkeyHex
   */
  recordBadData (pubkeyHex) {
    const m = this._getMetrics(pubkeyHex)
    m.accuracyLog.push(false)
    if (m.accuracyLog.length > this._accuracyWindow) {
      m.accuracyLog.shift()
    }
    this._emitUpdate(pubkeyHex)
  }

  /**
   * Set the stake bond age for a peer.
   * @param {string} pubkeyHex
   * @param {number} days — age of stake bond in days
   */
  setStakeAge (pubkeyHex, days) {
    const m = this._getMetrics(pubkeyHex)
    m.stakeAgeDays = days
    this._emitUpdate(pubkeyHex)
  }

  /**
   * Compute the uptime sub-score (0-1).
   * @param {object} m — metrics
   * @returns {number}
   */
  _computeUptime (m) {
    if (m.pings === 0) return 0.5 // neutral when no data
    return m.pongs / m.pings
  }

  /**
   * Compute the response time sub-score (0-1).
   * 1.0 = <= 100ms, 0.0 = >= 5000ms, linear between.
   * @param {object} m — metrics
   * @returns {number}
   */
  _computeResponseTime (m) {
    if (m.latencies.length === 0) return 0.5 // neutral when no data
    const avg = m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length
    if (avg <= RT_FLOOR) return 1.0
    if (avg >= RT_CEIL) return 0.0
    return 1.0 - (avg - RT_FLOOR) / (RT_CEIL - RT_FLOOR)
  }

  /**
   * Compute the data accuracy sub-score (0-1).
   * @param {object} m — metrics
   * @returns {number}
   */
  _computeDataAccuracy (m) {
    if (m.accuracyLog.length === 0) return 0.5 // neutral when no data
    const good = m.accuracyLog.filter(Boolean).length
    return good / m.accuracyLog.length
  }

  /**
   * Compute the stake age sub-score (0-1).
   * Formula: log2(days) / 10, capped at 1.0.
   * @param {object} m — metrics
   * @returns {number}
   */
  _computeStakeAge (m) {
    if (m.stakeAgeDays <= 0) return 0
    return Math.min(1.0, Math.log2(m.stakeAgeDays) / STAKE_AGE_DIVISOR)
  }

  /**
   * Get the composite score for a peer.
   * @param {string} pubkeyHex
   * @returns {number} 0-1
   */
  getScore (pubkeyHex) {
    if (!this._peers.has(pubkeyHex)) return 0.5 // unknown peer = neutral

    const m = this._peers.get(pubkeyHex)
    const uptime = this._computeUptime(m)
    const responseTime = this._computeResponseTime(m)
    const dataAccuracy = this._computeDataAccuracy(m)
    const stakeAge = this._computeStakeAge(m)

    return (
      WEIGHTS.uptime * uptime +
      WEIGHTS.responseTime * responseTime +
      WEIGHTS.dataAccuracy * dataAccuracy +
      WEIGHTS.stakeAge * stakeAge
    )
  }

  /**
   * Get all sub-scores and raw metrics for a peer.
   * @param {string} pubkeyHex
   * @returns {object|null}
   */
  getMetrics (pubkeyHex) {
    if (!this._peers.has(pubkeyHex)) return null

    const m = this._peers.get(pubkeyHex)
    return {
      uptime: this._computeUptime(m),
      responseTime: this._computeResponseTime(m),
      dataAccuracy: this._computeDataAccuracy(m),
      stakeAge: this._computeStakeAge(m),
      score: this.getScore(pubkeyHex),
      raw: {
        pings: m.pings,
        pongs: m.pongs,
        latencySamples: m.latencies.length,
        avgLatencyMs: m.latencies.length > 0
          ? Math.round(m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length)
          : null,
        accuracySamples: m.accuracyLog.length,
        stakeAgeDays: m.stakeAgeDays
      }
    }
  }

  /**
   * Get scores for all tracked peers.
   * @returns {Map<string, number>}
   */
  getAllScores () {
    const scores = new Map()
    for (const pubkeyHex of this._peers.keys()) {
      scores.set(pubkeyHex, this.getScore(pubkeyHex))
    }
    return scores
  }

  /**
   * Remove a peer from tracking.
   * @param {string} pubkeyHex
   */
  removePeer (pubkeyHex) {
    this._peers.delete(pubkeyHex)
  }

  /**
   * Emit a score update event.
   * @param {string} pubkeyHex
   */
  _emitUpdate (pubkeyHex) {
    this.emit('score:update', {
      pubkeyHex,
      score: this.getScore(pubkeyHex)
    })
  }
}
