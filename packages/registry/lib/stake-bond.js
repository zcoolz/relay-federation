import { Transaction, P2PKH, PrivateKey, SatoshisPerKilobyte, LockingScript, OP } from '@bsv/sdk'

const SECONDS_PER_DAY = 86400

/**
 * Build a stake bond transaction with a time-locked output.
 *
 * The locking script uses OP_CHECKLOCKTIMEVERIFY to lock funds for a specified
 * number of days. After the timelock expires, the bridge operator can spend
 * the output back to themselves.
 *
 * Script: <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DUP OP_HASH160 <pubkeyHash> OP_EQUALVERIFY OP_CHECKSIG
 *
 * @param {object} opts
 * @param {string} opts.wif - WIF private key of the bridge operator
 * @param {Array<{tx_hash: string, tx_pos: number, value: number, rawHex: string}>} opts.utxos
 * @param {number} opts.stakeAmountSats - Stake amount in satoshis
 * @param {number} [opts.lockDays=30] - Number of days to lock the stake
 * @returns {Promise<{txHex: string, txid: string, stakeOutputIndex: number, unlockTime: number}>}
 */
export async function buildStakeBondTx (opts) {
  const { wif, utxos, stakeAmountSats, lockDays = 30 } = opts

  const privateKey = PrivateKey.fromWif(wif)
  const address = privateKey.toPublicKey().toAddress()
  const tx = new Transaction()
  const p2pkh = new P2PKH()
  const lockingScript = p2pkh.lock(address)

  // Add funding inputs
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

  // Calculate locktime as unix timestamp
  const unlockTime = Math.floor(Date.now() / 1000) + (lockDays * SECONDS_PER_DAY)

  // Build CLTV locking script
  const cltvScript = buildCltvScript(unlockTime, address)

  // Output 0: time-locked stake
  tx.addOutput({
    lockingScript: cltvScript,
    satoshis: stakeAmountSats
  })

  // Output 1: change back to self
  tx.addOutput({
    lockingScript: p2pkh.lock(address),
    change: true
  })

  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  const txHex = tx.toHex()
  const txid = tx.id('hex')

  return { txHex, txid, stakeOutputIndex: 0, unlockTime }
}

/**
 * Build OP_CHECKLOCKTIMEVERIFY locking script.
 *
 * <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DUP OP_HASH160 <pubkeyHash> OP_EQUALVERIFY OP_CHECKSIG
 *
 * @param {number} unlockTime - Unix timestamp when funds become spendable
 * @param {string} address - BSV address (for pubkeyHash)
 * @returns {LockingScript}
 */
function buildCltvScript (unlockTime, address) {
  // Encode locktime as little-endian bytes (minimal encoding per BIP62)
  const locktimeBytes = encodeScriptNum(unlockTime)

  // Get pubkeyHash from address
  const p2pkh = new P2PKH()
  const standardScript = p2pkh.lock(address)
  // Standard P2PKH script: OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
  // The pubkeyHash is in chunk index 2 (0-indexed)
  const pubkeyHash = standardScript.chunks[2].data

  return new LockingScript([
    pushDataChunk(locktimeBytes),
    { op: OP.OP_NOP2 }, // OP_CHECKLOCKTIMEVERIFY = OP_NOP2 = 0xb1
    { op: OP.OP_DROP },
    { op: OP.OP_DUP },
    { op: OP.OP_HASH160 },
    pushDataChunk(pubkeyHash),
    { op: OP.OP_EQUALVERIFY },
    { op: OP.OP_CHECKSIG }
  ])
}

/**
 * Encode an integer as minimal script number bytes (little-endian, BIP62).
 * Used for CLTV locktime encoding.
 */
function encodeScriptNum (num) {
  if (num === 0) return [0x00]

  const result = []
  let n = Math.abs(num)
  while (n > 0) {
    result.push(n & 0xff)
    n >>= 8
  }

  // If the high bit is set, add a sign byte
  if (result[result.length - 1] & 0x80) {
    result.push(num < 0 ? 0x80 : 0x00)
  } else if (num < 0) {
    result[result.length - 1] |= 0x80
  }

  return result
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

export { buildCltvScript, encodeScriptNum }
