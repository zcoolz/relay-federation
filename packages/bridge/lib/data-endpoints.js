/**
 * Data endpoint handlers for the bridge HTTP API.
 *
 * Extracted from status-server.js to keep endpoint groups manageable.
 * These handlers implement the Doc 06 HTTP contract for data envelope operations.
 *
 * Endpoints:
 *   POST /data         — submit a signed data envelope for relay
 *   GET  /data/topics  — list topics with cached data (summary objects)
 *   GET  /data/:topic  — query cached envelopes with since/limit/hasMore
 *
 * Payment (BRC-105):
 *   Not yet implemented. When added:
 *   - POST /data and GET /data/:topic should support HTTP 402 flow
 *   - Add middleware before these handlers that checks x-bsv-payment header
 *   - Use BRC-103/104 for mutual authentication, BRC-29 for derivation
 *   - GET /pricing endpoint should be added here (Doc 06 contract)
 *   - Bridge-to-bridge payment uses BRC-105 over the status server (port 9333)
 *   - See ARCHITECTURE_LOCK_BRC_GAP_ANALYSIS.md for rationale
 */

/**
 * Handle POST /data — submit a signed data envelope.
 * @param {import('./data-relay.js').DataRelay} dataRelay
 * @param {object} body — parsed JSON request body
 * @param {import('node:http').ServerResponse} res
 */
export function handlePostData (dataRelay, body, res) {
  // TODO(brc-105): insert payment middleware here — 402 if bridge charges for propagation
  if (!body.topic || !body.payload || !body.pubkeyHex ||
      !body.timestamp || !body.ttl || !body.signature) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'missing_fields' }))
    return
  }

  const result = dataRelay.injectEnvelope({
    type: 'data',
    topic: body.topic,
    payload: body.payload,
    pubkeyHex: body.pubkeyHex,
    timestamp: body.timestamp,
    ttl: body.ttl,
    signature: body.signature
  })

  if (result.accepted) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ accepted: true, topic: body.topic }))
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ accepted: false, error: result.error }))
  }
}

/**
 * Handle GET /data/topics — list topics with summary objects.
 * @param {import('./data-relay.js').DataRelay} dataRelay
 * @param {import('node:http').ServerResponse} res
 */
export function handleGetTopics (dataRelay, res) {
  const topics = dataRelay.getTopicSummaries()
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify({ count: topics.length, topics }))
}

/**
 * Handle GET /data/:topic — query envelopes with since, limit, hasMore.
 * @param {import('./data-relay.js').DataRelay} dataRelay
 * @param {string} topic — decoded topic string
 * @param {URLSearchParams} params — query parameters
 * @param {import('node:http').ServerResponse} res
 */
export function handleGetData (dataRelay, topic, params, res) {
  // TODO(brc-105): insert payment middleware here — 402 if bridge charges for queries
  const rawSince = parseInt(params.get('since'), 10)
  const since = Number.isNaN(rawSince) ? 0 : rawSince
  const rawLimit = parseInt(params.get('limit'), 10)
  const limit = Number.isNaN(rawLimit) ? 10 : rawLimit
  const { envelopes, hasMore } = dataRelay.queryEnvelopes(topic, { since, limit })

  if (envelopes.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ topic, count: 0, envelopes: [], hasMore: false }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify({ topic, count: envelopes.length, envelopes, hasMore }))
}
