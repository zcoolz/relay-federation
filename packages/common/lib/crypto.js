import { Hash, Signature, PublicKey } from '@bsv/sdk'

/**
 * Sign data with a private key using ECDSA (SHA-256 hash + sign).
 *
 * @param {string} dataHex — Data to sign as hex string
 * @param {import('@bsv/sdk').PrivateKey} privKey — BSV SDK PrivateKey instance
 * @returns {string} DER-encoded signature as hex
 */
export function signHash (dataHex, privKey) {
  const hash = Hash.sha256(Buffer.from(dataHex, 'hex'))
  const sig = privKey.sign(hash)
  return sig.toDER('hex')
}

/**
 * Verify an ECDSA signature against a public key.
 *
 * @param {string} dataHex — Original data as hex string
 * @param {string} sigDerHex — DER-encoded signature as hex
 * @param {string} pubkeyHex — Compressed public key as hex
 * @returns {boolean} true if signature is valid
 */
export function verifyHash (dataHex, sigDerHex, pubkeyHex) {
  const hash = Hash.sha256(Buffer.from(dataHex, 'hex'))
  const sig = Signature.fromDER(sigDerHex, 'hex')
  const pubKey = PublicKey.fromString(pubkeyHex)
  return pubKey.verify(hash, sig)
}

/**
 * Convert a Uint8Array to a hex string.
 *
 * @param {Uint8Array} arr
 * @returns {string}
 */
export function uint8ToHex (arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Convert a hex string to a Uint8Array.
 *
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToUint8 (hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}
