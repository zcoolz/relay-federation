import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { buildRegistrationTx, buildDeregistrationTx } from '../lib/registration.js'
import { scanRegistry, parseRegistryTx, BEACON_ADDRESS } from '../lib/scanner.js'
import { BEACON_SATOSHIS } from '../lib/cbor.js'

const testKey = PrivateKey.fromRandom()
const testWif = testKey.toWif()
const fakeStakeTxid = new Uint8Array(32).fill(0xde)

function createFakeUtxo (privateKey, satoshis = 100000) {
  const address = privateKey.toPublicKey().toAddress()
  const p2pkh = new P2PKH()
  const fakeTx = new Transaction()
  fakeTx.addOutput({ lockingScript: p2pkh.lock(address), satoshis })
  return { tx_hash: fakeTx.id('hex'), tx_pos: 0, value: satoshis, rawHex: fakeTx.toHex() }
}

/**
 * Create a mock SPV server that serves address history and raw tx hex.
 * Takes a map of txid → { rawHex, height }.
 */
function createMockServer (txMap) {
  const history = Object.entries(txMap).map(([txid, { height }]) => ({
    tx_hash: txid,
    height
  }))

  return http.createServer((req, res) => {
    if (req.url.includes('/api/address/') && req.url.endsWith('/history')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(history))
      return
    }

    const hexMatch = req.url.match(/\/api\/tx\/([a-f0-9]+)\/hex/)
    if (hexMatch) {
      const txid = hexMatch[1]
      const entry = txMap[txid]
      if (entry) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(entry.rawHex)
      } else {
        res.writeHead(404)
        res.end('not found')
      }
      return
    }

    res.writeHead(404)
    res.end('not found')
  })
}

/** Start a server and return { server, baseUrl } */
async function startServer (txMap) {
  const server = createMockServer(txMap)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return { server, baseUrl }
}

describe('Chain scanner', () => {
  let regTx, deregTx
  const servers = []

  beforeEach(async () => {
    const utxo1 = createFakeUtxo(testKey)
    regTx = await buildRegistrationTx({
      wif: testWif,
      utxos: [utxo1],
      endpoint: 'wss://bridge1.example.com:8333',
      capabilities: ['tx_relay', 'header_sync', 'broadcast', 'address_history'],
      versions: ['1.0'],
      networkVersion: '1.0',
      stakeTxid: fakeStakeTxid,
      meshId: 'indelible'
    })

    const utxo2 = createFakeUtxo(testKey)
    deregTx = await buildDeregistrationTx({
      wif: testWif,
      utxos: [utxo2],
      reason: 'shutdown'
    })
  })

  afterEach(() => {
    for (const s of servers) s.close()
    servers.length = 0
  })

  it('scans and returns registration entries sorted by height', async () => {
    const { server, baseUrl } = await startServer({
      [regTx.txid]: { rawHex: regTx.txHex, height: 842100 },
      [deregTx.txid]: { rawHex: deregTx.txHex, height: 842200 }
    })
    servers.push(server)

    const entries = await scanRegistry({ spvEndpoint: baseUrl, apiKey: 'test_key' })

    assert.equal(entries.length, 2, 'should find 2 entries')
    assert.equal(entries[0].txid, regTx.txid)
    assert.equal(entries[0].height, 842100)
    assert.equal(entries[0].entry.action, 'register')
    assert.equal(entries[0].entry.endpoint, 'wss://bridge1.example.com:8333')
    assert.equal(entries[0].entry.mesh_id, 'indelible')
    assert.equal(entries[1].txid, deregTx.txid)
    assert.equal(entries[1].height, 842200)
    assert.equal(entries[1].entry.action, 'deregister')
    assert.equal(entries[1].entry.reason, 'shutdown')
  })

  it('skips non-registry transactions gracefully', async () => {
    const p2pkh = new P2PKH()
    const plainTx = new Transaction()
    plainTx.addOutput({
      lockingScript: p2pkh.lock(testKey.toPublicKey().toAddress()),
      satoshis: 5000
    })

    const { server, baseUrl } = await startServer({
      [regTx.txid]: { rawHex: regTx.txHex, height: 842100 },
      [plainTx.id('hex')]: { rawHex: plainTx.toHex(), height: 842150 }
    })
    servers.push(server)

    const entries = await scanRegistry({ spvEndpoint: baseUrl, apiKey: 'test_key' })
    assert.equal(entries.length, 1, 'should only find the registration')
    assert.equal(entries[0].entry.action, 'register')
  })

  it('returns empty array when no registry txs exist', async () => {
    const emptyServer = http.createServer((req, res) => {
      if (req.url.includes('/history')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('[]')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise(resolve => emptyServer.listen(0, '127.0.0.1', resolve))
    servers.push(emptyServer)

    const entries = await scanRegistry({
      spvEndpoint: `http://127.0.0.1:${emptyServer.address().port}`,
      apiKey: 'test_key'
    })
    assert.equal(entries.length, 0)
  })

  it('beacon address is deterministic', () => {
    assert.equal(BEACON_ADDRESS, '1KhH4VshyN8PnzxbTSjiojcQbbABNSZyzR')
    assert.equal(BEACON_SATOSHIS, 100)
  })

  it('parseRegistryTx extracts registration from raw hex', async () => {
    const { server, baseUrl } = await startServer({
      [regTx.txid]: { rawHex: regTx.txHex, height: 842100 }
    })
    servers.push(server)

    const entry = await parseRegistryTx(baseUrl, 'test_key', regTx.txid)
    assert.ok(entry, 'should return a parsed entry')
    assert.equal(entry.action, 'register')
    assert.equal(entry.endpoint, 'wss://bridge1.example.com:8333')
    assert.deepEqual(entry.capabilities, ['tx_relay', 'header_sync', 'broadcast', 'address_history'])
  })

  it('parseRegistryTx extracts deregistration from raw hex', async () => {
    const { server, baseUrl } = await startServer({
      [deregTx.txid]: { rawHex: deregTx.txHex, height: 842200 }
    })
    servers.push(server)

    const entry = await parseRegistryTx(baseUrl, 'test_key', deregTx.txid)
    assert.ok(entry, 'should return a parsed entry')
    assert.equal(entry.action, 'deregister')
    assert.equal(entry.reason, 'shutdown')
  })
})
