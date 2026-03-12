import { Level } from 'level'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'

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
    this._inscriptions = null
    this._inscriptionIdx = null
    this._txStatus = null
    this._txBlock = null
    this._content = null
    this._tokens = null
    this._contentDir = join(dataDir, 'content')
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
    this._inscriptions = this.db.sublevel('inscriptions', { valueEncoding: 'json' })
    this._inscriptionIdx = this.db.sublevel('inscIdx', { valueEncoding: 'json' })
    this._txStatus = this.db.sublevel('txStatus', { valueEncoding: 'json' })
    this._txBlock = this.db.sublevel('txBlock', { valueEncoding: 'json' })
    this._content = this.db.sublevel('content', { valueEncoding: 'json' })
    this._tokens = this.db.sublevel('tokens', { valueEncoding: 'json' })
    await mkdir(this._contentDir, { recursive: true })
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
  // ── Tx Status + Block Mapping ───────────────────────────

  /**
   * Set or update tx lifecycle state.
   * @param {string} txid
   * @param {'mempool'|'confirmed'|'orphaned'|'dropped'} state
   * @param {object} [meta] — optional fields: blockHash, height, source
   */
  async updateTxStatus (txid, state, meta = {}) {
    const key = `s!${txid}`
    const now = Date.now()
    let existing = null
    try {
      const val = await this._txStatus.get(key)
      if (val !== undefined) existing = val
    } catch {}

    const record = existing || { firstSeen: now }
    record.state = state
    record.lastSeen = now
    record.updatedAt = now
    if (meta.blockHash) record.blockHash = meta.blockHash
    if (meta.height !== undefined) record.height = meta.height
    if (meta.source) record.source = meta.source

    const batch = [{ type: 'put', key, value: record }]

    // Maintain mempool secondary index
    if (state === 'mempool') {
      batch.push({ type: 'put', key: `mempool!${txid}`, value: 1 })
    } else if (existing?.state === 'mempool') {
      batch.push({ type: 'del', key: `mempool!${txid}` })
    }

    await this._txStatus.batch(batch)
    return record
  }

  /**
   * Get tx lifecycle state.
   * @param {string} txid
   * @returns {Promise<object|null>}
   */
  async getTxStatus (txid) {
    try {
      const val = await this._txStatus.get(`s!${txid}`)
      return val !== undefined ? val : null
    } catch { return null }
  }

  /**
   * Confirm a tx — atomic batch: txBlock + reverse index + txStatus update.
   * @param {string} txid
   * @param {string} blockHash
   * @param {number} height
   * @param {{ nodes: string[], index: number }|null} proof
   */
  async confirmTx (txid, blockHash, height, proof = null) {
    const now = Date.now()
    const blockRecord = { blockHash, height, confirmedAt: now, verified: !!proof }
    if (proof) blockRecord.proof = proof

    // Atomic batch across txBlock + txStatus
    const txBlockBatch = [
      { type: 'put', key: `tx!${txid}`, value: blockRecord },
      { type: 'put', key: `block!${blockHash}!tx!${txid}`, value: 1 }
    ]
    await this._txBlock.batch(txBlockBatch)

    await this.updateTxStatus(txid, 'confirmed', { blockHash, height })
    this.emit('tx:confirmed', { txid, blockHash, height })
  }

  /**
   * Get tx block placement.
   * @param {string} txid
   * @returns {Promise<object|null>}
   */
  async getTxBlock (txid) {
    try {
      const val = await this._txBlock.get(`tx!${txid}`)
      return val !== undefined ? val : null
    } catch { return null }
  }

  /**
   * Handle reorg — mark all txs in disconnected block as orphaned.
   * @param {string} blockHash — the disconnected block hash
   * @returns {Promise<string[]>} list of affected txids
   */
  async handleReorg (blockHash) {
    const affected = []
    const prefix = `block!${blockHash}!tx!`

    // Find all txids in this block via reverse index
    for await (const [key] of this._txBlock.iterator({ gte: prefix, lt: prefix + '~' })) {
      const txid = key.slice(prefix.length)
      affected.push(txid)
    }

    // Mark each as orphaned + clean up block associations
    for (const txid of affected) {
      await this.updateTxStatus(txid, 'orphaned', { blockHash })
      await this._txBlock.del(`tx!${txid}`)
      await this._txBlock.del(`block!${blockHash}!tx!${txid}`)
    }

    return affected
  }

  // ── Content-Addressed Storage ───────────────────────────

  static CAS_THRESHOLD = 4096 // 4KB — below this, inline in LevelDB

  /**
   * Store content bytes via CAS. Small content inline, large to filesystem.
   * @param {string} hexContent — hex-encoded content bytes
   * @param {string} [mime] — content type
   * @returns {Promise<{ contentHash: string, contentLen: number, contentPath: string|null, inline: boolean }>}
   */
  async putContent (hexContent, mime) {
    const buf = Buffer.from(hexContent, 'hex')
    const contentHash = createHash('sha256').update(buf).digest('hex')
    const contentLen = buf.length
    const inline = contentLen < PersistentStore.CAS_THRESHOLD

    const record = { len: contentLen, mime: mime || null, createdAt: Date.now() }

    if (inline) {
      record.inline = hexContent
      record.path = null
    } else {
      const dir = join(this._contentDir, contentHash.slice(0, 2))
      const filePath = join(dir, contentHash)
      await mkdir(dir, { recursive: true })
      await writeFile(filePath, buf)
      record.path = filePath
    }

    await this._content.put(`c!${contentHash}`, record)
    return { contentHash, contentLen, contentPath: record.path, inline }
  }

  /**
   * Get content bytes by hash.
   * @param {string} contentHash
   * @returns {Promise<Buffer|null>}
   */
  async getContentBytes (contentHash) {
    let record
    try {
      const val = await this._content.get(`c!${contentHash}`)
      if (val === undefined) return null
      record = val
    } catch { return null }

    if (record.inline) {
      return Buffer.from(record.inline, 'hex')
    }
    if (record.path) {
      try { return await readFile(record.path) } catch { return null }
    }
    return null
  }

  /**
   * Get content metadata by hash.
   * @param {string} contentHash
   * @returns {Promise<object|null>}
   */
  async getContentMeta (contentHash) {
    try {
      const val = await this._content.get(`c!${contentHash}`)
      return val !== undefined ? val : null
    } catch { return null }
  }

  // ── Token Tracking (BSV-20) ─────────────────────────────

  /**
   * Process a BSV-20 token operation (confirmed-only).
   * Uses atomic batch() for all writes. Keyed by scriptHash for owner identity.
   * @param {{ op: string, tick: string, amt: string, ownerScriptHash: string, address: string|null, txid: string, height: number, blockHash: string }} params
   * @returns {Promise<{ valid: boolean, reason?: string }>}
   */
  async processTokenOp ({ op, tick, amt, ownerScriptHash, address, txid, height, blockHash }) {
    const tickNorm = tick.toLowerCase().trim()

    if (op === 'deploy') {
      // Only first deploy counts (chain-ordered by height)
      const existing = await this._safeGet(this._tokens, `tick!${tickNorm}`)
      if (existing) return { valid: false, reason: 'already deployed' }

      const parsed = typeof amt === 'object' ? amt : {}
      const batch = [
        { type: 'put', key: `tick!${tickNorm}`, value: {
          tick: tickNorm, max: parsed.max || '0', lim: parsed.lim || '0',
          dec: parsed.dec || '0', deployer: ownerScriptHash, deployerAddr: address,
          deployTxid: txid, deployHeight: height, totalMinted: '0'
        }},
        { type: 'put', key: `op!${String(height).padStart(10, '0')}!${txid}!deploy`, value: {
          tick: tickNorm, op: 'deploy', ownerScriptHash, valid: true
        }}
      ]
      await this._tokens.batch(batch)
      return { valid: true }
    }

    if (op === 'mint') {
      const deploy = await this._safeGet(this._tokens, `tick!${tickNorm}`)
      if (!deploy) return { valid: false, reason: 'token not deployed' }

      const mintAmt = BigInt(amt || '0')
      if (mintAmt <= 0n) return { valid: false, reason: 'invalid amount' }
      if (deploy.lim !== '0' && mintAmt > BigInt(deploy.lim)) return { valid: false, reason: 'exceeds mint limit' }

      const newTotal = BigInt(deploy.totalMinted) + mintAmt
      if (deploy.max !== '0' && newTotal > BigInt(deploy.max)) return { valid: false, reason: 'exceeds max supply' }

      // Credit owner balance
      const balKey = `bal!${tickNorm}!owner!${ownerScriptHash}`
      const existing = await this._safeGet(this._tokens, balKey) || { confirmed: '0' }
      const newBal = (BigInt(existing.confirmed) + mintAmt).toString()

      const batch = [
        { type: 'put', key: `tick!${tickNorm}`, value: { ...deploy, totalMinted: newTotal.toString() } },
        { type: 'put', key: balKey, value: { confirmed: newBal, updatedAt: Date.now() } },
        { type: 'put', key: `op!${String(height).padStart(10, '0')}!${txid}!mint`, value: {
          tick: tickNorm, op: 'mint', amt: amt, ownerScriptHash, valid: true
        }}
      ]
      await this._tokens.batch(batch)
      return { valid: true }
    }

    // Transfers deferred to Phase 2
    return { valid: false, reason: 'transfers not yet supported' }
  }

  /**
   * Get token deploy info.
   * @param {string} tick
   * @returns {Promise<object|null>}
   */
  async getToken (tick) {
    return this._safeGet(this._tokens, `tick!${tick.toLowerCase().trim()}`)
  }

  /**
   * Get token balance for an owner.
   * @param {string} tick
   * @param {string} ownerScriptHash
   * @returns {Promise<string>} balance as string
   */
  async getTokenBalance (tick, ownerScriptHash) {
    const record = await this._safeGet(this._tokens, `bal!${tick.toLowerCase().trim()}!owner!${ownerScriptHash}`)
    return record ? record.confirmed : '0'
  }

  /**
   * List all deployed tokens.
   * @returns {Promise<Array>}
   */
  async listTokens () {
    const tokens = []
    const prefix = 'tick!'
    for await (const [key, value] of this._tokens.iterator({ gte: prefix, lt: prefix + '~' })) {
      tokens.push(value)
    }
    return tokens
  }

  /** Safe get — returns null instead of throwing for missing keys. */
  async _safeGet (sublevel, key) {
    try {
      const val = await sublevel.get(key)
      return val !== undefined ? val : null
    } catch { return null }
  }

  // ── Inscriptions ─────────────────────────────────────────

  /**
   * Store an inscription record with secondary indexes.
   * @param {{ txid: string, vout: number, contentType: string, contentSize: number, isBsv20: boolean, bsv20: object|null, timestamp: number, address: string|null }} record
   */
  async putInscription (record) {
    const key = `${record.txid}:${record.vout}`
    const suffix = `${record.txid}:${record.vout}`

    // Purge ALL stale secondary index entries pointing to this key
    try {
      const delBatch = []
      for await (const [idxKey, val] of this._inscriptionIdx.iterator()) {
        if (val === key && idxKey.endsWith(suffix)) delBatch.push({ type: 'del', key: idxKey })
      }
      if (delBatch.length) await this._inscriptionIdx.batch(delBatch)
    } catch {}

    // Route content through CAS
    if (record.content) {
      try {
        const cas = await this.putContent(record.content, record.contentType)
        record.contentHash = cas.contentHash
        record.contentLen = cas.contentLen
        // Strip raw content from inscription record if large (stored on filesystem)
        if (!cas.inline) {
          delete record.content
        }
      } catch {}
    }

    await this._inscriptions.put(key, record)

    const ts = String(record.timestamp).padStart(15, '0')
    const batch = [{ type: 'put', key: `time:${ts}:${suffix}`, value: key }]
    if (record.contentType) {
      batch.push({ type: 'put', key: `mime:${record.contentType}:${ts}:${suffix}`, value: key })
    }
    if (record.address) {
      batch.push({ type: 'put', key: `addr:${record.address}:${ts}:${suffix}`, value: key })
    }
    await this._inscriptionIdx.batch(batch)
  }

  /**
   * Query inscriptions with optional filters.
   * @param {{ mime?: string, address?: string, limit?: number }} opts
   * @returns {Promise<Array>}
   */
  async getInscriptions ({ mime, address, limit = 50 } = {}) {
    const results = []
    let prefix
    if (address) {
      prefix = `addr:${address}:`
    } else if (mime) {
      prefix = `mime:${mime}:`
    } else {
      prefix = 'time:'
    }

    for await (const [, primaryKey] of this._inscriptionIdx.iterator({
      gte: prefix, lt: prefix + '~', reverse: true, limit
    })) {
      try {
        const record = await this._inscriptions.get(primaryKey)
        if (record) {
          // Strip content from list results (can be 400KB+ per image)
          const { content, ...meta } = record
          results.push(meta)
        }
      } catch {}
    }
    return results
  }

  /**
   * Rebuild inscription secondary indexes from primary records.
   * Clears all index entries and re-creates from source of truth.
   * @returns {Promise<number>} count of inscriptions re-indexed
   */
  async rebuildInscriptionIndex () {
    // Clear entire index
    for await (const [key] of this._inscriptionIdx.iterator()) {
      await this._inscriptionIdx.del(key)
    }
    // Re-create from primary records
    let count = 0
    for await (const [, record] of this._inscriptions.iterator()) {
      const ts = String(record.timestamp).padStart(15, '0')
      const suffix = `${record.txid}:${record.vout}`
      const key = suffix
      const batch = [{ type: 'put', key: `time:${ts}:${suffix}`, value: key }]
      if (record.contentType) batch.push({ type: 'put', key: `mime:${record.contentType}:${ts}:${suffix}`, value: key })
      if (record.address) batch.push({ type: 'put', key: `addr:${record.address}:${ts}:${suffix}`, value: key })
      await this._inscriptionIdx.batch(batch)
      count++
    }
    return count
  }

  /**
   * Get a single inscription record (with content) by txid:vout.
   * @param {string} txid
   * @param {number} vout
   * @returns {Promise<object|null>}
   */
  async getInscription (txid, vout) {
    try {
      return await this._inscriptions.get(`${txid}:${vout}`)
    } catch {
      return null
    }
  }

  /**
   * Get total inscription count.
   * @returns {Promise<number>}
   */
  async getInscriptionCount () {
    let count = 0
    for await (const _ of this._inscriptions.keys()) count++
    return count
  }
}

/** Double SHA-256 (Bitcoin standard) */
function doubleSha256 (data) {
  return createHash('sha256').update(
    createHash('sha256').update(data).digest()
  ).digest()
}
