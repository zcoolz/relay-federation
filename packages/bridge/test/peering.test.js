import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PeerConnection } from '../lib/peer-connection.js'
import { PeerManager } from '../lib/peer-manager.js'

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

  it('respects maxPeers limit', async () => {
    const server = new PeerManager({ maxPeers: 1 })
    const client1 = new PeerManager()
    const client2 = new PeerManager()
    managers.push(server, client1, client2)

    await server.startServer({ port: 0, host: '127.0.0.1' })
    const port = server._server.address().port

    // Connect client1
    const conn1 = client1.connectToPeer({ pubkeyHex: 'srv', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(conn1, 'open')
    conn1.send({ type: 'hello', pubkey: 'c1', endpoint: 'ws://c1:8333' })
    await waitFor(server, 'peer:connect')

    assert.equal(server.peers.size, 1)

    // Client2 connects — should be rejected (maxPeers = 1)
    const conn2 = client2.connectToPeer({ pubkeyHex: 'srv', endpoint: `ws://127.0.0.1:${port}` })
    await waitFor(conn2, 'open')
    conn2.send({ type: 'hello', pubkey: 'c2', endpoint: 'ws://c2:8333' })

    // Give time for server to process
    await new Promise(r => setTimeout(r, 200))

    assert.equal(server.peers.size, 1, 'should still have only 1 peer')
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
