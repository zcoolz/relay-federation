import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, Script } from '@bsv/sdk'
import { PersistentStore } from '../lib/persistent-store.js'
import { pubkeyToHash160, checkTxForWatched } from '../lib/output-parser.js'

let tempDir

async function teardown () {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
}

// Build a tx paying to a specific pubkey hash160
function buildFundingTx (recipientPubHex, satoshis = 100000) {
  const hash160 = pubkeyToHash160(recipientPubHex)
  const lockingScript = Script.fromHex(`76a914${hash160}88ac`)
  const fakePrevTxid = 'aa'.repeat(32)

  const tx = new Transaction()
  tx.addInput({
    sourceTXID: fakePrevTxid,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  tx.addOutput({ lockingScript, satoshis })

  return { rawHex: tx.toHex(), txid: tx.id('hex'), hash160 }
}

// Build a tx with two outputs — one to recipient, one to someone else
function buildMultiOutputTx (recipientPubHex, otherPubHex, sat1 = 50000, sat2 = 30000) {
  const hash1 = pubkeyToHash160(recipientPubHex)
  const hash2 = pubkeyToHash160(otherPubHex)
  const fakePrevTxid = 'bb'.repeat(32)

  const tx = new Transaction()
  tx.addInput({
    sourceTXID: fakePrevTxid,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  tx.addOutput({ lockingScript: Script.fromHex(`76a914${hash1}88ac`), satoshis: sat1 })
  tx.addOutput({ lockingScript: Script.fromHex(`76a914${hash2}88ac`), satoshis: sat2 })

  return { rawHex: tx.toHex(), txid: tx.id('hex') }
}

describe('fund command logic', () => {
  afterEach(teardown)

  it('detects and stores UTXO for bridge address', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fund-test-'))
    const store = new PersistentStore(tempDir)
    await store.open()

    const bridgeKey = PrivateKey.fromRandom()
    const pubHex = bridgeKey.toPublicKey().toString()
    const hash160 = pubkeyToHash160(pubHex)

    const { rawHex, txid } = buildFundingTx(pubHex, 100000)
    const result = checkTxForWatched(rawHex, new Set([hash160]))

    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].satoshis, 100000)

    for (const match of result.matches) {
      await store.putUtxo({
        txid: result.txid,
        vout: match.vout,
        satoshis: match.satoshis,
        scriptHex: match.scriptHex,
        address: pubHex
      })
    }
    await store.putTx(result.txid, rawHex)

    const utxos = await store.getUnspentUtxos()
    assert.equal(utxos.length, 1)
    assert.equal(utxos[0].txid, txid)
    assert.equal(utxos[0].satoshis, 100000)

    const balance = await store.getBalance()
    assert.equal(balance, 100000)

    await store.close()
  })

  it('ignores outputs to other addresses', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fund-test-'))
    const store = new PersistentStore(tempDir)
    await store.open()

    const bridgeKey = PrivateKey.fromRandom()
    const otherKey = PrivateKey.fromRandom()
    const pubHex = bridgeKey.toPublicKey().toString()
    const hash160 = pubkeyToHash160(pubHex)

    // Tx pays to OTHER address, not bridge
    const { rawHex } = buildFundingTx(otherKey.toPublicKey().toString(), 50000)
    const result = checkTxForWatched(rawHex, new Set([hash160]))

    assert.equal(result.matches.length, 0)

    const balance = await store.getBalance()
    assert.equal(balance, 0)

    await store.close()
  })

  it('picks only matching output from multi-output tx', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fund-test-'))
    const store = new PersistentStore(tempDir)
    await store.open()

    const bridgeKey = PrivateKey.fromRandom()
    const otherKey = PrivateKey.fromRandom()
    const bridgePub = bridgeKey.toPublicKey().toString()
    const otherPub = otherKey.toPublicKey().toString()
    const hash160 = pubkeyToHash160(bridgePub)

    const { rawHex, txid } = buildMultiOutputTx(bridgePub, otherPub, 60000, 40000)
    const result = checkTxForWatched(rawHex, new Set([hash160]))

    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].vout, 0)
    assert.equal(result.matches[0].satoshis, 60000)

    for (const match of result.matches) {
      await store.putUtxo({
        txid: result.txid,
        vout: match.vout,
        satoshis: match.satoshis,
        scriptHex: match.scriptHex,
        address: bridgePub
      })
    }

    const balance = await store.getBalance()
    assert.equal(balance, 60000)

    await store.close()
  })

  it('accumulates balance from multiple fund operations', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fund-test-'))
    const store = new PersistentStore(tempDir)
    await store.open()

    const bridgeKey = PrivateKey.fromRandom()
    const bridgePub = bridgeKey.toPublicKey().toString()
    const hash160 = pubkeyToHash160(bridgePub)

    // Fund tx 1
    const fund1 = buildFundingTx(bridgePub, 50000)
    const r1 = checkTxForWatched(fund1.rawHex, new Set([hash160]))
    for (const m of r1.matches) {
      await store.putUtxo({ txid: r1.txid, vout: m.vout, satoshis: m.satoshis, scriptHex: m.scriptHex, address: bridgePub })
    }

    // Fund tx 2 (different tx)
    const fund2 = buildFundingTx(bridgePub, 75000)
    const r2 = checkTxForWatched(fund2.rawHex, new Set([hash160]))
    for (const m of r2.matches) {
      await store.putUtxo({ txid: r2.txid, vout: m.vout, satoshis: m.satoshis, scriptHex: m.scriptHex, address: bridgePub })
    }

    const balance = await store.getBalance()
    assert.equal(balance, 125000)

    const utxos = await store.getUnspentUtxos()
    assert.equal(utxos.length, 2)

    await store.close()
  })

  it('persists funded UTXOs across store restart', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fund-test-'))
    let store = new PersistentStore(tempDir)
    await store.open()

    const bridgeKey = PrivateKey.fromRandom()
    const bridgePub = bridgeKey.toPublicKey().toString()
    const hash160 = pubkeyToHash160(bridgePub)

    const { rawHex } = buildFundingTx(bridgePub, 80000)
    const result = checkTxForWatched(rawHex, new Set([hash160]))
    for (const m of result.matches) {
      await store.putUtxo({ txid: result.txid, vout: m.vout, satoshis: m.satoshis, scriptHex: m.scriptHex, address: bridgePub })
    }
    await store.putTx(result.txid, rawHex)

    // Close and reopen
    await store.close()
    store = new PersistentStore(tempDir)
    await store.open()

    const balance = await store.getBalance()
    assert.equal(balance, 80000)

    const utxos = await store.getUnspentUtxos()
    assert.equal(utxos.length, 1)

    await store.close()
  })
})
