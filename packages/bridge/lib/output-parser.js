import { Transaction, Hash, PublicKey, P2PKH } from '@bsv/sdk'

/**
 * OutputParser — extracts addresses and script info from raw transactions.
 *
 * Parses raw transaction hex and inspects each output to determine:
 * - Whether it's a standard P2PKH output
 * - The hash160 (pubkey hash) it pays to
 * - The satoshi value
 *
 * Also inspects inputs to determine which UTXOs are being spent.
 *
 * This module does NOT depend on any network calls — pure local parsing.
 */

/**
 * Parse a raw transaction hex into structured output info.
 * @param {string} rawHex — raw transaction hex string
 * @returns {{ txid: string, inputs: Array<{ prevTxid: string, prevVout: number }>, outputs: Array<{ vout: number, satoshis: number, scriptHex: string, hash160: string|null, isP2PKH: boolean }> }}
 */
export function parseTx (rawHex) {
  const tx = Transaction.fromHex(rawHex)
  const txid = tx.id('hex')

  const inputs = tx.inputs.map(input => ({
    prevTxid: typeof input.sourceTXID === 'string'
      ? input.sourceTXID
      : Buffer.from(input.sourceTXID).toString('hex'),
    prevVout: input.sourceOutputIndex
  }))

  const outputs = tx.outputs.map((output, vout) => {
    const scriptHex = output.lockingScript.toHex()
    const satoshis = output.satoshis
    const parsed = parseOutputScript(scriptHex)
    return {
      vout,
      satoshis,
      scriptHex,
      hash160: parsed.hash160,
      isP2PKH: parsed.isP2PKH
    }
  })

  return { txid, inputs, outputs }
}

/**
 * Parse a locking script hex to extract hash160 if it's P2PKH.
 *
 * Standard P2PKH script: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
 * Hex pattern: 76a914{40 hex chars}88ac
 *
 * @param {string} scriptHex
 * @returns {{ isP2PKH: boolean, hash160: string|null }}
 */
export function parseOutputScript (scriptHex) {
  // P2PKH: 76 a9 14 <20 bytes hash160> 88 ac
  if (scriptHex.length === 50 &&
      scriptHex.startsWith('76a914') &&
      scriptHex.endsWith('88ac')) {
    return {
      isP2PKH: true,
      hash160: scriptHex.slice(6, 46)
    }
  }
  return { isP2PKH: false, hash160: null }
}

/**
 * Compute the hash160 of a compressed public key hex.
 * hash160 = RIPEMD160(SHA256(pubkey))
 *
 * @param {string} pubkeyHex — 33-byte compressed public key as hex
 * @returns {string} 20-byte hash160 as hex
 */
export function pubkeyToHash160 (pubkeyHex) {
  const pubkeyBytes = Buffer.from(pubkeyHex, 'hex')
  const sha = Hash.sha256(pubkeyBytes)
  const h160 = Hash.ripemd160(sha)
  return Buffer.from(h160).toString('hex')
}

/**
 * Check if a transaction has any outputs paying to a set of watched hash160s.
 *
 * @param {string} rawHex — raw transaction hex
 * @param {Set<string>} watchedHash160s — set of hash160 hex strings to watch
 * @returns {{ txid: string, matches: Array<{ vout: number, satoshis: number, scriptHex: string, hash160: string }>, spends: Array<{ prevTxid: string, prevVout: number }> }}
 */
export function checkTxForWatched (rawHex, watchedHash160s) {
  const parsed = parseTx(rawHex)

  const matches = parsed.outputs
    .filter(o => o.isP2PKH && watchedHash160s.has(o.hash160))
    .map(o => ({
      vout: o.vout,
      satoshis: o.satoshis,
      scriptHex: o.scriptHex,
      hash160: o.hash160
    }))

  return {
    txid: parsed.txid,
    matches,
    spends: parsed.inputs
  }
}
