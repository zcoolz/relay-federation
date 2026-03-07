import { Level } from 'level'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
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
    this._hashIndex = null
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
    this._hashIndex = this.db.sublevel('hashIndex', { valueEncoding: 'json' })
    this.emit('open')
  }

  /** Close the database. */
  async close () {
    if (this.db) await this.db.close()
  }

  // ── Headers ──────────────────────────────────────────────

  /**
   * Store a header by height (with hash index).
   * @param {{ height: number, hash: string, prevHash: string, merkleRoot?: string, timestamp?: number, bits?: number, nonce?: number, version?: number }} header
   */
  async putHeader (header) {
    await this._headers.put(String(header.height), header)
    if (header.hash) {
      await this._hashIndex.put(header.hash, header.height)
    }
  }

  /**
   * Store multiple headers in a batch (with hash index).
   * @param {Array<{ height: number, hash: string, prevHash: string, merkleRoot?: string, timestamp?: number, bits?: number, nonce?: number, version?: number }>} headers
   */
  async putHeaders (headers) {
    const headerOps = headers.map(h => ({
      type: 'put',
      key: String(h.height),
      value: h
    }))
    await this._headers.batch(headerOps)
    const hashOps = headers.filter(h => h.hash).map(h => ({
      type: 'put',
      key: h.hash,
      value: h.height
    }))
    if (hashOps.length > 0) {
      await this._hashIndex.batch(hashOps)
    }
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

  /**
   * Get a header by block hash.
   * @param {string} hash
   * @returns {Promise<object|null>}
   */
  async getHeaderByHash (hash) {
    const height = await this._hashIndex.get(hash)
    if (height === undefined) return null
    return this.getHeader(height)
  }

  /**
   * Verify a merkle proof against a stored block header.
   * @param {string} txHash — transaction hash (hex, display order)
   * @param {string[]} merkleProof — sibling hashes in the merkle path
   * @param {number} txIndex — transaction index in the block
   * @param {string} blockHash — block hash to verify against
   * @returns {Promise<{ verified: boolean, blockHeight: number, blockTimestamp: number }>}
   */
  async verifyMerkleProof (txHash, merkleProof, txIndex, blockHash) {
    const header = await this.getHeaderByHash(blockHash)
    if (!header) {
      throw new Error(`Block ${blockHash} not found in header chain`)
    }
    if (!header.merkleRoot) {
      throw new Error(`Header at height ${header.height} has no merkleRoot stored`)
    }

    // Compute merkle root from proof
    let hash = Buffer.from(txHash, 'hex').reverse()
    let index = txIndex

    for (const proofHash of merkleProof) {
      const sibling = Buffer.from(proofHash, 'hex').reverse()
      const combined = (index % 2 === 0)
        ? Buffer.concat([hash, sibling])
        : Buffer.concat([sibling, hash])
      hash = doubleSha256(combined)
      index = Math.floor(index / 2)
    }

    const calculatedRoot = hash.reverse().toString('hex')

    if (calculatedRoot !== header.merkleRoot) {
      throw new Error('Merkle proof verification failed')
    }

    return {
      verified: true,
      blockHash: header.hash,
      blockHeight: header.height,
      blockTimestamp: header.timestamp
    }
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

/** Double SHA-256 (Bitcoin standard) */
function doubleSha256 (data) {
  return createHash('sha256').update(
    createHash('sha256').update(data).digest()
  ).digest()
}
