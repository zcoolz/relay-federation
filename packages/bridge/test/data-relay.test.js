import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PrivateKey } from '@bsv/sdk'
import { signHash } from '@relay-federation/common/crypto'
import { DataRelay } from '../lib/data-relay.js'

// --- helpers ---

function fakePeerManager () {
  const pm = new EventEmitter()
  pm.peers = new Map()
  pm.broadcast = function (msg, excludePubkey) {
    let sent = 0
    for (const [pk, conn] of this.peers) {
      if (pk === excludePubkey) continue
      conn._sent.push(msg)
      sent++
    }
    return sent
  }
  return pm
}

function fakeConn (pubkeyHex) {
  const conn = { pubkeyHex, _sent: [], connected: true }
  conn.send = (msg) => { conn._sent.push(msg); return true }
  return conn
}

function buildEnvelope (privKey, pubkeyHex, opts = {}) {
  const topic = opts.topic || 'oracle:rates:bsv'
  const payload = opts.payload || '{"USD":42.50}'
  const timestamp = opts.timestamp || Math.floor(Date.now() / 1000)
  const ttl = opts.ttl || 300
  const preimage = `${topic}${payload}${timestamp}${ttl}`
  const dataHex = Buffer.from(preimage, 'utf8').toString('hex')
  const signature = signHash(dataHex, privKey)
  return { type: 'data', topic, payload, pubkeyHex, timestamp, ttl, signature }
}

function buildTopics (privKey, pubkeyHex, interests) {
  const timestamp = Math.floor(Date.now() / 1000)
  const preimage = `${interests.join(',')}${timestamp}`
  const dataHex = Buffer.from(preimage, 'utf8').toString('hex')
  const signature = signHash(dataHex, privKey)
  return { type: 'topics', interests, pubkeyHex, timestamp, signature }
}

