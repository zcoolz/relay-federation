import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, Transaction, P2PKH, OP } from '@bsv/sdk'
import { buildStakeBondTx, encodeScriptNum } from '../lib/stake-bond.js'

const testKey = PrivateKey.fromRandom()
const testWif = testKey.toWif()

function createFakeUtxo (privateKey, satoshis = 100000) {
  const address = privateKey.toPublicKey().toAddress()
  const p2pkh = new P2PKH()
  const fakeTx = new Transaction()
  fakeTx.addOutput({ lockingScript: p2pkh.lock(address), satoshis })
  return { tx_hash: fakeTx.id('hex'), tx_pos: 0, value: satoshis, rawHex: fakeTx.toHex() }
}

describe('Stake bond tx builder', () => {
  it('builds a valid stake bond transaction', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo],
      stakeAmountSats: 1000,
      lockDays: 30
    })

    assert.ok(result.txHex)
    assert.ok(result.txid)
    assert.equal(result.txid.length, 64)
    assert.equal(result.stakeOutputIndex, 0)
    assert.ok(result.unlockTime > Math.floor(Date.now() / 1000))

    // Parse and verify
    const tx = Transaction.fromHex(result.txHex)
    assert.ok(tx.outputs.length >= 2, 'should have stake + change outputs')

    // Stake output should have the correct satoshis
    assert.equal(tx.outputs[0].satoshis, 1000)
  })

  it('stake output contains OP_CHECKLOCKTIMEVERIFY', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo],
      stakeAmountSats: 1000,
      lockDays: 30
    })

    const tx = Transaction.fromHex(result.txHex)
    const scriptHex = tx.outputs[0].lockingScript.toHex()

    // OP_CHECKLOCKTIMEVERIFY = 0xb1, OP_DROP = 0x75
    assert.ok(scriptHex.includes('b175'), 'script should contain CLTV + DROP')

    // OP_DUP OP_HASH160 = 76a9, OP_EQUALVERIFY OP_CHECKSIG = 88ac
    assert.ok(scriptHex.includes('76a9'), 'script should contain DUP HASH160')
    assert.ok(scriptHex.includes('88ac'), 'script should contain EQUALVERIFY CHECKSIG')
  })

  it('locktime is approximately 30 days from now', async () => {
    const utxo = createFakeUtxo(testKey)
    const before = Math.floor(Date.now() / 1000)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo],
      stakeAmountSats: 1000,
      lockDays: 30
    })
    const after = Math.floor(Date.now() / 1000)

    const expectedMin = before + (30 * 86400)
    const expectedMax = after + (30 * 86400)
    assert.ok(result.unlockTime >= expectedMin, 'unlock time should be >= 30 days from start')
    assert.ok(result.unlockTime <= expectedMax, 'unlock time should be <= 30 days from end')
  })

  it('defaults to 30 days if lockDays not specified', async () => {
    const utxo = createFakeUtxo(testKey)
    const before = Math.floor(Date.now() / 1000)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo],
      stakeAmountSats: 1000
    })

    const thirtyDays = 30 * 86400
    assert.ok(result.unlockTime >= before + thirtyDays)
  })

  it('txid can be used as stake_txid in registration', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo],
      stakeAmountSats: 1000
    })

    // Convert txid hex to 32-byte Uint8Array (as required by CBOR registration)
    const txidBytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      txidBytes[i] = parseInt(result.txid.slice(i * 2, i * 2 + 2), 16)
    }
    assert.equal(txidBytes.length, 32)
  })
})

describe('encodeScriptNum', () => {
  it('encodes 0', () => {
    assert.deepEqual(encodeScriptNum(0), [0x00])
  })

  it('encodes small numbers', () => {
    assert.deepEqual(encodeScriptNum(1), [0x01])
    assert.deepEqual(encodeScriptNum(127), [0x7f])
  })

  it('encodes 128 with sign byte', () => {
    // 128 = 0x80, but high bit set means we need a 0x00 sign byte
    assert.deepEqual(encodeScriptNum(128), [0x80, 0x00])
  })

  it('encodes a unix timestamp (multi-byte)', () => {
    const ts = 1741190400 // March 5, 2026
    const encoded = encodeScriptNum(ts)
    assert.ok(encoded.length >= 4, 'timestamp should be at least 4 bytes')

    // Verify round-trip: decode back
    let decoded = 0
    for (let i = 0; i < encoded.length; i++) {
      decoded |= (encoded[i] & 0xff) << (8 * i)
    }
    assert.equal(decoded, ts)
  })
})
