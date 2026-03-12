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

  describe('txStatus', () => {
    it('sets mempool status on new tx', async () => {
      await setup()
      const record = await store.updateTxStatus('tx1', 'mempool', { source: 'p2p' })
      assert.equal(record.state, 'mempool')
      assert.equal(record.source, 'p2p')
      assert.ok(record.firstSeen)
    })

    it('returns null for unknown tx', async () => {
      await setup()
      const got = await store.getTxStatus('nonexistent')
      assert.equal(got, null)
    })

    it('preserves firstSeen on update', async () => {
      await setup()
      const first = await store.updateTxStatus('tx1', 'mempool')
      const second = await store.updateTxStatus('tx1', 'confirmed', { blockHash: 'bh1', height: 100 })
      assert.equal(second.firstSeen, first.firstSeen)
      assert.equal(second.state, 'confirmed')
      assert.equal(second.blockHash, 'bh1')
    })
  })

  describe('txBlock + confirmTx', () => {
    it('confirms tx with block placement', async () => {
      await setup()
      await store.updateTxStatus('tx1', 'mempool')
      await store.confirmTx('tx1', 'blockhash1', 500, { nodes: ['a', 'b'], index: 3 })
      const status = await store.getTxStatus('tx1')
      assert.equal(status.state, 'confirmed')
      assert.equal(status.height, 500)
      const block = await store.getTxBlock('tx1')
      assert.equal(block.blockHash, 'blockhash1')
      assert.equal(block.height, 500)
      assert.equal(block.verified, true)
      assert.deepEqual(block.proof, { nodes: ['a', 'b'], index: 3 })
    })

    it('returns null for unconfirmed tx block', async () => {
      await setup()
      const got = await store.getTxBlock('nonexistent')
      assert.equal(got, null)
    })

    it('emits tx:confirmed event', async () => {
      await setup()
      let emitted = null
      store.on('tx:confirmed', (data) => { emitted = data })
      await store.confirmTx('tx1', 'bh1', 100)
      assert.ok(emitted)
      assert.equal(emitted.txid, 'tx1')
      assert.equal(emitted.blockHash, 'bh1')
    })
  })

  describe('handleReorg', () => {
    it('marks txs as orphaned when block disconnects', async () => {
      await setup()
      await store.confirmTx('tx1', 'blockA', 100)
      await store.confirmTx('tx2', 'blockA', 100)
      await store.confirmTx('tx3', 'blockB', 101)

      const affected = await store.handleReorg('blockA')
      assert.equal(affected.length, 2)
      assert.ok(affected.includes('tx1'))
      assert.ok(affected.includes('tx2'))

      const s1 = await store.getTxStatus('tx1')
      assert.equal(s1.state, 'orphaned')
      const s3 = await store.getTxStatus('tx3')
      assert.equal(s3.state, 'confirmed')

      // Block associations cleaned up
      assert.equal(await store.getTxBlock('tx1'), null)
      assert.equal(await store.getTxBlock('tx2'), null)
      assert.ok(await store.getTxBlock('tx3'))
    })

    it('returns empty array for unknown block', async () => {
      await setup()
      const affected = await store.handleReorg('nonexistent')
      assert.equal(affected.length, 0)
    })
  })

  describe('content CAS', () => {
    it('stores small content inline', async () => {
      await setup()
      const hex = Buffer.from('Hello CAS').toString('hex') // 9 bytes, well under 4KB
      const result = await store.putContent(hex, 'text/plain')
      assert.ok(result.contentHash)
      assert.equal(result.contentLen, 9)
      assert.equal(result.inline, true)
      assert.equal(result.contentPath, null)
      const bytes = await store.getContentBytes(result.contentHash)
      assert.equal(bytes.toString(), 'Hello CAS')
    })

    it('stores large content on filesystem', async () => {
      await setup()
      const big = Buffer.alloc(5000, 0x42).toString('hex') // 5000 bytes, over 4KB
      const result = await store.putContent(big, 'application/octet-stream')
      assert.ok(result.contentHash)
      assert.equal(result.contentLen, 5000)
      assert.equal(result.inline, false)
      assert.ok(result.contentPath)
      const bytes = await store.getContentBytes(result.contentHash)
      assert.equal(bytes.length, 5000)
      assert.equal(bytes[0], 0x42)
    })

    it('returns null for unknown content hash', async () => {
      await setup()
      const bytes = await store.getContentBytes('0000000000000000000000000000000000000000000000000000000000000000')
      assert.equal(bytes, null)
    })

    it('putInscription routes content through CAS', async () => {
      await setup()
      const bigContent = Buffer.alloc(5000, 0x41).toString('hex')
      await store.putInscription({
        txid: 'cas_tx1', vout: 0,
        contentType: 'image/png', contentSize: 5000,
        content: bigContent,
        isBsv20: false, bsv20: null,
        timestamp: Date.now(), address: 'addr1'
      })
      const record = await store.getInscription('cas_tx1', 0)
      // Large content stripped from record, contentHash stored
      assert.ok(record.contentHash)
      assert.ok(!record.content) // stripped because >= 4KB
      // But retrievable via CAS
      const bytes = await store.getContentBytes(record.contentHash)
      assert.equal(bytes.length, 5000)
    })

    it('putInscription keeps small content inline', async () => {
      await setup()
      const smallContent = Buffer.from('tiny').toString('hex')
      await store.putInscription({
        txid: 'cas_tx2', vout: 0,
        contentType: 'text/plain', contentSize: 4,
        content: smallContent,
        isBsv20: false, bsv20: null,
        timestamp: Date.now(), address: 'addr2'
      })
      const record = await store.getInscription('cas_tx2', 0)
      assert.ok(record.contentHash)
      assert.ok(record.content) // kept inline because < 4KB
    })
  })

  describe('token tracking (BSV-20)', () => {
    it('deploys a token', async () => {
      await setup()
      const result = await store.processTokenOp({
        op: 'deploy', tick: 'TEST', amt: { max: '21000000', lim: '1000', dec: '8' },
        ownerScriptHash: 'sh1', address: '1A', txid: 'dtx1', height: 850000, blockHash: 'bh1'
      })
      assert.equal(result.valid, true)
      const token = await store.getToken('test')
      assert.equal(token.tick, 'test')
      assert.equal(token.max, '21000000')
      assert.equal(token.totalMinted, '0')
    })

    it('rejects duplicate deploy', async () => {
      await setup()
      await store.processTokenOp({
        op: 'deploy', tick: 'TEST', amt: { max: '100', lim: '10', dec: '0' },
        ownerScriptHash: 'sh1', address: '1A', txid: 'dtx1', height: 850000, blockHash: 'bh1'
      })
      const dup = await store.processTokenOp({
        op: 'deploy', tick: 'TEST', amt: { max: '999', lim: '10', dec: '0' },
        ownerScriptHash: 'sh2', address: '1B', txid: 'dtx2', height: 850001, blockHash: 'bh2'
      })
      assert.equal(dup.valid, false)
      assert.equal(dup.reason, 'already deployed')
    })

    it('mints tokens and credits balance', async () => {
      await setup()
      await store.processTokenOp({
        op: 'deploy', tick: 'COIN', amt: { max: '1000', lim: '100', dec: '0' },
        ownerScriptHash: 'deployer', address: '1D', txid: 'dtx', height: 850000, blockHash: 'bh1'
      })
      const mint = await store.processTokenOp({
        op: 'mint', tick: 'COIN', amt: '50',
        ownerScriptHash: 'minter1', address: '1M', txid: 'mtx1', height: 850001, blockHash: 'bh2'
      })
      assert.equal(mint.valid, true)
      const bal = await store.getTokenBalance('coin', 'minter1')
      assert.equal(bal, '50')
      const token = await store.getToken('coin')
      assert.equal(token.totalMinted, '50')
    })

    it('rejects mint exceeding max supply', async () => {
      await setup()
      await store.processTokenOp({
        op: 'deploy', tick: 'LIM', amt: { max: '100', lim: '200', dec: '0' },
        ownerScriptHash: 'sh1', address: '1A', txid: 'dtx', height: 850000, blockHash: 'bh1'
      })
      const result = await store.processTokenOp({
        op: 'mint', tick: 'LIM', amt: '101',
        ownerScriptHash: 'sh2', address: '1B', txid: 'mtx', height: 850001, blockHash: 'bh2'
      })
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'exceeds max supply')
    })

    it('rejects mint exceeding per-tx limit', async () => {
      await setup()
      await store.processTokenOp({
        op: 'deploy', tick: 'CAP', amt: { max: '1000', lim: '10', dec: '0' },
        ownerScriptHash: 'sh1', address: '1A', txid: 'dtx', height: 850000, blockHash: 'bh1'
      })
      const result = await store.processTokenOp({
        op: 'mint', tick: 'CAP', amt: '11',
        ownerScriptHash: 'sh2', address: '1B', txid: 'mtx', height: 850001, blockHash: 'bh2'
      })
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'exceeds mint limit')
    })

    it('rejects mint for undeployed token', async () => {
      await setup()
      const result = await store.processTokenOp({
        op: 'mint', tick: 'NOPE', amt: '1',
        ownerScriptHash: 'sh1', address: '1A', txid: 'mtx', height: 850000, blockHash: 'bh1'
      })
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'token not deployed')
    })

    it('lists deployed tokens', async () => {
      await setup()
      await store.processTokenOp({
        op: 'deploy', tick: 'AAA', amt: { max: '100', lim: '10', dec: '0' },
        ownerScriptHash: 'sh1', address: '1A', txid: 'dtx1', height: 850000, blockHash: 'bh1'
      })
      await store.processTokenOp({
        op: 'deploy', tick: 'BBB', amt: { max: '200', lim: '20', dec: '0' },
        ownerScriptHash: 'sh2', address: '1B', txid: 'dtx2', height: 850001, blockHash: 'bh2'
      })
      const tokens = await store.listTokens()
      assert.equal(tokens.length, 2)
    })
  })

  describe('backfill support (resume + idempotency)', () => {
    it('stores and resumes backfill_height', async () => {
      await setup()
      assert.equal(await store.getMeta('backfill_height', null), null)
      await store.putMeta('backfill_height', 850000)
      assert.equal(await store.getMeta('backfill_height'), 850000)
    })

    it('applied marker prevents reprocessing', async () => {
      await setup()
      const txid = 'abc123'
      assert.equal(await store.getMeta(`applied!${txid}`, null), null)
      await store.putMeta(`applied!${txid}`, { height: 850000, blockHash: 'bh1' })
      const applied = await store.getMeta(`applied!${txid}`)
      assert.equal(applied.height, 850000)
    })

    it('backfill indexes inscription with block timestamp', async () => {
      await setup()
      const blockTime = 1700000000
      await store.putInscription({
        txid: 'backfill_tx1', vout: 0,
        contentType: 'text/plain', contentSize: 5,
        content: '48656c6c6f',
        isBsv20: false, bsv20: null,
        timestamp: blockTime * 1000,
        address: 'addr1'
      })
      const record = await store.getInscription('backfill_tx1', 0)
      assert.equal(record.contentType, 'text/plain')
      assert.equal(record.timestamp, blockTime * 1000)
    })
  })
})
