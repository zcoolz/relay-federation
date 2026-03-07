import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { initConfig, loadConfig, configExists } from '../lib/config.js'

const testDir = join(tmpdir(), `relay-bridge-test-${randomBytes(4).toString('hex')}`)

describe('Bridge config', () => {
  afterEach(async () => {
    try { await rm(testDir, { recursive: true }) } catch {}
  })

  it('initConfig creates config with valid WIF and pubkey', async () => {
    const config = await initConfig(testDir)

    assert.ok(config.wif, 'should have WIF')
    assert.ok(
      config.wif.startsWith('L') || config.wif.startsWith('K'),
      'WIF should start with L or K (mainnet compressed)'
    )
    assert.ok(config.pubkeyHex, 'should have pubkeyHex')
    assert.equal(config.pubkeyHex.length, 66, 'compressed pubkey = 33 bytes = 66 hex chars')
    assert.ok(
      config.pubkeyHex.startsWith('02') || config.pubkeyHex.startsWith('03'),
      'compressed pubkey starts with 02 or 03'
    )
    assert.equal(config.meshId, '70016')
    assert.equal(typeof config.statusSecret, 'string')
    assert.equal(config.statusSecret.length, 64, 'statusSecret is 32 bytes hex')
    assert.ok(Array.isArray(config.capabilities))
    assert.equal(config.port, 8333)
  })

  it('loadConfig reads config back correctly', async () => {
    const original = await initConfig(testDir)
    const loaded = await loadConfig(testDir)

    assert.equal(loaded.wif, original.wif)
    assert.equal(loaded.pubkeyHex, original.pubkeyHex)
    assert.equal(loaded.endpoint, original.endpoint)
    assert.equal(loaded.meshId, original.meshId)
    assert.deepEqual(loaded.capabilities, original.capabilities)
  })

  it('configExists returns true when config exists', async () => {
    await initConfig(testDir)
    assert.equal(await configExists(testDir), true)
  })

  it('configExists returns false when config missing', async () => {
    assert.equal(await configExists(join(testDir, 'nonexistent')), false)
  })

  it('generates unique keys each time', async () => {
    const dir1 = join(testDir, 'a')
    const dir2 = join(testDir, 'b')

    const config1 = await initConfig(dir1)
    const config2 = await initConfig(dir2)

    assert.notEqual(config1.wif, config2.wif)
    assert.notEqual(config1.pubkeyHex, config2.pubkeyHex)
  })
})
