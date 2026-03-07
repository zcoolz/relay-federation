#!/usr/bin/env node

import { join } from 'node:path'
import { initConfig, loadConfig, configExists, defaultConfigDir } from './lib/config.js'
import { PeerManager } from './lib/peer-manager.js'
import { HeaderRelay } from './lib/header-relay.js'
import { TxRelay } from './lib/tx-relay.js'
import { StatusServer } from './lib/status-server.js'
// network.js import removed — register/deregister now use local UTXOs + P2P broadcast

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
  console.log(`  Config:  ${dir}/config.json`)
  console.log(`  Pubkey:  ${config.pubkeyHex}`)
  console.log(`  Address: ${config.address}`)
  console.log('')
  console.log('Next steps:')
  console.log(`  1. Edit config.json — set your WSS endpoint`)
  console.log(`  2. Fund your bridge: send BSV to ${config.address}`)
  console.log('  3. Import the funding tx: relay-bridge fund <rawTxHex>')
  console.log('  4. Run: relay-bridge register')
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

  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { runRegister } = await import('./lib/actions.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  console.log('Registration details:\n')

  try {
    const result = await runRegister({
      config,
      store,
      log: (type, msg) => console.log(type === 'done' ? msg : `  ${msg}`)
    })
    console.log('')
    console.log('Your bridge will appear in peer lists on next scan cycle.')
  } catch (err) {
    console.log(`Registration failed: ${err.message}`)
    await store.close()
    process.exit(1)
  }

  await store.close()
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

  // ── 2b. Phase 2: Security layer ────────────────────────────
  const { PeerScorer } = await import('./lib/peer-scorer.js')
  const { ScoreActions } = await import('./lib/score-actions.js')
  const { DataValidator } = await import('./lib/data-validator.js')
  const { PeerHealth } = await import('./lib/peer-health.js')
  const { AnchorManager } = await import('./lib/anchor-manager.js')
  const { createHandshake } = await import('./lib/handshake.js')

  const scorer = new PeerScorer()
  const scoreActions = new ScoreActions(scorer, peerManager)
  const dataValidator = new DataValidator(peerManager, scorer)
  const peerHealth = new PeerHealth()
  const anchorManager = new AnchorManager(peerManager, {
    anchors: config.anchorBridges || []
  })

  const handshake = createHandshake({
    wif: config.wif,
    pubkeyHex: config.pubkeyHex,
    endpoint: config.endpoint
  })

  // Wire peer health tracking
  peerManager.on('peer:connect', ({ pubkeyHex }) => {
    peerHealth.recordSeen(pubkeyHex)
  })

  peerManager.on('peer:disconnect', ({ pubkeyHex }) => {
    peerHealth.recordOffline(pubkeyHex)
  })

  // Wire peer:message → health.recordSeen (any message = peer is alive)
  peerManager.on('peer:message', ({ pubkeyHex }) => {
    peerHealth.recordSeen(pubkeyHex)
  })

  // Ping infrastructure — 60s interval, measures latency for scoring
  const PING_INTERVAL_MS = 60000
  const pendingPings = new Map() // pubkeyHex → timestamp

  peerManager.on('peer:message', ({ pubkeyHex, message }) => {
    if (message.type === 'ping') {
      // Respond with pong
      const conn = peerManager.peers.get(pubkeyHex)
      if (conn) conn.send({ type: 'pong', nonce: message.nonce })
    } else if (message.type === 'pong') {
      // Record latency
      const sentAt = pendingPings.get(pubkeyHex)
      if (sentAt) {
        const latency = Date.now() - sentAt
        pendingPings.delete(pubkeyHex)
        if (!peerHealth.isInGracePeriod(pubkeyHex)) {
          scorer.recordPing(pubkeyHex, latency)
        }
      }
    }
  })

  const pingTimer = setInterval(() => {
    const nonce = Date.now().toString(36)
    for (const [pubkeyHex, conn] of peerManager.peers) {
      if (conn.connected) {
        // Check for timed-out previous pings
        if (pendingPings.has(pubkeyHex)) {
          if (!peerHealth.isInGracePeriod(pubkeyHex)) {
            scorer.recordPingTimeout(pubkeyHex)
          }
          pendingPings.delete(pubkeyHex)
        }
        pendingPings.set(pubkeyHex, Date.now())
        conn.send({ type: 'ping', nonce })
      }
    }
  }, PING_INTERVAL_MS)
  if (pingTimer.unref) pingTimer.unref()

  // Health check — every 10 minutes, detect inactive peers
  const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000
  const healthTimer = setInterval(() => {
    const { grace, inactive } = peerHealth.checkAll()
    for (const pk of inactive) {
      console.log(`Peer inactive (7d+): ${pk.slice(0, 16)}...`)
    }
  }, HEALTH_CHECK_INTERVAL_MS)
  if (healthTimer.unref) healthTimer.unref()

  // Start anchor monitoring
  anchorManager.startMonitoring()

  console.log(`  Security: scoring, validation, health, anchors active`)

  // ── 3. Address watcher — watch our own address + beacon ──
  const { AddressWatcher } = await import('./lib/address-watcher.js')
  const { addressToHash160 } = await import('./lib/output-parser.js')
  const { BEACON_ADDRESS } = await import('@relay-federation/common/protocol')
  const watcher = new AddressWatcher(txRelay, store)
  watcher.watchPubkey(config.pubkeyHex, 'self')
  const beaconHash160 = addressToHash160(BEACON_ADDRESS)
  watcher.watchHash160(beaconHash160, 'beacon')
  console.log(`  Watching own address + beacon (${BEACON_ADDRESS})`)

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

  // ── 4a. Registry — track registered pubkeys for handshake gating ──
  const registeredPubkeys = new Set()
  registeredPubkeys.add(config.pubkeyHex) // always trust self
  const seedEndpoints = new Set()
  for (const seed of seedPeers) {
    if (seed.pubkeyHex) registeredPubkeys.add(seed.pubkeyHex)
    const ep = typeof seed === 'string' ? seed : seed.endpoint
    if (ep) seedEndpoints.add(ep)
  }
  console.log(`  Registry: ${registeredPubkeys.size} trusted pubkeys (self + seeds)`)

  // ── 4b. Beacon address watcher — detect on-chain registrations ──
  const { extractOpReturnData, decodePayload, PROTOCOL_PREFIX } = await import('../registry/lib/cbor.js')
  const { Transaction: BsvTx } = await import('@bsv/sdk')

  watcher.on('utxo:received', async ({ txid, hash160 }) => {
    if (hash160 !== beaconHash160) return

    try {
      const rawHex = await store.getTx(txid)
      if (!rawHex) return

      const tx = BsvTx.fromHex(rawHex)
      const opReturnOutput = tx.outputs.find(out =>
        out.satoshis === 0 && out.lockingScript.toHex().startsWith('006a')
      )
      if (!opReturnOutput) return

      const { prefix, cborBytes } = extractOpReturnData(opReturnOutput.lockingScript)
      if (prefix !== PROTOCOL_PREFIX) return

      const entry = decodePayload(cborBytes)

      if (entry.action === 'register') {
        const pubHex = Buffer.from(entry.pubkey).toString('hex')
        if (pubHex === config.pubkeyHex) return // skip self

        registeredPubkeys.add(pubHex)
        gossipManager.addSeed({
          pubkeyHex: pubHex,
          endpoint: entry.endpoint,
          meshId: entry.mesh_id
        })
        console.log(`Beacon: new registration detected — ${pubHex.slice(0, 16)}... @ ${entry.endpoint}`)
      } else if (entry.action === 'deregister') {
        const pubHex = Buffer.from(entry.pubkey).toString('hex')
        registeredPubkeys.delete(pubHex)
        console.log(`Beacon: deregistration detected — ${pubHex.slice(0, 16)}...`)
      }
    } catch {
      // Skip unparseable beacon txs
    }
  })

  // ── Outbound handshake helper ──────────────────────────────
  function performOutboundHandshake (conn) {
    const { message: helloMsg, nonce } = handshake.createHello()
    conn.send(helloMsg)

    const onMessage = (msg) => {
      if (msg.type === 'challenge_response') {
        conn.removeListener('message', onMessage)
        clearTimeout(timeout)
        const result = handshake.handleChallengeResponse(msg, nonce, conn.isSeed ? null : registeredPubkeys)
        if (result.error) {
          console.log(`Handshake failed with ${conn.pubkeyHex.slice(0, 16)}...: ${result.error}`)
          conn.destroy()
          return
        }
        // Re-key if we didn't know their real pubkey
        if (result.peerPubkey !== conn.pubkeyHex) {
          peerManager.peers.delete(conn.pubkeyHex)
          conn.pubkeyHex = result.peerPubkey
        }

        // Tie-break duplicate connections (inbound may have been accepted during handshake)
        const existing = peerManager.peers.get(result.peerPubkey)
        if (existing && existing !== conn) {
          if (config.pubkeyHex > result.peerPubkey) {
            // Higher pubkey drops outbound — keep existing inbound
            console.log(`  Duplicate: keeping inbound from ${result.peerPubkey.slice(0, 16)}...`)
            conn._shouldReconnect = false
            conn.destroy()
            return
          }
          // Lower pubkey keeps outbound — drop existing inbound
          console.log(`  Duplicate: keeping outbound to ${result.peerPubkey.slice(0, 16)}...`)
          existing._shouldReconnect = false
          existing.destroy()
        }

        peerManager.peers.set(result.peerPubkey, conn)
        // Learn seed pubkeys so future inbound connections from them pass registry check
        if (conn.isSeed && !registeredPubkeys.has(result.peerPubkey)) {
          registeredPubkeys.add(result.peerPubkey)
          console.log(`  Seed pubkey learned: ${result.peerPubkey.slice(0, 16)}...`)
        }
        console.log(`  Peer identified: ${result.peerPubkey.slice(0, 16)}... (v${result.selectedVersion})`)

        // Send verify to complete handshake
        conn.send(result.message)
        // Handshake complete — now safe to announce peer:connect
        peerManager.emit('peer:connect', { pubkeyHex: conn.pubkeyHex, endpoint: conn.endpoint })
      }
    }
    conn.on('message', onMessage)

    // Timeout: if no challenge_response within 10s, drop
    const timeout = setTimeout(() => {
      conn.removeListener('message', onMessage)
      if (!conn.connected) return
      console.log(`Handshake timeout: ${conn.pubkeyHex.slice(0, 16)}...`)
      conn.destroy()
    }, 10000)
    if (timeout.unref) timeout.unref()

    // Clean up on close — prevent stale handler on reconnect
    conn.once('close', () => {
      clearTimeout(timeout)
      conn.removeListener('message', onMessage)
    })
  }

  // ── 5. Start server ───────────────────────────────────────
  await peerManager.startServer({ port: config.port, host: '0.0.0.0', pubkeyHex: config.pubkeyHex, endpoint: config.endpoint, handshake, registeredPubkeys, seedEndpoints })
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

  // Start gossip after first peer connection completes.
  // With crypto handshake, peer:connect fires AFTER handshake verification,
  // so gossip won't race the handshake anymore.
  peerManager.on('peer:connect', () => {
    if (!gossipStarted) {
      gossipStarted = true
      gossipManager.start()
      gossipManager.requestPeersFromAll()
      console.log('Gossip started')

      // Periodic peer refresh — re-request peer lists every 10 minutes
      // Catches registrations missed during downtime or initial gossip
      const PEER_REFRESH_MS = 10 * 60 * 1000
      const refreshTimer = setInterval(() => {
        gossipManager.requestPeersFromAll()
      }, PEER_REFRESH_MS)
      if (refreshTimer.unref) refreshTimer.unref()
    }
  })

  // Auto-connect to newly discovered peers (with reachability probe + IP diversity)
  const { probeEndpoint } = await import('./lib/endpoint-probe.js')
  const { checkIpDiversity } = await import('./lib/ip-diversity.js')

  gossipManager.on('peer:discovered', async ({ pubkeyHex, endpoint }) => {
    if (peerManager.peers.has(pubkeyHex) || pubkeyHex === config.pubkeyHex) return

    // IP diversity check — prevent all peers clustering in one datacenter
    const connectedEndpoints = [...peerManager.peers.values()]
      .filter(c => c.endpoint).map(c => c.endpoint)
    const diversity = checkIpDiversity(connectedEndpoints, endpoint)
    if (!diversity.allowed) {
      console.log(`IP diversity blocked: ${pubkeyHex.slice(0, 16)}... — ${diversity.reason}`)
      return
    }

    const reachable = await probeEndpoint(endpoint)
    if (!reachable) {
      console.log(`Probe failed: ${pubkeyHex.slice(0, 16)}... ${endpoint} — skipping`)
      return
    }

    console.log(`Discovered peer via gossip: ${pubkeyHex.slice(0, 16)}... ${endpoint}`)
    const conn = peerManager.connectToPeer({ pubkeyHex, endpoint })
    if (conn) {
      conn.on('open', () => performOutboundHandshake(conn))
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
      conn.on('open', () => performOutboundHandshake(conn))
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
        conn.isSeed = true
        conn.on('open', () => performOutboundHandshake(conn))
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
          conn.on('open', () => performOutboundHandshake(conn))
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
    config,
    scorer,
    peerHealth,
    bsvNodeClient: bsvNode,
    store,
    performOutboundHandshake,
    registeredPubkeys
  })
  await statusServer.start()
  console.log(`  Status: http://127.0.0.1:${statusPort}/status`)

  // ── 9. Log events (dual: console + status server ring buffer) ──
  peerManager.on('peer:connect', ({ pubkeyHex }) => {
    const msg = `Peer connected: ${pubkeyHex.slice(0, 16)}...`
    console.log(msg)
    statusServer.addLog(msg)
  })

  peerManager.on('peer:disconnect', ({ pubkeyHex }) => {
    const msg = `Peer disconnected: ${pubkeyHex.slice(0, 16)}...`
    console.log(msg)
    statusServer.addLog(msg)
  })

  headerRelay.on('header:sync', ({ pubkeyHex, added, bestHeight }) => {
    const msg = `Synced ${added} headers from ${pubkeyHex.slice(0, 16)}... (height: ${bestHeight})`
    console.log(msg)
    statusServer.addLog(msg)
  })

  txRelay.on('tx:new', ({ txid }) => {
    const msg = `New tx: ${txid.slice(0, 16)}...`
    console.log(msg)
    statusServer.addLog(msg)
  })

  watcher.on('utxo:received', ({ txid, vout, satoshis }) => {
    const msg = `UTXO received: ${txid.slice(0, 16)}...:${vout} (${satoshis} sat)`
    console.log(msg)
    statusServer.addLog(msg)
  })

  watcher.on('utxo:spent', ({ txid, vout, spentByTxid }) => {
    const msg = `UTXO spent: ${txid.slice(0, 16)}...:${vout} by ${spentByTxid.slice(0, 16)}...`
    console.log(msg)
    statusServer.addLog(msg)
  })

  // Phase 2 events
  scoreActions.on('peer:disconnected', ({ pubkeyHex, score }) => {
    console.log(`Score disconnect: ${pubkeyHex.slice(0, 16)}... (score: ${score.toFixed(2)})`)
  })

  scoreActions.on('peer:blacklisted', ({ pubkeyHex, score }) => {
    console.log(`Blacklisted: ${pubkeyHex.slice(0, 16)}... (score: ${score.toFixed(2)}, 24h)`)
  })

  dataValidator.on('validation:fail', ({ pubkeyHex, type, reason }) => {
    console.log(`Bad data from ${pubkeyHex.slice(0, 16)}...: ${type} — ${reason}`)
  })

  anchorManager.on('anchor:disconnect', ({ pubkeyHex }) => {
    console.log(`Anchor disconnected: ${pubkeyHex.slice(0, 16)}...`)
  })

  anchorManager.on('anchor:low_score', ({ pubkeyHex, score }) => {
    console.log(`Anchor low score: ${pubkeyHex.slice(0, 16)}... (${score.toFixed(2)})`)
  })

  peerHealth.on('peer:recovered', ({ pubkeyHex }) => {
    console.log(`Peer recovered: ${pubkeyHex.slice(0, 16)}...`)
  })

  // ── 10. Graceful shutdown ─────────────────────────────────
  const shutdown = async () => {
    console.log('\nShutting down...')
    clearInterval(pingTimer)
    clearInterval(healthTimer)
    anchorManager.stopMonitoring()
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

  // BSV Node
  if (status.bsvNode) {
    console.log('')
    console.log('  BSV Node')
    console.log(`    Status: ${status.bsvNode.connected ? 'Connected' : 'Disconnected'}`)
    console.log(`    Host:   ${status.bsvNode.host || '-'}`)
    console.log(`    Height: ${status.bsvNode.height || '-'}`)
  }

  // Wallet
  if (status.wallet) {
    console.log('')
    console.log('  Wallet')
    console.log(`    Balance: ${status.wallet.balanceSats !== null ? status.wallet.balanceSats + ' sats' : '-'}`)
  }
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
  const { runFund } = await import('./lib/actions.js')

  const store = new PersistentStore(dir)
  await store.open()

  try {
    await runFund({
      config,
      store,
      rawHex,
      log: (type, msg) => console.log(`  ${msg}`)
    })
  } catch (err) {
    console.log(`Fund failed: ${err.message}`)
    process.exit(1)
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
  const reason = process.argv[3] || 'shutdown'

  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { runDeregister } = await import('./lib/actions.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  console.log('Deregistration details:\n')

  try {
    await runDeregister({
      config,
      store,
      reason,
      log: (type, msg) => console.log(type === 'done' ? msg : `  ${msg}`)
    })
    console.log('')
    console.log('Your bridge will be removed from peer lists on next scan cycle.')
  } catch (err) {
    console.log(`Deregistration failed: ${err.message}`)
    await store.close()
    process.exit(1)
  }

  await store.close()
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
