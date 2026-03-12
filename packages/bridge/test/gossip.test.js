import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PrivateKey } from '@bsv/sdk'
import { signHash, verifyHash } from '@relay-federation/common/crypto'
import { GossipManager } from '../lib/gossip.js'

// Fake PeerManager — just an EventEmitter with a peers Map and broadcast
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

// Fake peer connection
function fakeConn (pubkeyHex) {
  const conn = { pubkeyHex, _sent: [], connected: true }
  conn.send = (msg) => { conn._sent.push(msg); return true }
  return conn
}

// Build a signed announce message
function buildAnnounce (privKey, pubkeyHex, endpoint, meshId = '70016', timestamp = Date.now()) {
  const payload = `${pubkeyHex}:${endpoint}:${meshId}:${timestamp}`
  const dataHex = Buffer.from(payload, 'utf8').toString('hex')
  const signature = signHash(dataHex, privKey)
  return {
    type: 'announce',
    pubkeyHex,
    endpoint,
    meshId,
    timestamp,
    signature
  }
}

// Helper: wait for an event
function waitFor (emitter, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms)
    emitter.once(event, (data) => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

describe('GossipManager', () => {
  let gossip

  afterEach(() => {
    if (gossip) gossip.stop()
  })

  it('responds to getpeers with known peers', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    // Add some peers to directory
    gossip.addSeed({ pubkeyHex: 'peer_a', endpoint: 'wss://a:8333' })
    gossip.addSeed({ pubkeyHex: 'peer_b', endpoint: 'wss://b:8333' })

    // Add a connection for the requester
    const requesterConn = fakeConn('requester')
    pm.peers.set('requester', requesterConn)

    // Simulate getpeers
    pm.emit('peer:message', { pubkeyHex: 'requester', message: { type: 'getpeers' } })

    // Check response was sent
    assert.equal(requesterConn._sent.length, 1)
    assert.equal(requesterConn._sent[0].type, 'peers')
    assert.equal(requesterConn._sent[0].peers.length, 2)
  })

  it('does not include requester in peers response', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    gossip.addSeed({ pubkeyHex: 'requester', endpoint: 'wss://req:8333' })
    gossip.addSeed({ pubkeyHex: 'other', endpoint: 'wss://other:8333' })

    const requesterConn = fakeConn('requester')
    pm.peers.set('requester', requesterConn)

    pm.emit('peer:message', { pubkeyHex: 'requester', message: { type: 'getpeers' } })

    const response = requesterConn._sent[0]
    assert.equal(response.peers.length, 1)
    assert.equal(response.peers[0].pubkeyHex, 'other')
  })

  it('processes peers response and emits peer:discovered', async () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    const discoveredPromise = waitFor(gossip, 'peer:discovered')

    pm.emit('peer:message', {
      pubkeyHex: 'sender',
      message: {
        type: 'peers',
        peers: [
          { pubkeyHex: 'new_peer', endpoint: 'wss://new:8333', meshId: '70016' }
        ]
      }
    })

    const discovered = await discoveredPromise
    assert.equal(discovered.pubkeyHex, 'new_peer')
    assert.equal(discovered.endpoint, 'wss://new:8333')
    assert.equal(gossip.directorySize(), 1)
  })

  it('does not emit peer:discovered for already-known peer', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    gossip.addSeed({ pubkeyHex: 'known', endpoint: 'wss://known:8333' })

    let discovered = false
    gossip.on('peer:discovered', () => { discovered = true })

    pm.emit('peer:message', {
      pubkeyHex: 'sender',
      message: {
        type: 'peers',
        peers: [{ pubkeyHex: 'known', endpoint: 'wss://known:8333' }]
      }
    })

    assert.equal(discovered, false)
  })

  it('skips self in peers response', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    const myPub = myKey.toPublicKey().toString()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myPub,
      endpoint: 'wss://me:8333'
    })

    let discovered = false
    gossip.on('peer:discovered', () => { discovered = true })

    pm.emit('peer:message', {
      pubkeyHex: 'sender',
      message: {
        type: 'peers',
        peers: [{ pubkeyHex: myPub, endpoint: 'wss://me:8333' }]
      }
    })

    assert.equal(discovered, false)
    assert.equal(gossip.directorySize(), 0)
  })

  it('accepts valid signed announce and adds to directory', async () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    const peerKey = PrivateKey.fromRandom()
    const peerPub = peerKey.toPublicKey().toString()
    const announce = buildAnnounce(peerKey, peerPub, 'wss://peer:8333')

    const discoveredPromise = waitFor(gossip, 'peer:discovered')
    pm.emit('peer:message', { pubkeyHex: 'source', message: announce })
    const discovered = await discoveredPromise

    assert.equal(discovered.pubkeyHex, peerPub)
    assert.equal(discovered.endpoint, 'wss://peer:8333')
    assert.equal(gossip.directorySize(), 1)
  })

  it('rejects announce with invalid signature', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    const peerKey = PrivateKey.fromRandom()
    const peerPub = peerKey.toPublicKey().toString()
    // Sign with wrong key
    const wrongKey = PrivateKey.fromRandom()
    const announce = buildAnnounce(wrongKey, peerPub, 'wss://peer:8333')

    let discovered = false
    gossip.on('peer:discovered', () => { discovered = true })

    pm.emit('peer:message', { pubkeyHex: 'source', message: announce })

    assert.equal(discovered, false)
    assert.equal(gossip.directorySize(), 0)
  })

  it('rejects stale announce (too old)', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333',
      maxAge: 60000
    })

    const peerKey = PrivateKey.fromRandom()
    const peerPub = peerKey.toPublicKey().toString()
    const staleTime = Date.now() - 120000 // 2 min ago, maxAge is 1 min
    const announce = buildAnnounce(peerKey, peerPub, 'wss://peer:8333', '70016', staleTime)

    let discovered = false
    gossip.on('peer:discovered', () => { discovered = true })

    pm.emit('peer:message', { pubkeyHex: 'source', message: announce })

    assert.equal(discovered, false)
    assert.equal(gossip.directorySize(), 0)
  })

  it('deduplicates repeated announces', async () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    const peerKey = PrivateKey.fromRandom()
    const peerPub = peerKey.toPublicKey().toString()
    const announce = buildAnnounce(peerKey, peerPub, 'wss://peer:8333')

    let discoveredCount = 0
    gossip.on('peer:discovered', () => { discoveredCount++ })

    pm.emit('peer:message', { pubkeyHex: 'source', message: announce })
    pm.emit('peer:message', { pubkeyHex: 'source2', message: announce })
    pm.emit('peer:message', { pubkeyHex: 'source3', message: announce })

    // Give it a tick
    await new Promise(r => setTimeout(r, 20))

    assert.equal(discoveredCount, 1)
  })

  it('re-broadcasts announce to all peers except source', async () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    // Add two peers
    const connA = fakeConn('peer_a')
    const connB = fakeConn('peer_b')
    pm.peers.set('peer_a', connA)
    pm.peers.set('peer_b', connB)

    const peerKey = PrivateKey.fromRandom()
    const peerPub = peerKey.toPublicKey().toString()
    const announce = buildAnnounce(peerKey, peerPub, 'wss://new:8333')

    pm.emit('peer:message', { pubkeyHex: 'peer_a', message: announce })

    // peer_a is the source — should NOT get the re-broadcast
    // peer_b should get it
    assert.equal(connA._sent.length, 0)
    assert.equal(connB._sent.length, 1)
    assert.equal(connB._sent[0].type, 'announce')
  })

  it('skips self in announce', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    const myPub = myKey.toPublicKey().toString()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myPub,
      endpoint: 'wss://me:8333'
    })

    const announce = buildAnnounce(myKey, myPub, 'wss://me:8333')

    let discovered = false
    gossip.on('peer:discovered', () => { discovered = true })

    pm.emit('peer:message', { pubkeyHex: 'source', message: announce })

    assert.equal(discovered, false)
    assert.equal(gossip.directorySize(), 0)
  })

  it('broadcastAnnounce sends signed message to all peers', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    const myPub = myKey.toPublicKey().toString()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myPub,
      endpoint: 'wss://me:8333',
      meshId: 'testmesh'
    })

    const connA = fakeConn('peer_a')
    pm.peers.set('peer_a', connA)

    // Manually trigger broadcast (instead of start() which sets interval)
    gossip._broadcastAnnounce()

    assert.equal(connA._sent.length, 1)
    const msg = connA._sent[0]
    assert.equal(msg.type, 'announce')
    assert.equal(msg.pubkeyHex, myPub)
    assert.equal(msg.endpoint, 'wss://me:8333')
    assert.equal(msg.meshId, 'testmesh')
    assert.equal(typeof msg.timestamp, 'number')
    assert.equal(typeof msg.signature, 'string')

    // Verify the signature is valid
    const payload = `${myPub}:wss://me:8333:testmesh:${msg.timestamp}`
    const dataHex = Buffer.from(payload, 'utf8').toString('hex')
    assert.equal(verifyHash(dataHex, msg.signature, myPub), true)
  })

  it('getDirectory excludes stale entries', async () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333',
      maxAge: 50 // 50ms — will expire fast
    })

    gossip.addSeed({ pubkeyHex: 'stale_peer', endpoint: 'wss://stale:8333' })
    assert.equal(gossip.directorySize(), 1)

    // Wait for it to go stale
    await new Promise(r => setTimeout(r, 80))

    assert.equal(gossip.directorySize(), 0)
  })

  it('requestPeers sends getpeers to specific peer', () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333'
    })

    const conn = fakeConn('target')
    pm.peers.set('target', conn)

    gossip.requestPeers('target')

    assert.equal(conn._sent.length, 1)
    assert.equal(conn._sent[0].type, 'getpeers')
  })

  it('start and stop manage the announce timer', async () => {
    const pm = fakePeerManager()
    const myKey = PrivateKey.fromRandom()
    gossip = new GossipManager(pm, {
      privKey: myKey,
      pubkeyHex: myKey.toPublicKey().toString(),
      endpoint: 'wss://me:8333',
      announceIntervalMs: 30 // fast for test
    })

    const conn = fakeConn('peer')
    pm.peers.set('peer', conn)

    gossip.start()
    // Immediate announce
    assert.equal(conn._sent.length, 1)

    // Wait for one interval
    await new Promise(r => setTimeout(r, 50))
    assert.ok(conn._sent.length >= 2) // at least one more

    gossip.stop()
    const countAfterStop = conn._sent.length

    await new Promise(r => setTimeout(r, 50))
    assert.equal(conn._sent.length, countAfterStop) // no more after stop
  })
})
