import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistentStore } from '../lib/persistent-store.js'

let store
let tempDir

async function setup () {
  tempDir = await mkdtemp(join(tmpdir(), 'bridge-store-'))
  store = new PersistentStore(tempDir)
  await store.open()
}

async function teardown () {
  if (store) await store.close()
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
}

describe('PersistentStore', () => {
  afterEach(teardown)

  describe('open/close', () => {
    it('emits open event', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bridge-store-'))
      store = new PersistentStore(tempDir)
      let opened = false
      store.on('open', () => { opened = true })
      await store.open()
      assert.equal(opened, true)
    })
  })

  describe('headers', () => {
    it('stores and retrieves a header', async () => {
      await setup()
      const header = { height: 100, hash: 'abc123', prevHash: 'def456' }
      await store.putHeader(header)
      const got = await store.getHeader(100)
      assert.deepEqual(got, header)
    })

    it('returns null for missing header', async () => {
      await setup()
      const got = await store.getHeader(999)
      assert.equal(got, null)
    })

    it('stores multiple headers in batch', async () => {
      await setup()
      const headers = [
        { height: 1, hash: 'h1', prevHash: 'genesis' },
        { height: 2, hash: 'h2', prevHash: 'h1' },
        { height: 3, hash: 'h3', prevHash: 'h2' }
      ]
      await store.putHeaders(headers)
      assert.deepEqual(await store.getHeader(1), headers[0])
      assert.deepEqual(await store.getHeader(2), headers[1])
      assert.deepEqual(await store.getHeader(3), headers[2])
    })

    it('persists headers across close/reopen', async () => {
      await setup()
      await store.putHeader({ height: 50, hash: 'persist', prevHash: 'prev' })
      await store.close()
      store = new PersistentStore(tempDir)
      await store.open()
      const got = await store.getHeader(50)
      assert.equal(got.hash, 'persist')
    })
  })

  describe('transactions', () => {
    it('stores and retrieves a tx', async () => {
      await setup()
      await store.putTx('txid1', '0100000001abcdef')
      const got = await store.getTx('txid1')
      assert.equal(got, '0100000001abcdef')
    })

    it('returns null for missing tx', async () => {
      await setup()
      const got = await store.getTx('nonexistent')
      assert.equal(got, null)
    })

    it('hasTx returns true/false', async () => {
      await setup()
      await store.putTx('exists', 'deadbeef')
      assert.equal(await store.hasTx('exists'), true)
      assert.equal(await store.hasTx('nope'), false)
    })
  })

  describe('UTXOs', () => {
    it('stores and retrieves unspent UTXOs', async () => {
      await setup()
      const utxo = { txid: 'tx1', vout: 0, satoshis: 50000, scriptHex: 'script1', address: '1ABC' }
      await store.putUtxo(utxo)
      const unspent = await store.getUnspentUtxos()
      assert.equal(unspent.length, 1)
      assert.equal(unspent[0].txid, 'tx1')
      assert.equal(unspent[0].satoshis, 50000)
      assert.equal(unspent[0].spent, false)
    })

    it('marks UTXO as spent', async () => {
      await setup()
      await store.putUtxo({ txid: 'tx1', vout: 0, satoshis: 10000, scriptHex: 's1', address: '1A' })
      await store.putUtxo({ txid: 'tx2', vout: 1, satoshis: 20000, scriptHex: 's2', address: '1A' })
      await store.spendUtxo('tx1', 0)
      const unspent = await store.getUnspentUtxos()
      assert.equal(unspent.length, 1)
      assert.equal(unspent[0].txid, 'tx2')
    })

    it('getBalance returns sum of unspent', async () => {
      await setup()
      await store.putUtxo({ txid: 'a', vout: 0, satoshis: 30000, scriptHex: 's', address: '1X' })
      await store.putUtxo({ txid: 'b', vout: 0, satoshis: 20000, scriptHex: 's', address: '1X' })
      await store.putUtxo({ txid: 'c', vout: 0, satoshis: 10000, scriptHex: 's', address: '1X' })
      await store.spendUtxo('b', 0)
      const balance = await store.getBalance()
      assert.equal(balance, 40000) // 30000 + 10000
    })

    it('spendUtxo is no-op for nonexistent UTXO', async () => {
      await setup()
      await store.spendUtxo('nonexistent', 0) // should not throw
    })
  })

  describe('watched address matches', () => {
    it('stores and retrieves matches by address', async () => {
      await setup()
      await store.putWatchedTx({ txid: 'tx1', address: '1ABC', direction: 'in', timestamp: 1000 })
      await store.putWatchedTx({ txid: 'tx2', address: '1ABC', direction: 'out', timestamp: 2000 })
      await store.putWatchedTx({ txid: 'tx3', address: '1DEF', direction: 'in', timestamp: 3000 })

      const abc = await store.getWatchedTxs('1ABC')
      assert.equal(abc.length, 2)

      const def = await store.getWatchedTxs('1DEF')
      assert.equal(def.length, 1)
      assert.equal(def[0].txid, 'tx3')
    })
  })

  describe('metadata', () => {
    it('stores and retrieves metadata', async () => {
      await setup()
      await store.putMeta('bestHeight', 938000)
      const got = await store.getMeta('bestHeight')
      assert.equal(got, 938000)
    })

    it('returns default for missing key', async () => {
      await setup()
      const got = await store.getMeta('missing', 'fallback')
      assert.equal(got, 'fallback')
    })

    it('stores complex objects', async () => {
      await setup()
      const obj = { peers: ['a', 'b'], count: 2 }
      await store.putMeta('peerSnapshot', obj)
      const got = await store.getMeta('peerSnapshot')
      assert.deepEqual(got, obj)
    })

    it('persists metadata across restarts', async () => {
      await setup()
      await store.putMeta('version', '1.0.0')
      await store.close()
      store = new PersistentStore(tempDir)
      await store.open()
      assert.equal(await store.getMeta('version'), '1.0.0')
    })
  })
})
