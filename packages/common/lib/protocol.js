/**
 * Protocol constants for the Federated SPV Relay Mesh.
 *
 * These define the on-chain registry wire format, beacon address,
 * supported capabilities, and protocol versions.
 */

/** OP_RETURN protocol prefix for registry transactions */
export const PROTOCOL_PREFIX = 'indelible.bridge-registry'

/**
 * Deterministic beacon address derived from SHA-256(PROTOCOL_PREFIX).
 * All registration/deregistration txs send BEACON_SATOSHIS dust here
 * so the chain scanner can find them via address history.
 *
 * Derivation: SHA-256('indelible.bridge-registry') → first 20 bytes → P2PKH address
 */
export const BEACON_ADDRESS = '1KhH4VshyN8PnzxbTSjiojcQbbABNSZyzR'

/** Dust amount sent to beacon address for tx discoverability */
export const BEACON_SATOSHIS = 100

/** Valid bridge capabilities advertised in registration */
export const VALID_CAPABILITIES = ['tx_relay', 'header_sync', 'broadcast', 'address_history']

/** Supported protocol versions for handshake negotiation */
export const SUPPORTED_VERSIONS = ['1.0']

/** Handshake timeout — drop connection if not completed within this window */
export const HANDSHAKE_TIMEOUT_MS = 10000
