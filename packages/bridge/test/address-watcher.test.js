import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PrivateKey, Transaction, P2PKH, Script } from '@bsv/sdk'
import { PersistentStore } from '../lib/persistent-store.js'
import { AddressWatcher } from '../lib/address-watcher.js'
import { pubkeyToHash160 } from '../lib/output-parser.js'

let store, tempDir

async function setup () {
  tempDir = await mkdtemp(join(tmpdir(), 'watcher-'))
  store = new PersistentStore(tempDir)
  await store.open()
}

async function teardown () {
  if (store) await store.close()
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
}

// Fake TxRelay — just an EventEmitter
function fakeTxRelay () {
  return new EventEmitter()
}

// Build a test tx paying to a specific pubkey
function buildTxTo (recipientPubHex, satoshis = 50000) {
  const recipientPub = PrivateKey.fromRandom().toPublicKey()
  // Override: use the provided pubkey for the recipient output
  const pub = { toAddress: () => require_address_from_hex(recipientPubHex) }

  const fakePrevTxid = randomHex(32)
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: fakePrevTxid,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  // Build P2PKH locking script manually: 76 a9 14 <hash160> 88 ac
  const hash160 = pubkeyToHash160(recipientPubHex)
  const lockingScript = Script.fromHex(`76a914${hash160}88ac`)
  tx.addOutput({ lockingScript, satoshis })

  return {
    rawHex: tx.toHex(),
    txid: tx.id('hex'),
    prevTxid: fakePrevTxid,
    hash160
  }
}

// Build a tx that spends a specific prevTxid:vout and pays to a recipient
function buildSpendTx (prevTxid, prevVout, recipientPubHex, satoshis = 40000) {
  const hash160 = pubkeyToHash160(recipientPubHex)
  const lockingScript = Script.fromHex(`76a914${hash160}88ac`)

  const tx = new Transaction()
  tx.addInput({
    sourceTXID: prevTxid,
    sourceOutputIndex: prevVout,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  tx.addOutput({ lockingScript, satoshis })

  return {
    rawHex: tx.toHex(),
    txid: tx.id('hex'),
    hash160
  }
}

function randomHex (bytes) {
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('')
}

// Helper: wait for an event
function waitFor (emitter, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms)
    emitter.once(event, (data) => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

describe('AddressWatcher', () => {
  afterEach(teardown)

  it('watchPubkey registers a hash160', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const key = PrivateKey.fromRandom().toPublicKey().toString()
    watcher.watchPubkey(key, 'mybridge')

    const watched = watcher.getWatched()
    assert.equal(watched.length, 1)
    assert.equal(watched[0].label, 'mybridge')
    assert.equal(watched[0].hash160.length, 40)
  })

  it('detects incoming UTXO on tx:new', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const myKey = PrivateKey.fromRandom().toPublicKey().toString()
    const myHash = pubkeyToHash160(myKey)
    watcher.watchPubkey(myKey, 'mybridge')

    // Build a tx paying to our address
    const { rawHex, txid } = buildTxTo(myKey, 75000)

    // Emit tx:new and wait for utxo:received
    const receivedPromise = waitFor(watcher, 'utxo:received')
    txRelay.emit('tx:new', { txid, rawHex })
    const received = await receivedPromise

    assert.equal(received.txid, txid)
    assert.equal(received.vout, 0)
    assert.equal(received.satoshis, 75000)
    assert.equal(received.hash160, myHash)
  })

  it('stores UTXO in persistent store', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const myKey = PrivateKey.fromRandom().toPublicKey().toString()
    watcher.watchPubkey(myKey, 'mybridge')

    const { rawHex, txid } = buildTxTo(myKey, 30000)

    const receivedPromise = waitFor(watcher, 'utxo:received')
    txRelay.emit('tx:new', { txid, rawHex })
    await receivedPromise

    // Check store
    const utxos = await store.getUnspentUtxos()
    assert.equal(utxos.length, 1)
    assert.equal(utxos[0].txid, txid)
    assert.equal(utxos[0].satoshis, 30000)
    assert.equal(utxos[0].spent, false)
  })

  it('detects spent UTXO when input matches', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const myKey = PrivateKey.fromRandom().toPublicKey().toString()
    const otherKey = PrivateKey.fromRandom().toPublicKey().toString()
    watcher.watchPubkey(myKey, 'mybridge')

    // First: receive a UTXO
    const { rawHex: rx1, txid: txid1 } = buildTxTo(myKey, 50000)
    const p1 = waitFor(watcher, 'utxo:received')
    txRelay.emit('tx:new', { txid: txid1, rawHex: rx1 })
    await p1

    // Now: spend that UTXO
    const { rawHex: rx2, txid: txid2 } = buildSpendTx(txid1, 0, otherKey, 40000)
    const spentPromise = waitFor(watcher, 'utxo:spent')
    txRelay.emit('tx:new', { txid: txid2, rawHex: rx2 })
    const spent = await spentPromise

    assert.equal(spent.txid, txid1)
    assert.equal(spent.vout, 0)
    assert.equal(spent.spentByTxid, txid2)

    // Balance should be 0
    const balance = await store.getBalance()
    assert.equal(balance, 0)
  })

  it('ignores transactions to unwatched addresses', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const myKey = PrivateKey.fromRandom().toPublicKey().toString()
    const otherKey = PrivateKey.fromRandom().toPublicKey().toString()
    watcher.watchPubkey(myKey, 'mybridge')

    // Build tx paying to OTHER address
    const { rawHex, txid } = buildTxTo(otherKey, 50000)

    let received = false
    watcher.on('utxo:received', () => { received = true })

    txRelay.emit('tx:new', { txid, rawHex })

    // Give it a tick to process
    await new Promise(r => setTimeout(r, 50))
    assert.equal(received, false)

    const utxos = await store.getUnspentUtxos()
    assert.equal(utxos.length, 0)
  })

  it('records watched-address match in store', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const myKey = PrivateKey.fromRandom().toPublicKey().toString()
    watcher.watchPubkey(myKey, 'mybridge')

    const { rawHex, txid } = buildTxTo(myKey)
    const p = waitFor(watcher, 'utxo:received')
    txRelay.emit('tx:new', { txid, rawHex })
    await p

    const matches = await store.getWatchedTxs('mybridge')
    assert.equal(matches.length, 1)
    assert.equal(matches[0].txid, txid)
    assert.equal(matches[0].direction, 'in')
  })

  it('unwatch stops tracking an address', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const myKey = PrivateKey.fromRandom().toPublicKey().toString()
    const myHash = pubkeyToHash160(myKey)
    watcher.watchPubkey(myKey, 'mybridge')
    assert.equal(watcher.getWatched().length, 1)

    watcher.unwatch(myHash)
    assert.equal(watcher.getWatched().length, 0)
  })

  it('emits tx:watched with match count', async () => {
    await setup()
    const txRelay = fakeTxRelay()
    const watcher = new AddressWatcher(txRelay, store)

    const myKey = PrivateKey.fromRandom().toPublicKey().toString()
    watcher.watchPubkey(myKey, 'mybridge')

    const { rawHex, txid } = buildTxTo(myKey)
    const watchedPromise = waitFor(watcher, 'tx:watched')
    txRelay.emit('tx:new', { txid, rawHex })
    const ev = await watchedPromise

    assert.equal(ev.txid, txid)
    assert.equal(ev.matches, 1)
  })
})
