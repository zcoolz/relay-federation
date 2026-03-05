import { encode, decode } from 'cborg'

const PROTOCOL_PREFIX = 'indelible.bridge-registry'

/**
 * Deterministic beacon address derived from SHA-256(PROTOCOL_PREFIX).
 * All registration/deregistration txs send BEACON_SATOSHIS dust here
 * so the chain scanner can find them via address history.
 *
 * Derivation: SHA-256('indelible.bridge-registry') → first 20 bytes → P2PKH address
 * Result: 1KhH4VshyN8PnzxbTSjiojcQbbABNSZyzR (deterministic, reproducible)
 */
const BEACON_ADDRESS = '1KhH4VshyN8PnzxbTSjiojcQbbABNSZyzR'
const BEACON_SATOSHIS = 100

const REQUIRED_REGISTER_FIELDS = ['action', 'endpoint', 'pubkey', 'capabilities', 'versions', 'network_version', 'stake_txid', 'mesh_id', 'timestamp']
const REQUIRED_DEREGISTER_FIELDS = ['action', 'pubkey', 'reason', 'timestamp']
const VALID_CAPABILITIES = ['tx_relay', 'header_sync', 'broadcast', 'address_history']

/**
 * Encode a bridge registration payload to CBOR bytes.
 *
 * @param {object} payload
 * @param {string} payload.endpoint - WSS endpoint (e.g. "wss://bridge.example.com:8333")
 * @param {Uint8Array} payload.pubkey - 33-byte compressed public key
 * @param {string[]} payload.capabilities - subset of VALID_CAPABILITIES
 * @param {string[]} payload.versions - supported protocol versions (e.g. ["1.0"])
 * @param {string} payload.network_version - current network version (e.g. "1.0")
 * @param {Uint8Array} payload.stake_txid - 32-byte stake bond transaction ID
 * @param {string} payload.mesh_id - mesh identifier (e.g. "indelible")
 * @param {number} payload.timestamp - unix timestamp in seconds
 * @returns {Uint8Array} CBOR-encoded bytes
 */
export function encodeRegistration (payload) {
  const obj = { action: 'register', ...payload }
  validate(obj, REQUIRED_REGISTER_FIELDS)

  if (!(obj.pubkey instanceof Uint8Array) || obj.pubkey.length !== 33) {
    throw new Error('pubkey must be 33-byte Uint8Array')
  }
  if (!(obj.stake_txid instanceof Uint8Array) || obj.stake_txid.length !== 32) {
    throw new Error('stake_txid must be 32-byte Uint8Array')
  }
  if (!obj.endpoint.startsWith('wss://')) {
    throw new Error('endpoint must start with wss://')
  }
  for (const cap of obj.capabilities) {
    if (!VALID_CAPABILITIES.includes(cap)) {
      throw new Error(`invalid capability: ${cap}`)
    }
  }

  return encode(obj)
}

/**
 * Encode a bridge deregistration payload to CBOR bytes.
 *
 * @param {object} payload
 * @param {Uint8Array} payload.pubkey - 33-byte compressed public key
 * @param {string} payload.reason - reason for deregistration (e.g. "shutdown")
 * @param {number} payload.timestamp - unix timestamp in seconds
 * @returns {Uint8Array} CBOR-encoded bytes
 */
export function encodeDeregistration (payload) {
  const obj = { action: 'deregister', ...payload }
  validate(obj, REQUIRED_DEREGISTER_FIELDS)

  if (!(obj.pubkey instanceof Uint8Array) || obj.pubkey.length !== 33) {
    throw new Error('pubkey must be 33-byte Uint8Array')
  }

  return encode(obj)
}

/**
 * Decode CBOR bytes back to a registration or deregistration payload.
 *
 * @param {Uint8Array} bytes - CBOR-encoded bytes
 * @returns {object} decoded payload with action field
 */
export function decodePayload (bytes) {
  const obj = decode(bytes)

  if (obj.action === 'register') {
    validate(obj, REQUIRED_REGISTER_FIELDS)
  } else if (obj.action === 'deregister') {
    validate(obj, REQUIRED_DEREGISTER_FIELDS)
  } else {
    throw new Error(`unknown action: ${obj.action}`)
  }

  return obj
}

/**
 * Extract protocol prefix and CBOR payload from an OP_RETURN locking script.
 * Handles the round-trip parsing issue where OP_RETURN causes the script parser
 * to lump everything after OP_RETURN into one data blob.
 *
 * Script format: OP_FALSE OP_RETURN <pushdata prefix> <pushdata cbor>
 *
 * @param {LockingScript} lockingScript
 * @returns {{ prefix: string, cborBytes: Uint8Array }}
 */
export function extractOpReturnData (lockingScript) {
  const hex = lockingScript.toHex()
  // Script starts with 006a (OP_FALSE OP_RETURN)
  // Then pushdata for prefix, then pushdata for CBOR payload
  let offset = 4 // skip 00 6a

  // Read prefix push
  const { data: prefixData, newOffset: afterPrefix } = readPushData(hex, offset)
  const prefix = Buffer.from(prefixData).toString('utf8')

  // Read CBOR push
  const { data: cborData } = readPushData(hex, afterPrefix)

  return { prefix, cborBytes: new Uint8Array(cborData) }
}

function readPushData (hex, offset) {
  const opByte = parseInt(hex.slice(offset, offset + 2), 16)
  offset += 2

  let dataLen
  if (opByte >= 1 && opByte <= 75) {
    dataLen = opByte
  } else if (opByte === 0x4c) { // OP_PUSHDATA1
    dataLen = parseInt(hex.slice(offset, offset + 2), 16)
    offset += 2
  } else if (opByte === 0x4d) { // OP_PUSHDATA2
    dataLen = parseInt(hex.slice(offset, offset + 2), 16) +
              parseInt(hex.slice(offset + 2, offset + 4), 16) * 256
    offset += 4
  } else {
    throw new Error(`unexpected opcode at offset ${offset - 2}: 0x${opByte.toString(16)}`)
  }

  const dataHex = hex.slice(offset, offset + dataLen * 2)
  const data = []
  for (let i = 0; i < dataHex.length; i += 2) {
    data.push(parseInt(dataHex.slice(i, i + 2), 16))
  }

  return { data, newOffset: offset + dataLen * 2 }
}

/** Protocol prefix for OP_RETURN identification */
export { PROTOCOL_PREFIX, VALID_CAPABILITIES, BEACON_ADDRESS, BEACON_SATOSHIS }

function validate (obj, requiredFields) {
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`missing required field: ${field}`)
    }
  }
}
