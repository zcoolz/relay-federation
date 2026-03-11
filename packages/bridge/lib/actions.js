/**
 * Shared action logic for register, deregister, and fund.
 * Used by both CLI (cli.js) and StatusServer (status-server.js).
 *
 * Each function accepts a pluggable logger: log(type, message, data?)
 *   type: 'step' | 'done' | 'error'
 */

import { join } from 'node:path'

/**
 * Register this bridge on the relay mesh.
 * Builds stake bond + registration tx, broadcasts via BSV P2P.
 *
 * @param {object} opts
 * @param {object} opts.config - Bridge config (wif, pubkeyHex, endpoint, meshId, capabilities, dataDir)
 * @param {object} opts.store  - Open PersistentStore instance
 * @param {function} opts.log  - Logger: (type, message, data?) => void
 * @returns {object} { stakeTxid, registrationTxid }
 */
export async function runRegister ({ config, store, log }) {
  log('step', `Pubkey:       ${config.pubkeyHex}`)
  log('step', `Endpoint:     ${config.endpoint}`)
  log('step', `Mesh:         ${config.meshId}`)
  log('step', `Capabilities: ${config.capabilities.join(', ')}`)

  const { buildRegistrationTx } = await import('../../registry/lib/registration.js')
  const { BSVNodeClient } = await import('./bsv-node-client.js')

  // Get UTXOs from local store
  const localUtxos = await store.getUnspentUtxos()

  if (!localUtxos.length) {
    throw new Error('No UTXOs found. Fund your bridge first: relay-bridge fund <rawTxHex>')
  }

  // Map local UTXO format to what buildRegistrationTx expects
  const utxos = []
  for (const u of localUtxos) {
    const rawHex = await store.getTx(u.txid)
    if (!rawHex) {
      log('step', `Warning: No source tx for UTXO ${u.txid}:${u.vout}, skipping`)
      continue
    }
    utxos.push({ tx_hash: u.txid, tx_pos: u.vout, value: u.satoshis, rawHex })
  }

  if (!utxos.length) {
    throw new Error('No usable UTXOs (missing source transactions).')
  }

  // Connect to BSV P2P node for broadcasting
  log('step', 'Connecting to BSV network...')
  const bsvNode = new BSVNodeClient()

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bsvNode.disconnect()
      reject(new Error('BSV node connection timeout (15s)'))
    }, 15000)
    bsvNode.on('handshake', () => { clearTimeout(timeout); resolve() })
    bsvNode.on('error', (err) => { clearTimeout(timeout); reject(err) })
    bsvNode.connect()
  })

  try {
    // Step 1: Build and broadcast stake bond tx
    const { buildStakeBondTx } = await import('../../registry/lib/stake-bond.js')
    const { MIN_STAKE_SATS } = await import('@relay-federation/common/protocol')

    log('step', `Building stake bond (${MIN_STAKE_SATS} sats)...`)
    const stakeBond = await buildStakeBondTx({ wif: config.wif, utxos })

    bsvNode.broadcastTx(stakeBond.txHex)
    log('step', `Stake bond txid: ${stakeBond.txid}`)

    // Brief wait for stake tx to propagate
    await new Promise(r => setTimeout(r, 1000))

    // Step 2: Build registration tx using real stake bond txid
    const stakeTxid = new Uint8Array(Buffer.from(stakeBond.txid, 'hex'))

    // Use the stake bond tx's change output (index 1) as funding for registration
    const { Transaction } = await import('@bsv/sdk')
    const stakeParsed = Transaction.fromHex(stakeBond.txHex)
    const changeOutput = stakeParsed.outputs[1]
    const regUtxos = []
    if (changeOutput && changeOutput.satoshis > 0) {
      regUtxos.push({
        tx_hash: stakeBond.txid,
        tx_pos: 1,
        value: changeOutput.satoshis,
        rawHex: stakeBond.txHex
      })
    }

    if (!regUtxos.length) {
      throw new Error('Stake bond consumed all funds. No UTXOs left for registration tx.')
    }

    const { txHex, txid } = await buildRegistrationTx({
      wif: config.wif,
      utxos: regUtxos,
      endpoint: config.endpoint,
      capabilities: config.capabilities,
      versions: ['1.0'],
      networkVersion: '1.0',
      stakeTxid,
      meshId: config.meshId
    })

    bsvNode.broadcastTx(txHex)
    log('done', `Registration broadcast successful! txid: ${txid}`, { stakeTxid: stakeBond.txid, registrationTxid: txid })

    // Brief wait for tx to propagate
    await new Promise(r => setTimeout(r, 1000))

    return { stakeTxid: stakeBond.txid, registrationTxid: txid }
  } finally {
    bsvNode.disconnect()
  }
}

