import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { buildRegistrationTx, buildDeregistrationTx } from '../lib/registration.js'
import { decodePayload, extractOpReturnData, PROTOCOL_PREFIX, BEACON_ADDRESS, BEACON_SATOSHIS } from '../lib/cbor.js'

// Generate a throwaway key for testing
const testKey = PrivateKey.fromRandom()
const testWif = testKey.toWif()

// Build a fake funding tx so we have a valid UTXO with rawHex
function createFakeUtxo (privateKey, satoshis = 100000) {
  const address = privateKey.toPublicKey().toAddress()
  const p2pkh = new P2PKH()
  const fakeTx = new Transaction()
  fakeTx.addOutput({
    lockingScript: p2pkh.lock(address),
    satoshis
  })
  const rawHex = fakeTx.toHex()
  const txHash = fakeTx.id('hex')
  return { tx_hash: txHash, tx_pos: 0, value: satoshis, rawHex }
}

const fakeStakeTxid = new Uint8Array(32).fill(0xde)

describe('Registration tx builder', () => {
  it('builds a valid registration transaction', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildRegistrationTx({
      wif: testWif,
      utxos: [utxo],
      endpoint: 'wss://bridge.example.com:8333',
      capabilities: ['tx_relay', 'header_sync', 'broadcast', 'address_history'],
      versions: ['1.0'],
      networkVersion: '1.0',
      stakeTxid: fakeStakeTxid,
      meshId: 'indelible'
    })

    assert.ok(result.txHex, 'should return txHex')
    assert.ok(result.txid, 'should return txid')
    assert.equal(typeof result.txHex, 'string')
    assert.equal(result.txid.length, 64, 'txid should be 64 hex chars')

    // Parse the tx and verify output structure: OP_RETURN + beacon + change
    const tx = Transaction.fromHex(result.txHex)
    assert.ok(tx.outputs.length >= 3, 'should have at least 3 outputs (OP_RETURN + beacon + change)')

    // First output should be OP_RETURN (0 satoshis)
    const opReturnOutput = tx.outputs[0]
    assert.equal(opReturnOutput.satoshis, 0, 'OP_RETURN output should be 0 sats')

    // Second output should be beacon dust (100 satoshis)
    const beaconOutput = tx.outputs[1]
    assert.equal(beaconOutput.satoshis, BEACON_SATOSHIS, 'beacon output should be 100 sats')

    // Verify the script contains our protocol prefix
    const scriptHex = opReturnOutput.lockingScript.toHex()
    const prefixHex = Buffer.from(PROTOCOL_PREFIX, 'utf8').toString('hex')
    assert.ok(scriptHex.includes(prefixHex), 'script should contain protocol prefix')

    // Extract and decode the CBOR payload from the raw script bytes
    const { prefix, cborBytes } = extractOpReturnData(opReturnOutput.lockingScript)
    assert.equal(prefix, PROTOCOL_PREFIX, 'prefix should match')
    const decoded = decodePayload(cborBytes)
    assert.equal(decoded.action, 'register')
    assert.equal(decoded.endpoint, 'wss://bridge.example.com:8333')
    assert.equal(decoded.mesh_id, 'indelible')
    assert.deepEqual(decoded.capabilities, ['tx_relay', 'header_sync', 'broadcast', 'address_history'])
  })

  it('builds a valid deregistration transaction', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildDeregistrationTx({
      wif: testWif,
      utxos: [utxo],
      reason: 'shutdown'
    })

    assert.ok(result.txHex)
    assert.ok(result.txid)

    const tx = Transaction.fromHex(result.txHex)
    assert.ok(tx.outputs.length >= 3, 'deregistration should also have beacon output')
    assert.equal(tx.outputs[1].satoshis, BEACON_SATOSHIS, 'beacon output should be 100 sats')

    const { cborBytes } = extractOpReturnData(tx.outputs[0].lockingScript)
    const decoded = decodePayload(cborBytes)
    assert.equal(decoded.action, 'deregister')
    assert.equal(decoded.reason, 'shutdown')
  })

  it('pubkey in payload matches the WIF', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildRegistrationTx({
      wif: testWif,
      utxos: [utxo],
      endpoint: 'wss://test.example.com:8333',
      capabilities: ['tx_relay'],
      versions: ['1.0'],
      networkVersion: '1.0',
      stakeTxid: fakeStakeTxid,
      meshId: 'indelible'
    })

    const tx = Transaction.fromHex(result.txHex)
    const { cborBytes } = extractOpReturnData(tx.outputs[0].lockingScript)
    const decoded = decodePayload(cborBytes)

    const expectedPubkey = new Uint8Array(testKey.toPublicKey().encode(true))
    assert.deepEqual(decoded.pubkey, expectedPubkey, 'pubkey should match WIF')
  })
})
