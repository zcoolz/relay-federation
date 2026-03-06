import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, Transaction, P2PKH, Script } from '@bsv/sdk'
import {
  parseTx,
  parseOutputScript,
  pubkeyToHash160,
  checkTxForWatched
} from '../lib/output-parser.js'

// Build a test transaction with P2PKH outputs
// Uses a dummy unlocking script since we only need to parse outputs
function buildTestTx () {
  const senderKey = PrivateKey.fromRandom()
  const recipientKey = PrivateKey.fromRandom()

  const senderPub = senderKey.toPublicKey()
  const recipientPub = recipientKey.toPublicKey()

  const fakePrevTxid = 'aa'.repeat(32)

  const tx = new Transaction()
  tx.addInput({
    sourceTXID: fakePrevTxid,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex('00'), // dummy script for serialization
    sequence: 0xffffffff
  })
  // Output 0: pay to recipient
  tx.addOutput({
    lockingScript: new P2PKH().lock(recipientPub.toAddress()),
    satoshis: 50000
  })
  // Output 1: change back to sender
  tx.addOutput({
    lockingScript: new P2PKH().lock(senderPub.toAddress()),
    satoshis: 49000
  })

  return {
    rawHex: tx.toHex(),
    txid: tx.id('hex'),
    fundingTxid: fakePrevTxid,
    senderPubHex: senderPub.toString(),
    recipientPubHex: recipientPub.toString()
  }
}

describe('parseOutputScript', () => {
  it('detects standard P2PKH script', () => {
    // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    const script = '76a914' + 'ab'.repeat(20) + '88ac'
    const result = parseOutputScript(script)
    assert.equal(result.isP2PKH, true)
    assert.equal(result.hash160, 'ab'.repeat(20))
  })

  it('rejects non-P2PKH script', () => {
    // OP_RETURN data
    const script = '006a' + '48656c6c6f'
    const result = parseOutputScript(script)
    assert.equal(result.isP2PKH, false)
    assert.equal(result.hash160, null)
  })

  it('rejects truncated P2PKH script', () => {
    const script = '76a914' + 'ab'.repeat(10) + '88ac'
    const result = parseOutputScript(script)
    assert.equal(result.isP2PKH, false)
  })
})

describe('pubkeyToHash160', () => {
  it('produces consistent hash160 for same pubkey', () => {
    const key = PrivateKey.fromRandom().toPublicKey()
    const hex = key.toString()
    const h1 = pubkeyToHash160(hex)
    const h2 = pubkeyToHash160(hex)
    assert.equal(h1, h2)
    assert.equal(h1.length, 40) // 20 bytes = 40 hex chars
  })

  it('different pubkeys produce different hash160s', () => {
    const k1 = PrivateKey.fromRandom().toPublicKey().toString()
    const k2 = PrivateKey.fromRandom().toPublicKey().toString()
    assert.notEqual(pubkeyToHash160(k1), pubkeyToHash160(k2))
  })
})

describe('parseTx', () => {
  it('parses a real transaction with inputs and outputs', () => {
    const { rawHex, fundingTxid } = buildTestTx()
    const parsed = parseTx(rawHex)

    assert.equal(typeof parsed.txid, 'string')
    assert.equal(parsed.txid.length, 64)

    // 1 input spending from funding tx
    assert.equal(parsed.inputs.length, 1)
    assert.equal(parsed.inputs[0].prevTxid, fundingTxid)
    assert.equal(parsed.inputs[0].prevVout, 0)

    // 2 outputs (recipient + change)
    assert.equal(parsed.outputs.length, 2)

    // Both should be P2PKH
    assert.equal(parsed.outputs[0].isP2PKH, true)
    assert.equal(parsed.outputs[1].isP2PKH, true)

    // Check satoshi values
    assert.equal(parsed.outputs[0].satoshis, 50000)
    assert.equal(parsed.outputs[1].satoshis, 49000)

    // hash160 should be 40 hex chars
    assert.equal(parsed.outputs[0].hash160.length, 40)
    assert.equal(parsed.outputs[1].hash160.length, 40)

    // Different recipients = different hash160s
    assert.notEqual(parsed.outputs[0].hash160, parsed.outputs[1].hash160)
  })
})

describe('checkTxForWatched', () => {
  it('finds matching outputs for watched address', () => {
    const { rawHex, recipientPubHex } = buildTestTx()
    const recipientHash = pubkeyToHash160(recipientPubHex)
    const watched = new Set([recipientHash])

    const result = checkTxForWatched(rawHex, watched)

    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].vout, 0)
    assert.equal(result.matches[0].satoshis, 50000)
    assert.equal(result.matches[0].hash160, recipientHash)
  })

  it('finds change output when watching sender', () => {
    const { rawHex, senderPubHex } = buildTestTx()
    const senderHash = pubkeyToHash160(senderPubHex)
    const watched = new Set([senderHash])

    const result = checkTxForWatched(rawHex, watched)

    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].vout, 1) // change is output 1
    assert.equal(result.matches[0].satoshis, 49000)
  })

  it('finds both outputs when watching both addresses', () => {
    const { rawHex, senderPubHex, recipientPubHex } = buildTestTx()
    const watched = new Set([
      pubkeyToHash160(senderPubHex),
      pubkeyToHash160(recipientPubHex)
    ])

    const result = checkTxForWatched(rawHex, watched)
    assert.equal(result.matches.length, 2)
  })

  it('returns empty matches for unwatched addresses', () => {
    const { rawHex } = buildTestTx()
    const randomHash = pubkeyToHash160(PrivateKey.fromRandom().toPublicKey().toString())
    const watched = new Set([randomHash])

    const result = checkTxForWatched(rawHex, watched)
    assert.equal(result.matches.length, 0)
  })

  it('returns input spends regardless of matches', () => {
    const { rawHex, fundingTxid } = buildTestTx()
    const watched = new Set()

    const result = checkTxForWatched(rawHex, watched)
    assert.equal(result.spends.length, 1)
    assert.equal(result.spends[0].prevTxid, fundingTxid)
    assert.equal(result.spends[0].prevVout, 0)
  })
})