/**
 * Deregister this bridge from the relay mesh.
 * Builds deregistration tx, broadcasts via BSV P2P.
 *
 * @param {object} opts
 * @param {object} opts.config - Bridge config (wif, pubkeyHex)
 * @param {object} opts.store  - Open PersistentStore instance
 * @param {string} opts.reason - Deregistration reason (default: 'shutdown')
 * @param {function} opts.log  - Logger
 * @returns {object} { txid }
 */
export async function runDeregister ({ config, store, reason = 'shutdown', log }) {
  log('step', `Pubkey: ${config.pubkeyHex}`)
  log('step', `Reason: ${reason}`)

  const { buildDeregistrationTx } = await import('../../registry/lib/registration.js')
  const { BSVNodeClient } = await import('./bsv-node-client.js')

  // Get UTXOs from local store
  const localUtxos = await store.getUnspentUtxos()

  if (!localUtxos.length) {
    throw new Error('No UTXOs found. Fund your bridge first: relay-bridge fund <rawTxHex>')
  }

  // Map local UTXO format
  const utxos = []
  for (const u of localUtxos) {
    const rawHex = await store.getTx(u.txid)
    if (!rawHex) {
      log('step', `Warning: No source tx for UTXO ${u.txid}:${u.vout}, skipping`)
      continue
    }
    utxos.push({ tx_hash: u.txid, tx_pos: u.vout, value: u.satoshis, rawHex })
  }

  if (!utxos.length) {
    throw new Error('No usable UTXOs (missing source transactions).')
  }

  // Build deregistration tx
  const { txHex, txid } = await buildDeregistrationTx({
    wif: config.wif,
    utxos,
    reason
  })

  // Broadcast via BSV P2P
  log('step', 'Connecting to BSV network...')
  const bsvNode = new BSVNodeClient()

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bsvNode.disconnect()
      reject(new Error('BSV node connection timeout (15s)'))
    }, 15000)
    bsvNode.on('handshake', () => { clearTimeout(timeout); resolve() })
    bsvNode.on('error', (err) => { clearTimeout(timeout); reject(err) })
    bsvNode.connect()
  })

  try {
    bsvNode.broadcastTx(txHex)
    log('done', `Deregistration broadcast successful! txid: ${txid}`, { txid })

    await new Promise(r => setTimeout(r, 1000))
    return { txid }
  } finally {
    bsvNode.disconnect()
  }
}

/**
 * Fund this bridge by storing a raw transaction's outputs.
 * No BSV P2P needed — just parses the tx and stores matching UTXOs.
 *
 * @param {object} opts
 * @param {object} opts.config - Bridge config (pubkeyHex)
 * @param {object} opts.store  - Open PersistentStore instance
 * @param {string} opts.rawHex - Raw transaction hex
 * @param {function} opts.log  - Logger
 * @returns {object} { stored, balance }
 */
export async function runFund ({ config, store, rawHex, log }) {
  const { pubkeyToHash160, checkTxForWatched } = await import('./output-parser.js')

  const hash160 = pubkeyToHash160(config.pubkeyHex)
  const result = checkTxForWatched(rawHex, new Set([hash160]))

  if (result.matches.length === 0) {
    throw new Error(`No outputs found paying to this bridge address. Bridge hash160: ${hash160}`)
  }

  log('step', `Found ${result.matches.length} output(s) for this bridge`)

  for (const match of result.matches) {
    await store.putUtxo({
      txid: result.txid,
      vout: match.vout,
      satoshis: match.satoshis,
      scriptHex: match.scriptHex,
      address: config.pubkeyHex
    })
    log('step', `UTXO stored: ${result.txid}:${match.vout} (${match.satoshis} sat)`)
  }

  await store.putTx(result.txid, rawHex)
  const balance = await store.getBalance()
  log('done', `Total balance: ${balance} satoshis`, { stored: result.matches.length, balance })

  return { stored: result.matches.length, balance }
}

