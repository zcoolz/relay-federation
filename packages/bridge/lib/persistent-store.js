import { Level } from 'level'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

/**
 * PersistentStore — LevelDB-backed storage for bridge state.
 *
 * Stores headers, transactions, and arbitrary metadata in sublevel
 * namespaces. Replaces the in-memory Maps used by HeaderRelay and
 * TxRelay with durable storage that survives restarts.
 *
 * Sublevels:
 *   headers    — height → { height, hash, prevHash }
 *   txs        — txid → rawHex
 *   utxos      — txid:vout → { txid, vout, satoshis, scriptHex, address, spent }
 *   meta       — key → value (bestHeight, bestHash, etc.)
 *   watched    — txid → { txid, address, direction, timestamp }
 *
 * Events:
 *   'open'  — store ready
 *   'error' — LevelDB error
 */
export class PersistentStore extends EventEmitter {
  /**
   * @param {string} dataDir — directory for the LevelDB database
   */
  constructor (dataDir) {
    super()
    this.dbPath = join(dataDir, 'bridge.db')
    this.db = null
    this._headers = null
    this._txs = null
    this._utxos = null
    this._meta = null
    this._watched = null
  }

  /** Open the database and create sublevels. */
  async open () {
    this.db = new Level(this.dbPath, { valueEncoding: 'json' })
    await this.db.open()
    this._headers = this.db.sublevel('headers', { valueEncoding: 'json' })
    this._txs = this.db.sublevel('txs', { valueEncoding: 'utf8' })
    this._utxos = this.db.sublevel('utxos', { valueEncoding: 'json' })
    this._meta = this.db.sublevel('meta', { valueEncoding: 'json' })
    this._watched = this.db.sublevel('watched', { valueEncoding: 'json' })
    this.emit('open')
  }

  /** Close the database. */
  async close () {
    if (this.db) await this.db.close()
  }

  // ── Headers ──────────────────────────────────────────────

  /**
   * Store a header by height.
   * @param {{ height: number, hash: string, prevHash: string }} header
   */
  async putHeader (header) {
    await this._headers.put(String(header.height), header)
  }

  /**
   * Store multiple headers in a batch.
   * @param {Array<{ height: number, hash: string, prevHash: string }>} headers
   */
  async putHeaders (headers) {
    const ops = headers.map(h => ({
      type: 'put',
      key: String(h.height),
      value: h
    }))
    await this._headers.batch(ops)
  }

  /**
   * Get a header by height.
   * @param {number} height
   * @returns {Promise<{ height: number, hash: string, prevHash: string }|null>}
   */
  async getHeader (height) {
    const val = await this._headers.get(String(height))
    return val !== undefined ? val : null
  }

  // ── Transactions ─────────────────────────────────────────

  /**
   * Store a raw transaction.
   * @param {string} txid
   * @param {string} rawHex
   */
  async putTx (txid, rawHex) {
    await this._txs.put(txid, rawHex)
  }

  /**
   * Get a raw transaction by txid.
   * @param {string} txid
   * @returns {Promise<string|null>} rawHex or null
   */
  async getTx (txid) {
    const val = await this._txs.get(txid)
    return val !== undefined ? val : null
  }

  /**
   * Check if a transaction exists.
   * @param {string} txid
   * @returns {Promise<boolean>}
   */
  async hasTx (txid) {
    return (await this.getTx(txid)) !== null
  }

  // ── UTXOs ────────────────────────────────────────────────

  /**
   * Store a UTXO.
   * @param {{ txid: string, vout: number, satoshis: number, scriptHex: string, address: string }} utxo
   */
  async putUtxo (utxo) {
    const key = `${utxo.txid}:${utxo.vout}`
    await this._utxos.put(key, { ...utxo, spent: false })
  }

  /**
   * Mark a UTXO as spent.
   * @param {string} txid
   * @param {number} vout
   */
  async spendUtxo (txid, vout) {
    const key = `${txid}:${vout}`
    const utxo = await this._utxos.get(key)
    if (utxo === undefined) return
    utxo.spent = true
    await this._utxos.put(key, utxo)
  }

  /**
   * Get all unspent UTXOs.
   * @returns {Promise<Array<{ txid: string, vout: number, satoshis: number, scriptHex: string, address: string }>>}
   */
  async getUnspentUtxos () {
    const utxos = []
    for await (const [, utxo] of this._utxos.iterator()) {
      if (!utxo.spent) utxos.push(utxo)
    }
    return utxos
  }

  /**
   * Get total unspent balance in satoshis.
   * @returns {Promise<number>}
   */
  async getBalance () {
    let total = 0
    for await (const [, utxo] of this._utxos.iterator()) {
      if (!utxo.spent) total += utxo.satoshis
    }
    return total
  }

  // ── Watched address matches ──────────────────────────────

  /**
   * Store a watched-address match (a tx that touched a watched address).
   * @param {{ txid: string, address: string, direction: 'in'|'out', timestamp: number }} match
   */
  async putWatchedTx (match) {
    const key = `${match.address}:${match.txid}`
    await this._watched.put(key, match)
  }

  /**
   * Get all watched-address matches for an address.
   * @param {string} address
   * @returns {Promise<Array>}
   */
  async getWatchedTxs (address) {
    const matches = []
    for await (const [key, value] of this._watched.iterator()) {
      if (key.startsWith(`${address}:`)) {
        matches.push(value)
      }
    }
    return matches
  }

  // ── Metadata ─────────────────────────────────────────────

  /**
   * Store a metadata value.
   * @param {string} key
   * @param {*} value — any JSON-serializable value
   */
  async putMeta (key, value) {
    await this._meta.put(key, value)
  }

  /**
   * Get a metadata value.
   * @param {string} key
   * @param {*} [defaultValue=null]
   * @returns {Promise<*>}
   */
  async getMeta (key, defaultValue = null) {
    const val = await this._meta.get(key)
    return val !== undefined ? val : defaultValue
  }
}
