import { parseTx } from './output-parser.js'

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const BATCH_SIZE = 5          // concurrent fetches per batch
const BATCH_DELAY_MS = 400    // pause between batches (~12 req/s burst, ~5/400ms avg)
const PROGRESS_INTERVAL = 10  // emit progress every N txs (or on inscription find)

/**
 * AddressScanner — fetches all txids for an address from WhatsOnChain,
 * retrieves raw tx hex, parses each one, and indexes any inscriptions
 * found into the persistent store.
 *
 * Uses batched parallel fetching for speed while respecting WoC rate limits.
 * Emits progress callbacks so callers can stream status to clients.
 */

/**
 * Scan an address for inscriptions.
 * @param {string} address — BSV address to scan
 * @param {import('./persistent-store.js').PersistentStore} store — persistent store instance
 * @param {function} [onProgress] — called with { phase, current, total, txid, found } on each step
 * @returns {Promise<{ address: string, txsScanned: number, inscriptionsFound: number, errors: number }>}
 */
export async function scanAddress (address, store, onProgress = () => {}) {
  // Phase 1: Fetch tx history from WhatsOnChain
  onProgress({ phase: 'discovery', current: 0, total: 0, message: 'Fetching transaction history...' })

  const historyUrl = `${WOC_BASE}/address/${address}/history`
  const histRes = await fetchWithRetry(historyUrl)
  if (!histRes.ok) {
    throw new Error(`WhatsOnChain returned ${histRes.status} for address history`)
  }
  const history = await histRes.json()

  if (!Array.isArray(history) || history.length === 0) {
    onProgress({ phase: 'done', current: 0, total: 0, message: 'No transactions found for this address' })
    return { address, txsScanned: 0, inscriptionsFound: 0, errors: 0 }
  }

  const txids = history.map(h => h.tx_hash)
  onProgress({ phase: 'scanning', current: 0, total: txids.length, message: `Found ${txids.length} transactions. Scanning...` })

  // Phase 2: Check cache — split into cached vs uncached
  const uncached = []
  const cached = []
  for (const txid of txids) {
    const rawHex = await store.getTx(txid)
    if (rawHex) {
      cached.push({ txid, rawHex })
    } else {
      uncached.push(txid)
    }
  }

  onProgress({
    phase: 'scanning',
    current: cached.length,
    total: txids.length,
    message: `${cached.length} cached, ${uncached.length} to fetch from network...`
  })

  let inscriptionsFound = 0
  let errors = 0
  let processed = 0

  // Phase 3: Process cached txs instantly (no network, no delay)
  for (const { txid, rawHex } of cached) {
    const found = await parseTxAndIndex(txid, rawHex, store)
    inscriptionsFound += found
    processed++
    if (found > 0 || processed % PROGRESS_INTERVAL === 0) {
      onProgress({ phase: 'scanning', current: processed, total: txids.length, txid, found })
    }
  }

  // Phase 4: Fetch uncached txs in parallel batches
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE)

    // Fetch batch concurrently
    const results = await Promise.allSettled(
      batch.map(txid => fetchTxHex(txid))
    )

    // Process batch results
    for (let j = 0; j < results.length; j++) {
      const txid = batch[j]
      const result = results[j]
      processed++

      if (result.status === 'rejected' || result.value === null) {
        errors++
        if (processed % PROGRESS_INTERVAL === 0) {
          onProgress({ phase: 'scanning', current: processed, total: txids.length, txid, error: result.reason?.message || 'fetch failed' })
        }
        continue
      }

      const rawHex = result.value
      await store.putTx(txid, rawHex)
      const found = await parseTxAndIndex(txid, rawHex, store)
      inscriptionsFound += found

      if (found > 0 || processed % PROGRESS_INTERVAL === 0) {
        onProgress({ phase: 'scanning', current: processed, total: txids.length, txid, found })
      }
    }

    // Rate limit between batches (only if more batches remain)
    if (i + BATCH_SIZE < uncached.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  // Final progress
  onProgress({
    phase: 'done',
    current: txids.length,
    total: txids.length,
    message: `Scan complete. ${inscriptionsFound} inscriptions found in ${txids.length} transactions (${cached.length} cached, ${uncached.length} fetched).`
  })

  return { address, txsScanned: txids.length, inscriptionsFound, errors }
}

/** Fetch raw tx hex from WhatsOnChain. Returns hex string or null on error. */
async function fetchTxHex (txid) {
  const res = await fetchWithRetry(`${WOC_BASE}/tx/${txid}/hex`)
  if (!res.ok) return null
  return res.text()
}

/** Parse a tx and index any inscriptions. Returns count of inscriptions found. */
async function parseTxAndIndex (txid, rawHex, store) {
  const parsed = parseTx(rawHex)
  let count = 0
  for (const output of parsed.outputs) {
    if (output.type === 'ordinal' && output.parsed) {
      await store.putInscription({
        txid,
        vout: output.vout,
        contentType: output.parsed.contentType || null,
        contentSize: output.parsed.content ? output.parsed.content.length / 2 : 0,
        content: output.parsed.content || null,
        isBsv20: output.parsed.isBsv20 || false,
        bsv20: output.parsed.bsv20 || null,
        timestamp: Date.now(),
        address: output.hash160 || null
      })
      count++
    }
  }
  return count
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry (url, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url)
    if (res.status === 429 && attempt < maxAttempts) {
      await sleep(1000 * Math.pow(2, attempt - 1))
      continue
    }
    return res
  }
}