/**
 * Send BSV from this bridge's wallet to a destination address.
 * Builds a P2PKH tx, broadcasts via BSV P2P.
 *
 * @param {object} opts
 * @param {object} opts.config - Bridge config (wif, pubkeyHex)
 * @param {object} opts.store  - Open PersistentStore instance
 * @param {string} opts.toAddress - Destination BSV address
 * @param {number} opts.amount - Amount in satoshis to send
 * @param {function} opts.log  - Logger
 * @returns {object} { txid, sent, change }
 */
export async function runSend ({ config, store, toAddress, amount, log }) {
  const { Transaction, P2PKH, PrivateKey, SatoshisPerKilobyte } = await import('@bsv/sdk')

  if (!toAddress || typeof toAddress !== 'string') {
    throw new Error('Destination address is required.')
  }
  if (!amount || amount < 546) {
    throw new Error('Amount must be at least 546 satoshis (dust limit).')
  }

  // Get UTXOs from local store
  const localUtxos = await store.getUnspentUtxos()
  if (!localUtxos.length) {
    throw new Error('No UTXOs available. Wallet is empty.')
  }

  // Map local UTXO format and gather enough to cover amount + fee
  const utxos = []
  let gathered = 0
  for (const u of localUtxos) {
    const rawHex = await store.getTx(u.txid)
    if (!rawHex) continue
    utxos.push({ tx_hash: u.txid, tx_pos: u.vout, value: u.satoshis, rawHex })
    gathered += u.satoshis
    if (gathered >= amount + 1000) break // rough fee estimate
  }

  if (gathered < amount + 546) {
    throw new Error(`Insufficient funds. Have ${gathered} sats, need ${amount} + fee.`)
  }

  log('step', `Sending ${amount} sats to ${toAddress}`)

  const privateKey = PrivateKey.fromWif(config.wif)
  const selfAddress = privateKey.toPublicKey().toAddress()
  const p2pkh = new P2PKH()
  const selfLockingScript = p2pkh.lock(selfAddress)

  const tx = new Transaction()

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
        selfLockingScript
      )
    })
  }

  // Output 0: payment to destination
  tx.addOutput({
    lockingScript: p2pkh.lock(toAddress),
    satoshis: amount
  })

  // Output 1: change back to self
  tx.addOutput({
    lockingScript: p2pkh.lock(selfAddress),
    change: true
  })

  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  const txHex = tx.toHex()
  const txid = tx.id('hex')

  // Broadcast via BSV P2P
  log('step', 'Connecting to BSV network...')
  const { BSVNodeClient } = await import('./bsv-node-client.js')
  const bsvNode = new BSVNodeClient()

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bsvNode.disconnect()
      reject(new Error('BSV node connection timeout (15s)'))
    }, 15000)
    bsvNode.on('handshake', () => { clearTimeout(timeout); resolve() })
    bsvNode.on('error', (err) => { clearTimeout(timeout); reject(err) })
    bsvNode.connect()
  })

  try {
    bsvNode.broadcastTx(txHex)
    log('step', `Broadcast txid: ${txid}`)

    // Mark spent UTXOs in store
    for (const utxo of utxos) {
      await store.spendUtxo(utxo.tx_hash, utxo.tx_pos)
    }

    // Store the new tx and change UTXO
    await store.putTx(txid, txHex)
    const parsedTx = Transaction.fromHex(txHex)
    const changeOutput = parsedTx.outputs[1]
    if (changeOutput && changeOutput.satoshis > 0) {
      const { pubkeyToHash160, checkTxForWatched } = await import('./output-parser.js')
      const hash160 = pubkeyToHash160(config.pubkeyHex)
      const result = checkTxForWatched(txHex, new Set([hash160]))
      for (const match of result.matches) {
        await store.putUtxo({
          txid,
          vout: match.vout,
          satoshis: match.satoshis,
          scriptHex: match.scriptHex,
          address: config.pubkeyHex
        })
      }
    }

    await new Promise(r => setTimeout(r, 1000))
    const balance = await store.getBalance()
    log('done', `Sent ${amount} sats to ${toAddress}. Remaining balance: ${balance} sats`, { txid, sent: amount, balance })

    return { txid, sent: amount, balance }
  } finally {
    bsvNode.disconnect()
  }
}
