/**
 * Local benchmark for address scanner.
 * Creates a temp LevelDB store, runs the scanner, reports timing.
 *
 * Usage: node test/scanner-bench.mjs [address]
 * Default address: 1JJocovXmjvnzpwT4psah9XFHd31nqfbGX (22 txs, 13 inscriptions)
 */
import { PersistentStore } from '../lib/persistent-store.js'
import { scanAddress } from '../lib/address-scanner.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const address = process.argv[2] || '1JJocovXmjvnzpwT4psah9XFHd31nqfbGX'
const tmpDir = mkdtempSync(join(tmpdir(), 'scanner-bench-'))

console.log(`Benchmarking address scanner`)
console.log(`Address: ${address}`)
console.log(`Temp DB: ${tmpDir}`)
console.log(`---`)

const store = new PersistentStore(tmpDir)
await store.open()

let lastProgress = null
const start = Date.now()

const result = await scanAddress(address, store, (progress) => {
  lastProgress = progress
  if (progress.phase === 'discovery') {
    console.log(`[discovery] ${progress.message}`)
  } else if (progress.phase === 'scanning') {
    const pct = Math.round((progress.current / progress.total) * 100)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const rate = progress.current > 0 ? (progress.current / ((Date.now() - start) / 1000)).toFixed(1) : '0'
    const suffix = progress.found > 0 ? ` [+${progress.found} inscription(s)]` : ''
    const errSuffix = progress.error ? ` [ERROR: ${progress.error}]` : ''
    console.log(`[${pct}%] ${progress.current}/${progress.total} (${elapsed}s, ${rate} tx/s)${suffix}${errSuffix}`)
  } else if (progress.phase === 'done') {
    console.log(`[done] ${progress.message}`)
  }
})

const elapsed = ((Date.now() - start) / 1000).toFixed(1)
const rate = (result.txsScanned / ((Date.now() - start) / 1000)).toFixed(1)

console.log(`\n=== Results ===`)
console.log(`Txs scanned:   ${result.txsScanned}`)
console.log(`Inscriptions:  ${result.inscriptionsFound}`)
console.log(`Errors:        ${result.errors}`)
console.log(`Time:          ${elapsed}s`)
console.log(`Rate:          ${rate} tx/s`)

// Run again to test cached performance
console.log(`\n=== Re-scan (cached) ===`)
const start2 = Date.now()
const result2 = await scanAddress(address, store, (progress) => {
  if (progress.phase === 'done') console.log(`[done] ${progress.message}`)
})
const elapsed2 = ((Date.now() - start2) / 1000).toFixed(1)
console.log(`Time:          ${elapsed2}s (all cached)`)

await store.close()

// Cleanup
try { rmSync(tmpDir, { recursive: true }) } catch {}
console.log(`\nTemp DB cleaned up.`)
