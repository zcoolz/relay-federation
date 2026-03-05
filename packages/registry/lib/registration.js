import { Transaction, P2PKH, PrivateKey, SatoshisPerKilobyte, LockingScript, OP } from '@bsv/sdk'
import { encodeRegistration, encodeDeregistration, PROTOCOL_PREFIX, BEACON_ADDRESS, BEACON_SATOSHIS } from './cbor.js'

/**
 * Build an OP_RETURN transaction for bridge registration.
 *
 * @param {object} opts
 * @param {string} opts.wif - WIF private key of the bridge operator
 * @param {Array<{tx_hash: string, tx_pos: number, value: number, rawHex: string}>} opts.utxos
 *   Funding UTXOs. Each must include rawHex (full source tx hex) for fee calculation.
 * @param {string} opts.endpoint - WSS endpoint
 * @param {string[]} opts.capabilities - e.g. ["tx_relay", "header_sync", "broadcast", "address_history"]
 * @param {string[]} opts.versions - e.g. ["1.0"]
 * @param {string} opts.networkVersion - e.g. "1.0"
 * @param {Uint8Array} opts.stakeTxid - 32-byte stake bond txid
 * @param {string} opts.meshId - e.g. "indelible"
 * @returns {Promise<{txHex: string, txid: string}>}
 */
export async function buildRegistrationTx (opts) {
  const { wif, utxos, endpoint, capabilities, versions, networkVersion, stakeTxid, meshId } = opts

  const privateKey = PrivateKey.fromWif(wif)
  const pubkey = new Uint8Array(privateKey.toPublicKey().encode(true))

  const cborBytes = encodeRegistration({
    endpoint,
    pubkey,
    capabilities,
    versions,
    network_version: networkVersion,
    stake_txid: stakeTxid,
    mesh_id: meshId,
    timestamp: Math.floor(Date.now() / 1000)
  })

  return buildOpReturnTx(privateKey, utxos, cborBytes)
}

/**
 * Build an OP_RETURN transaction for bridge deregistration.
 *
 * @param {object} opts
 * @param {string} opts.wif - WIF private key of the bridge operator
 * @param {Array<{tx_hash: string, tx_pos: number, value: number, rawHex: string}>} opts.utxos
 * @param {string} opts.reason - e.g. "shutdown"
 * @returns {Promise<{txHex: string, txid: string}>}
 */
export async function buildDeregistrationTx (opts) {
  const { wif, utxos, reason } = opts

  const privateKey = PrivateKey.fromWif(wif)
  const pubkey = new Uint8Array(privateKey.toPublicKey().encode(true))

  const cborBytes = encodeDeregistration({
    pubkey,
    reason,
    timestamp: Math.floor(Date.now() / 1000)
  })

  return buildOpReturnTx(privateKey, utxos, cborBytes)
}

/**
 * Internal: build an OP_RETURN tx with protocol prefix + CBOR payload.
 * Matches the pattern used in the Indelible MCP server (spv.js).
 */
async function buildOpReturnTx (privateKey, utxos, cborBytes) {
  const address = privateKey.toPublicKey().toAddress()
  const tx = new Transaction()
  const p2pkh = new P2PKH()
  const lockingScript = p2pkh.lock(address)

  for (const utxo of utxos) {
    const sourceTransaction = Transaction.fromHex(utxo.rawHex)
    tx.addInput({
      sourceTransaction,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: p2pkh.unlock(
        privateKey,
        'all',
        false,
        utxo.value,
        lockingScript
      )
    })
  }

  // OP_FALSE OP_RETURN <protocol_prefix> <cbor_payload>
  const prefixBytes = Array.from(Buffer.from(PROTOCOL_PREFIX, 'utf8'))
  const dataBytes = Array.from(cborBytes)
  const opReturnScript = new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_RETURN },
    pushDataChunk(prefixBytes),
    pushDataChunk(dataBytes)
  ])

  tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 })
  // Beacon output: 100 sat dust to deterministic registry address for chain scanning
  tx.addOutput({ lockingScript: p2pkh.lock(BEACON_ADDRESS), satoshis: BEACON_SATOSHIS })
  tx.addOutput({ lockingScript: p2pkh.lock(address), change: true })

  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  const txHex = tx.toHex()
  const txid = tx.id('hex')

  return { txHex, txid }
}

function pushDataChunk (data) {
  const len = data.length
  let op
  if (len < OP.OP_PUSHDATA1) {
    op = len
  } else if (len <= 0xff) {
    op = OP.OP_PUSHDATA1
  } else if (len <= 0xffff) {
    op = OP.OP_PUSHDATA2
  } else {
    op = OP.OP_PUSHDATA4
  }
  return { op, data }
}
