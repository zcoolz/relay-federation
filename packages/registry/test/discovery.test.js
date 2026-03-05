import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPeerList, excludeSelf, filterByCapability, filterByMesh } from '../lib/discovery.js'

// Test fixtures — simulated scanner output
const pubkeyA = new Uint8Array(33).fill(0x02)
const pubkeyB = new Uint8Array(33).fill(0x03)
const pubkeyC = new Uint8Array(33)
pubkeyC[0] = 0x02
pubkeyC.fill(0xaa, 1)

const stakeA = new Uint8Array(32).fill(0xde)
const stakeB = new Uint8Array(32).fill(0xef)
const stakeC = new Uint8Array(32).fill(0xab)

function hexOf (arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

function makeRegEntry (pubkey, endpoint, opts = {}) {
  return {
    action: 'register',
    endpoint,
    pubkey,
    capabilities: opts.capabilities || ['tx_relay', 'header_sync', 'broadcast', 'address_history'],
    versions: ['1.0'],
    network_version: '1.0',
    stake_txid: opts.stakeTxid || stakeA,
    mesh_id: opts.meshId || 'indelible',
    timestamp: opts.timestamp || 1741190400
  }
}

function makeDeregEntry (pubkey, reason = 'shutdown') {
  return {
    action: 'deregister',
    pubkey,
    reason,
    timestamp: 1741190400
  }
}

describe('Peer discovery', () => {
  describe('buildPeerList', () => {
    it('single registration creates one peer', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://bridge-a.com:8333') }
      ]

      const peers = buildPeerList(entries)
      assert.equal(peers.length, 1)
      assert.equal(peers[0].pubkeyHex, hexOf(pubkeyA))
      assert.equal(peers[0].endpoint, 'wss://bridge-a.com:8333')
      assert.equal(peers[0].meshId, 'indelible')
      assert.equal(peers[0].txid, 'aaa')
      assert.equal(peers[0].height, 842100)
    })

    it('multiple registrations create multiple peers', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://bridge-a.com:8333') },
        { txid: 'bbb', height: 842200, entry: makeRegEntry(pubkeyB, 'wss://bridge-b.com:8333', { stakeTxid: stakeB }) }
      ]

      const peers = buildPeerList(entries)
      assert.equal(peers.length, 2)
    })

    it('deregistration removes a peer', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://bridge-a.com:8333') },
        { txid: 'bbb', height: 842200, entry: makeRegEntry(pubkeyB, 'wss://bridge-b.com:8333', { stakeTxid: stakeB }) },
        { txid: 'ccc', height: 842300, entry: makeDeregEntry(pubkeyA) }
      ]

      const peers = buildPeerList(entries)
      assert.equal(peers.length, 1)
      assert.equal(peers[0].pubkeyHex, hexOf(pubkeyB))
    })

    it('re-registration after deregistration brings peer back', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://bridge-a.com:8333') },
        { txid: 'bbb', height: 842200, entry: makeDeregEntry(pubkeyA) },
        { txid: 'ccc', height: 842300, entry: makeRegEntry(pubkeyA, 'wss://bridge-a-v2.com:8333') }
      ]

      const peers = buildPeerList(entries)
      assert.equal(peers.length, 1)
      assert.equal(peers[0].endpoint, 'wss://bridge-a-v2.com:8333', 'should use latest endpoint')
      assert.equal(peers[0].txid, 'ccc')
    })

    it('later registration updates endpoint for same pubkey', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://old.com:8333') },
        { txid: 'bbb', height: 842200, entry: makeRegEntry(pubkeyA, 'wss://new.com:8333') }
      ]

      const peers = buildPeerList(entries)
      assert.equal(peers.length, 1)
      assert.equal(peers[0].endpoint, 'wss://new.com:8333')
      assert.equal(peers[0].txid, 'bbb')
    })

    it('returns empty when all bridges deregistered', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://a.com:8333') },
        { txid: 'bbb', height: 842200, entry: makeDeregEntry(pubkeyA) }
      ]

      const peers = buildPeerList(entries)
      assert.equal(peers.length, 0)
    })

    it('returns empty for no entries', () => {
      assert.equal(buildPeerList([]).length, 0)
    })

    it('converts pubkey and stake_txid to hex strings', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://a.com:8333') }
      ]

      const peers = buildPeerList(entries)
      assert.equal(typeof peers[0].pubkeyHex, 'string')
      assert.equal(peers[0].pubkeyHex.length, 66, '33 bytes = 66 hex chars')
      assert.equal(typeof peers[0].stakeTxid, 'string')
      assert.equal(peers[0].stakeTxid.length, 64, '32 bytes = 64 hex chars')
    })
  })

  describe('excludeSelf', () => {
    it('filters out our own pubkey', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://a.com:8333') },
        { txid: 'bbb', height: 842200, entry: makeRegEntry(pubkeyB, 'wss://b.com:8333', { stakeTxid: stakeB }) }
      ]

      const peers = buildPeerList(entries)
      const filtered = excludeSelf(peers, hexOf(pubkeyA))
      assert.equal(filtered.length, 1)
      assert.equal(filtered[0].pubkeyHex, hexOf(pubkeyB))
    })
  })

  describe('filterByCapability', () => {
    it('filters peers by capability', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://a.com:8333', { capabilities: ['tx_relay', 'header_sync'] }) },
        { txid: 'bbb', height: 842200, entry: makeRegEntry(pubkeyB, 'wss://b.com:8333', { capabilities: ['tx_relay'], stakeTxid: stakeB }) }
      ]

      const peers = buildPeerList(entries)
      const headerPeers = filterByCapability(peers, 'header_sync')
      assert.equal(headerPeers.length, 1)
      assert.equal(headerPeers[0].pubkeyHex, hexOf(pubkeyA))

      const txPeers = filterByCapability(peers, 'tx_relay')
      assert.equal(txPeers.length, 2)
    })
  })

  describe('filterByMesh', () => {
    it('filters peers by mesh ID', () => {
      const entries = [
        { txid: 'aaa', height: 842100, entry: makeRegEntry(pubkeyA, 'wss://a.com:8333', { meshId: 'indelible' }) },
        { txid: 'bbb', height: 842200, entry: makeRegEntry(pubkeyB, 'wss://b.com:8333', { meshId: 'other-mesh', stakeTxid: stakeB }) },
        { txid: 'ccc', height: 842300, entry: makeRegEntry(pubkeyC, 'wss://c.com:8333', { meshId: 'indelible', stakeTxid: stakeC }) }
      ]

      const peers = buildPeerList(entries)
      const indeliblePeers = filterByMesh(peers, 'indelible')
      assert.equal(indeliblePeers.length, 2)

      const otherPeers = filterByMesh(peers, 'other-mesh')
      assert.equal(otherPeers.length, 1)
      assert.equal(otherPeers[0].pubkeyHex, hexOf(pubkeyB))
    })
  })
})
