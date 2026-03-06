#!/usr/bin/env node

import { join } from 'node:path'
import { initConfig, loadConfig, configExists, defaultConfigDir } from './lib/config.js'
import { PeerManager } from './lib/peer-manager.js'
import { HeaderRelay } from './lib/header-relay.js'
import { TxRelay } from './lib/tx-relay.js'
import { StatusServer } from './lib/status-server.js'
import { fetchUtxos, broadcastTx } from '@relay-federation/common/network'

const command = process.argv[2]

switch (command) {
  case 'init':
    await cmdInit()
    break
  case 'register':
    await cmdRegister()
    break
  case 'start':
    await cmdStart()
    break
  case 'status':
    await cmdStatus()
    break
  case 'fund':
    await cmdFund()
    break
  case 'deregister':
    await cmdDeregister()
    break
  default:
    console.log('relay-bridge — Federated SPV relay mesh bridge\n')
    console.log('Commands:')
    console.log('  init        Generate bridge identity and config')
    console.log('  register    Register this bridge on-chain')
    console.log('  start       Start the bridge server')
    console.log('  status      Show running bridge status')
    console.log('  fund        Import a funding transaction (raw hex)')
    console.log('  deregister  Deregister this bridge from the mesh')
    console.log('')
    console.log('Usage: relay-bridge <command> [options]')
    process.exit(command ? 1 : 0)
}

async function cmdInit () {
  const dir = defaultConfigDir()

  if (await configExists(dir)) {
    console.log(`Config already exists at ${dir}/config.json`)
    console.log('To re-initialize, delete the existing config first.')
    process.exit(1)
  }

  const config = await initConfig(dir)

  console.log('Bridge initialized!\n')
  console.log(`  Config: ${dir}/config.json`)
  console.log(`  Pubkey: ${config.pubkeyHex}`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. Edit config.json — set your WSS endpoint and API key')
  console.log('  2. Fund your bridge address with BSV')
  console.log('  3. Run: relay-bridge register')
}

async function cmdRegister () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)

  if (config.endpoint === 'wss://your-bridge.example.com:8333') {
    console.log('Error: Update your endpoint in config.json before registering.')
    process.exit(1)
  }

  console.log('Registration details:\n')
  console.log(`  Pubkey:       ${config.pubkeyHex}`)
  console.log(`  Endpoint:     ${config.endpoint}`)
  console.log(`  Mesh:         ${config.meshId}`)
  console.log(`  Capabilities: ${config.capabilities.join(', ')}`)
  console.log(`  SPV Endpoint: ${config.spvEndpoint}`)
  console.log('')
  console.log('On-chain registration requires:')
  console.log('  - Funded wallet (stake bond + tx fees)')
  console.log('  - Valid API key for SPV bridge access')
  console.log('')
  console.log('Broadcast support coming in Phase 2.')
}

