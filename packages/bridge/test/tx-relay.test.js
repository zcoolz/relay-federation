import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PeerManager } from '../lib/peer-manager.js'
import { TxRelay } from '../lib/tx-relay.js'

// Helper: wait for an event with timeout
function waitFor (emitter, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms)
    emitter.once(event, (data) => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

// Connect two PeerManagers with hello handshake
async function connectPeers (serverMgr, clientMgr, opts = {}) {
  const serverPubkey = opts.serverPubkey || 'srv'
  const clientPubkey = opts.clientPubkey || 'cli'

  if (!serverMgr._server) {
    await serverMgr.startServer({ port: 0, host: '127.0.0.1' })
  }
  const port = serverMgr._server.address().port

  const connectPromise = waitFor(serverMgr, 'peer:connect')
  const conn = clientMgr.connectToPeer({
    pubkeyHex: serverPubkey,
    endpoint: `ws://127.0.0.1:${port}`
  })
  await waitFor(conn, 'open')
  conn.send({ type: 'hello', pubkey: clientPubkey, endpoint: 'ws://client:8333' })
  await connectPromise

  return { conn, port }
}

describe('Tx relay', () => {
  const managers = []

  afterEach(async () => {
    for (const m of managers) await m.shutdown()
    managers.length = 0
  })

  it('broadcastTx stores tx and returns peer count', () => {
    const mgr = new PeerManager()
    managers.push(mgr)
    const relay = new TxRelay(mgr)

    // No peers — returns 0 but still stores
    const sent = relay.broadcastTx('tx1', 'aabbccdd')
    assert.equal(sent, 0)
    assert.equal(relay.mempool.get('tx1'), 'aabbccdd')
    assert.equal(relay.seen.has('tx1'), true)
  })

  it('broadcastTx ignores already-seen tx', () => {
    const mgr = new PeerManager()
    managers.push(mgr)
    const relay = new TxRelay(mgr)

    relay.broadcastTx('tx1', 'aabbccdd')
    const sent = relay.broadcastTx('tx1', 'aabbccdd')
    assert.equal(sent, 0, 'should return 0 for duplicate')
    assert.equal(relay.mempool.size, 1, 'should not double-store')
  })

  it('relays tx between two peers via announce-request-send', async () => {
    const serverMgr = new PeerManager()
    const clientMgr = new PeerManager()
    managers.push(serverMgr, clientMgr)

    const serverRelay = new TxRelay(serverMgr)
    const clientRelay = new TxRelay(clientMgr)

    await connectPeers(serverMgr, clientMgr)

    // Server broadcasts a tx
    const txPromise = waitFor(clientRelay, 'tx:new')
    serverRelay.broadcastTx('tx1', 'deadbeef01')

    const received = await txPromise
    assert.equal(received.txid, 'tx1')
    assert.equal(received.rawHex, 'deadbeef01')
    assert.equal(clientRelay.mempool.get('tx1'), 'deadbeef01')
  })

  it('does not re-request already-seen tx', async () => {
    const serverMgr = new PeerManager()
    const clientMgr = new PeerManager()
    managers.push(serverMgr, clientMgr)

    const serverRelay = new TxRelay(serverMgr)
    const clientRelay = new TxRelay(clientMgr)

    await connectPeers(serverMgr, clientMgr)

    // First broadcast — client receives
    const txPromise = waitFor(clientRelay, 'tx:new')
    serverRelay.broadcastTx('tx1', 'deadbeef01')
    await txPromise

    // Track any additional tx:new events
    let extraCount = 0
    clientRelay.on('tx:new', () => extraCount++)

    // Send a duplicate announce directly
    const serverConn = serverMgr.peers.values().next().value
    serverConn.send({ type: 'tx_announce', txid: 'tx1' })

    // Wait to ensure no second request/response cycle
    await new Promise(r => setTimeout(r, 200))
    assert.equal(extraCount, 0, 'should not emit tx:new for already-seen tx')
  })

  it('propagates tx through a third peer', async () => {
    const peerA = new PeerManager()
    const peerB = new PeerManager()
    const peerC = new PeerManager()
    managers.push(peerA, peerB, peerC)

    const relayA = new TxRelay(peerA)
    const relayB = new TxRelay(peerB)
    const relayC = new TxRelay(peerC)

    // peerB is the hub
    await peerB.startServer({ port: 0, host: '127.0.0.1' })
    const port = peerB._server.address().port

    // peerC connects to peerB
    const connC = peerC.connectToPeer({ pubkeyHex: 'peerB', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(connC, 'open')
    connC.send({ type: 'hello', pubkey: 'peerC', endpoint: 'ws://c:8333' })
    await waitFor(peerB, 'peer:connect')

    // peerA connects to peerB
    const connA = peerA.connectToPeer({ pubkeyHex: 'peerB', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(connA, 'open')
    connA.send({ type: 'hello', pubkey: 'peerA', endpoint: 'ws://a:8333' })
    await waitFor(peerB, 'peer:connect')

    // peerA broadcasts a tx — should propagate A → B → C
    const txCPromise = waitFor(relayC, 'tx:new')
    relayA.broadcastTx('tx1', 'cafebabe')

    // Wait for B to relay
    await waitFor(relayB, 'tx:new')

    // C should receive via B's re-announce
    const txC = await txCPromise
    assert.equal(txC.txid, 'tx1')
    assert.equal(txC.rawHex, 'cafebabe')
    assert.equal(relayB.mempool.get('tx1'), 'cafebabe')
    assert.equal(relayC.mempool.get('tx1'), 'cafebabe')
  })
})
