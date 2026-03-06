import { EventEmitter } from 'node:events'
import { checkTxForWatched, pubkeyToHash160 } from './output-parser.js'

/**
 * AddressWatcher — monitors transactions for outputs to watched addresses.
 *
 * Listens to TxRelay's 'tx:new' events, parses each transaction, and
 * checks outputs against a set of watched hash160s. When a match is
 * found, it:
 *   1. Stores the UTXO in PersistentStore
 *   2. Checks inputs for spent UTXOs and marks them
 *   3. Records the watched-address match
 *   4. Emits events for upstream consumers
 *
 * This replaces the HTTP-based address queries (fetchUtxos,
 * fetchAddressHistory) with pure local P2P-based tracking.
 *
 * Events:
 *   'utxo:received'  — { txid, vout, satoshis, address, hash160 }
 *   'utxo:spent'     — { txid, vout, spentByTxid }
 *   'tx:watched'     — { txid, address, direction, matches }
 */
export class AddressWatcher extends EventEmitter {
  /**
   * @param {import('./tx-relay.js').TxRelay} txRelay
   * @param {import('./persistent-store.js').PersistentStore} store
   */
  constructor (txRelay, store) {
    super()
    this.txRelay = txRelay
    this.store = store
    /** @type {Map<string, string>} hash160 → address (human-readable) */
    this._watched = new Map()
    /** @type {Set<string>} hash160s for fast lookup */
    this._hash160Set = new Set()

    this.txRelay.on('tx:new', ({ txid, rawHex }) => {
      this._processTx(txid, rawHex).catch(err => {
        this.emit('error', err)
      })
    })
  }

  /**
   * Watch an address by its compressed public key hex.
   * @param {string} pubkeyHex — 33-byte compressed public key
   * @param {string} [label] — optional human-readable label
   */
  watchPubkey (pubkeyHex, label) {
    const hash160 = pubkeyToHash160(pubkeyHex)
    this._watched.set(hash160, label || pubkeyHex)
    this._hash160Set.add(hash160)
  }

  /**
   * Watch an address by its hash160 directly.
   * @param {string} hash160 — 20-byte hash160 as hex
   * @param {string} [label] — optional human-readable label
   */
  watchHash160 (hash160, label) {
    this._watched.set(hash160, label || hash160)
    this._hash160Set.add(hash160)
  }

  /**
   * Stop watching an address.
   * @param {string} hash160
   */
  unwatch (hash160) {
    this._watched.delete(hash160)
    this._hash160Set.delete(hash160)
  }

  /**
   * Get all watched hash160s.
   * @returns {Array<{ hash160: string, label: string }>}
   */
  getWatched () {
    const result = []
    for (const [hash160, label] of this._watched) {
      result.push({ hash160, label })
    }
    return result
  }

  /**
   * Manually process a raw transaction (e.g., from fund command).
   * @param {string} rawHex
   */
  async processTxManual (rawHex) {
    const { checkTxForWatched: check } = await import('./output-parser.js')
    const result = check(rawHex, this._hash160Set)
    await this._handleResult(result, rawHex)
  }

  /** @private */
  async _processTx (txid, rawHex) {
    if (this._hash160Set.size === 0) return

    const result = checkTxForWatched(rawHex, this._hash160Set)
    await this._handleResult(result, rawHex)
  }

  /** @private */
  async _handleResult (result, rawHex) {
    // Check inputs — are any of our UTXOs being spent?
    for (const spend of result.spends) {
      const utxoKey = `${spend.prevTxid}:${spend.prevVout}`
      // Check if this input spends one of our tracked UTXOs
      const existing = await this.store._utxos.get(utxoKey)
      if (existing !== undefined && !existing.spent) {
        await this.store.spendUtxo(spend.prevTxid, spend.prevVout)
        this.emit('utxo:spent', {
          txid: spend.prevTxid,
          vout: spend.prevVout,
          spentByTxid: result.txid
        })
      }
    }

    // Check outputs — any paying to our watched addresses?
    if (result.matches.length > 0) {
      // Store the raw tx for future reference
      await this.store.putTx(result.txid, rawHex)

      for (const match of result.matches) {
        const address = this._watched.get(match.hash160) || match.hash160

        // Store as UTXO
        await this.store.putUtxo({
          txid: result.txid,
          vout: match.vout,
          satoshis: match.satoshis,
          scriptHex: match.scriptHex,
          address
        })

        // Record watched-address match
        await this.store.putWatchedTx({
          txid: result.txid,
          address,
          direction: 'in',
          timestamp: Date.now()
        })

        this.emit('utxo:received', {
          txid: result.txid,
          vout: match.vout,
          satoshis: match.satoshis,
          address,
          hash160: match.hash160
        })
      }

      this.emit('tx:watched', {
        txid: result.txid,
        matches: result.matches.length
      })
    }
  }
}
