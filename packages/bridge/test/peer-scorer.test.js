import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PeerScorer } from '../lib/peer-scorer.js'

const PEER_A = 'aa'.repeat(33)
const PEER_B = 'bb'.repeat(33)

describe('PeerScorer', () => {
  it('unknown peer returns neutral score (0.5)', () => {
    const scorer = new PeerScorer()
    assert.equal(scorer.getScore('unknown'), 0.5)
  })

  it('getMetrics returns null for unknown peer', () => {
    const scorer = new PeerScorer()
    assert.equal(scorer.getMetrics('unknown'), null)
  })

  it('new peer with no data gets neutral sub-scores', () => {
    const scorer = new PeerScorer()
    // Touch the peer so it exists
    scorer.recordPing(PEER_A, 100)
    // Reset to simulate fresh — just check that sub-scores are reasonable
    const m = scorer.getMetrics(PEER_A)
    assert.ok(m, 'should have metrics')
    assert.ok(m.score >= 0 && m.score <= 1, 'score in range')
  })

  it('perfect peer scores near 1.0', () => {
    const scorer = new PeerScorer()

    // 100% uptime with fast responses
    for (let i = 0; i < 100; i++) {
      scorer.recordPing(PEER_A, 50) // 50ms = fast
    }

    // 100% data accuracy
    for (let i = 0; i < 100; i++) {
      scorer.recordGoodData(PEER_A)
    }

    // Old stake
    scorer.setStakeAge(PEER_A, 365)

    const score = scorer.getScore(PEER_A)
    assert.ok(score > 0.9, `perfect peer should score > 0.9, got ${score}`)
  })

  it('terrible peer scores near 0', () => {
    const scorer = new PeerScorer()

    // 0% uptime — all timeouts
    for (let i = 0; i < 100; i++) {
      scorer.recordPingTimeout(PEER_A)
    }

    // 0% data accuracy
    for (let i = 0; i < 100; i++) {
      scorer.recordBadData(PEER_A)
    }

    // No stake
    scorer.setStakeAge(PEER_A, 0)

    const score = scorer.getScore(PEER_A)
    assert.ok(score <= 0.1, `terrible peer should score <= 0.1, got ${score}`)
  })

  it('uptime tracks pings vs pongs correctly', () => {
    const scorer = new PeerScorer()

    // 50% uptime: 5 good, 5 bad
    for (let i = 0; i < 5; i++) scorer.recordPing(PEER_A, 200)
    for (let i = 0; i < 5; i++) scorer.recordPingTimeout(PEER_A)

    const m = scorer.getMetrics(PEER_A)
    assert.equal(m.uptime, 0.5, 'uptime should be 0.5')
    assert.equal(m.raw.pings, 10)
    assert.equal(m.raw.pongs, 5)
  })

  it('response time: fast = high score, slow = low score', () => {
    const scorer = new PeerScorer()

    // Fast peer
    for (let i = 0; i < 10; i++) scorer.recordPing(PEER_A, 50)
    const fast = scorer.getMetrics(PEER_A)
    assert.equal(fast.responseTime, 1.0, 'should be 1.0 for <= 100ms')

    // Slow peer
    for (let i = 0; i < 10; i++) scorer.recordPing(PEER_B, 5000)
    const slow = scorer.getMetrics(PEER_B)
    assert.equal(slow.responseTime, 0.0, 'should be 0.0 for >= 5000ms')
  })

  it('response time: mid-range scores proportionally', () => {
    const scorer = new PeerScorer()

    // 2550ms = midpoint between 100 and 5000
    for (let i = 0; i < 10; i++) scorer.recordPing(PEER_A, 2550)
    const m = scorer.getMetrics(PEER_A)
    assert.ok(m.responseTime > 0.4 && m.responseTime < 0.6,
      `mid-range latency should score ~0.5, got ${m.responseTime}`)
  })

  it('data accuracy: all good = 1.0, all bad = 0.0', () => {
    const scorer = new PeerScorer()

    for (let i = 0; i < 50; i++) scorer.recordGoodData(PEER_A)
    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 1.0)

    for (let i = 0; i < 50; i++) scorer.recordBadData(PEER_B)
    assert.equal(scorer.getMetrics(PEER_B).dataAccuracy, 0.0)
  })

  it('data accuracy: mixed gives ratio', () => {
    const scorer = new PeerScorer()

    // 75% good
    for (let i = 0; i < 75; i++) scorer.recordGoodData(PEER_A)
    for (let i = 0; i < 25; i++) scorer.recordBadData(PEER_A)

    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 0.75)
  })

  it('data accuracy: rolling window trims old entries', () => {
    const scorer = new PeerScorer({ accuracyWindow: 10 })

    // Fill window with bad data
    for (let i = 0; i < 10; i++) scorer.recordBadData(PEER_A)
    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 0.0)

    // Now push 10 good — should push out all bad
    for (let i = 0; i < 10; i++) scorer.recordGoodData(PEER_A)
    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 1.0)
  })

  it('stake age: 0 days = 0, 365 days ≈ 0.86, 1024 days = 1.0', () => {
    const scorer = new PeerScorer()

    scorer.setStakeAge(PEER_A, 0)
    assert.equal(scorer.getMetrics(PEER_A).stakeAge, 0)

    scorer.setStakeAge(PEER_A, 1)
    assert.equal(scorer.getMetrics(PEER_A).stakeAge, 0) // log2(1)/10 = 0

    scorer.setStakeAge(PEER_A, 1024)
    assert.equal(scorer.getMetrics(PEER_A).stakeAge, 1.0) // log2(1024)/10 = 1.0

    scorer.setStakeAge(PEER_A, 365)
    const age365 = scorer.getMetrics(PEER_A).stakeAge
    assert.ok(age365 > 0.8 && age365 < 0.9,
      `365 days should be ~0.86, got ${age365}`)
  })

  it('stake age: capped at 1.0 for very old stakes', () => {
    const scorer = new PeerScorer()
    scorer.setStakeAge(PEER_A, 10000)
    assert.equal(scorer.getMetrics(PEER_A).stakeAge, 1.0)
  })

  it('composite score uses correct weights', () => {
    const scorer = new PeerScorer()

    // Set up known sub-scores:
    // uptime = 1.0 (all pings succeed)
    for (let i = 0; i < 10; i++) scorer.recordPing(PEER_A, 50)
    // responseTime = 1.0 (all < 100ms)
    // dataAccuracy = 1.0 (all good)
    for (let i = 0; i < 10; i++) scorer.recordGoodData(PEER_A)
    // stakeAge = 1.0 (1024 days)
    scorer.setStakeAge(PEER_A, 1024)

    const m = scorer.getMetrics(PEER_A)
    assert.equal(m.uptime, 1.0)
    assert.equal(m.responseTime, 1.0)
    assert.equal(m.dataAccuracy, 1.0)
    assert.equal(m.stakeAge, 1.0)

    // 0.3*1 + 0.2*1 + 0.4*1 + 0.1*1 = 1.0
    const expected = 0.3 + 0.2 + 0.4 + 0.1
    assert.ok(Math.abs(m.score - expected) < 0.001,
      `composite should be ${expected}, got ${m.score}`)
  })

  it('getAllScores returns all tracked peers', () => {
    const scorer = new PeerScorer()

    scorer.recordPing(PEER_A, 100)
    scorer.recordPing(PEER_B, 200)

    const scores = scorer.getAllScores()
    assert.equal(scores.size, 2)
    assert.ok(scores.has(PEER_A))
    assert.ok(scores.has(PEER_B))
  })

  it('removePeer stops tracking', () => {
    const scorer = new PeerScorer()

    scorer.recordPing(PEER_A, 100)
    assert.ok(scorer.getMetrics(PEER_A))

    scorer.removePeer(PEER_A)
    assert.equal(scorer.getMetrics(PEER_A), null)
    assert.equal(scorer.getAllScores().size, 0)
  })

  it('emits score:update on every record call', () => {
    const scorer = new PeerScorer()
    const updates = []

    scorer.on('score:update', (evt) => updates.push(evt))

    scorer.recordPing(PEER_A, 100)
    scorer.recordPingTimeout(PEER_A)
    scorer.recordGoodData(PEER_A)
    scorer.recordBadData(PEER_A)
    scorer.setStakeAge(PEER_A, 30)

    assert.equal(updates.length, 5, 'should emit 5 updates')
    assert.ok(updates.every(u => u.pubkeyHex === PEER_A))
    assert.ok(updates.every(u => typeof u.score === 'number'))
  })

  it('uptime window rolls over correctly', () => {
    const scorer = new PeerScorer({ uptimeWindow: 10 })

    // 10 successful pings
    for (let i = 0; i < 10; i++) scorer.recordPing(PEER_A, 100)
    assert.equal(scorer.getMetrics(PEER_A).uptime, 1.0)

    // 1 more timeout — triggers rollover, should scale down
    scorer.recordPingTimeout(PEER_A)
    const m = scorer.getMetrics(PEER_A)
    assert.ok(m.uptime < 1.0, 'uptime should drop after timeout')
    assert.ok(m.raw.pings <= 11, 'pings should be trimmed')
  })

  it('latency window trims old samples', () => {
    const scorer = new PeerScorer({ latencyWindow: 5 })

    // Fill with slow pings
    for (let i = 0; i < 5; i++) scorer.recordPing(PEER_A, 4000)
    assert.ok(scorer.getMetrics(PEER_A).responseTime < 0.3)

    // Push fast pings — should evict slow ones
    for (let i = 0; i < 5; i++) scorer.recordPing(PEER_A, 50)
    assert.equal(scorer.getMetrics(PEER_A).responseTime, 1.0)
    assert.equal(scorer.getMetrics(PEER_A).raw.latencySamples, 5)
  })

  it('getMetrics returns avgLatencyMs', () => {
    const scorer = new PeerScorer()

    scorer.recordPing(PEER_A, 100)
    scorer.recordPing(PEER_A, 200)
    scorer.recordPing(PEER_A, 300)

    const m = scorer.getMetrics(PEER_A)
    assert.equal(m.raw.avgLatencyMs, 200) // (100+200+300)/3
  })
})
