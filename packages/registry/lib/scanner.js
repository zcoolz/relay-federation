import { extractOpReturnData, decodePayload } from './cbor.js'
import { PROTOCOL_PREFIX, BEACON_ADDRESS } from '@relay-federation/common/protocol'
import { fetchAddressHistory, fetchTxHex } from '@relay-federation/common/network'
import { Transaction } from '@bsv/sdk'

/**
 * Scan the blockchain for bridge registry transactions.
 *
 * All registration/deregistration txs send a 100 sat dust output to the
 * deterministic BEACON_ADDRESS. The scanner pulls address history for that
 * address, fetches each tx, parses the OP_RETURN output, and returns an
 * array of registry entries.
 *
 * @param {object} opts
 * @param {string} opts.spvEndpoint - SPV bridge base URL (e.g. "http://155.138.238.167:8080")
 * @param {string} opts.apiKey - Relay API key for authentication
 * @returns {Promise<Array<{txid: string, height: number, entry: object}>>}
 *   Sorted by height ascending (oldest first). Each entry has the decoded
 *   CBOR payload (action, endpoint, pubkey, capabilities, etc.)
 */
export async function scanRegistry (opts) {
  const { spvEndpoint, apiKey } = opts

  // Step 1: Get address history for the beacon address
  const history = await fetchAddressHistory(spvEndpoint, apiKey, BEACON_ADDRESS)

  // Step 2: Fetch each tx and parse OP_RETURN
  const entries = []
  for (const item of history) {
    try {
      const entry = await parseRegistryTx(spvEndpoint, apiKey, item.tx_hash)
      if (entry) {
        entries.push({
          txid: item.tx_hash,
          height: item.height,
          entry
        })
      }
    } catch (err) {
      // Skip unparseable txs — could be non-registry dust sent to beacon
    }
  }

  // Step 3: Sort by height ascending (oldest first)
  entries.sort((a, b) => a.height - b.height)

  return entries
}

/**
 * Fetch a transaction and attempt to parse its OP_RETURN as a registry entry.
 * Returns null if the tx doesn't contain a valid registry OP_RETURN.
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} txid
 * @returns {Promise<object|null>} Decoded CBOR payload or null
 */
async function parseRegistryTx (baseUrl, apiKey, txid) {
  const rawHex = await fetchTxHex(baseUrl, apiKey, txid)

  // Parse the raw transaction to find OP_RETURN output
  const tx = Transaction.fromHex(rawHex)

  // Find the OP_RETURN output (0 satoshis, starts with 006a)
  const opReturnOutput = tx.outputs.find(out =>
    out.satoshis === 0 && out.lockingScript.toHex().startsWith('006a')
  )

  if (!opReturnOutput) return null

  // Extract prefix and CBOR data
  const { prefix, cborBytes } = extractOpReturnData(opReturnOutput.lockingScript)

  // Verify it's our protocol
  if (prefix !== PROTOCOL_PREFIX) return null

  // Decode the CBOR payload
  return decodePayload(cborBytes)
}

export { parseRegistryTx, BEACON_ADDRESS }
