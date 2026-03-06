import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { StatusServer } from '../lib/status-server.js'

function createMockPeerManager () {
  const pm = new EventEmitter()
  pm.peers = new Map()
  pm.maxPeers = 20
  pm.connectedCount = () => {
    let count = 0
    for (const conn of pm.peers.values()) {
      if (conn.connected) count++
    }
    return count
  }
  return pm
}

function createMockHeaderRelay () {
  return {
    bestHeight: -1,
    bestHash: null,
    headers: new Map()
  }
}

function createMockTxRelay () {
  return {
    mempool: new Map(),
    seen: new Set()
  }
}

const TEST_CONFIG = {
  pubkeyHex: 'aa'.repeat(33),
  endpoint: 'wss://test-bridge.example.com:8333',
  meshId: 'indelible'
}

// Use a different port for each test to avoid EADDRINUSE
let portCounter = 19333

describe('StatusServer', () => {
  let server

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('getStatus returns bridge identity', () => {
    server = new StatusServer({ config: TEST_CONFIG })
    const status = server.getStatus()

    assert.equal(status.bridge.pubkeyHex, TEST_CONFIG.pubkeyHex)
    assert.equal(status.bridge.endpoint, TEST_CONFIG.endpoint)
    assert.equal(status.bridge.meshId, TEST_CONFIG.meshId)
    assert.equal(typeof status.bridge.uptimeSeconds, 'number')
    assert.ok(status.bridge.uptimeSeconds >= 0)
  })

  it('getStatus returns peer info', () => {
    const pm = createMockPeerManager()
    pm.peers.set('bb'.repeat(33), {
      pubkeyHex: 'bb'.repeat(33),
      endpoint: 'wss://peer1.example.com:8333',
      connected: true
    })
    pm.peers.set('cc'.repeat(33), {
      pubkeyHex: 'cc'.repeat(33),
      endpoint: 'wss://peer2.example.com:8333',
      connected: false
    })

    server = new StatusServer({ peerManager: pm, config: TEST_CONFIG })
    const status = server.getStatus()

    assert.equal(status.peers.connected, 1) // only one with connected=true
    assert.equal(status.peers.max, 20)
    assert.equal(status.peers.list.length, 2)
    assert.equal(status.peers.list[0].pubkeyHex, 'bb'.repeat(33))
    assert.equal(status.peers.list[0].connected, true)
    assert.equal(status.peers.list[1].connected, false)
  })

  it('getStatus returns header info', () => {
    const hr = createMockHeaderRelay()
    hr.bestHeight = 100
    hr.bestHash = 'dd'.repeat(32)
    hr.headers.set(99, { height: 99, hash: 'cc'.repeat(32), prevHash: 'bb'.repeat(32) })
    hr.headers.set(100, { height: 100, hash: 'dd'.repeat(32), prevHash: 'cc'.repeat(32) })

    server = new StatusServer({ headerRelay: hr, config: TEST_CONFIG })
    const status = server.getStatus()

    assert.equal(status.headers.bestHeight, 100)
    assert.equal(status.headers.bestHash, 'dd'.repeat(32))
    assert.equal(status.headers.count, 2)
  })

  it('getStatus returns tx info', () => {
    const tr = createMockTxRelay()
    tr.mempool.set('tx1', 'aabb')
    tr.mempool.set('tx2', 'ccdd')
    tr.seen.add('tx1')
    tr.seen.add('tx2')
    tr.seen.add('tx3') // seen but not in mempool (evicted)

    server = new StatusServer({ txRelay: tr, config: TEST_CONFIG })
    const status = server.getStatus()

    assert.equal(status.txs.mempool, 2)
    assert.equal(status.txs.seen, 3)
  })

  it('getStatus works with no components (null safety)', () => {
    server = new StatusServer({})
    const status = server.getStatus()

    assert.equal(status.bridge.pubkeyHex, null)
    assert.equal(status.bridge.endpoint, null)
    assert.equal(status.peers.connected, 0)
    assert.equal(status.peers.max, 0)
    assert.equal(status.peers.list.length, 0)
    assert.equal(status.headers.bestHeight, -1)
    assert.equal(status.headers.bestHash, null)
    assert.equal(status.headers.count, 0)
    assert.equal(status.txs.mempool, 0)
    assert.equal(status.txs.seen, 0)
  })

  it('uptime increases over time', async () => {
    server = new StatusServer({ config: TEST_CONFIG })

    const s1 = server.getStatus()
    await new Promise(resolve => setTimeout(resolve, 10))
    const s2 = server.getStatus()

    assert.ok(s2.bridge.uptimeSeconds >= s1.bridge.uptimeSeconds)
  })

  it('HTTP server serves GET /status', async () => {
    const port = portCounter++
    const pm = createMockPeerManager()
    pm.peers.set('bb'.repeat(33), {
      pubkeyHex: 'bb'.repeat(33),
      endpoint: 'wss://peer1.example.com:8333',
      connected: true
    })

    server = new StatusServer({
      port,
      peerManager: pm,
      headerRelay: createMockHeaderRelay(),
      txRelay: createMockTxRelay(),
      config: TEST_CONFIG
    })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/status`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/json')

    const status = await res.json()
    assert.equal(status.bridge.pubkeyHex, TEST_CONFIG.pubkeyHex)
    assert.equal(status.peers.connected, 1)
    assert.equal(status.peers.list.length, 1)
  })

  it('HTTP server returns 404 for unknown paths', async () => {
    const port = portCounter++
    server = new StatusServer({ port, config: TEST_CONFIG })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/unknown`)
    assert.equal(res.status, 404)
  })

  it('HTTP server returns 404 for POST /status', async () => {
    const port = portCounter++
    server = new StatusServer({ port, config: TEST_CONFIG })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/status`, { method: 'POST' })
    assert.equal(res.status, 404)
  })

  it('stop is idempotent', async () => {
    server = new StatusServer({ config: TEST_CONFIG })
    await server.stop() // no-op, never started
    await server.stop() // still no-op
  })

  it('port getter returns configured port', () => {
    server = new StatusServer({ port: 7777, config: TEST_CONFIG })
    assert.equal(server.port, 7777)
  })

  it('default port is 9333', () => {
    server = new StatusServer({ config: TEST_CONFIG })
    assert.equal(server.port, 9333)
  })

  it('reflects live peer changes', async () => {
    const pm = createMockPeerManager()
    server = new StatusServer({ peerManager: pm, config: TEST_CONFIG })

    assert.equal(server.getStatus().peers.connected, 0)

    pm.peers.set('bb'.repeat(33), {
      pubkeyHex: 'bb'.repeat(33),
      endpoint: 'wss://new-peer.com:8333',
      connected: true
    })

    assert.equal(server.getStatus().peers.connected, 1)
    assert.equal(server.getStatus().peers.list.length, 1)
  })

  it('reflects live header changes', () => {
    const hr = createMockHeaderRelay()
    server = new StatusServer({ headerRelay: hr, config: TEST_CONFIG })

    assert.equal(server.getStatus().headers.bestHeight, -1)

    hr.bestHeight = 500
    hr.bestHash = 'ee'.repeat(32)
    hr.headers.set(500, { height: 500, hash: 'ee'.repeat(32), prevHash: 'dd'.repeat(32) })

    assert.equal(server.getStatus().headers.bestHeight, 500)
    assert.equal(server.getStatus().headers.count, 1)
  })
})
