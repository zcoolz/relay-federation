import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AnchorManager } from '../lib/anchor-manager.js'
import { PeerScorer } from '../lib/peer-scorer.js'

const ANCHOR_1 = { pubkeyHex: 'aa'.repeat(33), endpoint: 'wss://bridge-1.example.com:8333' }
const ANCHOR_2 = { pubkeyHex: 'bb'.repeat(33), endpoint: 'wss://bridge-2.example.com:8333' }
const ANCHOR_3 = { pubkeyHex: 'cc'.repeat(33), endpoint: 'wss://bridge-3.example.com:8333' }
const REGULAR_PEER = { pubkeyHex: 'dd'.repeat(33), endpoint: 'wss://some-bridge.com:8333' }

function createMockPeerManager () {
  const pm = new EventEmitter()
  pm.peers = new Map()
  pm.maxPeers = 20

  pm.connectToPeer = (peer) => {
    if (pm.peers.has(peer.pubkeyHex)) return pm.peers.get(peer.pubkeyHex)
    if (pm.peers.size >= pm.maxPeers) return null

    const conn = { connected: true, pubkeyHex: peer.pubkeyHex, endpoint: peer.endpoint }
    pm.peers.set(peer.pubkeyHex, conn)
    return conn
  }

  pm.disconnectPeer = (pubkeyHex) => {
    pm.peers.delete(pubkeyHex)
  }

  return pm
}

describe('AnchorManager', () => {
  it('isAnchor identifies configured anchors', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1, ANCHOR_2] })

    assert.ok(mgr.isAnchor(ANCHOR_1.pubkeyHex))
    assert.ok(mgr.isAnchor(ANCHOR_2.pubkeyHex))
    assert.ok(!mgr.isAnchor(REGULAR_PEER.pubkeyHex))
  })

  it('getAnchors returns configured list', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1, ANCHOR_2] })

    const anchors = mgr.getAnchors()
    assert.equal(anchors.length, 2)
    assert.equal(anchors[0].pubkeyHex, ANCHOR_1.pubkeyHex)
    assert.equal(anchors[1].pubkeyHex, ANCHOR_2.pubkeyHex)
  })

  it('ensureConnections connects to missing anchors', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1, ANCHOR_2, ANCHOR_3] })

    const initiated = mgr.ensureConnections()
    assert.equal(initiated, 3)
    assert.equal(pm.peers.size, 3)
    assert.ok(pm.peers.has(ANCHOR_1.pubkeyHex))
    assert.ok(pm.peers.has(ANCHOR_2.pubkeyHex))
    assert.ok(pm.peers.has(ANCHOR_3.pubkeyHex))
  })

  it('ensureConnections skips already-connected anchors', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1, ANCHOR_2] })

    // First call connects both
    mgr.ensureConnections()
    assert.equal(pm.peers.size, 2)

    // Second call — all connected, no new connections
    const initiated = mgr.ensureConnections()
    assert.equal(initiated, 0)
  })

  it('connectedAnchorCount tracks connected anchors', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1, ANCHOR_2] })

    assert.equal(mgr.connectedAnchorCount(), 0)

    mgr.ensureConnections()
    assert.equal(mgr.connectedAnchorCount(), 2)

    // Simulate disconnect
    pm.peers.get(ANCHOR_1.pubkeyHex).connected = false
    assert.equal(mgr.connectedAnchorCount(), 1)
  })

  it('emits anchor:connect on anchor peer connect', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1] })
    const events = []
    mgr.on('anchor:connect', (e) => events.push(e))

    pm.emit('peer:connect', { pubkeyHex: ANCHOR_1.pubkeyHex, endpoint: ANCHOR_1.endpoint })
    assert.equal(events.length, 1)
    assert.equal(events[0].pubkeyHex, ANCHOR_1.pubkeyHex)
  })

  it('does not emit anchor:connect for regular peers', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1] })
    const events = []
    mgr.on('anchor:connect', (e) => events.push(e))

    pm.emit('peer:connect', { pubkeyHex: REGULAR_PEER.pubkeyHex, endpoint: REGULAR_PEER.endpoint })
    assert.equal(events.length, 0)
  })

  it('emits anchor:disconnect on anchor peer disconnect', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1] })
    const events = []
    mgr.on('anchor:disconnect', (e) => events.push(e))

    pm.emit('peer:disconnect', { pubkeyHex: ANCHOR_1.pubkeyHex, endpoint: ANCHOR_1.endpoint })
    assert.equal(events.length, 1)
  })

  it('checkAnchorScores warns about low-scoring anchors', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1, ANCHOR_2] })
    const scorer = new PeerScorer()
    const events = []
    mgr.on('anchor:low_score', (e) => events.push(e))

    // ANCHOR_1 has bad score
    for (let i = 0; i < 50; i++) scorer.recordPingTimeout(ANCHOR_1.pubkeyHex)
    for (let i = 0; i < 50; i++) scorer.recordBadData(ANCHOR_1.pubkeyHex)

    // ANCHOR_2 has good score
    for (let i = 0; i < 50; i++) scorer.recordPing(ANCHOR_2.pubkeyHex, 50)
    for (let i = 0; i < 50; i++) scorer.recordGoodData(ANCHOR_2.pubkeyHex)

    const lowScoring = mgr.checkAnchorScores(scorer)
    assert.equal(lowScoring.length, 1)
    assert.equal(lowScoring[0].pubkeyHex, ANCHOR_1.pubkeyHex)
    assert.ok(lowScoring[0].score < 0.3)
    assert.equal(events.length, 1)
  })

  it('checkAnchorScores returns empty when all anchors healthy', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1] })
    const scorer = new PeerScorer()

    for (let i = 0; i < 50; i++) scorer.recordPing(ANCHOR_1.pubkeyHex, 50)
    for (let i = 0; i < 50; i++) scorer.recordGoodData(ANCHOR_1.pubkeyHex)

    const lowScoring = mgr.checkAnchorScores(scorer)
    assert.equal(lowScoring.length, 0)
  })

  it('ensureConnections cleans up disconnected anchor before reconnecting', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [ANCHOR_1] })

    mgr.ensureConnections()
    assert.equal(pm.peers.size, 1)

    // Simulate disconnect (set connected = false but leave in map)
    pm.peers.get(ANCHOR_1.pubkeyHex).connected = false

    // ensureConnections should clean up and reconnect
    const initiated = mgr.ensureConnections()
    assert.equal(initiated, 1)
    assert.ok(pm.peers.get(ANCHOR_1.pubkeyHex).connected)
  })

  it('works with empty anchor list', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, { anchors: [] })

    assert.equal(mgr.connectedAnchorCount(), 0)
    assert.equal(mgr.ensureConnections(), 0)
    assert.equal(mgr.getAnchors().length, 0)
  })

  it('startMonitoring and stopMonitoring lifecycle', () => {
    const pm = createMockPeerManager()
    const mgr = new AnchorManager(pm, {
      anchors: [ANCHOR_1],
      reconnectIntervalMs: 100000 // long interval so it doesn't fire during test
    })

    mgr.startMonitoring()
    assert.ok(mgr._reconnectTimer !== null)

    // Starting again is a no-op
    mgr.startMonitoring()

    mgr.stopMonitoring()
    assert.equal(mgr._reconnectTimer, null)
  })
})
