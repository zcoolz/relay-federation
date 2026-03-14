import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { verifyHash } from '@relay-federation/common/crypto'

/**
 * DataRelay — relays ephemeral signed data envelopes between peers.
 *
 * Handles four message types:
 *   data           — signed envelope broadcast (gossip push)
 *   topics         — peer interest declaration (gossip announce)
 *   data_request   — pull-based catch-up query (local cache only)
 *   data_response  — response to data_request
 *
 * Events:
 *   'data:new' — { topic, payload, pubkeyHex, timestamp, ttl } — new valid envelope received
 */
export class DataRelay extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} [opts]
   * @param {number} [opts.maxEnvelopesPerTopic=100] — Ring buffer size per topic
   * @param {number} [opts.maxPayloadBytes=4096] — Max payload size in bytes
   * @param {number} [opts.maxTtl=3600] — Max TTL in seconds
   * @param {number} [opts.maxFutureSecs=30] — Max seconds a timestamp can be in the future
   * @param {number} [opts.maxSeenSize=10000] — Max entries in dedup set before FIFO eviction
   */
  constructor (peerManager, opts = {}) {
    super()
    this.peerManager = peerManager
    this._maxPerTopic = opts.maxEnvelopesPerTopic || 100
    this._maxPayloadBytes = opts.maxPayloadBytes || 4096
    this._maxTtl = opts.maxTtl || 3600
    this._maxFutureSecs = opts.maxFutureSecs || 30
    this._maxSeenSize = opts.maxSeenSize || 10000

    /** @type {Map<string, object[]>} topic → envelope ring buffer */
    this._topicBuffers = new Map()

    /** @type {Map<string, number>} hash → insertion order for bounded FIFO dedup */
    this._seen = new Map()
    this._seenCounter = 0

    /** @type {Map<string, string[]>} peerPubkeyHex → interest prefixes */
    this._peerInterests = new Map()

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._handleMessage(pubkeyHex, message)
    })
  }

  /**
   * Get cached envelopes for a topic (all live envelopes, no filtering).
   * @param {string} topic
   * @returns {object[]}
   */
  getEnvelopes (topic) {
    this._pruneExpired(topic)
    return this._topicBuffers.get(topic) || []
  }

  /**
   * Query envelopes with filtering and pagination.
   * @param {string} topic
   * @param {object} [opts]
   * @param {number} [opts.since=0] — return envelopes newer than this Unix timestamp
   * @param {number} [opts.limit=10] — max envelopes to return (capped at 100)
   * @returns {{ envelopes: object[], hasMore: boolean }}
   */
  queryEnvelopes (topic, opts = {}) {
    const since = opts.since || 0
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
    const all = this.getEnvelopes(topic)
    const filtered = since > 0 ? all.filter(e => e.timestamp > since) : all
    return {
      envelopes: filtered.slice(0, limit),
      hasMore: filtered.length > limit
    }
  }

  /**
   * Get topic summaries with count and latest timestamp.
   * @returns {{ topic: string, count: number, latestTimestamp: number }[]}
   */
  getTopicSummaries () {
    const now = Math.floor(Date.now() / 1000)
    const summaries = []
    for (const [topic, buffer] of this._topicBuffers) {
      const live = buffer.filter(e => e.timestamp + e.ttl >= now)
      if (live.length > 0) {
        summaries.push({
          topic,
          count: live.length,
          latestTimestamp: Math.max(...live.map(e => e.timestamp))
        })
      }
    }
    return summaries
  }

  /**
   * Get all topics that have cached data.
   * @returns {string[]}
   */
  getTopics () {
    return this.getTopicSummaries().map(s => s.topic)
  }

  /**
   * Inject an envelope from the local HTTP API (for app submission).
   * @param {object} envelope — full data envelope object
   * @returns {{ accepted: boolean, error?: string }}
   */
  injectEnvelope (envelope) {
    const result = this._validateAndStore(envelope)
    if (result.accepted) {
      this._forward(null, envelope)
    }
    return result
  }

  /** @private */
  _handleMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'data':
        this._onData(pubkeyHex, message)
        break
      case 'topics':
        this._onTopics(pubkeyHex, message)
        break
      case 'data_request':
        this._onDataRequest(pubkeyHex, message)
        break
      case 'data_response':
        this._onDataResponse(pubkeyHex, message)
        break
    }
  }

  /**
   * Validate an envelope (field presence, size, TTL, freshness, dedup, signature).
   * If valid, marks as seen and stores. Does NOT forward.
   * @private
   * @param {object} msg
   * @returns {{ accepted: boolean, error?: string }}
   */
  _validateAndStore (msg) {
    if (!msg.topic || !msg.payload || !msg.pubkeyHex ||
        !msg.timestamp || !msg.ttl || !msg.signature) {
      return { accepted: false, error: 'missing_fields' }
    }
    if (Buffer.byteLength(msg.payload, 'utf8') > this._maxPayloadBytes) {
      return { accepted: false, error: 'payload_too_large' }
    }
    if (msg.ttl > this._maxTtl) {
      return { accepted: false, error: 'ttl_too_large' }
    }
    const now = Math.floor(Date.now() / 1000)
    if (msg.timestamp > now + this._maxFutureSecs) {
      return { accepted: false, error: 'timestamp_future' }
    }
    if (msg.timestamp + msg.ttl < now) {
      return { accepted: false, error: 'expired_ttl' }
    }
    const dedupKey = this._envelopeHash(msg)
    if (this._seen.has(dedupKey)) {
      return { accepted: false, error: 'duplicate' }
    }
    if (!this._verifyEnvelope(msg)) {
      return { accepted: false, error: 'invalid_signature' }
    }

    this._addSeen(dedupKey)
    this._store(msg)
    this.emit('data:new', {
      topic: msg.topic,
      payload: msg.payload,
      pubkeyHex: msg.pubkeyHex,
      timestamp: msg.timestamp,
      ttl: msg.ttl
    })

    return { accepted: true }
  }

  /**
   * Process an incoming data envelope (gossip push).
   * Validates, stores, and forwards to interested peers.
   * @private
   * @param {string|null} sourcePubkey — peer that sent it (null = local injection)
   * @param {object} msg
   * @returns {boolean} true if accepted
   */
  _onData (sourcePubkey, msg) {
    const result = this._validateAndStore(msg)
    if (!result.accepted) return false

    this._forward(sourcePubkey, msg)
    return true
  }

  /**
   * Process a topics declaration from a peer.
   * @private
   */
  _onTopics (pubkeyHex, msg) {
    if (!Array.isArray(msg.interests) || !msg.pubkeyHex ||
        !msg.timestamp || !msg.signature) {
      return
    }

    // Verify signature
    const preimage = `${msg.interests.join(',')}${msg.timestamp}`
    const dataHex = Buffer.from(preimage, 'utf8').toString('hex')
    try {
      if (!verifyHash(dataHex, msg.signature, msg.pubkeyHex)) return
    } catch {
      return
    }

    this._peerInterests.set(pubkeyHex, msg.interests)
  }

  /**
   * Respond to a data_request with local cached envelopes.
   * @private
   */
  _onDataRequest (pubkeyHex, msg) {
    if (!msg.topic) return

    const since = msg.since || 0
    const limit = Math.min(Math.max(msg.limit ?? 10, 1), 100)

    this._pruneExpired(msg.topic)
    const buffer = this._topicBuffers.get(msg.topic) || []
    const filtered = buffer.filter(e => e.timestamp > since)
    const envelopes = filtered.slice(0, limit)

    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({
        type: 'data_response',
        topic: msg.topic,
        envelopes,
        hasMore: filtered.length > limit
      })
    }
  }

  /**
   * Request catch-up data from a peer.
   * @param {string} peerPubkey — peer to query
   * @param {string} topic — topic to catch up on
   * @param {number} [since=0] — Unix timestamp, return envelopes newer than this
   * @param {number} [limit=10]
   */
  requestData (peerPubkey, topic, since = 0, limit = 10) {
    const conn = this.peerManager.peers.get(peerPubkey)
    if (conn) {
      conn.send({ type: 'data_request', topic, since, limit })
    }
  }

  /**
   * Process an incoming data_response — ingest valid envelopes from catch-up.
   * @private
   */
  _onDataResponse (pubkeyHex, msg) {
    if (!msg.topic || !Array.isArray(msg.envelopes)) return
    let ingested = 0
    for (const envelope of msg.envelopes) {
      // Validate and store only — do NOT forward (catch-up is point-to-point)
      const result = this._validateAndStore({ ...envelope, type: 'data' })
      if (result.accepted) {
        ingested++
      }
    }
    if (ingested > 0) {
      this.emit('data:catchup', { topic: msg.topic, count: ingested, from: pubkeyHex })
    }
  }

  /**
   * Remove expired envelopes from a topic buffer.
   * @private
   */
  _pruneExpired (topic) {
    const buffer = this._topicBuffers.get(topic)
    if (!buffer) return
    const now = Math.floor(Date.now() / 1000)
    const live = buffer.filter(e => e.timestamp + e.ttl >= now)
    if (live.length === 0) {
      this._topicBuffers.delete(topic)
    } else if (live.length < buffer.length) {
      this._topicBuffers.set(topic, live)
    }
  }

  /**
   * Add a hash to the bounded dedup set with FIFO eviction.
   * @private
   */
  _addSeen (hash) {
    this._seen.set(hash, this._seenCounter++)
    if (this._seen.size > this._maxSeenSize) {
      // Evict the oldest entry (first key in insertion-order Map)
      const oldest = this._seen.keys().next().value
      this._seen.delete(oldest)
    }
  }

  /**
   * Forward an envelope to all peers with matching interest, except source.
   * @private
   */
  _forward (sourcePubkey, msg) {
    for (const [peerPub, conn] of this.peerManager.peers) {
      if (peerPub === sourcePubkey) continue
      if (!this._peerMatchesTopic(peerPub, msg.topic)) continue
      conn.send(msg)
    }
  }

  /**
   * Check if a peer has declared interest in a topic.
   * @private
   */
  _peerMatchesTopic (peerPub, topic) {
    const interests = this._peerInterests.get(peerPub)
    if (!interests) return false
    for (const prefix of interests) {
      if (prefix === '*') return true
      if (topic.startsWith(prefix)) return true
    }
    return false
  }

  /**
   * Store an envelope in the per-topic ring buffer.
   * @private
   */
  _store (envelope) {
    let buffer = this._topicBuffers.get(envelope.topic)
    if (!buffer) {
      buffer = []
      this._topicBuffers.set(envelope.topic, buffer)
    }
    buffer.push(envelope)
    while (buffer.length > this._maxPerTopic) {
      buffer.shift()
    }
  }

  /**
   * Verify the ECDSA signature on a data envelope.
   * @private
   */
  _verifyEnvelope (msg) {
    const preimage = `${msg.topic}${msg.payload}${msg.timestamp}${msg.ttl}`
    const dataHex = Buffer.from(preimage, 'utf8').toString('hex')
    try {
      return verifyHash(dataHex, msg.signature, msg.pubkeyHex)
    } catch {
      return false
    }
  }

  /**
   * Compute a dedup hash for an envelope.
   * @private
   */
  _envelopeHash (msg) {
    const input = `${msg.pubkeyHex}:${msg.topic}:${msg.payload}:${msg.timestamp}`
    return createHash('sha256').update(input).digest('hex')
  }
}
