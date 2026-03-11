import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, Transaction, P2PKH, Script } from '@bsv/sdk'
import {
  parseTx,
  parseOutputScript,
  pubkeyToHash160,
  checkTxForWatched,
  parseOpReturn,
  parseOrdinal
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

// --- Phase 3: Protocol parsing tests ---

// Helper to build hex push data: length byte + data
function pushHex (hexData) {
  const len = hexData.length / 2
  if (len <= 75) return len.toString(16).padStart(2, '0') + hexData
  if (len <= 255) return '4c' + len.toString(16).padStart(2, '0') + hexData
  return '4d' + (len & 0xff).toString(16).padStart(2, '0') + ((len >> 8) & 0xff).toString(16).padStart(2, '0') + hexData
}

function strToHex (str) {
  return Buffer.from(str, 'utf8').toString('hex')
}

describe('parseOutputScript — type detection', () => {
  it('returns type=p2pkh for P2PKH scripts', () => {
    const script = '76a914' + 'ab'.repeat(20) + '88ac'
    const result = parseOutputScript(script)
    assert.equal(result.type, 'p2pkh')
    assert.equal(result.isP2PKH, true)
    assert.equal(result.protocol, null)
  })

  it('returns type=op_return for OP_RETURN scripts', () => {
    const data = strToHex('hello world')
    const script = '6a' + pushHex(data)
    const result = parseOutputScript(script)
    assert.equal(result.type, 'op_return')
    assert.equal(result.isP2PKH, false)
    assert.equal(result.hash160, null)
    assert.ok(Array.isArray(result.data))
    assert.equal(result.data.length, 1)
  })

  it('returns type=op_return for OP_FALSE OP_RETURN scripts', () => {
    const data = strToHex('test data')
    const script = '006a' + pushHex(data)
    const result = parseOutputScript(script)
    assert.equal(result.type, 'op_return')
    assert.equal(result.isP2PKH, false)
  })

  it('returns type=p2sh for P2SH scripts', () => {
    const script = 'a914' + 'cc'.repeat(20) + '87'
    const result = parseOutputScript(script)
    assert.equal(result.type, 'p2sh')
    assert.equal(result.parsed.scriptHash, 'cc'.repeat(20))
  })

  it('returns type=unknown for unrecognized scripts', () => {
    const script = 'aabbccdd'
    const result = parseOutputScript(script)
    assert.equal(result.type, 'unknown')
    assert.equal(result.isP2PKH, false)
    assert.equal(result.hash160, null)
  })
})

describe('parseOpReturn', () => {
  it('extracts multiple push data segments', () => {
    const push1 = strToHex('hello')
    const push2 = strToHex('world')
    const script = '6a' + pushHex(push1) + pushHex(push2)
    const result = parseOpReturn(script)
    assert.ok(result)
    assert.equal(result.pushes.length, 2)
    assert.equal(result.pushes[0], push1)
    assert.equal(result.pushes[1], push2)
    assert.equal(result.isFalseReturn, false)
  })

  it('handles OP_FALSE OP_RETURN', () => {
    const push1 = strToHex('data')
    const script = '006a' + pushHex(push1)
    const result = parseOpReturn(script)
    assert.ok(result)
    assert.equal(result.isFalseReturn, true)
    assert.equal(result.pushes.length, 1)
  })

  it('returns null for non-OP_RETURN scripts', () => {
    const script = '76a914' + 'ab'.repeat(20) + '88ac'
    const result = parseOpReturn(script)
    assert.equal(result, null)
  })

  it('handles OP_0 pushes as empty strings', () => {
    // OP_RETURN OP_0 <data>
    const data = strToHex('after-zero')
    const script = '6a' + '00' + pushHex(data)
    const result = parseOpReturn(script)
    assert.ok(result)
    assert.equal(result.pushes[0], '')
    assert.equal(result.pushes[1], data)
  })
})

describe('B:// protocol detection', () => {
  it('detects B:// protocol and extracts fields', () => {
    const prefix = strToHex('19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut')
    const fileData = strToHex('file content here')
    const mime = strToHex('text/plain')
    const encoding = strToHex('UTF-8')
    const filename = strToHex('test.txt')
    const script = '006a' + pushHex(prefix) + pushHex(fileData) + pushHex(mime) + pushHex(encoding) + pushHex(filename)

    const result = parseOutputScript(script)
    assert.equal(result.type, 'op_return')
    assert.equal(result.protocol, 'b')
    assert.ok(result.parsed)
    assert.equal(result.parsed.mimeType, 'text/plain')
    assert.equal(result.parsed.encoding, 'UTF-8')
    assert.equal(result.parsed.filename, 'test.txt')
    assert.equal(result.parsed.data, fileData)
  })
})

describe('BCAT protocol detection', () => {
  it('detects BCAT linker and extracts chunk txids', () => {
    const prefix = strToHex('15DHFxWZJT58f9nhyGnsRBqrgwK4W6h4Up')
    const info = strToHex('test file')
    const mime = strToHex('image/png')
    const charset = strToHex('')
    const filename = strToHex('image.png')
    const flag = strToHex('')
    const txid1 = 'aa'.repeat(32)
    const txid2 = 'bb'.repeat(32)
    const script = '006a' + pushHex(prefix) + pushHex(info) + pushHex(mime) + pushHex(charset) + pushHex(filename) + pushHex(flag) + pushHex(txid1) + pushHex(txid2)

    const result = parseOutputScript(script)
    assert.equal(result.protocol, 'bcat')
    assert.equal(result.parsed.mimeType, 'image/png')
    assert.equal(result.parsed.filename, 'image.png')
    assert.equal(result.parsed.chunkTxids.length, 2)
    assert.equal(result.parsed.chunkTxids[0], txid1)
    assert.equal(result.parsed.chunkTxids[1], txid2)
  })

  it('detects BCAT part', () => {
    const prefix = strToHex('1ChDHzdd1H4wSjgGMHyndZm6qxEDGjqpJL')
    const chunkData = 'deadbeef'.repeat(10)
    const script = '006a' + pushHex(prefix) + pushHex(chunkData)

    const result = parseOutputScript(script)
    assert.equal(result.protocol, 'bcat-part')
    assert.equal(result.parsed.data, chunkData)
  })
})

describe('MAP protocol detection', () => {
  it('detects MAP and extracts key-value pairs', () => {
    const prefix = strToHex('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5')
    const action = strToHex('SET')
    const key1 = strToHex('app')
    const val1 = strToHex('myapp')
    const key2 = strToHex('type')
    const val2 = strToHex('post')
    const script = '006a' + pushHex(prefix) + pushHex(action) + pushHex(key1) + pushHex(val1) + pushHex(key2) + pushHex(val2)

    const result = parseOutputScript(script)
    assert.equal(result.protocol, 'map')
    assert.equal(result.parsed.action, 'SET')
    assert.equal(result.parsed.pairs.app, 'myapp')
    assert.equal(result.parsed.pairs.type, 'post')
  })
})

describe('MetaNet protocol detection', () => {
  it('detects MetaNet by magic bytes', () => {
    const metaMagic = '6d657461' // "meta"
    const nodeAddr = strToHex('1J4hrKAHGcgfGTZZoSUFy4F1rkxBLiWY8s')
    const parentTxid = 'ff'.repeat(32)
    const script = '006a' + pushHex(metaMagic) + pushHex(nodeAddr) + pushHex(parentTxid)

    const result = parseOutputScript(script)
    assert.equal(result.protocol, 'metanet')
    assert.equal(result.parsed.nodeAddress, '1J4hrKAHGcgfGTZZoSUFy4F1rkxBLiWY8s')
    assert.equal(result.parsed.parentTxid, parentTxid)
  })
})

describe('1Sat Ordinals', () => {
  it('detects ordinal inscription and extracts content', () => {
    // Build: P2PKH + OP_FALSE OP_IF PUSH3"ord" OP_1 <mime> OP_0 <data> OP_ENDIF
    const p2pkh = '76a914' + 'ab'.repeat(20) + '88ac'
    const mime = strToHex('text/plain')
    const data = strToHex('hello ordinal')
    // OP_FALSE(00) OP_IF(63) PUSH3(03) "ord"(6f7264) OP_1(51) <mime> OP_0(00) <data> OP_ENDIF(68)
    const ordEnvelope = '0063036f7264' + '51' + pushHex(mime) + '00' + pushHex(data) + '68'
    const script = p2pkh + ordEnvelope

    const result = parseOutputScript(script)
    assert.equal(result.type, 'ordinal')
    assert.equal(result.parsed.contentType, 'text/plain')
    assert.equal(result.parsed.isBsv20, false)
    assert.equal(result.parsed.bsv20, null)
  })

  it('detects BSV-20 token transfer', () => {
    const p2pkh = '76a914' + 'ab'.repeat(20) + '88ac'
    const mime = strToHex('application/bsv-20')
    const payload = JSON.stringify({ p: 'bsv-20', op: 'transfer', tick: 'TEST', amt: '1000' })
    const data = strToHex(payload)
    const ordEnvelope = '0063036f7264' + '51' + pushHex(mime) + '00' + pushHex(data) + '68'
    const script = p2pkh + ordEnvelope

    const result = parseOutputScript(script)
    assert.equal(result.type, 'ordinal')
    assert.equal(result.protocol, 'bsv-20')
    assert.equal(result.parsed.isBsv20, true)
    assert.equal(result.parsed.bsv20.op, 'transfer')
    assert.equal(result.parsed.bsv20.tick, 'TEST')
    assert.equal(result.parsed.bsv20.amt, '1000')
  })

  it('returns null for non-ordinal scripts', () => {
    const result = parseOrdinal('76a914' + 'ab'.repeat(20) + '88ac')
    assert.equal(result, null)
  })
})

describe('P2SH detection', () => {
  it('detects P2SH and extracts script hash', () => {
    const script = 'a914' + 'dd'.repeat(20) + '87'
    const result = parseOutputScript(script)
    assert.equal(result.type, 'p2sh')
    assert.equal(result.parsed.scriptHash, 'dd'.repeat(20))
    assert.equal(result.isP2PKH, false)
  })

  it('rejects wrong-length P2SH', () => {
    const script = 'a914' + 'dd'.repeat(10) + '87'
    const result = parseOutputScript(script)
    assert.notEqual(result.type, 'p2sh')
  })
})

describe('Bare multisig detection', () => {
  it('detects 2-of-3 multisig', () => {
    // OP_2 <pubkey1> <pubkey2> <pubkey3> OP_3 OP_CHECKMULTISIG
    const pubkey1 = '02' + 'aa'.repeat(32) // 33-byte compressed
    const pubkey2 = '03' + 'bb'.repeat(32)
    const pubkey3 = '02' + 'cc'.repeat(32)
    const script = '52' + '21' + pubkey1 + '21' + pubkey2 + '21' + pubkey3 + '53' + 'ae'

    const result = parseOutputScript(script)
    assert.equal(result.type, 'multisig')
    assert.equal(result.parsed.m, 2)
    assert.equal(result.parsed.n, 3)
    assert.equal(result.parsed.pubkeys.length, 3)
    assert.equal(result.parsed.pubkeys[0], pubkey1)
  })

  it('rejects scripts that end with ae but are not multisig', () => {
    const script = 'aabbccddae'
    const result = parseOutputScript(script)
    // Should not detect as multisig — first byte is not OP_1..OP_16
    assert.notEqual(result.type, 'multisig')
  })
})

describe('parseTx — new output fields', () => {
  it('includes type and protocol fields in parsed outputs', () => {
    const { rawHex } = buildTestTx()
    const parsed = parseTx(rawHex)

    // P2PKH outputs should have the new fields
    assert.equal(parsed.outputs[0].type, 'p2pkh')
    assert.equal(parsed.outputs[0].protocol, null)
    assert.equal(parsed.outputs[0].data, null)
    assert.equal(parsed.outputs[0].parsed, null)
    // Backward compat
    assert.equal(parsed.outputs[0].isP2PKH, true)
    assert.ok(parsed.outputs[0].hash160)
  })
})

describe('backward compatibility', () => {
  it('checkTxForWatched still works with new output format', () => {
    const { rawHex, recipientPubHex } = buildTestTx()
    const recipientHash = pubkeyToHash160(recipientPubHex)
    const watched = new Set([recipientHash])

    const result = checkTxForWatched(rawHex, watched)
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].hash160, recipientHash)
    assert.equal(result.matches[0].satoshis, 50000)
  })
})
