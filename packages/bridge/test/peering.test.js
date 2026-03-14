import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import { signHash } from '@relay-federation/common/crypto'
import { PeerConnection } from '../lib/peer-connection.js'
import { PeerManager } from '../lib/peer-manager.js'
import { DataRelay } from '../lib/data-relay.js'

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

describe('WebSocket peering', () => {
  const managers = []

  afterEach(async () => {
    for (const m of managers) await m.shutdown()
    managers.length = 0
  })

  it('two managers can connect and exchange messages', async () => {
    const server = new PeerManager()
    const client = new PeerManager()
    managers.push(server, client)

    // Start server on random port
    await server.startServer({ port: 0, host: '127.0.0.1' })
    const port = server._server.address().port

    // Client connects to server
    const connectPromise = waitFor(server, 'peer:connect')
    const conn = client.connectToPeer({
      pubkeyHex: 'server_pubkey_hex',
      endpoint: `ws://127.0.0.1:${port}`
    })

    // Wait for outbound connection to open
    await waitFor(conn, 'open')

    // Client sends hello (required for inbound acceptance)
    conn.send({ type: 'hello', pubkey: 'client_pubkey_hex', endpoint: 'ws://client:8333' })

    // Server should accept the peer
    const connectEvent = await connectPromise
    assert.equal(connectEvent.pubkeyHex, 'client_pubkey_hex')

    // Server sends a message back
    const msgPromise = waitFor(client, 'peer:message')
    server.broadcast({ type: 'ping', data: 'hello from server' })

    const { message } = await msgPromise
    assert.equal(message.type, 'ping')
    assert.equal(message.data, 'hello from server')
  })

  it('broadcast sends to all connected peers', async () => {
    const server = new PeerManager()
    const client1 = new PeerManager()
    const client2 = new PeerManager()
    managers.push(server, client1, client2)

    await server.startServer({ port: 0, host: '127.0.0.1' })
    const port = server._server.address().port

    // Connect client1
    const conn1 = client1.connectToPeer({
      pubkeyHex: 'server_hex',
      endpoint: `ws://127.0.0.1:${port}`
    })
    await waitFor(conn1, 'open')
    conn1.send({ type: 'hello', pubkey: 'client1_hex', endpoint: 'ws://c1:8333' })
    await waitFor(server, 'peer:connect')

    // Connect client2
    const conn2 = client2.connectToPeer({
      pubkeyHex: 'server_hex',
      endpoint: `ws://127.0.0.1:${port}`
    })
    await waitFor(conn2, 'open')
    conn2.send({ type: 'hello', pubkey: 'client2_hex', endpoint: 'ws://c2:8333' })
    await waitFor(server, 'peer:connect')

    assert.equal(server.peers.size, 2)

    // Broadcast from server
    const msg1Promise = waitFor(client1, 'peer:message')
    const msg2Promise = waitFor(client2, 'peer:message')

    const sent = server.broadcast({ type: 'announce', data: 'test' })
    assert.equal(sent, 2)

    const [r1, r2] = await Promise.all([msg1Promise, msg2Promise])
    assert.equal(r1.message.type, 'announce')
    assert.equal(r2.message.type, 'announce')
  })

  it('broadcast excludes specified peer', async () => {
    const server = new PeerManager()
    const client1 = new PeerManager()
    const client2 = new PeerManager()
    managers.push(server, client1, client2)

    await server.startServer({ port: 0, host: '127.0.0.1' })
    const port = server._server.address().port

    // Connect both clients
    const conn1 = client1.connectToPeer({ pubkeyHex: 'srv', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(conn1, 'open')
    conn1.send({ type: 'hello', pubkey: 'c1', endpoint: 'ws://c1:8333' })
    await waitFor(server, 'peer:connect')

    const conn2 = client2.connectToPeer({ pubkeyHex: 'srv', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(conn2, 'open')
    conn2.send({ type: 'hello', pubkey: 'c2', endpoint: 'ws://c2:8333' })
    await waitFor(server, 'peer:connect')

    // Broadcast excluding c1
    const sent = server.broadcast({ type: 'test' }, 'c1')
    assert.equal(sent, 1, 'should only send to c2')
  })

  it('connectedCount tracks active connections', async () => {
    const server = new PeerManager()
    const client = new PeerManager()
    managers.push(server, client)

    assert.equal(server.connectedCount(), 0)

    await server.startServer({ port: 0, host: '127.0.0.1' })
    const port = server._server.address().port

    const conn = client.connectToPeer({ pubkeyHex: 'srv', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(conn, 'open')
    conn.send({ type: 'hello', pubkey: 'c1', endpoint: 'ws://c1:8333' })
    await waitFor(server, 'peer:connect')

    assert.equal(server.connectedCount(), 1)
    assert.equal(client.connectedCount(), 1)
  })

  it('disconnectPeer removes and destroys connection', async () => {
    const server = new PeerManager()
    const client = new PeerManager()
    managers.push(server, client)

    await server.startServer({ port: 0, host: '127.0.0.1' })
    const port = server._server.address().port

    const conn = client.connectToPeer({ pubkeyHex: 'srv', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(conn, 'open')
    conn.send({ type: 'hello', pubkey: 'c1', endpoint: 'ws://c1:8333' })
    await waitFor(server, 'peer:connect')

    assert.equal(server.peers.size, 1)
    server.disconnectPeer('c1')
    assert.equal(server.peers.size, 0)
  })

  it('shutdown closes all connections and server', async () => {
    const server = new PeerManager()
    const client = new PeerManager()
    managers.push(server, client)

    await server.startServer({ port: 0, host: '127.0.0.1' })
    const port = server._server.address().port

    const conn = client.connectToPeer({ pubkeyHex: 'srv', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(conn, 'open')
    conn.send({ type: 'hello', pubkey: 'c1', endpoint: 'ws://c1:8333' })
    await waitFor(server, 'peer:connect')

    await server.shutdown()
    assert.equal(server.peers.size, 0)
    assert.equal(server._server, null)
  })
})

// --- Helpers for data relay peering ---

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

async function connectPeers (serverMgr, clientMgr, opts = {}) {
  const clientPubkey = opts.clientPubkey || 'cli'
  if (!serverMgr._server) {
    await serverMgr.startServer({ port: 0, host: '127.0.0.1' })
  }
  const port = serverMgr._server.address().port
  const connectPromise = waitFor(serverMgr, 'peer:connect')
  const conn = clientMgr.connectToPeer({
    pubkeyHex: 'srv',
    endpoint: `ws://127.0.0.1:${port}`
  })
  await waitFor(conn, 'open')
  conn.send({ type: 'hello', pubkey: clientPubkey, endpoint: 'ws://client:8333' })
  await connectPromise
  return { conn, port }
}

describe('Data relay peering', () => {
  const managers = []

  afterEach(async () => {
    for (const m of managers) await m.shutdown()
    managers.length = 0
  })

  it('data envelope propagates between two peers via gossip', async () => {
    const pmA = new PeerManager()
    const pmB = new PeerManager()
    managers.push(pmA, pmB)

    const relayA = new DataRelay(pmA)
    const relayB = new DataRelay(pmB)

    await connectPeers(pmA, pmB, { clientPubkey: 'peerB' })

    // Peer A declares wildcard interest so it receives everything
    const peerAPriv = PrivateKey.fromRandom()
    const peerAPub = peerAPriv.toPublicKey().toString()
    relayA._peerInterests.set('peerB', ['*'])

    // Peer B declares wildcard interest
    relayB._peerInterests.set('srv', ['*'])

    // Create and inject an envelope on peer A
    const origPriv = PrivateKey.fromRandom()
    const origPub = origPriv.toPublicKey().toString()
    const env = buildEnvelope(origPriv, origPub)

    const dataPromise = waitFor(relayB, 'data:new')
    relayA.injectEnvelope(env)

    const received = await dataPromise
    assert.equal(received.topic, 'oracle:rates:bsv')
    assert.equal(received.payload, '{"USD":42.50}')

    // Verify it's cached on peer B
    const cached = relayB.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 1)
  })

  it('peer without matching interest does not receive envelope', async () => {
    const pmA = new PeerManager()
    const pmB = new PeerManager()
    managers.push(pmA, pmB)

    const relayA = new DataRelay(pmA)
    const relayB = new DataRelay(pmB)

    await connectPeers(pmA, pmB, { clientPubkey: 'peerB' })

    // Peer B only interested in attestation:*, not oracle:*
    relayA._peerInterests.set('peerB', ['attestation:'])

    const origPriv = PrivateKey.fromRandom()
    const origPub = origPriv.toPublicKey().toString()
    const env = buildEnvelope(origPriv, origPub, { topic: 'oracle:rates:bsv' })

    relayA.injectEnvelope(env)

    // Give time for any message to arrive
    await new Promise(r => setTimeout(r, 200))

    const cached = relayB.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 0, 'uninterested peer should not receive envelope')
  })

  it('topic interest declaration propagates via wire', async () => {
    const pmA = new PeerManager()
    const pmB = new PeerManager()
    managers.push(pmA, pmB)

    const relayA = new DataRelay(pmA)
    const relayB = new DataRelay(pmB)

    await connectPeers(pmA, pmB, { clientPubkey: 'peerB' })

    // Peer B sends a signed topics declaration to peer A
    const peerBPriv = PrivateKey.fromRandom()
    const peerBPub = peerBPriv.toPublicKey().toString()
    const topicsMsg = buildTopics(peerBPriv, peerBPub, ['oracle:'])

    // Send via the wire (peer B broadcasts to peer A)
    pmB.broadcast(topicsMsg)

    // Wait for peer A to process it
    await new Promise(r => setTimeout(r, 200))

    // Peer A should now know peerB's interests
    const interests = relayA._peerInterests.get('peerB')
    assert.ok(interests, 'peer A should have recorded peer B interests')
    assert.deepEqual(interests, ['oracle:'])
  })

  it('data_request catch-up works between peers', async () => {
    const pmA = new PeerManager()
    const pmB = new PeerManager()
    managers.push(pmA, pmB)

    const relayA = new DataRelay(pmA)
    const relayB = new DataRelay(pmB)

    await connectPeers(pmA, pmB, { clientPubkey: 'peerB' })

    // Inject an envelope on peer A (locally, no gossip needed)
    const origPriv = PrivateKey.fromRandom()
    const origPub = origPriv.toPublicKey().toString()
    const env = buildEnvelope(origPriv, origPub)
    relayA.injectEnvelope(env)

    // Peer B requests catch-up from peer A
    const catchupPromise = waitFor(relayB, 'data:catchup', 3000)
    relayB.requestData('srv', 'oracle:rates:bsv', 0, 10)

    const catchup = await catchupPromise
    assert.equal(catchup.topic, 'oracle:rates:bsv')
    assert.equal(catchup.count, 1)

    // Verify peer B now has the envelope cached
    const cached = relayB.getEnvelopes('oracle:rates:bsv')
    assert.equal(cached.length, 1)
    assert.equal(cached[0].payload, '{"USD":42.50}')
  })

  it('end-to-end: wire-level topic declaration then propagation A → B → C', async () => {
    const pmA = new PeerManager()
    const pmB = new PeerManager()
    const pmC = new PeerManager()
    managers.push(pmA, pmB, pmC)

    const relayA = new DataRelay(pmA)
    const relayB = new DataRelay(pmB)
    const relayC = new DataRelay(pmC)

    // B is the hub: A → B, C → B
    await pmB.startServer({ port: 0, host: '127.0.0.1' })
    const port = pmB._server.address().port

    // C connects to B
    const connC = pmC.connectToPeer({ pubkeyHex: 'peerB', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(connC, 'open')
    connC.send({ type: 'hello', pubkey: 'peerC', endpoint: 'ws://c:8333' })
    await waitFor(pmB, 'peer:connect')

    // A connects to B
    const connA = pmA.connectToPeer({ pubkeyHex: 'peerB', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(connA, 'open')
    connA.send({ type: 'hello', pubkey: 'peerA', endpoint: 'ws://a:8333' })
    await waitFor(pmB, 'peer:connect')

    // Declare interests via signed wire messages (no pre-seeding)
    // Each peer broadcasts its topics declaration to its connected peers
    const keyB = PrivateKey.fromRandom()
    const pubB = keyB.toPublicKey().toString()
    const keyC = PrivateKey.fromRandom()
    const pubC = keyC.toPublicKey().toString()
    const keyA = PrivateKey.fromRandom()
    const pubA = keyA.toPublicKey().toString()

    // B tells A it wants oracle:* (so A forwards to B)
    pmB.broadcast(buildTopics(keyB, pubB, ['oracle:']))
    // C tells B it wants oracle:* (so B forwards to C)
    pmC.broadcast(buildTopics(keyC, pubC, ['oracle:']))
    // A tells B it wants oracle:* (so B forwards to A)
    pmA.broadcast(buildTopics(keyA, pubA, ['oracle:']))

    // Wait for wire messages to propagate
    await new Promise(r => setTimeout(r, 300))

    // A injects an envelope
    const origPriv = PrivateKey.fromRandom()
    const origPub = origPriv.toPublicKey().toString()
    const env = buildEnvelope(origPriv, origPub)

    const dataBPromise = waitFor(relayB, 'data:new')
    const dataCPromise = waitFor(relayC, 'data:new', 3000)

    relayA.injectEnvelope(env)

    // B receives from A
    await dataBPromise

    // C receives from B (multi-hop)
    const receivedC = await dataCPromise
    assert.equal(receivedC.topic, 'oracle:rates:bsv')
    assert.equal(receivedC.payload, '{"USD":42.50}')

    // All three should have it cached
    assert.equal(relayA.getEnvelopes('oracle:rates:bsv').length, 1)
    assert.equal(relayB.getEnvelopes('oracle:rates:bsv').length, 1)
    assert.equal(relayC.getEnvelopes('oracle:rates:bsv').length, 1)
  })
})
