import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { signHash, verifyHash, uint8ToHex, hexToUint8 } from '../lib/crypto.js'

describe('signHash / verifyHash', () => {
  it('sign and verify round-trip', () => {
    const privKey = PrivateKey.fromRandom()
    const pubkeyHex = privKey.toPublicKey().toString()
    const dataHex = randomBytes(32).toString('hex')

    const sig = signHash(dataHex, privKey)
    assert.ok(typeof sig === 'string')
    assert.ok(sig.length > 0)

    const valid = verifyHash(dataHex, sig, pubkeyHex)
    assert.ok(valid)
  })

  it('verify fails with wrong data', () => {
    const privKey = PrivateKey.fromRandom()
    const pubkeyHex = privKey.toPublicKey().toString()
    const dataHex = randomBytes(32).toString('hex')
    const wrongDataHex = randomBytes(32).toString('hex')

    const sig = signHash(dataHex, privKey)
    const valid = verifyHash(wrongDataHex, sig, pubkeyHex)
    assert.equal(valid, false)
  })

  it('verify fails with wrong key', () => {
    const privKey = PrivateKey.fromRandom()
    const wrongKey = PrivateKey.fromRandom()
    const wrongPubkeyHex = wrongKey.toPublicKey().toString()
    const dataHex = randomBytes(32).toString('hex')

    const sig = signHash(dataHex, privKey)
    const valid = verifyHash(dataHex, sig, wrongPubkeyHex)
    assert.equal(valid, false)
  })

  it('verify throws on invalid signature format', () => {
    const privKey = PrivateKey.fromRandom()
    const pubkeyHex = privKey.toPublicKey().toString()
    const dataHex = randomBytes(32).toString('hex')

    assert.throws(() => {
      verifyHash(dataHex, 'not_valid_der', pubkeyHex)
    })
  })

  it('different data produces different signatures', () => {
    const privKey = PrivateKey.fromRandom()
    const data1 = randomBytes(32).toString('hex')
    const data2 = randomBytes(32).toString('hex')

    const sig1 = signHash(data1, privKey)
    const sig2 = signHash(data2, privKey)
    assert.notEqual(sig1, sig2)
  })
})

describe('uint8ToHex / hexToUint8', () => {
  it('round-trip conversion', () => {
    const original = new Uint8Array([0x00, 0xab, 0xcd, 0xef, 0xff])
    const hex = uint8ToHex(original)
    assert.equal(hex, '00abcdef ff'.replace(' ', ''))

    const back = hexToUint8(hex)
    assert.deepEqual(back, original)
  })

  it('empty array', () => {
    assert.equal(uint8ToHex(new Uint8Array([])), '')
    assert.deepEqual(hexToUint8(''), new Uint8Array([]))
  })

  it('uint8ToHex pads single-digit hex', () => {
    const arr = new Uint8Array([0, 1, 2, 15])
    assert.equal(uint8ToHex(arr), '0001020f')
  })

  it('hexToUint8 parses 33-byte pubkey', () => {
    const hex = 'aa'.repeat(33)
    const arr = hexToUint8(hex)
    assert.equal(arr.length, 33)
    assert.equal(arr[0], 0xaa)
    assert.equal(arr[32], 0xaa)
  })
})
