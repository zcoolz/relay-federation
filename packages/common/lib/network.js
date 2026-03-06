/**
 * SPV bridge API client — shared HTTP helpers for interacting with
 * the relay mesh gateway/bridge endpoints.
 */

/**
 * Fetch UTXOs for a given address from the SPV bridge.
 *
 * @param {string} spvEndpoint — Base URL (e.g. "https://relay.indelible.one")
 * @param {string} apiKey — Relay API key
 * @param {string} address — BSV address
 * @returns {Promise<Array<{tx_hash: string, tx_pos: number, value: number, rawHex: string}>>}
 */
export async function fetchUtxos (spvEndpoint, apiKey, address) {
  const url = `${spvEndpoint}/api/address/${address}/utxos`
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey }
  })

  if (!res.ok) {
    throw new Error(`UTXO fetch failed: ${res.status} ${res.statusText}`)
  }

  return res.json()
}

/**
 * Broadcast a raw transaction via the SPV bridge.
 *
 * @param {string} spvEndpoint — Base URL
 * @param {string} apiKey — Relay API key
 * @param {string} txHex — Raw transaction hex
 * @returns {Promise<object>} Broadcast result from the bridge
 */
export async function broadcastTx (spvEndpoint, apiKey, txHex) {
  const url = `${spvEndpoint}/api/tx/broadcast`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({ rawTx: txHex })
  })

  if (!res.ok) {
    throw new Error(`Broadcast failed: ${res.status} ${res.statusText}`)
  }

  return res.json()
}

/**
 * Fetch address history from the SPV bridge.
 *
 * @param {string} spvEndpoint — Base URL
 * @param {string} apiKey — Relay API key
 * @param {string} address — BSV address
 * @returns {Promise<Array<{tx_hash: string, height: number}>>}
 */
export async function fetchAddressHistory (spvEndpoint, apiKey, address) {
  const url = `${spvEndpoint}/api/address/${address}/history`
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey }
  })

  if (!res.ok) {
    throw new Error(`Address history failed: ${res.status} ${res.statusText}`)
  }

  return res.json()
}

/**
 * Fetch raw transaction hex from the SPV bridge.
 *
 * @param {string} spvEndpoint — Base URL
 * @param {string} apiKey — Relay API key
 * @param {string} txid — Transaction ID
 * @returns {Promise<string>} Raw transaction hex
 */
export async function fetchTxHex (spvEndpoint, apiKey, txid) {
  const url = `${spvEndpoint}/api/tx/${txid}/hex`
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey }
  })

  if (!res.ok) {
    throw new Error(`TX fetch failed: ${res.status} ${res.statusText}`)
  }

  return res.text()
}
