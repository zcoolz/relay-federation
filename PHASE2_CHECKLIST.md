# Phase 2: Security Layer + SPV Independence — Completion Checklist

**Goal:** Production-grade bridge software. Real operators can fund, stake, register on-chain without depending on Indelible or WoC. Mesh enforces identity, rejects bad actors, scores peers, and maintains healthy topology.

**Date started:** March 5, 2026
**Last updated:** March 8, 2026

---

## Done

- [x] **2.1 Peer scoring engine** — Composite scoring: 30% uptime + 20% response_time + 40% data_accuracy + 10% stake_age. Rolling windows. (`bridge/lib/peer-scorer.js`)
- [x] **2.2 Score-based auto-disconnect** — Auto-disconnect < 0.3, auto-blacklist < 0.1 for 24h. (`bridge/lib/score-actions.js`)
- [x] **2.3 Pubkey challenge-response handshake** — 2-round-trip crypto handshake with nonce exchange and ECDSA signatures. (`bridge/lib/handshake.js`)
- [x] **2.4 Version negotiation** — Highest mutual version selected during handshake. (`bridge/lib/handshake.js`)
- [x] **2.5 Data accuracy validation** — Validates headers (PoW, linkage, timestamps), txs (format, txid integrity via double-SHA256). Feeds accuracy into scorer. (`bridge/lib/data-validator.js`)
- [x] **2.6 Inactive detection (7-day)** — Peers unreachable for 7+ days flagged as inactive. (`bridge/lib/peer-health.js`)
- [x] **2.7 Grace period (24h)** — New disconnections get 24h grace before scoring impact. (`bridge/lib/peer-health.js`)
- [x] **2.8 Anchor bridge config** — Hardcoded anchor list, min 2 connections enforced, auto-reconnect every 30s. (`bridge/lib/anchor-manager.js`)
- [x] **2.15 Gossip-based peer discovery** — P2P peer exchange between connected bridges. (`bridge/lib/gossip.js`)
- [x] **2.16 Peer tie-breaker** — Duplicate connection resolution by pubkey comparison. (`bridge/lib/peer-manager.js`)
- [x] **2.17 Ping/pong latency measurement** — 60s interval, feeds response_time into scorer. (`bridge/cli.js`)
- [x] **2.18 Federation dashboard** — Bubble map visualization with live health data from all bridges. (`dashboard/index.html`)

## TODO — P2P Transaction Capability (SPV Independence)

These items give the bridge its own transaction capability via BSV P2P, eliminating dependency on Indelible's gateway and WoC. This is the foundation — everything else builds on it.

**Implementation plan:** [`plans/p2p-tx-capability-plan.md`](plans/p2p-tx-capability-plan.md)

- [x] **2.19 `getdata MSG_TX` in bsv-node-client** — `getTx(txid)` sends `getdata` with `MSG_TX` (type 1), returns Promise, 10s timeout, handles `notfound`. 5 tests. (`bridge/lib/bsv-node-client.js`)
- [x] **2.20 `tx` message parsing in bsv-node-client** — `_onTx` parses incoming tx, computes txid, emits `'tx'` event with `{ txid, rawHex }`, resolves pending `getTx` requests. 1 test. (`bridge/lib/bsv-node-client.js`)
- [x] **2.21 `inv`/`getdata`/`tx` broadcast in bsv-node-client** — `broadcastTx(rawTxHex)` sends tx directly, caches 60s for `getdata` serving. `_onGetdata` serves cached txs. `_onInv` emits `'tx:inv'` for MSG_TX. 5 tests. (`bridge/lib/bsv-node-client.js`)
- [x] **2.22 Self-sufficient registration** — `cmdRegister` and `cmdDeregister` now use `PersistentStore.getUnspentUtxos()` for local UTXOs and `BSVNodeClient.broadcastTx()` for P2P broadcast. No gateway, no apiKey. (`bridge/cli.js`)
- [x] **2.23 Self-sufficient funding** — `relay-bridge init` now shows wallet address. Address stored in config. Next steps updated (no apiKey, shows address, includes fund step). (`bridge/cli.js`, `bridge/lib/config.js`)
- [x] **2.24 Beacon address watching** — Beacon address added to AddressWatcher in `cmdStart`. `addressToHash160()` utility added to output-parser. On beacon UTXO received, parses OP_RETURN, adds new registrations to gossip directory, logs deregistrations. (`bridge/cli.js`, `bridge/lib/output-parser.js`)
- [x] **2.25 Remove `network.js` dependency from CLI** — `network.js` import removed from `cli.js`. Zero references to `common/lib/network.js` remain in the bridge package. Bridge operates independently.