async function cmdStart () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)
  const peerArg = process.argv[3] // optional: ws://host:port

  // ── 1. Open persistent store ──────────────────────────────
  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { PrivateKey } = await import('@bsv/sdk')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()
  console.log(`Database opened: ${dataDir}`)

  // Load persisted balance
  const balance = await store.getBalance()
  if (balance > 0) {
    console.log(`  Wallet balance: ${balance} satoshis`)
  }

  // ── 2. Core components ────────────────────────────────────
  const peerManager = new PeerManager({ maxPeers: config.maxPeers })
  const headerRelay = new HeaderRelay(peerManager)
  const txRelay = new TxRelay(peerManager)

  // ── 3. Address watcher — watch our own address ────────────
  const { AddressWatcher } = await import('./lib/address-watcher.js')
  const watcher = new AddressWatcher(txRelay, store)
  watcher.watchPubkey(config.pubkeyHex, 'self')
  console.log(`  Watching own address`)

  // ── 4. Gossip manager — P2P peer discovery ────────────────
  const { GossipManager } = await import('./lib/gossip.js')
  const privKey = PrivateKey.fromWif(config.wif)
  const gossipManager = new GossipManager(peerManager, {
    privKey,
    pubkeyHex: config.pubkeyHex,
    endpoint: config.endpoint,
    meshId: config.meshId
  })

  // Add seed peers to gossip directory
  const seedPeers = config.seedPeers || []
  for (const seed of seedPeers) {
    gossipManager.addSeed(seed)
  }

  // ── 5. Start server ───────────────────────────────────────
  await peerManager.startServer({ port: config.port, host: '0.0.0.0', pubkeyHex: config.pubkeyHex, endpoint: config.endpoint })
  console.log(`Bridge listening on port ${config.port}`)
  console.log(`  Pubkey: ${config.pubkeyHex}`)
  console.log(`  Mesh:   ${config.meshId}`)

  // ── 6. Persistence layer — save headers/txs to LevelDB ───
  headerRelay.on('header:new', async (header) => {
    try { await store.putHeader(header) } catch {}
  })

  headerRelay.on('header:sync', async ({ headers }) => {
    if (headers && headers.length) {
      try { await store.putHeaders(headers) } catch {}
    }
  })

  txRelay.on('tx:new', async ({ txid, rawHex }) => {
    try { await store.putTx(txid, rawHex) } catch {}
  })

  // ── 6b. BSV P2P header sync — connect to BSV nodes ──────
  const { BSVNodeClient } = await import('./lib/bsv-node-client.js')
  const bsvNode = new BSVNodeClient()

  bsvNode.on('headers', async ({ headers, count }) => {
    // Feed into HeaderRelay for peer propagation
    const added = headerRelay.addHeaders(headers)
    if (added > 0) {
      console.log(`BSV P2P: synced ${added} headers (height: ${headerRelay.bestHeight})`)
      // Persist to LevelDB
      try { await store.putHeaders(headers) } catch {}
      // Announce to federation peers
      headerRelay.announceToAll()
    }
  })

  bsvNode.on('connected', ({ host }) => {
    console.log(`BSV P2P: connected to ${host}:8333`)
  })

  bsvNode.on('handshake', ({ userAgent, startHeight }) => {
    console.log(`BSV P2P: handshake complete (${userAgent}, height: ${startHeight})`)
  })

  bsvNode.on('disconnected', () => {
    console.log('BSV P2P: disconnected, will reconnect...')
  })

  bsvNode.on('error', (err) => {
    // Don't crash — just log
    if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT') {
      console.log(`BSV P2P: ${err.message}`)
    }
  })

  // Start the BSV P2P connection
  bsvNode.connect()

  // ── 7. Connect to peers ───────────────────────────────────
  let gossipStarted = false

  // Start gossip after first peer connects
  peerManager.on('peer:connect', ({ pubkeyHex }) => {
    if (!gossipStarted) {
      gossipStarted = true
      gossipManager.start()
      gossipManager.requestPeersFromAll()
      console.log('Gossip started')
    }
  })

  // Auto-connect to newly discovered peers
  gossipManager.on('peer:discovered', ({ pubkeyHex, endpoint }) => {
    if (!peerManager.peers.has(pubkeyHex) && pubkeyHex !== config.pubkeyHex) {
      console.log(`Discovered peer via gossip: ${pubkeyHex.slice(0, 16)}... ${endpoint}`)
      const conn = peerManager.connectToPeer({ pubkeyHex, endpoint })
      if (conn) {
        conn.on('open', () => {
          conn.send({
            type: 'hello',
            pubkey: config.pubkeyHex,
            endpoint: config.endpoint
          })
        })
      }
    }
  })

  if (peerArg) {
    // Manual peer connection
    console.log(`Connecting to peer: ${peerArg}`)
    const conn = peerManager.connectToPeer({
      pubkeyHex: 'manual_peer',
      endpoint: peerArg
    })
    if (conn) {
      conn.on('open', () => {
        conn.send({
          type: 'hello',
          pubkey: config.pubkeyHex,
          endpoint: config.endpoint
        })
      })
    }
  } else if (seedPeers.length > 0) {
    // Connect to seed peers (accept both string URLs and {pubkeyHex, endpoint} objects)
    console.log(`Connecting to ${seedPeers.length} seed peer(s)...`)
    for (let i = 0; i < seedPeers.length; i++) {
      const seed = seedPeers[i]
      const endpoint = typeof seed === 'string' ? seed : seed.endpoint
      const pubkey = typeof seed === 'string' ? `seed_${i}` : seed.pubkeyHex
      const conn = peerManager.connectToPeer({ pubkeyHex: pubkey, endpoint })
      if (conn) {
        conn.on('open', () => {
          conn.send({
            type: 'hello',
            pubkey: config.pubkeyHex,
            endpoint: config.endpoint
          })
        })
        // Re-key when server sends hello response with real pubkey
        conn.on('message', (msg) => {
          if (msg.type === 'hello' && msg.pubkey && msg.pubkey !== pubkey) {
            peerManager.peers.delete(pubkey)
            conn.pubkeyHex = msg.pubkey
            peerManager.peers.set(msg.pubkey, conn)
            console.log(`  Peer identified: ${msg.pubkey.slice(0, 16)}... ${msg.endpoint || endpoint}`)
          }
        })
      }
    }
  } else if (config.apiKey) {
    // Fallback: scan chain for peers (legacy mode)
    console.log('No seed peers configured. Scanning chain for peers...')
    try {
      const { scanRegistry } = await import('../registry/lib/scanner.js')
      const { buildPeerList, excludeSelf } = await import('../registry/lib/discovery.js')
      const { savePeerCache, loadPeerCache } = await import('../registry/lib/peer-cache.js')

      const cachePath = join(dir, 'cache', 'peers.json')
      let peers = await loadPeerCache(cachePath)

      if (!peers) {
        const entries = await scanRegistry({
          spvEndpoint: config.spvEndpoint,
          apiKey: config.apiKey
        })
        peers = buildPeerList(entries)
        peers = excludeSelf(peers, config.pubkeyHex)
        await savePeerCache(peers, cachePath)
      }

      console.log(`Found ${peers.length} peers`)
      for (const peer of peers) {
        const conn = peerManager.connectToPeer(peer)
        if (conn) {
          conn.on('open', () => {
            conn.send({
              type: 'hello',
              pubkey: config.pubkeyHex,
              endpoint: config.endpoint
            })
          })
        }
      }
    } catch (err) {
      console.log(`Peer scan failed: ${err.message}`)
      console.log('Start with manual peer: relay-bridge start ws://peer:port')
    }
  } else {
    console.log('No seed peers, no manual peer, and no API key configured.')
    console.log('Usage: relay-bridge start ws://peer:port')
    console.log('   or: Add seedPeers to config.json')
  }

  // ── 8. Status server ──────────────────────────────────────
  const statusPort = config.statusPort || 9333
  const statusServer = new StatusServer({
    port: statusPort,
    peerManager,
    headerRelay,
    txRelay,
    config
  })
  await statusServer.start()
  console.log(`  Status: http://127.0.0.1:${statusPort}/status`)

  // ── 9. Log events ─────────────────────────────────────────
  peerManager.on('peer:connect', ({ pubkeyHex }) => {
    console.log(`Peer connected: ${pubkeyHex.slice(0, 16)}...`)
  })

  peerManager.on('peer:disconnect', ({ pubkeyHex }) => {
    console.log(`Peer disconnected: ${pubkeyHex.slice(0, 16)}...`)
  })

  headerRelay.on('header:sync', ({ pubkeyHex, added, bestHeight }) => {
    console.log(`Synced ${added} headers from ${pubkeyHex.slice(0, 16)}... (height: ${bestHeight})`)
  })

  txRelay.on('tx:new', ({ txid }) => {
    console.log(`New tx: ${txid.slice(0, 16)}...`)
  })

  watcher.on('utxo:received', ({ txid, vout, satoshis }) => {
    console.log(`UTXO received: ${txid.slice(0, 16)}...:${vout} (${satoshis} sat)`)
  })

  watcher.on('utxo:spent', ({ txid, vout, spentByTxid }) => {
    console.log(`UTXO spent: ${txid.slice(0, 16)}...:${vout} by ${spentByTxid.slice(0, 16)}...`)
  })

  // ── 10. Graceful shutdown ─────────────────────────────────
  const shutdown = async () => {
    console.log('\nShutting down...')
    bsvNode.disconnect()
    gossipManager.stop()
    await statusServer.stop()
    await peerManager.shutdown()
    await store.close()
    console.log('Database closed.')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function cmdStatus () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)
  const statusPort = config.statusPort || 9333

  let status
  try {
    const res = await fetch(`http://127.0.0.1:${statusPort}/status`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    status = await res.json()
  } catch {
    console.log('Bridge is not running.')
    console.log(`  (expected status server on port ${statusPort})`)
    console.log('  Start it with: relay-bridge start')
    process.exit(1)
  }

  console.log('Bridge Status\n')

  // Bridge identity
  console.log('  Bridge')
  console.log(`    Pubkey:   ${status.bridge.pubkeyHex}`)
  console.log(`    Endpoint: ${status.bridge.endpoint}`)
  console.log(`    Mesh:     ${status.bridge.meshId}`)
  console.log(`    Uptime:   ${formatUptime(status.bridge.uptimeSeconds)}`)

  // Peers
  console.log('')
  console.log(`  Peers (${status.peers.connected}/${status.peers.max})`)
  if (status.peers.list.length === 0) {
    console.log('    (no peers)')
  } else {
    for (const peer of status.peers.list) {
      const tag = peer.connected ? 'connected' : 'disconnected'
      console.log(`    ${peer.pubkeyHex.slice(0, 16)}... ${peer.endpoint} (${tag})`)
    }
  }

  // Headers
  console.log('')
  console.log('  Headers')
  console.log(`    Best Height: ${status.headers.bestHeight}`)
  console.log(`    Best Hash:   ${status.headers.bestHash || '(none)'}`)
  console.log(`    Stored:      ${status.headers.count}`)

  // Transactions
  console.log('')
  console.log('  Transactions')
  console.log(`    Mempool: ${status.txs.mempool}`)
  console.log(`    Seen:    ${status.txs.seen}`)
}

