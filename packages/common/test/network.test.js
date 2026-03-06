import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fetchUtxos, broadcastTx, fetchAddressHistory, fetchTxHex } from '../lib/network.js'

let server
let port = 18333

function startMockServer (handler) {
  return new Promise((resolve) => {
    const p = port++
    server = createServer(handler)
    server.listen(p, '127.0.0.1', () => resolve(p))
  })
}

afterEach(() => {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => { server = null; resolve() })
    } else {
      resolve()
    }
  })
})

describe('fetchUtxos', () => {
  it('returns parsed JSON on success', async () => {
    const utxos = [{ tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 10000 }]
    const p = await startMockServer((req, res) => {
      assert.ok(req.url.includes('/api/address/'))
      assert.ok(req.url.includes('/utxos'))
      assert.equal(req.headers['x-api-key'], 'test-key')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(utxos))
    })

    const result = await fetchUtxos(`http://127.0.0.1:${p}`, 'test-key', '1TestAddress')
    assert.deepEqual(result, utxos)
  })

  it('throws on non-200 response', async () => {
    const p = await startMockServer((req, res) => {
      res.writeHead(401)
      res.end('Unauthorized')
    })

    await assert.rejects(
      () => fetchUtxos(`http://127.0.0.1:${p}`, 'bad-key', '1TestAddress'),
      /UTXO fetch failed: 401/
    )
  })
})

describe('broadcastTx', () => {
  it('sends POST with rawTx body', async () => {
    const p = await startMockServer((req, res) => {
      assert.equal(req.method, 'POST')
      assert.ok(req.url.includes('/api/tx/broadcast'))
      assert.equal(req.headers['content-type'], 'application/json')
      assert.equal(req.headers['x-api-key'], 'test-key')

      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        assert.equal(parsed.rawTx, 'deadbeef')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ txid: 'aa'.repeat(32) }))
      })
    })

    const result = await broadcastTx(`http://127.0.0.1:${p}`, 'test-key', 'deadbeef')
    assert.equal(result.txid, 'aa'.repeat(32))
  })

  it('throws on broadcast failure', async () => {
    const p = await startMockServer((req, res) => {
      res.writeHead(500)
      res.end('Internal Server Error')
    })

    await assert.rejects(
      () => broadcastTx(`http://127.0.0.1:${p}`, 'test-key', 'deadbeef'),
      /Broadcast failed: 500/
    )
  })
})

describe('fetchAddressHistory', () => {
  it('returns parsed JSON on success', async () => {
    const history = [{ tx_hash: 'bb'.repeat(32), height: 100 }]
    const p = await startMockServer((req, res) => {
      assert.ok(req.url.includes('/api/address/'))
      assert.ok(req.url.includes('/history'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(history))
    })

    const result = await fetchAddressHistory(`http://127.0.0.1:${p}`, 'test-key', '1TestAddress')
    assert.deepEqual(result, history)
  })

  it('throws on non-200 response', async () => {
    const p = await startMockServer((req, res) => {
      res.writeHead(404)
      res.end('Not Found')
    })

    await assert.rejects(
      () => fetchAddressHistory(`http://127.0.0.1:${p}`, 'test-key', '1TestAddress'),
      /Address history failed: 404/
    )
  })
})

describe('fetchTxHex', () => {
  it('returns raw hex text on success', async () => {
    const rawHex = 'deadbeefcafebabe'
    const p = await startMockServer((req, res) => {
      assert.ok(req.url.includes('/api/tx/'))
      assert.ok(req.url.includes('/hex'))
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(rawHex)
    })

    const result = await fetchTxHex(`http://127.0.0.1:${p}`, 'test-key', 'cc'.repeat(32))
    assert.equal(result, rawHex)
  })

  it('throws on non-200 response', async () => {
    const p = await startMockServer((req, res) => {
      res.writeHead(403)
      res.end('Forbidden')
    })

    await assert.rejects(
      () => fetchTxHex(`http://127.0.0.1:${p}`, 'test-key', 'cc'.repeat(32)),
      /TX fetch failed: 403/
    )
  })
})
