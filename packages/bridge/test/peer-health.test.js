import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PeerHealth } from '../lib/peer-health.js'

const PEER_A = 'aa'.repeat(33)
const PEER_B = 'bb'.repeat(33)

describe('PeerHealth', () => {
  it('unknown peer returns status "unknown"', () => {
    const health = new PeerHealth()
    assert.equal(health.getStatus(PEER_A), 'unknown')
  })

  it('recordSeen sets status to online', () => {
    const health = new PeerHealth()
    health.recordSeen(PEER_A)
    assert.equal(health.getStatus(PEER_A), 'online')
  })

  it('recordOffline starts offline tracking', () => {
    const health = new PeerHealth()
    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)
    // Just went offline — within grace period
    assert.equal(health.getStatus(PEER_A), 'grace')
  })

  it('grace period: within 24h = grace', () => {
    const health = new PeerHealth({ gracePeriodMs: 100 })
    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)
    // Immediately after — still within grace
    assert.equal(health.getStatus(PEER_A), 'grace')
  })

  it('after grace period: status becomes offline', () => {
    // Use tiny grace period for testing
    const health = new PeerHealth({ gracePeriodMs: 1, inactiveThresholdMs: 1000 })
    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)

    // Wait for grace to expire
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }

    assert.equal(health.getStatus(PEER_A), 'offline')
  })

  it('after inactive threshold: status becomes inactive', () => {
    const health = new PeerHealth({ gracePeriodMs: 1, inactiveThresholdMs: 1 })
    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)

    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }

    assert.equal(health.getStatus(PEER_A), 'inactive')
  })

  it('recordSeen after offline resets to online', () => {
    const health = new PeerHealth()
    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)
    assert.equal(health.getStatus(PEER_A), 'grace')

    health.recordSeen(PEER_A)
    assert.equal(health.getStatus(PEER_A), 'online')
  })

  it('emits peer:recovered when offline peer comes back', () => {
    const health = new PeerHealth()
    const events = []
    health.on('peer:recovered', (e) => events.push(e))

    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)
    health.recordSeen(PEER_A) // recovered

    assert.equal(events.length, 1)
    assert.equal(events[0].pubkeyHex, PEER_A)
  })

  it('does not emit recovered if peer was online', () => {
    const health = new PeerHealth()
    const events = []
    health.on('peer:recovered', (e) => events.push(e))

    health.recordSeen(PEER_A)
    health.recordSeen(PEER_A) // still online — no event

    assert.equal(events.length, 0)
  })

  it('checkAll emits peer:inactive for long-offline peers', () => {
    const health = new PeerHealth({ gracePeriodMs: 1, inactiveThresholdMs: 1 })
    const events = []
    health.on('peer:inactive', (e) => events.push(e))

    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)

    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }

    const result = health.checkAll()
    assert.ok(result.inactive.includes(PEER_A))
    assert.equal(events.length, 1)
    assert.equal(events[0].pubkeyHex, PEER_A)
  })

  it('checkAll does not re-emit for already-inactive peer', () => {
    const health = new PeerHealth({ gracePeriodMs: 1, inactiveThresholdMs: 1 })
    const events = []
    health.on('peer:inactive', (e) => events.push(e))

    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)

    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }

    health.checkAll() // first check — emits
    health.checkAll() // second check — should NOT re-emit

    assert.equal(events.length, 1)
  })

  it('getInactivePeers returns only inactive peers', () => {
    const health = new PeerHealth({ gracePeriodMs: 1, inactiveThresholdMs: 1 })

    health.recordSeen(PEER_A)
    health.recordSeen(PEER_B)
    health.recordOffline(PEER_A) // will become inactive

    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }

    const inactive = health.getInactivePeers()
    assert.ok(inactive.includes(PEER_A))
    assert.ok(!inactive.includes(PEER_B)) // PEER_B is still online
  })

  it('isInGracePeriod returns true during grace', () => {
    const health = new PeerHealth({ gracePeriodMs: 10000 }) // 10 second grace
    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)

    assert.ok(health.isInGracePeriod(PEER_A))
  })

  it('isInGracePeriod returns false for online peer', () => {
    const health = new PeerHealth()
    health.recordSeen(PEER_A)

    assert.equal(health.isInGracePeriod(PEER_A), false)
  })

  it('isInGracePeriod returns false for unknown peer', () => {
    const health = new PeerHealth()
    assert.equal(health.isInGracePeriod(PEER_A), false)
  })

  it('getLastSeen returns timestamp', () => {
    const health = new PeerHealth()
    const before = Date.now()
    health.recordSeen(PEER_A)
    const after = Date.now()

    const lastSeen = health.getLastSeen(PEER_A)
    assert.ok(lastSeen >= before && lastSeen <= after)
  })

  it('getLastSeen returns null for unknown peer', () => {
    const health = new PeerHealth()
    assert.equal(health.getLastSeen(PEER_A), null)
  })

  it('removePeer stops tracking', () => {
    const health = new PeerHealth()
    health.recordSeen(PEER_A)
    health.removePeer(PEER_A)

    assert.equal(health.getStatus(PEER_A), 'unknown')
    assert.equal(health.getLastSeen(PEER_A), null)
  })

  it('recordOffline does not reset timer on subsequent calls', () => {
    const health = new PeerHealth({ gracePeriodMs: 1, inactiveThresholdMs: 1000 })
    health.recordSeen(PEER_A)
    health.recordOffline(PEER_A)

    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }

    // Second recordOffline should NOT reset the timer
    health.recordOffline(PEER_A)

    // Should still be past grace period
    assert.equal(health.getStatus(PEER_A), 'offline')
  })
})
