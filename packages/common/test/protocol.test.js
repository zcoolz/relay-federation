import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTOCOL_PREFIX,
  BEACON_ADDRESS,
  BEACON_SATOSHIS,
  VALID_CAPABILITIES,
  SUPPORTED_VERSIONS,
  HANDSHAKE_TIMEOUT_MS
} from '../lib/protocol.js'

describe('protocol constants', () => {
  it('PROTOCOL_PREFIX is the registry protocol string', () => {
    assert.equal(PROTOCOL_PREFIX, 'indelible.bridge-registry')
  })

  it('BEACON_ADDRESS is a valid BSV address', () => {
    assert.ok(BEACON_ADDRESS.startsWith('1'))
    assert.ok(BEACON_ADDRESS.length >= 25 && BEACON_ADDRESS.length <= 34)
  })

  it('BEACON_SATOSHIS is 100', () => {
    assert.equal(BEACON_SATOSHIS, 100)
  })

  it('VALID_CAPABILITIES includes core capabilities', () => {
    assert.ok(VALID_CAPABILITIES.includes('tx_relay'))
    assert.ok(VALID_CAPABILITIES.includes('header_sync'))
    assert.ok(VALID_CAPABILITIES.includes('broadcast'))
    assert.ok(VALID_CAPABILITIES.includes('address_history'))
    assert.equal(VALID_CAPABILITIES.length, 4)
  })

  it('SUPPORTED_VERSIONS includes 1.0', () => {
    assert.ok(SUPPORTED_VERSIONS.includes('1.0'))
    assert.ok(SUPPORTED_VERSIONS.length >= 1)
  })

  it('HANDSHAKE_TIMEOUT_MS is 10 seconds', () => {
    assert.equal(HANDSHAKE_TIMEOUT_MS, 10000)
  })
})