## TODO — Security Layer

- [x] **2.9 Wire stake bond into `relay-bridge register`** — Real stake bond: `buildStakeBondTx()` creates P2PKH output with MIN_STAKE_SATS (100M sats / 1 BSV) to bridge's own address. Broadcast via P2P, then use txid in registration. CLTV dropped (disabled on BSV since Genesis). (`registry/lib/stake-bond.js`, `bridge/cli.js`, `common/lib/protocol.js`)
- [x] **2.10 Stake bond validation in scanner** — `validateStakeBond()` fetches stake tx, verifies output with >= MIN_STAKE_SATS to registrant's pubkey. `scanRegistry()` adds `stakeValid: true/false` to each entry. (`registry/lib/scanner.js`)
- [x] **2.11 Registry check in handshake** — `registeredPubkeys` Set created from self + seed peers, updated by beacon watcher (register adds, deregister removes). Passed to `handleHello` (inbound) and `handleChallengeResponse` (outbound). Unregistered pubkeys rejected with `not_registered`. (`bridge/cli.js`, `bridge/lib/peer-manager.js`)
- [x] **2.12 Endpoint reachability probe** — `probeEndpoint(endpoint, timeoutMs)` opens WebSocket, waits for open (5s default), closes. `peer:discovered` handler probes before connecting. 4 tests. (`bridge/lib/endpoint-probe.js`, `bridge/cli.js`)
- [x] **2.13 IP diversity rules** — `extractSubnet`, `getSubnets`, `checkIpDiversity` enforce min 3 /16 subnets. Blocks >50% from same subnet when diversity is low. 13 tests. (`bridge/lib/ip-diversity.js`, `bridge/cli.js`)
- [x] **2.14 Periodic peer refresh** — 10-minute `requestPeersFromAll()` interval catches registrations missed during downtime. Replaces chain rescan — beacon watching (2.24) handles real-time, gossip refresh handles gaps. (`bridge/cli.js`)

## TODO — Status & Visibility

- [x] **2.26 BSV P2P node info in status server** — `bsvNodeClient` passed to StatusServer. `/status` JSON includes `bsvNode: { connected, host, height }`. Dashboard shows BSV Node card with status dot, host, height. CLI `relay-bridge status` shows BSV Node section. (`bridge/lib/status-server.js`, `bridge/cli.js`)
- [x] **2.27 Wallet balance in status** — `store` (PersistentStore) passed to StatusServer. `getStatus()` now async, calls `store.getBalance()`. Dashboard shows Wallet card with balance in sats. CLI shows Wallet section. (`bridge/lib/status-server.js`, `bridge/cli.js`)

---

## Phase 2 Checkpoint (from roadmap)

These are the acceptance criteria from `relay-federation-roadmap.md`:

- [x] Bridges compute and display peer scores via `relay-bridge status`
- [x] Low-scoring peers are auto-disconnected
- [x] Handshake rejects connections from unregistered pubkeys *(2.11)*
- [x] Version mismatch produces clean error
- [x] Anchor connections are maintained (auto-reconnect)
- [x] Unreachable bridges are locally flagged as inactive after 7 days

---

---

## Reference: What exists today

| Module | Status | Notes |
|---|---|---|
| `bsv-node-client.js` | Headers + Transactions | P2P connect, handshake, getheaders, ping/pong, `getTx`, `broadcastTx`, `_onTx`, `_onNotfound`, `_onGetdata`, `tx:inv`. 11 tests. |
| `network.js` (common) | Gateway dependency | `fetchUtxos`, `broadcastTx`, `fetchTxHex`, `fetchAddressHistory` all call Indelible gateway. WoC fallback on `fetchTxHex`. |
| `stake-bond.js` (registry) | Code complete, tested | `buildStakeBondTx()` builds real CLTV output. Not wired into CLI. |
| `registration.js` (registry) | Code complete, tested | `buildRegistrationTx()` and `buildDeregistrationTx()` work. Use `network.js` for broadcast. |
| `scanner.js` (registry) | Works but no stake validation | Scans beacon address history, parses CBOR. Doesn't verify stake UTXOs. |
| `AddressWatcher` (bridge) | Works for own address | Watches txs, tracks UTXOs in LevelDB. Already running on live bridges. |
| `PersistentStore` (bridge) | Works | LevelDB store for headers, txs, UTXOs, balance. |
| Indelible `p2p.js` + `spv-client.js` | Reference code | Full P2P tx capability exists in Indelible codebase. Can reference for 2.19-2.21. |

