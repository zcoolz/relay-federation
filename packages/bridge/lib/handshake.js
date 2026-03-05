import { randomBytes } from 'node:crypto'
import { PrivateKey, PublicKey, Hash, Signature } from '@bsv/sdk'

const SUPPORTED_VERSIONS = ['1.0']
const HANDSHAKE_TIMEOUT_MS = 10000

/**
 * Sign a nonce with a private key using ECDSA (SHA-256 hash + sign).
 * @param {string} nonceHex — 32-byte nonce as hex
 * @param {PrivateKey} privKey
 * @returns {string} DER-encoded signature as hex
 */
function signNonce (nonceHex, privKey) {
  const hash = Hash.sha256(Buffer.from(nonceHex, 'hex'))
  const sig = privKey.sign(hash)
  return sig.toDER('hex')
}

/**
 * Verify a nonce signature against a public key.
 * @param {string} nonceHex — 32-byte nonce as hex
 * @param {string} sigDerHex — DER-encoded signature as hex
 * @param {string} pubkeyHex — Compressed pubkey as hex
 * @returns {boolean}
 */
function verifyNonce (nonceHex, sigDerHex, pubkeyHex) {
  const hash = Hash.sha256(Buffer.from(nonceHex, 'hex'))
  const sig = Signature.fromDER(sigDerHex, 'hex')
  const pubKey = PublicKey.fromString(pubkeyHex)
  return pubKey.verify(hash, sig)
}

/**
 * Create a cryptographic handshake helper.
 *
 * Protocol (2 round-trips):
 *   1. Initiator → Responder: { type: "hello", pubkey, nonce, versions, endpoint }
 *   2. Responder → Initiator: { type: "challenge_response", pubkey, nonce, signature, selected_version }
 *   3. Initiator → Responder: { type: "verify", signature }
 *   (Responder verifies → connection established)
 *
 * @param {object} opts
 * @param {string} opts.wif — Our WIF private key
 * @param {string} opts.pubkeyHex — Our compressed pubkey hex
 * @param {string} opts.endpoint — Our advertised WSS endpoint
 * @param {string[]} [opts.versions] — Supported protocol versions
 * @returns {object} Handshake helper with methods
 */
export function createHandshake (opts) {
  const privKey = PrivateKey.fromWif(opts.wif)
  const ourPubkeyHex = opts.pubkeyHex
  const ourEndpoint = opts.endpoint
  const ourVersions = opts.versions || SUPPORTED_VERSIONS

  return {
    /**
     * Build the initial hello message (initiator side).
     * @returns {{ message: object, nonce: string }}
     */
    createHello () {
      const nonce = randomBytes(32).toString('hex')
      return {
        message: {
          type: 'hello',
          pubkey: ourPubkeyHex,
          nonce,
          versions: ourVersions,
          endpoint: ourEndpoint
        },
        nonce
      }
    },

    /**
     * Handle an incoming hello and produce a challenge_response (responder side).
     *
     * @param {object} hello — The received hello message
     * @param {Set<string>|null} [registeredPubkeys] — Set of registered pubkeys (if null, skip registry check)
     * @returns {{ message: object, nonce: string, peerPubkey: string, selectedVersion: string } | { error: string }}
     */
    handleHello (hello, registeredPubkeys = null) {
      if (!hello || hello.type !== 'hello' || !hello.pubkey || !hello.nonce || !hello.endpoint) {
        return { error: 'invalid_hello' }
      }

      if (!Array.isArray(hello.versions) || hello.versions.length === 0) {
        return { error: 'missing_versions' }
      }

      // Check registry
      if (registeredPubkeys && !registeredPubkeys.has(hello.pubkey)) {
        return { error: 'not_registered' }
      }

      // Version negotiation — select highest mutual version
      const mutual = hello.versions.filter(v => ourVersions.includes(v))
      if (mutual.length === 0) {
        return { error: 'version_mismatch', supported: ourVersions }
      }
      const selectedVersion = mutual.sort().pop() // highest mutual version

      // Sign the initiator's nonce to prove our identity
      const signature = signNonce(hello.nonce, privKey)
      const responderNonce = randomBytes(32).toString('hex')

      return {
        message: {
          type: 'challenge_response',
          pubkey: ourPubkeyHex,
          nonce: responderNonce,
          signature,
          selected_version: selectedVersion
        },
        nonce: responderNonce,
        peerPubkey: hello.pubkey,
        selectedVersion
      }
    },

    /**
     * Verify the challenge_response and produce the verify message (initiator side).
     *
     * @param {object} response — The received challenge_response message
     * @param {string} ourNonce — The nonce we sent in hello
     * @param {Set<string>|null} [registeredPubkeys] — Set of registered pubkeys
     * @returns {{ message: object, peerPubkey: string, selectedVersion: string } | { error: string }}
     */
    handleChallengeResponse (response, ourNonce, registeredPubkeys = null) {
      if (!response || response.type !== 'challenge_response' || !response.pubkey || !response.nonce || !response.signature) {
        return { error: 'invalid_challenge_response' }
      }

      if (!response.selected_version) {
        return { error: 'missing_version' }
      }

      // Check registry
      if (registeredPubkeys && !registeredPubkeys.has(response.pubkey)) {
        return { error: 'not_registered' }
      }

      // Verify responder signed our nonce
      try {
        const valid = verifyNonce(ourNonce, response.signature, response.pubkey)
        if (!valid) {
          return { error: 'invalid_signature' }
        }
      } catch {
        return { error: 'invalid_signature' }
      }

      // Sign responder's nonce
      const signature = signNonce(response.nonce, privKey)

      return {
        message: {
          type: 'verify',
          signature
        },
        peerPubkey: response.pubkey,
        selectedVersion: response.selected_version
      }
    },

    /**
     * Verify the verify message (responder side — final step).
     *
     * @param {object} verify — The received verify message
     * @param {string} ourNonce — The nonce we sent in challenge_response
     * @param {string} peerPubkeyHex — The initiator's pubkey from hello
     * @returns {{ success: true } | { error: string }}
     */
    handleVerify (verify, ourNonce, peerPubkeyHex) {
      if (!verify || verify.type !== 'verify' || !verify.signature) {
        return { error: 'invalid_verify' }
      }

      try {
        const valid = verifyNonce(ourNonce, verify.signature, peerPubkeyHex)
        if (!valid) {
          return { error: 'invalid_signature' }
        }
      } catch {
        return { error: 'invalid_signature' }
      }

      return { success: true }
    }
  }
}

export { SUPPORTED_VERSIONS, HANDSHAKE_TIMEOUT_MS }