function waitFor (emitter, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms)
    emitter.once(event, (data) => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

describe('DataRelay', () => {
  let relay, pm

  afterEach(() => {
    if (relay) relay.removeAllListeners()
  })

  // --- Envelope acceptance & storage ---

  it('accepts valid envelope and stores it', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub)

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 1)
    assert.equal(cached[0].payload, '{"USD":42.50}')
    assert.equal(cached[0].pubkeyHex, pub)
  })

  it('emits data:new on valid envelope', async () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub)

    const p = waitFor(relay, 'data:new')
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })
    const received = await p
    assert.equal(received.topic, 'oracle:rates:bsv')
  })

  // --- Signature rejection ---

  it('rejects envelope with invalid signature', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub)
    env.signature = 'deadbeef' // corrupt

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0)
  })

  // --- TTL rejection ---

  it('rejects envelope with expired TTL', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    // timestamp 1 hour ago, TTL 60s → expired 59 minutes ago
    const env = buildEnvelope(priv, pub, {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      ttl: 60
    })

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0)
  })

  it('rejects envelope with timestamp too far in the future', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub, {
      timestamp: Math.floor(Date.now() / 1000) + 120 // 2 min in future
    })

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0)
  })

  // --- Deduplication ---

  it('suppresses duplicate envelopes', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub)

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })
    pm.emit('peer:message', { pubkeyHex: 'peerB', message: { ...env } })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 1, 'duplicate should be suppressed')
  })

  // --- Topic interest filtering ---

  it('does not forward envelope to peer without matching interest', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()

    // Peer B has interest in attestation:*, not oracle:*
    const peerPriv = PrivateKey.fromRandom()
    const peerPub = peerPriv.toPublicKey().toString()
    const topicsMsg = buildTopics(peerPriv, peerPub, ['attestation:'])
    pm.emit('peer:message', { pubkeyHex: peerPub, message: topicsMsg })

    // Add peer B as a connected peer
    const connB = fakeConn(peerPub)
    pm.peers.set(peerPub, connB)

    // Send an oracle envelope from peer A
    const env = buildEnvelope(priv, pub, { topic: 'oracle:rates:bsv' })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    // Peer B should NOT have received a forwarded message
    const forwarded = connB._sent.filter(m => m.type === 'data')
    assert.equal(forwarded.length, 0, 'should not forward to uninterested peer')
  })

  it('forwards envelope to peer with matching interest prefix', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()

    // Peer B declares interest in oracle:
    const peerPriv = PrivateKey.fromRandom()
    const peerPub = peerPriv.toPublicKey().toString()
    const topicsMsg = buildTopics(peerPriv, peerPub, ['oracle:'])
    pm.emit('peer:message', { pubkeyHex: peerPub, message: topicsMsg })

    // Add peer B as a connected peer
    const connB = fakeConn(peerPub)
    pm.peers.set(peerPub, connB)

    // Send oracle envelope from peer A (different from peerB)
    const env = buildEnvelope(priv, pub, { topic: 'oracle:rates:bsv' })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const forwarded = connB._sent.filter(m => m.type === 'data')
    assert.equal(forwarded.length, 1, 'should forward to interested peer')
  })

  it('wildcard interest * matches all topics', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()

    // Peer declares wildcard interest
    const peerPriv = PrivateKey.fromRandom()
    const peerPub = peerPriv.toPublicKey().toString()
    const topicsMsg = buildTopics(peerPriv, peerPub, ['*'])
    pm.emit('peer:message', { pubkeyHex: peerPub, message: topicsMsg })

    const connB = fakeConn(peerPub)
    pm.peers.set(peerPub, connB)

    const env = buildEnvelope(priv, pub, { topic: 'anything:goes:here' })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const forwarded = connB._sent.filter(m => m.type === 'data')
    assert.equal(forwarded.length, 1, 'wildcard should match any topic')
  })

  // --- data_request / data_response ---

  it('data_request returns cached envelopes for topic', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()

    // Insert two envelopes
    const env1 = buildEnvelope(priv, pub, { payload: '{"USD":42}', timestamp: Math.floor(Date.now() / 1000) - 10 })
    const env2 = buildEnvelope(priv, pub, { payload: '{"USD":43}', timestamp: Math.floor(Date.now() / 1000) })

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env1 })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env2 })

    // Peer B requests data
    const connB = fakeConn('peerB')
    pm.peers.set('peerB', connB)

    pm.emit('peer:message', {
      pubkeyHex: 'peerB',
      message: { type: 'data_request', topic: 'oracle:rates:bsv', since: 0, limit: 10 }
    })

    const responses = connB._sent.filter(m => m.type === 'data_response')
    assert.equal(responses.length, 1)
    assert.equal(responses[0].topic, 'oracle:rates:bsv')
    assert.equal(responses[0].envelopes.length, 2)
  })

  it('data_request respects since filter', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const now = Math.floor(Date.now() / 1000)

    const env1 = buildEnvelope(priv, pub, { payload: '{"USD":42}', timestamp: now - 60 })
    const env2 = buildEnvelope(priv, pub, { payload: '{"USD":43}', timestamp: now })

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env1 })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env2 })

    const connB = fakeConn('peerB')
    pm.peers.set('peerB', connB)

    pm.emit('peer:message', {
      pubkeyHex: 'peerB',
      message: { type: 'data_request', topic: 'oracle:rates:bsv', since: now - 30, limit: 10 }
    })

    const responses = connB._sent.filter(m => m.type === 'data_response')
    assert.equal(responses[0].envelopes.length, 1, 'should only return envelopes after since')
    assert.equal(responses[0].envelopes[0].payload, '{"USD":43}')
  })

  it('data_request returns empty for unknown topic', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const connB = fakeConn('peerB')
    pm.peers.set('peerB', connB)

    pm.emit('peer:message', {
      pubkeyHex: 'peerB',
      message: { type: 'data_request', topic: 'nonexistent:topic', since: 0, limit: 10 }
    })

    const responses = connB._sent.filter(m => m.type === 'data_response')
    assert.equal(responses.length, 1)
    assert.equal(responses[0].envelopes.length, 0)
    assert.equal(responses[0].hasMore, false)
  })

  // --- Ring buffer eviction ---

  it('evicts oldest entries when ring buffer is full', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm, { maxEnvelopesPerTopic: 3 })

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const now = Math.floor(Date.now() / 1000)

    for (let i = 0; i < 5; i++) {
      const env = buildEnvelope(priv, pub, {
        payload: `{"i":${i}}`,
        timestamp: now + i // distinct timestamps to avoid dedup
      })
      pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })
    }

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 3, 'should keep only 3 envelopes')
    // oldest two (i=0, i=1) should be evicted
    assert.equal(cached[0].payload, '{"i":2}')
    assert.equal(cached[2].payload, '{"i":4}')
  })

  // --- Payload size guard ---

  it('rejects envelope with payload exceeding max size', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const bigPayload = 'x'.repeat(5000) // > 4096 bytes
    const env = buildEnvelope(priv, pub, { payload: bigPayload })

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0, 'oversized payload should be rejected')
  })

  // --- TTL cap ---

  it('rejects envelope with TTL exceeding max', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub, { ttl: 7200 }) // 2 hours > 3600 max

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0, 'TTL exceeding max should be rejected')
  })

  // --- Does not forward back to source ---

  it('does not forward envelope back to source peer', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()

    // Source peer declares wildcard interest
    const connA = fakeConn('peerA')
    pm.peers.set('peerA', connA)
    const peerPriv = PrivateKey.fromRandom()
    const peerPub = peerPriv.toPublicKey().toString()
    // Give peerA wildcard interest under its own key
    relay._peerInterests.set('peerA', ['*'])

    const env = buildEnvelope(priv, pub)
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })

    const forwarded = connA._sent.filter(m => m.type === 'data')
    assert.equal(forwarded.length, 0, 'should not forward back to source')
  })

  // --- getTopics helper ---

  it('getTopics returns all topics with cached data', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()

    const env1 = buildEnvelope(priv, pub, { topic: 'oracle:rates:bsv' })
    const env2 = buildEnvelope(priv, pub, { topic: 'attestation:test' })

    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env1 })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env2 })

    const topics = relay.getTopics()
    assert.ok(topics.includes('oracle:rates:bsv'))
    assert.ok(topics.includes('attestation:test'))
  })

  // --- queryEnvelopes ---

  it('queryEnvelopes clamps non-positive limit to 1', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const now = Math.floor(Date.now() / 1000)

    const env1 = buildEnvelope(priv, pub, { payload: '{"a":1}', timestamp: now - 1 })
    const env2 = buildEnvelope(priv, pub, { payload: '{"a":2}', timestamp: now })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env1 })
    pm.emit('peer:message', { pubkeyHex: 'peerA', message: env2 })

    const result = relay.queryEnvelopes('oracle:rates:bsv', { limit: -1 })
    assert.equal(result.envelopes.length, 1, 'negative limit should be clamped to 1')
    assert.equal(result.hasMore, true, 'should signal more envelopes exist')

    const result0 = relay.queryEnvelopes('oracle:rates:bsv', { limit: 0 })
    assert.equal(result0.envelopes.length, 1, 'zero limit should be clamped to 1')
  })

  // --- TTL pruning on read ---

  it('getEnvelopes prunes expired entries', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()

    // Insert an envelope with TTL=1 and timestamp 10 seconds ago → already expired
    const env = buildEnvelope(priv, pub, {
      timestamp: Math.floor(Date.now() / 1000) - 10,
      ttl: 1
    })
    // Bypass normal validation to force it into the buffer
    relay._topicBuffers.set('oracle:rates:bsv', [env])

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0, 'expired envelope should be pruned on read')
  })

  it('data_request prunes expired entries before responding', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const now = Math.floor(Date.now() / 1000)

    // One expired, one live
    const expired = buildEnvelope(priv, pub, { payload: '{"old":true}', timestamp: now - 120, ttl: 60 })
    const live = buildEnvelope(priv, pub, { payload: '{"new":true}', timestamp: now, ttl: 300 })
    relay._topicBuffers.set('oracle:rates:bsv', [expired, live])

    const connB = fakeConn('peerB')
    pm.peers.set('peerB', connB)

    pm.emit('peer:message', {
      pubkeyHex: 'peerB',
      message: { type: 'data_request', topic: 'oracle:rates:bsv', since: 0, limit: 10 }
    })

    const responses = connB._sent.filter(m => m.type === 'data_response')
    assert.equal(responses[0].envelopes.length, 1, 'should only return live envelope')
    assert.equal(responses[0].envelopes[0].payload, '{"new":true}')
  })

  it('getTopics excludes topics with only expired envelopes', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const now = Math.floor(Date.now() / 1000)

    // Expired topic
    const expired = buildEnvelope(priv, pub, { topic: 'stale:topic', timestamp: now - 120, ttl: 60 })
    relay._topicBuffers.set('stale:topic', [expired])

    // Live topic
    const live = buildEnvelope(priv, pub, { topic: 'live:topic', timestamp: now, ttl: 300 })
    relay._topicBuffers.set('live:topic', [live])

    const topics = relay.getTopics()
    assert.ok(!topics.includes('stale:topic'), 'expired-only topic should not appear')
    assert.ok(topics.includes('live:topic'), 'live topic should appear')
  })

  // --- Bounded dedup eviction ---

  it('evicts oldest dedup entries when max size exceeded', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm, { maxSeenSize: 5 })

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const now = Math.floor(Date.now() / 1000)

    // Insert 7 distinct envelopes
    for (let i = 0; i < 7; i++) {
      const env = buildEnvelope(priv, pub, { payload: `{"i":${i}}`, timestamp: now + i })
      pm.emit('peer:message', { pubkeyHex: 'peerA', message: env })
    }

    // Dedup set should be bounded to 5
    assert.ok(relay._seen.size <= 5, `dedup set should be bounded (got ${relay._seen.size})`)

    // The first envelope (i=0) should have been evicted from dedup,
    // so re-submitting it should be accepted again (as a new envelope)
    // but it will be a dedup miss → re-verify and re-store
    const resubmit = buildEnvelope(priv, pub, { payload: '{"i":0}', timestamp: now })
    // It's already in the ring buffer, but dedup hash was evicted
    // The ring buffer may already have it, but the point is _seen doesn't block it
    assert.equal(relay._seen.has(relay._envelopeHash(resubmit)), false,
      'oldest dedup entry should have been evicted')
  })

  // --- data_response ingestion ---

  it('ingests valid envelopes from data_response', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const now = Math.floor(Date.now() / 1000)

    const env1 = buildEnvelope(priv, pub, { payload: '{"USD":42}', timestamp: now - 5 })
    const env2 = buildEnvelope(priv, pub, { payload: '{"USD":43}', timestamp: now })

    // Simulate receiving a data_response from a peer
    pm.emit('peer:message', {
      pubkeyHex: 'peerA',
      message: {
        type: 'data_response',
        topic: 'oracle:rates:bsv',
        envelopes: [env1, env2],
        hasMore: false
      }
    })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 2, 'should ingest envelopes from data_response')
  })

  it('emits data:catchup after ingesting data_response envelopes', async () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub)

    const p = waitFor(relay, 'data:catchup')
    pm.emit('peer:message', {
      pubkeyHex: 'peerA',
      message: {
        type: 'data_response',
        topic: 'oracle:rates:bsv',
        envelopes: [env],
        hasMore: false
      }
    })

    const result = await p
    assert.equal(result.topic, 'oracle:rates:bsv')
    assert.equal(result.count, 1)
    assert.equal(result.from, 'peerA')
  })

  it('data_response rejects envelopes with bad signatures', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub)
    env.signature = 'badbad' // corrupt

    pm.emit('peer:message', {
      pubkeyHex: 'peerA',
      message: {
        type: 'data_response',
        topic: 'oracle:rates:bsv',
        envelopes: [env],
        hasMore: false
      }
    })

    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0, 'bad sig in data_response should be rejected')
  })

  it('data_response ingestion does not re-gossip to other peers', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    const env = buildEnvelope(priv, pub)

    // Peer C has wildcard interest — should catch any gossip
    const connC = fakeConn('peerC')
    pm.peers.set('peerC', connC)
    relay._peerInterests.set('peerC', ['*'])

    // Peer A sends a data_response (catch-up, not gossip)
    pm.emit('peer:message', {
      pubkeyHex: 'peerA',
      message: {
        type: 'data_response',
        topic: 'oracle:rates:bsv',
        envelopes: [env],
        hasMore: false
      }
    })

    // Envelope should be stored locally
    const cached = relay.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 1, 'should store the envelope')

    // But peer C should NOT have received any forwarded data
    const forwarded = connC._sent.filter(m => m.type === 'data')
    assert.equal(forwarded.length, 0, 'catch-up must not re-gossip')
  })

  // --- requestData helper ---

  it('requestData sends data_request to peer', () => {
    pm = fakePeerManager()
    relay = new DataRelay(pm)

    const connA = fakeConn('peerA')
    pm.peers.set('peerA', connA)

    relay.requestData('peerA', 'oracle:rates:bsv', 1000, 5)

    const requests = connA._sent.filter(m => m.type === 'data_request')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].topic, 'oracle:rates:bsv')
    assert.equal(requests[0].since, 1000)
    assert.equal(requests[0].limit, 5)
  })
})
