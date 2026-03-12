# Relay Federation

A federated mesh network for BSV. Each bridge is a lightweight SPV node that syncs headers, verifies transactions with Merkle proofs, indexes inscriptions and tokens, and serves a full REST API — no full node required. Bridges discover each other on-chain, peer over WebSocket, and share data across the mesh. Run your own infrastructure in three commands.

## Features

- **SPV verification** — header sync from BSV P2P nodes, Merkle proof generation and validation
- **Transaction relay** — lookup, broadcast, UTXO queries, full address history
- **Inscription indexing** — ordinal inscriptions with content-addressed storage and content serving
- **BSV-20 tokens** — deploy/mint/transfer tracking, balance queries by address
- **Protocol parsing** — P2PKH, OP_RETURN, ordinals, B://, BCAT, MAP, MetaNet, BSV-20
- **Price feed** — live BSV/USD from CoinGecko
- **Federation mesh** — bridges discover and verify each other via on-chain stake bonds
- **Operator dashboard** — glassmorphism UI with Overview, Mempool, Explorer, Inscriptions, Tokens, and Apps tabs
- **291 tests passing** — MIT license

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@relay-federation/bridge`](packages/bridge) | [![npm](https://img.shields.io/npm/v/@relay-federation/bridge)](https://www.npmjs.com/package/@relay-federation/bridge) | Bridge server — WebSocket peering, header sync, tx relay, CLI |
| [`@relay-federation/common`](packages/common) | [![npm](https://img.shields.io/npm/v/@relay-federation/common)](https://www.npmjs.com/package/@relay-federation/common) | Shared modules — crypto, network, protocol constants |
| [`@relay-federation/registry`](packages/registry) | — | On-chain bridge registry — CBOR encoding, registration/deregistration tx builders |
| [`@relay-federation/sdk`](packages/sdk) | [![npm](https://img.shields.io/npm/v/@relay-federation/sdk)](https://www.npmjs.com/package/@relay-federation/sdk) | JavaScript client SDK — connect to any bridge from your app |

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/api.md) | HTTP endpoints — request/response formats for all routes |
| [Protocol Spec](docs/protocol.md) | On-chain registry, CBOR format, handshake, gossip, peer scoring |
| [Whitepaper](docs/whitepaper.md) | Architecture and design of the Federated SPV Relay Mesh |
| [SDK README](packages/sdk/README.md) | Client library quick start and API reference |

## Quick Start

### For app developers (SDK)

```bash
npm install @relay-federation/sdk
```

```javascript
import { RelayBridge } from '@relay-federation/sdk'

const bridge = new RelayBridge('http://your-bridge:9333')
const tx = await bridge.getTx('abc123...')
const mesh = await bridge.discover()
```

See the [SDK README](packages/sdk/README.md) for full API.

### For bridge operators (CLI)

```bash
# 1. Install
npm install -g @relay-federation/bridge

# 2. Generate identity and config (auto-detects your IP)
relay-bridge init

# 3. Fund your bridge — send BSV to the address shown by init
#    Then import the funding tx (get raw hex from your wallet or block explorer)
relay-bridge fund <rawTxHex>

# 4. Register on-chain — creates stake bond + publishes registration tx
relay-bridge register

# 5. Start the bridge
relay-bridge start
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `relay-bridge init` | Generate keypair, auto-detect IP, create config at `~/.relay-bridge/config.json` |
| `relay-bridge start` | Start the bridge server — listens for peers, syncs headers, relays transactions |
| `relay-bridge start ws://host:port` | Start and connect to a specific peer |
| `relay-bridge status` | Show running bridge status — peers, headers, mempool |
| `relay-bridge fund <rawTxHex>` | Import a funding transaction (raw hex) into the bridge's UTXO store |
| `relay-bridge register` | Register on-chain — builds stake bond tx + registration tx, broadcasts to BSV network |
| `relay-bridge deregister [reason]` | Deregister this bridge from the mesh |
| `relay-bridge backfill` | Backfill historical inscriptions and tokens for watched addresses |
| `relay-bridge secret` | Show your operator secret for dashboard login |

## Configuration

`relay-bridge init` creates `~/.relay-bridge/config.json`:

```json
{
  "wif": "<generated private key>",
  "pubkeyHex": "<derived compressed public key>",
  "endpoint": "wss://your-bridge.example.com:8333",
  "meshId": "70016",
  "capabilities": ["tx_relay", "header_sync", "broadcast", "address_history"],
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
| `port` | WebSocket server port. Default `8333`. |
| `statusPort` | HTTP status server + dashboard port. Default `9333`. |
| `maxPeers` | Maximum peer connections. Default `20`. |
| `seedPeers` | Array of `{endpoint, pubkeyHex}` objects — known peers to connect to on startup. |
| `statusSecret` | Operator secret for dashboard login. Generated by `init`, shown by `secret`. |
| `apps` | Array of `{name, url, healthUrl, bridgeDomain}` objects — apps running on this bridge (shown in dashboard). `healthUrl` is optional — use a local URL to avoid DNS/TLS loopback timeout. |

## Registration

Registration puts your bridge on-chain so other bridges can discover and peer with it. It's a two-transaction process:

1. **Stake bond tx** — locks 1,000,000 sats (minimum) to your own address as proof of BSV ownership. Operators can stake more for a slightly higher trust score.
2. **Registration tx** — OP_RETURN with CBOR-encoded payload: endpoint, pubkey, capabilities, mesh ID, stake txid. Sends 100 sats dust to the beacon address for discoverability.

```bash
# 1. Send BSV to your bridge address (shown during init)
# 2. Get the raw tx hex from your wallet or block explorer
# 3. Import it
relay-bridge fund <rawTxHex>

# 4. Register (bridge must be stopped — can't share LevelDB lock)
relay-bridge register
# Output:
#   Stake bond txid: abc123...
#   Registration broadcast successful! txid: def456...

# 5. Start the bridge
relay-bridge start
```

**Important:** The bridge must be stopped when running `register` — both commands need exclusive access to the LevelDB store. Fund first, then register, then start.

### Stake Bond

| Parameter | Value |
|-----------|-------|
| Minimum | 1,000,000 sats (~0.01 BSV) |
| Purpose | Proof of BSV ownership, Sybil deterrence |
| Scoring weight | 10% (stake_age factor in peer scoring) |
| Recovery | Deregister to unlock |

The stake isn't a payment — it's a security deposit locked to your own address. Higher stakes don't buy much in scoring (only 10% weight). The real defense against bad actors is data_accuracy scoring (40% weight) — fake bridges get auto-disconnected.

### Peer Scoring

Every bridge scores its peers locally. No centralized reputation.

```
score = 0.3 * uptime + 0.2 * response_time + 0.4 * data_accuracy + 0.1 * stake_age
```

| Factor | Weight | What It Measures |
|--------|--------|------------------|
| Uptime | 0.3 | % reachable over rolling window |
| Response time | 0.2 | Normalized inverse latency |
| Data accuracy | 0.4 | % of relayed data that validates correctly |
| Stake age | 0.1 | How long the stake bond has existed |

Score < 0.3 → auto-disconnect. Score < 0.1 → 24-hour blacklist.

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

The `examples/` folder has copy-paste scripts:

```bash
# SDK demo — connect to a bridge, explore the mesh
node examples/sdk-demo.js
node examples/sdk-demo.js http://your-bridge:9333

# Raw API examples (no SDK)
node examples/lookup-tx.js abc123...
node examples/broadcast-tx.js 0100000001...
node examples/check-balance.js 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
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

**Dashboard:** Each bridge runs a local HTTP server (default port 9333) with a glassmorphism dashboard — tabs for Overview, Mempool, Explorer, Inscriptions, Tokens, and Apps. Operator login via `statusSecret`.

## Development

```bash
git clone https://github.com/zcoolz/relay-federation.git
cd relay-federation
npm install

# Run bridge tests (291 tests)
npm test --workspace=packages/bridge
```

## Operational Notes

### Restarting a bridge

Kill and start as **separate SSH commands** — `pkill` kills the SSH session too.

```bash
# Step 1: Kill
ssh root@<IP> "pkill -f 'relay-bridge start'"

# Step 2: Kill stale port holders, remove lock, and start
ssh root@<IP> "fuser -k 8333/tcp 2>/dev/null; rm -f /root/.relay-bridge/data/bridge.db/LOCK && setsid relay-bridge start > /var/log/relay-bridge.log 2>&1 &"
```

### Deploy updates

```bash
# Pack locally
cd relay-federation
npm pack --workspace=packages/common --workspace=packages/registry --workspace=packages/bridge

# SCP and install
scp relay-federation-*.tgz root@<IP>:/tmp/
ssh root@<IP> "npm install -g /tmp/relay-federation-common-*.tgz /tmp/relay-federation-registry-*.tgz /tmp/relay-federation-bridge-*.tgz"
```

Then restart the bridge (see above).

### Dashboard

Access at `http://<IP>:9333`. Login with operator secret (`relay-bridge secret`).

Tabs: Overview | Mempool | Explorer | Inscriptions | Tokens | Apps

### Adding apps to a bridge

Edit `~/.relay-bridge/config.json`:

```json
{
  "apps": [
    {
      "name": "My App",
      "url": "https://myapp.com",
      "healthUrl": "http://127.0.0.1:3000",
      "bridgeDomain": "bridge.myapp.com"
    }
  ]
}
```

Restart the bridge. Apps appear in the Apps tab with health checks, SSL status, and latency monitoring.

## License

MIT