async function cmdFund () {
  const rawHex = process.argv[3]
  if (!rawHex) {
    console.log('Usage: relay-bridge fund <rawTxHex>')
    console.log('')
    console.log('  Provide the raw hex of a transaction that pays to this bridge.')
    console.log('  Get the raw hex from your wallet or a block explorer after sending BSV.')
    process.exit(1)
  }

  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)
  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { pubkeyToHash160, checkTxForWatched } = await import('./lib/output-parser.js')

  const store = new PersistentStore(dir)
  await store.open()

  try {
    const hash160 = pubkeyToHash160(config.pubkeyHex)
    const result = checkTxForWatched(rawHex, new Set([hash160]))

    if (result.matches.length === 0) {
      console.log('No outputs found paying to this bridge address.')
      console.log(`  Bridge hash160: ${hash160}`)
      process.exit(1)
    }

    console.log(`Found ${result.matches.length} output(s) for this bridge:\n`)

    for (const match of result.matches) {
      await store.putUtxo({
        txid: result.txid,
        vout: match.vout,
        satoshis: match.satoshis,
        scriptHex: match.scriptHex,
        address: config.pubkeyHex
      })
      console.log(`  UTXO stored: ${result.txid}:${match.vout} (${match.satoshis} sat)`)
    }

    await store.putTx(result.txid, rawHex)
    const balance = await store.getBalance()
    console.log(`\n  Total balance: ${balance} satoshis`)
  } finally {
    await store.close()
  }
}

