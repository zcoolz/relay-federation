import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PeerScorer } from '../lib/peer-scorer.js'
import { ScoreActions } from '../lib/score-actions.js'

const PEER_A = 'aa'.repeat(33)
const PEER_B = 'bb'.repeat(33)

/**
 * Minimal PeerManager mock — just needs disconnectPeer.
 */
function createMockPeerManager () {
  const pm = new EventEmitter()
  pm.disconnected = []
  pm.disconnectPeer = (pubkeyHex) => {
    pm.disconnected.push(pubkeyHex)
  }
  return pm
}

/**
 * Drive a peer's score below a threshold by recording bad data.
 */
function driveScoreBelow (scorer, pubkeyHex, target) {
  // All timeouts (uptime = 0) + all bad data (accuracy = 0) + no stake (0)
  // Score = 0.3*0 + 0.2*0.5 + 0.4*0 + 0.1*0 = 0.1
  // To get below 0.1 we need response_time to also be 0
  // Record some very slow pings to drive response_time down
  for (let i = 0; i < 50; i++) scorer.recordPingTimeout(pubkeyHex)
  for (let i = 0; i < 50; i++) scorer.recordBadData(pubkeyHex)
  if (target < 0.1) {
    // Add slow pings to drive response_time to 0
    for (let i = 0; i < 50; i++) scorer.recordPing(pubkeyHex, 6000)
  }
}

describe('ScoreActions', () => {
  it('does not disconnect peer above threshold', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)

    // Good peer — all pings succeed, fast, good data
    for (let i = 0; i < 10; i++) scorer.recordPing(PEER_A, 50)
    for (let i = 0; i < 10; i++) scorer.recordGoodData(PEER_A)

    assert.equal(pm.disconnected.length, 0, 'should not disconnect good peer')
  })

  it('disconnects peer when score drops below 0.3', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)
    const events = []
    actions.on('peer:disconnected', (e) => events.push(e))

    // Drive score below 0.3: all timeouts + all bad data
    driveScoreBelow(scorer, PEER_A, 0.3)

    assert.ok(pm.disconnected.includes(PEER_A), 'should disconnect low-scoring peer')
    assert.ok(events.length > 0, 'should emit peer:disconnected')
    assert.equal(events[0].pubkeyHex, PEER_A)
    assert.equal(events[0].reason, 'low_score')
  })

  it('blacklists peer when score drops below 0.1', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)
    const events = []
    actions.on('peer:blacklisted', (e) => events.push(e))

    // Drive score below 0.1
    driveScoreBelow(scorer, PEER_A, 0.05)

    assert.ok(pm.disconnected.includes(PEER_A), 'should disconnect blacklisted peer')
    assert.ok(events.length > 0, 'should emit peer:blacklisted')
    assert.equal(events[0].pubkeyHex, PEER_A)
    assert.ok(events[0].expiresAt > Date.now(), 'expiry should be in the future')
    assert.ok(actions.isBlacklisted(PEER_A), 'peer should be blacklisted')
  })

  it('isBlacklisted returns false for non-blacklisted peer', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)

    assert.equal(actions.isBlacklisted(PEER_A), false)
  })

  it('blacklist expires after duration', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    // Use 1ms blacklist duration for testing
    const actions = new ScoreActions(scorer, pm, { blacklistDurationMs: 1 })

    // Blacklist the peer
    driveScoreBelow(scorer, PEER_A, 0.05)
    assert.ok(actions.isBlacklisted(PEER_A), 'should be blacklisted initially')

    // Wait for expiry
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait 5ms */ }

    assert.equal(actions.isBlacklisted(PEER_A), false, 'should expire after duration')
  })

  it('getBlacklistExpiry returns timestamp for blacklisted peer', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)

    driveScoreBelow(scorer, PEER_A, 0.05)

    const expiry = actions.getBlacklistExpiry(PEER_A)
    assert.ok(expiry !== null, 'should have an expiry')
    assert.ok(expiry > Date.now(), 'expiry should be in the future')
  })

  it('getBlacklistExpiry returns null for non-blacklisted peer', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)

    assert.equal(actions.getBlacklistExpiry(PEER_A), null)
  })

  it('unblacklist removes peer from blacklist', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)

    driveScoreBelow(scorer, PEER_A, 0.05)
    assert.ok(actions.isBlacklisted(PEER_A))

    actions.unblacklist(PEER_A)
    assert.equal(actions.isBlacklisted(PEER_A), false)
  })

  it('getBlacklist returns all blacklisted peers', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)

    driveScoreBelow(scorer, PEER_A, 0.05)
    driveScoreBelow(scorer, PEER_B, 0.05)

    const blacklist = actions.getBlacklist()
    assert.equal(blacklist.size, 2)
    assert.ok(blacklist.has(PEER_A))
    assert.ok(blacklist.has(PEER_B))
  })

  it('custom thresholds are respected', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm, {
      disconnectThreshold: 0.5,
      blacklistThreshold: 0.2
    })

    // Peer with score ~0.4 (below custom 0.5 threshold)
    for (let i = 0; i < 20; i++) scorer.recordPingTimeout(PEER_A)
    for (let i = 0; i < 10; i++) scorer.recordGoodData(PEER_A)
    for (let i = 0; i < 10; i++) scorer.recordBadData(PEER_A)

    const score = scorer.getScore(PEER_A)
    if (score < 0.5) {
      assert.ok(pm.disconnected.includes(PEER_A),
        `peer with score ${score} should be disconnected at threshold 0.5`)
    }
  })

  it('only affects the specific peer, not others', () => {
    const scorer = new PeerScorer()
    const pm = createMockPeerManager()
    const actions = new ScoreActions(scorer, pm)

    // PEER_A is bad
    driveScoreBelow(scorer, PEER_A, 0.3)

    // PEER_B is good
    for (let i = 0; i < 10; i++) scorer.recordPing(PEER_B, 50)
    for (let i = 0; i < 10; i++) scorer.recordGoodData(PEER_B)

    assert.ok(pm.disconnected.includes(PEER_A), 'bad peer should be disconnected')
    assert.ok(!pm.disconnected.includes(PEER_B), 'good peer should not be disconnected')
  })
})