## Post-Phase 2 Fixes (Mar 7, 2026)

### Header Sync Bug — Live Peer Reuse + Retry Loop

**Problem:** SPV bridges (the 5-node Indelible relay) drifted behind chain tip. Header sync opened its own fragile P2P connections that dropped mid-download. On disconnect, `sync()` gave up entirely — no retry, waited 60s for the next periodic attempt. Also: `headerPromise` listened for `'close'` event but BSVP2P emits `'disconnect'`, so disconnects were never detected (always hit 30s timeout).

**Fix (header-sync.js + server-spv.js):**
1. `setLiveConnections(connections)` — accepts actual BSVP2P instances from SPV client's stable peers
2. `connect(failedHosts)` — tries live connections first (already handshaken), falls back to new connections, skips failed hosts
3. `sync()` — retry loop (max 3 attempts), tracks failed peer hosts between attempts
4. Event name fix: `'close'` → `'disconnect'` in headerPromise listeners
5. `close()` — only disconnects if `ownConnection` (don't kill shared SPV peers)
6. `server-spv.js` periodic sync passes `p2p` instances via `setLiveConnections()`

**Deployed:** enterprise-federation (155.138.216.126) as canary — confirmed working ("Reusing live peer" in logs, sync completing instantly). Pending rollout to other 4 bridges.

**Files:** `/opt/spv-bridge-v2/header-sync.js`, `/opt/spv-bridge-v2/server-spv.js`
**Local copies:** `C:/Users/oorel/AppData/Local/Temp/bridge-fix/`

### 155.138.254.224 Rollback

Bridge was running federation engine (`spv-engine.js`) from earlier testing — 0 BSV peers, stuck at 930,000. Rolled back to `spv-client.js`. Now connects to BSV peers but this IP still has issues (DNS seeds / BSV nodes refuse handshake from this IP). Works via mesh relay but can't sync headers independently.

### Whitepaper v2 Status

**Done:** Production code updates — native P2P peer discovery (getaddr/addr), Section 9 Supervision & Self-Healing, restructured layers. Located at `C:/bsv-claude-wrapper/whitepaper/federated-spv-relay-mesh.md`.

**Not done (federation sections per `plans/relay-federation-whitepaper-v2-plan.md`):**
- On-chain bridge registry protocol (OP_RETURN + CBOR)
- Stake bonds (anti-Sybil)
- Cryptographic handshake (pubkey challenge-response)
- Peer scoring formula
- Eclipse attack resistance
- Reframing from "Indelible infrastructure" to "BSV developer infrastructure"
- Signal model positioning
- Sections 14.1, 14.5, 14.6 should move from Future Work to current (they're built)

## Recent Changes (Mar 8, 2026)

- [x] **Dashboard redesign** — Replaced bubble map with stats hero (4 cards), card grid view, table view (sortable), and search bar. Scales to 1000s of bridges. (`dashboard/index.html`)
- [x] **Dynamic bridge discovery** — `/discover` endpoint on status server exposes gossip directory over HTTP. Dashboard discovers bridges dynamically from seeds instead of hardcoded array. Re-discovers every 60s. (`bridge/lib/status-server.js`, `bridge/cli.js`)
- [x] **Operator panel reorder** — Wallet + Actions moved to top of side panel (after Bridge info), above BSV Node/Network/Mempool.
- [x] **`--config` CLI bug fix** — `process.argv[3]` treated `--config` as a manual peer endpoint, skipping seed peers entirely. Fixed by filtering args starting with `-`. (`bridge/cli.js`)
- [x] **Endpoint hiding** — `/status` no longer exposes `endpoint` field to unauthenticated requests. Operator-only.
- [x] **Fund button removal** — Removed Fund action button from dashboard (funding is done externally).
- [x] **Mempool scrollable** — Mempool list capped at 300px with overflow scroll.
- [x] **Deployed v0.2.1** — Both VPS running latest. `/discover` confirmed working via curl.

---

## Operational TODO

These are deployment/operations tasks, not code changes.

- [ ] **Fund wallets** — Both bridge wallets at 0 sats. Need BSV sent to register on-chain.
  - bridge-alpha: `1EEtoaSuniYkoU7q16rohyHcquMNpHBRNC`
  - bridge-beta: `17og92uejQX3StfdmW63HnDKknF9FYPKc9`
- [ ] **Register both bridges on-chain** — Requires funded wallets. Use dashboard Register button. Will enable STK scoring (currently 0).
- [ ] **meshId change** — Change from `"indelible"` to `"70016"` in config on both VPS.
- [ ] **Header sync fix rollout** — Canary on enterprise-federation (155.138.216.126) confirmed working. Pending rollout to other 4 bridges.
- [ ] **155.138.254.224 BSV P2P** — This IP can't sync headers independently (BSV nodes refuse handshake). Works via mesh relay only.

---

## Phase 3: Output Parsing & Protocol Support

The bridge currently only decodes P2PKH outputs. To serve developers (like on-chain file storage, inscriptions, metadata), the output parser needs to understand additional script types. This is what makes the bridge useful as developer infrastructure.

**Implementation target:** `bridge/lib/output-parser.js`

- [x] **P2PKH** — Pay-to-address. Already implemented. Extracts address, tracks UTXOs.
- [x] **OP_RETURN / OP_FALSE OP_RETURN** — Data carrier outputs. Extracts all push data segments, detects protocol prefixes. Foundation for all data protocols below. (`bridge/lib/output-parser.js`)
- [x] **B:// protocol** — On-chain file storage. Detects `19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut` prefix, extracts data, mimeType, encoding, filename. (`bridge/lib/output-parser.js`)
- [x] **BCAT** — Chunked large files. Linker (`15DHFxWZJT58f9nhyGnsRBqrgwK4W6h4Up`) extracts mimeType, charset, filename, chunk txids. Part (`1ChDHzdd1H4wSjgGMHyndZm6qxEDGjqpJL`) extracts raw data. (`bridge/lib/output-parser.js`)
- [x] **MAP** — Metadata Attachment Protocol. Detects `1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5` prefix, extracts action + key-value pairs. (`bridge/lib/output-parser.js`)
- [x] **MetaNet** — Tree-structured data protocol. Detects `"meta"` magic bytes, extracts nodeAddress + parentTxid. (`bridge/lib/output-parser.js`)
- [x] **1Sat Ordinals + BSV-20** — Inscription protocol. Scans for `OP_FALSE OP_IF OP_PUSH3 "ord"` envelope, extracts contentType + content. Auto-detects BSV-20 tokens (`application/bsv-20`) and parses JSON (op, tick/id, amt). (`bridge/lib/output-parser.js`)
- [x] **P2SH** — Pay-to-script-hash. Detects `a914[20 bytes]87` pattern, extracts script hash. Deprecated on BSV since Genesis but exists in history. (`bridge/lib/output-parser.js`)
- [x] **Bare multisig** — `OP_m <pubkeys> OP_n OP_CHECKMULTISIG`. Extracts m, n, and public keys. (`bridge/lib/output-parser.js`)
- [x] **`/tx/:txid` API endpoint** — Developer-facing API. Fetches tx from mempool/P2P/WoC, parses with full protocol support, returns structured JSON with type/protocol/parsed for every output. (`bridge/lib/status-server.js`)
- [x] **`/mempool` protocol fields** — Mempool endpoint now includes type, protocol, and parsed data for each output. (`bridge/lib/status-server.js`)
- [x] **Dashboard protocol support** — Protocol badges (color-coded by type), parsed data display for mempool txs, Transaction Explorer with txid lookup. Clickable mempool txids auto-fill the explorer. (`dashboard/index.html`)

---

## Notes

- Stake bond builder code exists and is tested (`registry/lib/stake-bond.js`, `registry/test/stake-bond.test.js`) — wired into CLI (2.9)
- Registration and deregistration tx builders exist and are tested (`registry/lib/registration.js`)
- CBOR encoding/decoding exists and is tested (`registry/lib/cbor.js`)
- Chain scanner exists and is tested (`registry/lib/scanner.js`) — stake validation added (2.10)
- All 268 bridge tests pass (0 failures) — 23 new protocol parser tests added
- Current deployed version: v0.2.1
- Live nodes: bridge-alpha (144.202.48.217), bridge-beta (45.63.77.31)
- Federation bridges serve bsvbible.club and chainofthought.news via nginx reverse proxies on VPS1
- SSH key auth configured for VPS1 (144.202.48.217) — no password needed