async function cmdDeregister () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)

  if (!config.apiKey) {
    console.log('Error: API key required for deregistration (broadcasts via SPV bridge).')
    console.log('Set "apiKey" in config.json.')
    process.exit(1)
  }

  const reason = process.argv[3] || 'shutdown'

  console.log('Deregistration details:\n')
  console.log(`  Pubkey: ${config.pubkeyHex}`)
  console.log(`  Reason: ${reason}`)
  console.log(`  SPV:    ${config.spvEndpoint}`)
  console.log('')

  try {
    const { buildDeregistrationTx } = await import('../registry/lib/registration.js')

    // Fetch UTXOs from SPV bridge
    const utxos = await fetchUtxos(config.spvEndpoint, config.apiKey, config.pubkeyHex)

    if (!utxos.length) {
      console.log('Error: No UTXOs found. Wallet needs funding for tx fees.')
      process.exit(1)
    }

    // Build deregistration tx
    const { txHex, txid } = await buildDeregistrationTx({
      wif: config.wif,
      utxos,
      reason
    })

    // Broadcast via SPV bridge
    await broadcastTx(config.spvEndpoint, config.apiKey, txHex)

    console.log('Deregistration broadcast successful!')
    console.log(`  txid: ${txid}`)
    console.log('')
    console.log('Your bridge will be removed from peer lists on next scan cycle.')
  } catch (err) {
    console.log(`Deregistration failed: ${err.message}`)
    process.exit(1)
  }
}

function formatUptime (seconds) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}
