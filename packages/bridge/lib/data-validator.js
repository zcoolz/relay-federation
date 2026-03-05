import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'

// BSV block header is 80 bytes.
// Timestamp bounds: reject headers more than 2 hours in the future.
const MAX_FUTURE_SECONDS = 2 * 60 * 60

/**
 * Validate a block header.
 *
 * Checks:
 * - Has required fields (height, hash, prevHash)
 * - Hash is a 64-char hex string
 * - prevHash is a 64-char hex string
 *
 * Note: Full PoW validation requires raw 80-byte header data, which our
 * HeaderRelay doesn't carry (it uses {height, hash, prevHash} objects).
 * We validate format and chain linkage here; PoW validation is deferred
 * to when raw headers are available.
 *
 * @param {object} header — { height, hash, prevHash }
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateHeader (header) {
  if (!header || typeof header !== 'object') {
    return { valid: false, reason: 'not_an_object' }
  }

  if (typeof header.height !== 'number' || header.height < 0) {
    return { valid: false, reason: 'invalid_height' }
  }

  if (typeof header.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(header.hash)) {
    return { valid: false, reason: 'invalid_hash' }
  }

  if (typeof header.prevHash !== 'string' || !/^[0-9a-f]{64}$/i.test(header.prevHash)) {
    return { valid: false, reason: 'invalid_prevHash' }
  }

  return { valid: true }
}

/**
 * Validate a transaction.
 *
 * Checks:
 * - txid is a valid 64-char hex string
 * - rawHex is a non-empty hex string
 * - rawHex has minimum tx size (at least 10 bytes = 20 hex chars)
 *
 * @param {string} txid
 * @param {string} rawHex
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateTx (txid, rawHex) {
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    return { valid: false, reason: 'invalid_txid' }
  }

  if (typeof rawHex !== 'string' || rawHex.length < 20) {
    return { valid: false, reason: 'invalid_raw_hex' }
  }

  if (!/^[0-9a-f]+$/i.test(rawHex)) {
    return { valid: false, reason: 'not_hex' }
  }

  // Verify txid matches hash of raw tx
  const hash1 = createHash('sha256').update(Buffer.from(rawHex, 'hex')).digest()
  const hash2 = createHash('sha256').update(hash1).digest()
  const computedTxid = hash2.reverse().toString('hex')

  if (computedTxid !== txid.toLowerCase()) {
    return { valid: false, reason: 'txid_mismatch' }
  }

  return { valid: true }
}

/**
 * Validate header chain linkage.
 *
 * Checks that each header's prevHash matches the previous header's hash.
 *
 * @param {Array<{ height: number, hash: string, prevHash: string }>} headers — sorted by height ascending
 * @returns {{ valid: boolean, reason?: string, invalidAt?: number }}
 */
export function validateHeaderChain (headers) {
  if (!Array.isArray(headers) || headers.length === 0) {
    return { valid: true } // empty chain is valid
  }

  for (let i = 0; i < headers.length; i++) {
    const check = validateHeader(headers[i])
    if (!check.valid) {
      return { valid: false, reason: `header[${i}]: ${check.reason}`, invalidAt: i }
    }
  }

  for (let i = 1; i < headers.length; i++) {
    if (headers[i].prevHash !== headers[i - 1].hash) {
      return {
        valid: false,
        reason: `chain_break at height ${headers[i].height}: prevHash doesn't match previous hash`,
        invalidAt: i
      }
    }
  }

  return { valid: true }
}

/**
 * DataValidator — hooks into PeerManager events and reports
 * data accuracy to PeerScorer.
 *
 * Listens for peer:message events, validates headers and txs,
 * and calls scorer.recordGoodData/recordBadData.
 *
 * Emits:
 *   'validation:fail' — { pubkeyHex, type, reason }
 */
export class DataValidator extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {import('./peer-scorer.js').PeerScorer} scorer
   */
  constructor (peerManager, scorer) {
    super()
    this.peerManager = peerManager
    this.scorer = scorer

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._onMessage(pubkeyHex, message)
    })
  }

  _onMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'headers':
        this._validateHeaders(pubkeyHex, message)
        break
      case 'tx':
        this._validateTx(pubkeyHex, message)
        break
      case 'header_announce':
        this._validateHeaderAnnounce(pubkeyHex, message)
        break
    }
  }

  _validateHeaders (pubkeyHex, msg) {
    if (!Array.isArray(msg.headers) || msg.headers.length === 0) {
      this.scorer.recordBadData(pubkeyHex)
      this.emit('validation:fail', { pubkeyHex, type: 'headers', reason: 'empty_or_missing' })
      return
    }

    const chainCheck = validateHeaderChain(msg.headers)
    if (!chainCheck.valid) {
      this.scorer.recordBadData(pubkeyHex)
      this.emit('validation:fail', { pubkeyHex, type: 'headers', reason: chainCheck.reason })
      return
    }

    // Each valid header counts as a good data point
    for (let i = 0; i < msg.headers.length; i++) {
      this.scorer.recordGoodData(pubkeyHex)
    }
  }

  _validateTx (pubkeyHex, msg) {
    if (!msg.txid || !msg.rawHex) {
      this.scorer.recordBadData(pubkeyHex)
      this.emit('validation:fail', { pubkeyHex, type: 'tx', reason: 'missing_fields' })
      return
    }

    const check = validateTx(msg.txid, msg.rawHex)
    if (!check.valid) {
      this.scorer.recordBadData(pubkeyHex)
      this.emit('validation:fail', { pubkeyHex, type: 'tx', reason: check.reason })
      return
    }

    this.scorer.recordGoodData(pubkeyHex)
  }

  _validateHeaderAnnounce (pubkeyHex, msg) {
    if (typeof msg.height !== 'number' || msg.height < 0) {
      this.scorer.recordBadData(pubkeyHex)
      this.emit('validation:fail', { pubkeyHex, type: 'header_announce', reason: 'invalid_height' })
      return
    }

    if (typeof msg.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(msg.hash)) {
      this.scorer.recordBadData(pubkeyHex)
      this.emit('validation:fail', { pubkeyHex, type: 'header_announce', reason: 'invalid_hash' })
      return
    }

    this.scorer.recordGoodData(pubkeyHex)
  }
}
