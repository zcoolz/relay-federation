import { uint8ToHex } from '@relay-federation/common/crypto'

/**
 * Peer discovery — resolve scanner output into a list of active bridges.
 *
 * Walks entries oldest→newest. For each pubkey:
 *   register   → add or update the peer
 *   deregister → remove the peer
 *
 * Returns only currently active bridges.
 */

/**
 * Build a list of active peers from scanner entries.
 *
 * @param {Array<{txid: string, height: number, entry: object}>} entries
 *   Output from scanRegistry(), sorted by height ascending.
 * @returns {Array<{pubkeyHex: string, endpoint: string, capabilities: string[],
 *   versions: string[], networkVersion: string, meshId: string,
 *   stakeTxid: string, txid: string, height: number, timestamp: number}>}
 */
export function buildPeerList (entries) {
  // Map of pubkeyHex → peer info. Walking oldest→newest means
  // later entries overwrite earlier ones for the same pubkey.
  const activePeers = new Map()

  for (const { txid, height, entry } of entries) {
    const pubkeyHex = uint8ToHex(entry.pubkey)

    if (entry.action === 'register') {
      activePeers.set(pubkeyHex, {
        pubkeyHex,
        endpoint: entry.endpoint,
        capabilities: entry.capabilities,
        versions: entry.versions,
        networkVersion: entry.network_version,
        meshId: entry.mesh_id,
        stakeTxid: uint8ToHex(entry.stake_txid),
        txid,
        height,
        timestamp: entry.timestamp
      })
    } else if (entry.action === 'deregister') {
      activePeers.delete(pubkeyHex)
    }
  }

  return Array.from(activePeers.values())
}

/**
 * Filter a peer list to exclude our own pubkey.
 *
 * @param {Array} peers - Output from buildPeerList()
 * @param {string} ownPubkeyHex - Our bridge's compressed pubkey as hex
 * @returns {Array} Peers excluding ourselves
 */
export function excludeSelf (peers, ownPubkeyHex) {
  return peers.filter(p => p.pubkeyHex !== ownPubkeyHex)
}

/**
 * Filter peers by capability.
 *
 * @param {Array} peers
 * @param {string} capability - e.g. 'tx_relay', 'header_sync'
 * @returns {Array} Peers that advertise the given capability
 */
export function filterByCapability (peers, capability) {
  return peers.filter(p => p.capabilities.includes(capability))
}

/**
 * Filter peers by mesh ID.
 *
 * @param {Array} peers
 * @param {string} meshId - e.g. 'indelible'
 * @returns {Array} Peers in the given mesh
 */
export function filterByMesh (peers, meshId) {
  return peers.filter(p => p.meshId === meshId)
}

