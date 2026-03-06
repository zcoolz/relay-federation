# Relay Federation

A federated mesh network for relaying Bitcoin SV transactions and block headers. Bridges peer with each other over WebSocket, sync headers, and propagate transactions across the network. Bridge identity and discovery are anchored on-chain via a CBOR-encoded registry protocol.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@relay-federation/bridge`](packages/bridge) | [![npm](https://img.shields.io/npm/v/@relay-federation/bridge)](https://www.npmjs.com/package/@relay-federation/bridge) | Bridge server — WebSocket peering, header sync, tx relay, CLI |
| [`@relay-federation/common`](packages/common) | [![npm](https://img.shields.io/npm/v/@relay-federation/common)](https://www.npmjs.com/package/@relay-federation/common) | Shared modules — crypto, network, protocol constants |
| [`@relay-federation/registry`](packages/registry) | — | On-chain bridge registry — CBOR encoding, registration/deregistration tx builders |

## Quick Start

```bash
# Install
npm install -g @relay-federation/bridge

# Generate identity and config
relay-bridge init

# Edit config — set your endpoint and API key
# ~/.relay-bridge/config.json

# Start the bridge
relay-bridge start
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `relay-bridge init` | Generate a fresh keypair and config file at `~/.relay-bridge/config.json` |
| `relay-bridge start` | Start the bridge server — listens for peers, syncs headers, relays transactions |
| `relay-bridge start ws://host:port` | Start and connect to a specific peer |
| `relay-bridge status` | Show running bridge status — peers, headers, mempool |
| `relay-bridge register` | Register this bridge on-chain (broadcast support coming in Phase 2) |
| `relay-bridge deregister [reason]` | Deregister this bridge from the mesh |

## Configuration

`relay-bridge init` creates `~/.relay-bridge/config.json`:

```json
{
  "wif": "<generated private key>",
  "pubkeyHex": "<derived compressed public key>",
  "endpoint": "wss://your-bridge.example.com:8333",
  "meshId": "indelible",
  "capabilities": ["tx_relay", "header_sync", "broadcast", "address_history"],
  "spvEndpoint": "https://relay.indelible.one",
  "apiKey": "",
  "port": 8333,
  "statusPort": 9333,
  "maxPeers": 20
}
```

| Field | Description |
|-------|-------------|
| `wif` | Bridge private key (WIF format). Generated automatically. |
| `pubkeyHex` | Compressed public key. This is your bridge identity. |
| `endpoint` | Your public WSS endpoint. Other bridges connect here. |
| `meshId` | Which mesh to join. Bridges only peer within the same mesh. |
| `capabilities` | What this bridge supports: `tx_relay`, `header_sync`, `broadcast`, `address_history`. |
| `spvEndpoint` | Gateway for UTXO lookups and tx broadcast. |
| `apiKey` | API key for gateway access. Required for registration and chain scanning. |
| `port` | WebSocket server port. Default `8333`. |
| `statusPort` | Local HTTP status server port. Default `9333`. |
| `maxPeers` | Maximum peer connections. Default `20`. |

## Alternative Install Methods

### Standalone Binary

Pre-compiled binaries require no runtime — just download and run:

```bash
# Linux
chmod +x relay-bridge-linux
./relay-bridge-linux init
./relay-bridge-linux start

# Windows
relay-bridge.exe init
relay-bridge.exe start
```

### Docker

```bash
docker build -t relay-federation/bridge .
docker run -v ~/.relay-bridge:/root/.relay-bridge -p 8333:8333 -p 9333:9333 relay-federation/bridge
```

The Docker image uses the compiled Linux binary on `debian:bookworm-slim` (~80 MB).

## Examples

The `examples/` folder has copy-paste scripts for common operations:

```bash
# Set your API key
export RELAY_API_KEY=relay_sk_your_key_here

# Look up a transaction
node examples/lookup-tx.js abc123...

# Broadcast a raw transaction
node examples/broadcast-tx.js 0100000001...

# Check an address balance
node examples/check-balance.js 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa

# Check mesh health
node examples/mesh-health.js
```

## Architecture

```
 Bridge A ──ws──> Bridge B ──ws──> Bridge C
    │                │                │
    ├─ header sync   ├─ header sync   ├─ header sync
    ├─ tx relay      ├─ tx relay      ├─ tx relay
    └─ status :9333  └─ status :9333  └─ status :9333
```

**Peering:** Bridges connect via WebSocket with a cryptographic handshake — mutual nonce signing proves identity. Version negotiation selects the highest mutually supported protocol version.

**Header Sync:** Bridges exchange block headers and maintain a local header chain. New headers propagate across the mesh as they arrive.

**Transaction Relay:** Transactions broadcast to any bridge propagate to all connected peers. Each bridge maintains a mempool and deduplicates by txid.

**Registry:** Bridges register on-chain using a CBOR-encoded OP_RETURN protocol. Other bridges scan the chain to discover peers, filtering by mesh ID and capabilities.

**Status Server:** Each bridge runs a local HTTP server (default port 9333) exposing `/status` with peer count, header height, mempool size, and uptime.

## Development

```bash
git clone https://github.com/zcoolz/relay-federation.git
cd relay-federation
npm install

# Run all tests (208 tests across 3 packages)
npm test --workspaces
```

## License

MIT
