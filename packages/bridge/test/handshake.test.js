import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import { createHandshake, SUPPORTED_VERSIONS } from '../lib/handshake.js'

function makeIdentity () {
  const priv = PrivateKey.fromRandom()
  return {
    wif: priv.toWif(),
    pubkeyHex: priv.toPublicKey().toString(),
    endpoint: 'wss://test-bridge.example.com:8333'
  }
}

describe('Handshake', () => {
  it('full handshake succeeds between two valid peers', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()

    const aliceHS = createHandshake(alice)
    const bobHS = createHandshake(bob)

    // Step 1: Alice creates hello
    const { message: hello, nonce: aliceNonce } = aliceHS.createHello()
    assert.equal(hello.type, 'hello')
    assert.equal(hello.pubkey, alice.pubkeyHex)
    assert.ok(hello.nonce)
    assert.deepEqual(hello.versions, SUPPORTED_VERSIONS)
    assert.equal(hello.endpoint, alice.endpoint)

    // Step 2: Bob handles hello, produces challenge_response
    const bobResult = bobHS.handleHello(hello)
    assert.ok(!bobResult.error, `handleHello should succeed, got: ${bobResult.error}`)
    assert.equal(bobResult.message.type, 'challenge_response')
    assert.equal(bobResult.message.pubkey, bob.pubkeyHex)
    assert.ok(bobResult.message.nonce)
    assert.ok(bobResult.message.signature)
    assert.equal(bobResult.message.selected_version, '1.0')
    assert.equal(bobResult.peerPubkey, alice.pubkeyHex)

    // Step 3: Alice handles challenge_response, produces verify
    const aliceResult = aliceHS.handleChallengeResponse(bobResult.message, aliceNonce)
    assert.ok(!aliceResult.error, `handleChallengeResponse should succeed, got: ${aliceResult.error}`)
    assert.equal(aliceResult.message.type, 'verify')
    assert.ok(aliceResult.message.signature)
    assert.equal(aliceResult.peerPubkey, bob.pubkeyHex)
    assert.equal(aliceResult.selectedVersion, '1.0')

    // Step 4: Bob handles verify
    const verifyResult = bobHS.handleVerify(aliceResult.message, bobResult.nonce, alice.pubkeyHex)
    assert.ok(verifyResult.success, `handleVerify should succeed, got: ${verifyResult.error}`)
  })

  it('rejects hello with missing fields', () => {
    const bob = makeIdentity()
    const bobHS = createHandshake(bob)

    assert.equal(bobHS.handleHello({}).error, 'invalid_hello')
    assert.equal(bobHS.handleHello({ type: 'hello' }).error, 'invalid_hello')
    assert.equal(bobHS.handleHello({ type: 'hello', pubkey: 'aa', nonce: 'bb' }).error, 'invalid_hello')
    assert.equal(bobHS.handleHello(null).error, 'invalid_hello')
  })

  it('rejects hello with no versions', () => {
    const bob = makeIdentity()
    const bobHS = createHandshake(bob)

    const result = bobHS.handleHello({
      type: 'hello',
      pubkey: 'aa'.repeat(33),
      nonce: 'bb'.repeat(32),
      endpoint: 'wss://test:8333',
      versions: []
    })
    assert.equal(result.error, 'missing_versions')
  })

  it('rejects hello from unregistered pubkey', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()
    const aliceHS = createHandshake(alice)
    const bobHS = createHandshake(bob)

    const { message: hello } = aliceHS.createHello()
    const registry = new Set(['cc'.repeat(33)]) // alice not in registry

    const result = bobHS.handleHello(hello, registry)
    assert.equal(result.error, 'not_registered')
  })

  it('skips registry check when registeredPubkeys is null', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()
    const aliceHS = createHandshake(alice)
    const bobHS = createHandshake(bob)

    const { message: hello } = aliceHS.createHello()
    const result = bobHS.handleHello(hello, null)
    assert.ok(!result.error)
  })

  it('rejects version mismatch', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()
    const aliceHS = createHandshake({ ...alice, versions: ['2.0'] })
    const bobHS = createHandshake({ ...bob, versions: ['1.0'] })

    const { message: hello } = aliceHS.createHello()
    const result = bobHS.handleHello(hello)
    assert.equal(result.error, 'version_mismatch')
    assert.deepEqual(result.supported, ['1.0'])
  })

  it('selects highest mutual version', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()
    const aliceHS = createHandshake({ ...alice, versions: ['1.0', '1.1'] })
    const bobHS = createHandshake({ ...bob, versions: ['1.0', '1.1'] })

    const { message: hello } = aliceHS.createHello()
    const result = bobHS.handleHello(hello)
    assert.equal(result.selectedVersion, '1.1')
    assert.equal(result.message.selected_version, '1.1')
  })

  it('rejects forged signature in challenge_response', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()
    const evil = makeIdentity()

    const aliceHS = createHandshake(alice)
    const bobHS = createHandshake(bob)
    const evilHS = createHandshake(evil)

    const { message: hello, nonce: aliceNonce } = aliceHS.createHello()

    // Evil intercepts and responds with bob's pubkey but evil's signature
    const bobResult = bobHS.handleHello(hello)
    bobResult.message.signature = 'deadbeef'.repeat(8) // garbage sig

    const result = aliceHS.handleChallengeResponse(bobResult.message, aliceNonce)
    assert.equal(result.error, 'invalid_signature')
  })

  it('rejects forged signature in verify', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()

    const aliceHS = createHandshake(alice)
    const bobHS = createHandshake(bob)

    const { message: hello, nonce: aliceNonce } = aliceHS.createHello()
    const bobResult = bobHS.handleHello(hello)
    const aliceResult = aliceHS.handleChallengeResponse(bobResult.message, aliceNonce)

    // Tamper with signature
    aliceResult.message.signature = 'deadbeef'.repeat(8)

    const result = bobHS.handleVerify(aliceResult.message, bobResult.nonce, alice.pubkeyHex)
    assert.equal(result.error, 'invalid_signature')
  })

  it('rejects challenge_response with missing fields', () => {
    const alice = makeIdentity()
    const aliceHS = createHandshake(alice)

    assert.equal(aliceHS.handleChallengeResponse({}, 'nonce').error, 'invalid_challenge_response')
    assert.equal(aliceHS.handleChallengeResponse(null, 'nonce').error, 'invalid_challenge_response')
    assert.equal(aliceHS.handleChallengeResponse({
      type: 'challenge_response',
      pubkey: 'aa',
      nonce: 'bb'
      // missing signature
    }, 'nonce').error, 'invalid_challenge_response')
  })

  it('rejects challenge_response from unregistered pubkey', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()

    const aliceHS = createHandshake(alice)
    const bobHS = createHandshake(bob)

    const { message: hello, nonce: aliceNonce } = aliceHS.createHello()
    const bobResult = bobHS.handleHello(hello)

    const registry = new Set([alice.pubkeyHex]) // bob not in registry
    const result = aliceHS.handleChallengeResponse(bobResult.message, aliceNonce, registry)
    assert.equal(result.error, 'not_registered')
  })

  it('rejects verify with missing fields', () => {
    const bob = makeIdentity()
    const bobHS = createHandshake(bob)

    assert.equal(bobHS.handleVerify({}, 'nonce', 'pubkey').error, 'invalid_verify')
    assert.equal(bobHS.handleVerify(null, 'nonce', 'pubkey').error, 'invalid_verify')
    assert.equal(bobHS.handleVerify({ type: 'verify' }, 'nonce', 'pubkey').error, 'invalid_verify')
  })

  it('each hello generates a unique nonce', () => {
    const alice = makeIdentity()
    const aliceHS = createHandshake(alice)

    const { nonce: n1 } = aliceHS.createHello()
    const { nonce: n2 } = aliceHS.createHello()
    assert.notEqual(n1, n2)
  })

  it('wrong key cannot sign for another peer', () => {
    const alice = makeIdentity()
    const bob = makeIdentity()
    const evil = makeIdentity()

    const aliceHS = createHandshake(alice)
    const evilHS = createHandshake(evil) // evil pretends to be bob

    const { message: hello, nonce: aliceNonce } = aliceHS.createHello()

    // Evil handles hello (signs with evil's key, but claims bob's pubkey)
    const evilResult = evilHS.handleHello(hello)
    // Replace pubkey with bob's
    evilResult.message.pubkey = bob.pubkeyHex

    // Alice tries to verify — should fail because sig doesn't match bob's pubkey
    const result = aliceHS.handleChallengeResponse(evilResult.message, aliceNonce)
    assert.equal(result.error, 'invalid_signature')
  })
})
