#!/usr/bin/env node

import { join } from 'node:path'
import { initConfig, loadConfig, configExists, defaultConfigDir } from './lib/config.js'
import { PeerManager } from './lib/peer-manager.js'
import { HeaderRelay } from './lib/header-relay.js'
import { TxRelay } from './lib/tx-relay.js'

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
  default:
    console.log('relay-bridge — Federated SPV relay mesh bridge\n')
    console.log('Commands:')
    console.log('  init      Generate bridge identity and config')
    console.log('  register  Register this bridge on-chain')
    console.log('  start     Start the bridge server')
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

  const peerManager = new PeerManager({ maxPeers: config.maxPeers })
  const headerRelay = new HeaderRelay(peerManager)
  const txRelay = new TxRelay(peerManager)

  // Start server
  await peerManager.startServer({ port: config.port, host: '0.0.0.0' })
  console.log(`Bridge listening on port ${config.port}`)
  console.log(`  Pubkey: ${config.pubkeyHex}`)
  console.log(`  Mesh:   ${config.meshId}`)

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
  } else if (config.apiKey) {
    // Scan chain for peers
    console.log('Scanning chain for peers...')
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
    console.log('No peer specified and no API key configured.')
    console.log('Usage: relay-bridge start ws://peer:port')
  }

  // Log events
  peerManager.on('peer:connect', ({ pubkeyHex }) => {
    console.log(`Peer connected: ${pubkeyHex}`)
  })

  peerManager.on('peer:disconnect', ({ pubkeyHex }) => {
    console.log(`Peer disconnected: ${pubkeyHex}`)
  })

  headerRelay.on('header:sync', ({ pubkeyHex, added, bestHeight }) => {
    console.log(`Synced ${added} headers from ${pubkeyHex} (height: ${bestHeight})`)
  })

  txRelay.on('tx:new', ({ txid }) => {
    console.log(`New tx: ${txid}`)
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...')
    await peerManager.shutdown()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
