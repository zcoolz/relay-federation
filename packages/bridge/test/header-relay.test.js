import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PeerManager } from '../lib/peer-manager.js'
import { HeaderRelay } from '../lib/header-relay.js'

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

// Generate a chain of fake headers with deterministic hashes
function makeHeaders (count, startHeight = 0) {
  const headers = []
  let prevHash = '0'.repeat(64)
  if (startHeight > 0) {
    prevHash = startHeight.toString(16).padStart(64, '0')
  }
  for (let i = 0; i < count; i++) {
    const height = startHeight + i
    const hash = (height + 1).toString(16).padStart(64, '0')
    headers.push({ height, hash, prevHash })
    prevHash = hash
  }
  return headers
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

describe('Header relay', () => {
  const managers = []

  afterEach(async () => {
    for (const m of managers) await m.shutdown()
    managers.length = 0
  })

  it('addHeader stores headers and tracks bestHeight', () => {
    const mgr = new PeerManager()
    managers.push(mgr)
    const relay = new HeaderRelay(mgr)

    const headers = makeHeaders(5)
    for (const h of headers) {
      assert.equal(relay.addHeader(h), true)
    }

    assert.equal(relay.bestHeight, 4)
    assert.equal(relay.headers.size, 5)

    const best = relay.getBestHeader()
    assert.equal(best.height, 4)
    assert.equal(best.hash, (5).toString(16).padStart(64, '0'))
  })

  it('rejects duplicate headers', () => {
    const mgr = new PeerManager()
    managers.push(mgr)
    const relay = new HeaderRelay(mgr)

    relay.addHeaders(makeHeaders(3))

    assert.equal(relay.addHeader(makeHeaders(3)[1]), false)
    assert.equal(relay.headers.size, 3)
  })

  it('rejects header with invalid prevHash', () => {
    const mgr = new PeerManager()
    managers.push(mgr)
    const relay = new HeaderRelay(mgr)

    relay.addHeaders(makeHeaders(3))

    const bad = { height: 3, hash: 'bad'.padEnd(64, '0'), prevHash: 'wrong'.padEnd(64, '0') }
    assert.equal(relay.addHeader(bad), false)
    assert.equal(relay.headers.size, 3)
  })

  it('syncs headers from server to client on connect', async () => {
    const serverMgr = new PeerManager()
    const clientMgr = new PeerManager()
    managers.push(serverMgr, clientMgr)

    const serverRelay = new HeaderRelay(serverMgr)
    const clientRelay = new HeaderRelay(clientMgr)

    // Server has headers 0-4
    serverRelay.addHeaders(makeHeaders(5))

    // Connect — server announces via hello handler, client syncs
    const syncPromise = waitFor(clientRelay, 'header:sync')
    await connectPeers(serverMgr, clientMgr)

    const sync = await syncPromise
    assert.equal(sync.added, 5)
    assert.equal(sync.bestHeight, 4)
    assert.equal(clientRelay.headers.size, 5)
  })

  it('syncs headers from client to server (reverse direction)', async () => {
    const serverMgr = new PeerManager()
    const clientMgr = new PeerManager()
    managers.push(serverMgr, clientMgr)

    const serverRelay = new HeaderRelay(serverMgr)
    const clientRelay = new HeaderRelay(clientMgr)

    // Client has headers 0-4, server has none
    clientRelay.addHeaders(makeHeaders(5))

    // Server announces { height: -1 }, client is ahead, announces back,
    // server requests, client sends, server syncs
    const syncPromise = waitFor(serverRelay, 'header:sync')
    await connectPeers(serverMgr, clientMgr)

    const sync = await syncPromise
    assert.equal(sync.added, 5)
    assert.equal(sync.bestHeight, 4)
    assert.equal(serverRelay.headers.size, 5)
  })

  it('partial sync transfers only missing headers', async () => {
    const serverMgr = new PeerManager()
    const clientMgr = new PeerManager()
    managers.push(serverMgr, clientMgr)

    const serverRelay = new HeaderRelay(serverMgr)
    const clientRelay = new HeaderRelay(clientMgr)

    // Server has 0-9, client has 0-4
    serverRelay.addHeaders(makeHeaders(10))
    clientRelay.addHeaders(makeHeaders(5))

    const syncPromise = waitFor(clientRelay, 'header:sync')
    await connectPeers(serverMgr, clientMgr)

    const sync = await syncPromise
    assert.equal(sync.added, 5, 'should only add headers 5-9')
    assert.equal(sync.bestHeight, 9)
    assert.equal(clientRelay.headers.size, 10)
  })

  it('propagates headers through a third peer', async () => {
    const peerA = new PeerManager()
    const peerB = new PeerManager()
    const peerC = new PeerManager()
    managers.push(peerA, peerB, peerC)

    const relayA = new HeaderRelay(peerA)
    const relayB = new HeaderRelay(peerB)
    const relayC = new HeaderRelay(peerC)

    // peerA has headers 0-4
    relayA.addHeaders(makeHeaders(5))

    // peerB starts a server — hub for both peerA and peerC
    await peerB.startServer({ port: 0, host: '127.0.0.1' })
    const port = peerB._server.address().port

    // peerC connects to peerB first (both empty — no sync)
    const connC = peerC.connectToPeer({ pubkeyHex: 'peerB', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(connC, 'open')
    connC.send({ type: 'hello', pubkey: 'peerC', endpoint: 'ws://c:8333' })
    await waitFor(peerB, 'peer:connect')

    // peerA connects to peerB — peerA has headers, triggers full flow:
    // peerB announces -1 → peerA announces back 4 → peerB syncs from peerA
    // → peerB re-announces to peerC → peerC syncs from peerB
    const syncCPromise = waitFor(relayC, 'header:sync')
    const connA = peerA.connectToPeer({ pubkeyHex: 'peerB', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(connA, 'open')
    connA.send({ type: 'hello', pubkey: 'peerA', endpoint: 'ws://a:8333' })
    await waitFor(peerB, 'peer:connect')

    // Wait for full propagation: A → B → C
    await waitFor(relayB, 'header:sync')
    const syncC = await syncCPromise

    assert.equal(syncC.bestHeight, 4)
    assert.equal(relayC.headers.size, 5)
    assert.equal(relayB.headers.size, 5)
  })
})
