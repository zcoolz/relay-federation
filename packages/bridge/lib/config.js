import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PrivateKey } from '@bsv/sdk'

const DEFAULT_DIR = join(homedir(), '.relay-bridge')
const CONFIG_FILE = 'config.json'

/**
 * Get the default config directory path.
 * @returns {string}
 */
export function defaultConfigDir () {
  return DEFAULT_DIR
}

/**
 * Initialize a new bridge config with a fresh key pair.
 *
 * @param {string} [dir] — Config directory (default: ~/.relay-bridge)
 * @returns {Promise<object>} The generated config
 */
export async function initConfig (dir = DEFAULT_DIR) {
  const privKey = PrivateKey.fromRandom()

  const config = {
    wif: privKey.toWif(),
    pubkeyHex: privKey.toPublicKey().toString(),
    endpoint: 'wss://your-bridge.example.com:8333',
    meshId: 'indelible',
    capabilities: ['tx_relay', 'header_sync', 'broadcast', 'address_history'],
    spvEndpoint: 'https://relay.indelible.one',
    apiKey: '',
    port: 8333,
    maxPeers: 20
  }

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2))

  return config
}

/**
 * Load an existing bridge config.
 *
 * @param {string} [dir] — Config directory (default: ~/.relay-bridge)
 * @returns {Promise<object>}
 */
export async function loadConfig (dir = DEFAULT_DIR) {
  const raw = await readFile(join(dir, CONFIG_FILE), 'utf8')
  return JSON.parse(raw)
}

/**
 * Check if a config file exists.
 *
 * @param {string} [dir] — Config directory (default: ~/.relay-bridge)
 * @returns {Promise<boolean>}
 */
export async function configExists (dir = DEFAULT_DIR) {
  try {
    await access(join(dir, CONFIG_FILE))
    return true
  } catch {
    return false
  }
}
