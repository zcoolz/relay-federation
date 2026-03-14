# Relay Federation — Protocol Specification

**Version:** 1.0
**Status:** Deployed (mainnet)

This document specifies the wire formats, on-chain structures, and peer-to-peer protocols used by the Federated SPV Relay Mesh.

---

## Table of Contents

1. [Constants](#1-constants)
2. [On-Chain Registry](#2-on-chain-registry)
   - 2.1 Beacon Address
   - 2.2 Registration Transaction
   - 2.3 Stake Bond Transaction
   - 2.4 Deregistration Transaction
   - 2.5 CBOR Payload Format
3. [Cryptographic Handshake](#3-cryptographic-handshake)
4. [Gossip Protocol](#4-gossip-protocol)
5. [Peer Scoring](#5-peer-scoring)
6. [Protocol Parsing](#6-protocol-parsing)
7. [Transaction Confirmation Model](#7-transaction-confirmation-model)
8. [Content-Addressed Storage](#8-content-addressed-storage)
9. [BSV-20 Token State Machine](#9-bsv-20-token-state-machine)
10. [Data Relay Protocol](#10-data-relay-protocol)

---

## 1. Constants

| Constant | Value | Description |
|---|---|---|
| `PROTOCOL_PREFIX` | `indelible.bridge-registry` | OP_RETURN protocol identifier |
| `BEACON_ADDRESS` | `1KhH4VshyN8PnzxbTSjiojcQbbABNSZyzR` | Deterministic dust output address |
| `BEACON_SATOSHIS` | `100` | Dust amount sent to beacon address |
| `MIN_STAKE_SATS` | `1,000,000` (0.01 BSV) | Minimum stake bond amount |
| `VALID_CAPABILITIES` | `tx_relay`, `header_sync`, `broadcast`, `address_history` | Advertised bridge capabilities |
| `SUPPORTED_VERSIONS` | `1.0` | Protocol versions for handshake negotiation |
| `HANDSHAKE_TIMEOUT_MS` | `10,000` | Max time to complete handshake (ms) |

---

## 2. On-Chain Registry

Bridge registration is recorded on the BSV blockchain using OP_RETURN transactions. A deterministic beacon address enables chain scanners to discover all registrations by querying address history.

### 2.1 Beacon Address

Derived deterministically from the protocol prefix:

```
SHA-256("indelible.bridge-registry") → first 20 bytes → P2PKH address
```

Result: `1KhH4VshyN8PnzxbTSjiojcQbbABNSZyzR`

Every registration and deregistration transaction includes a 100-satoshi dust output to this address. Scanners find all registry transactions by querying the beacon address history.

### 2.2 Registration Transaction

A registration transaction has 3 outputs:

| Output | Type | Description |
|---|---|---|
| 0 | `OP_FALSE OP_RETURN <prefix> <cbor>` | Protocol prefix + CBOR-encoded registration payload |
| 1 | P2PKH to `BEACON_ADDRESS` | 100 sat dust for discoverability |
| 2 | P2PKH to self | Change output |

**Script format (output 0):**

```
OP_FALSE OP_RETURN
  PUSHDATA <"indelible.bridge-registry">
  PUSHDATA <CBOR bytes>
```

### 2.3 Stake Bond Transaction

A separate transaction broadcast **before** the registration tx. Proves BSV ownership by locking funds to the operator's own address.

| Output | Type | Description |
|---|---|---|
| 0 | P2PKH to self | Stake amount (>= `MIN_STAKE_SATS`) |
| 1 | P2PKH to self | Change output |

The registration tx references the stake bond via `stake_txid` in its CBOR payload. Scanners verify the bond UTXO is unspent on-chain. If the operator spends the bond, scanners flag the bridge as unbonded.

**Note:** BSV disabled `OP_CHECKLOCKTIMEVERIFY` (reverted to `OP_NOP2`) since the Genesis upgrade (Feb 2020). Script-level timelocks are not possible. Bond enforcement is scanner-based: watch for spent bonds.

Operators can stake more than `MIN_STAKE_SATS` for a slightly higher trust score (10% weight in the scoring formula).

### 2.4 Deregistration Transaction

Same output structure as registration (OP_RETURN + beacon dust + change), but with a deregistration CBOR payload.

### 2.5 CBOR Payload Format

Payloads are encoded with [CBOR (RFC 8949)](https://www.rfc-editor.org/rfc/rfc8949) using the `cborg` library.

#### Registration Payload

```
{
  "action":          "register",          // string — always "register"
  "endpoint":        "ws://1.2.3.4:8333", // string — WebSocket endpoint (ws:// or wss://)
  "pubkey":          <33 bytes>,          // Uint8Array — compressed secp256k1 public key
  "capabilities":    ["tx_relay", ...],   // string[] — subset of VALID_CAPABILITIES
  "versions":        ["1.0"],             // string[] — supported protocol versions
  "network_version": "1.0",              // string — current network version
  "stake_txid":      <32 bytes>,          // Uint8Array — txid of stake bond transaction
  "mesh_id":         "70016",             // string — mesh network identifier
  "timestamp":       1741700000           // number — unix timestamp (seconds)
}
```

**Required fields:** `action`, `endpoint`, `pubkey`, `capabilities`, `versions`, `network_version`, `stake_txid`, `mesh_id`, `timestamp`

**Validation rules:**
- `pubkey` must be exactly 33 bytes (compressed secp256k1)
- `stake_txid` must be exactly 32 bytes
- `endpoint` must start with `ws://` or `wss://`
- Each capability must be in `VALID_CAPABILITIES`

#### Deregistration Payload

```
{
  "action":    "deregister",    // string — always "deregister"
  "pubkey":    <33 bytes>,      // Uint8Array — compressed secp256k1 public key
  "reason":    "shutdown",      // string — reason for leaving
  "timestamp": 1741700000       // number — unix timestamp (seconds)
}
```

**Required fields:** `action`, `pubkey`, `reason`, `timestamp`

---

## 3. Cryptographic Handshake

Mutual authentication between two bridges using BSV keypairs. Two round-trips, no certificate authority.

### Protocol Flow

```
Initiator                              Responder
    |                                      |
    |--- hello --------------------------->|
    |    pubkey, nonce_i, versions,         |
    |    endpoint                          |
    |                                      |
    |<-- challenge_response ---------------|
    |    pubkey, nonce_r,                   |
    |    sig(nonce_i), selected_version    |
    |                                      |
    |--- verify -------------------------->|
    |    sig(nonce_r)                       |
    |                                      |
    |========= connection established =====|
```

### Message 1: hello (Initiator → Responder)

```json
{
  "type": "hello",
  "pubkey": "02abc...",
  "nonce": "<64 hex chars>",
  "versions": ["1.0"],
  "endpoint": "ws://1.2.3.4:8333"
}
```

- `nonce`: 32 random bytes, hex-encoded
- `versions`: array of supported protocol versions

### Message 2: challenge_response (Responder → Initiator)

```json
{
  "type": "challenge_response",
  "pubkey": "03def...",
  "nonce": "<64 hex chars>",
  "signature": "<DER hex>",
  "selected_version": "1.0"
}
```

- `signature`: ECDSA-SHA256 signature of `nonce_i` (the initiator's nonce), signed with responder's private key
- `selected_version`: highest mutually supported version
- Responder may reject with `{ error: "not_registered" }` if the initiator's pubkey is not in the on-chain registry

### Message 3: verify (Initiator → Responder)

```json
{
  "type": "verify",
  "signature": "<DER hex>"
}
```

- `signature`: ECDSA-SHA256 signature of `nonce_r` (the responder's nonce), signed with initiator's private key

### Verification

Each side verifies the other's signature against their claimed public key:

```
SHA-256(nonce_bytes) → hash
ECDSA.verify(hash, signature, pubkey) → true/false
```

### Error Codes

| Code | Meaning |
|---|---|
| `invalid_hello` | Malformed hello message |
| `missing_versions` | No versions array in hello |
| `not_registered` | Pubkey not found in on-chain registry |
| `version_mismatch` | No mutual protocol version |
| `invalid_challenge_response` | Malformed challenge_response |
| `missing_version` | No selected_version in response |
| `invalid_signature` | Signature verification failed |
| `invalid_verify` | Malformed verify message |

### Timeout

If the handshake is not completed within `HANDSHAKE_TIMEOUT_MS` (10 seconds), the connection is dropped.

---

## 4. Gossip Protocol

Peer discovery via WebSocket message passing. Three message types.

### 4.1 getpeers

Request: "tell me who you know"

```json
{ "type": "getpeers" }
```

Can be sent to a specific peer or broadcast to all.

### 4.2 peers

Response to `getpeers`. Returns known peers from the gossip directory (excluding the requester).

```json
{
  "type": "peers",
  "peers": [
    {
      "pubkeyHex": "02abc...",
      "endpoint": "ws://1.2.3.4:8333",
      "meshId": "70016",
      "lastSeen": 1741700000000
    }
  ]
}
```

Capped at 50 peers per response.

### 4.3 announce

Signed self-announcement: "I'm alive." Propagated to all peers via gossip flood.

```json
{
  "type": "announce",
  "pubkeyHex": "02abc...",
  "endpoint": "ws://1.2.3.4:8333",
  "meshId": "70016",
  "timestamp": 1741700000000,
  "signature": "<DER hex>"
}
```

**Signature payload:**

```
UTF-8 bytes of: "<pubkeyHex>:<endpoint>:<meshId>:<timestamp>"
→ hex-encode
→ SHA-256
→ ECDSA sign with private key
→ DER-encode
```

**Validation rules:**
- Reject if `timestamp` is older than 5 minutes (`maxAge = 300,000 ms`)
- Reject if `timestamp` is more than 30 seconds in the future
- Reject if signature verification fails against `pubkeyHex`
- Deduplicate by `pubkeyHex:timestamp` (don't process the same announcement twice)
- Skip if `pubkeyHex` matches self

**Propagation:** Valid announcements are re-broadcast to all connected peers except the source.

**Frequency:** Each bridge announces every 60 seconds.

---

## 5. Peer Scoring

Local reputation scores computed per-peer. Not shared on the network — each bridge maintains its own scores.

### Formula

```
score = 0.3 * uptime + 0.2 * response_time + 0.4 * data_accuracy + 0.1 * stake_age
```

### Sub-Scores (0.0 to 1.0)

| Metric | Weight | Computation | Neutral (no data) |
|---|---|---|---|
| Uptime | 0.3 | `pongs / pings` (rolling window of 1000) | 0.5 |
| Response Time | 0.2 | Linear: 1.0 at <= 100ms, 0.0 at >= 5000ms | 0.5 |
| Data Accuracy | 0.4 | `good_relays / total_relays` (rolling window of 1000) | 0.5 |
| Stake Age | 0.1 | `min(1.0, log2(days) / 10)` | 0.0 |

### Input Events

| Event | Method | Effect |
|---|---|---|
| Peer responds to ping | `recordPing(pubkey, latencyMs)` | +1 pong, +1 ping, record latency |
| Peer times out on ping | `recordPingTimeout(pubkey)` | +1 ping (no pong) |
| Valid data relayed | `recordGoodData(pubkey)` | Append `true` to accuracy log |
| Invalid data relayed | `recordBadData(pubkey)` | Append `false` to accuracy log |
| Stake age discovered | `setStakeAge(pubkey, days)` | Set stake age |

### Anti-Sybil

The stake bond (minimum 1,000,000 sats) provides a cost floor for creating fake peers. The `data_accuracy` weight (40%) is the primary defense — a peer relaying invalid headers or transactions gets its score crushed regardless of stake.

---

## 6. Protocol Parsing

The bridge parses OP_RETURN outputs to identify BSV protocol data. Supported protocols:

| Protocol | Detection | Parsed Fields |
|---|---|---|
| **B://** | Push `19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut` | `data`, `mediaType`, `encoding`, `filename` |
| **BCAT** | Push `15DHFxWZJT58f9nhyGnsRBqrgwK4W6h4Up` | `info`, `mediaType`, `encoding`, `filename`, `flag`, `chunks[]` |
| **MAP** | Push `1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5` + `SET` | Key-value pairs |
| **MetaNet** | `OP_FALSE OP_RETURN <node_pubkey> <parent_txid>` | `nodePubkey`, `parentTxid` |
| **Ordinals** | `OP_FALSE OP_IF 6f7264 OP_1 <type> OP_0 <data> OP_ENDIF` | `contentType`, `data` |
| **BSV-20** | JSON with `"p":"bsv-20"` in OP_RETURN | `op`, `tick`, `max`, `lim`, `amt`, `dec` |

Each output in the parsed transaction includes:

```json
{
  "vout": 0,
  "satoshis": 0,
  "isP2PKH": false,
  "hash160": null,
  "type": "op_return",
  "data": ["<hex push 1>", "<hex push 2>"],
  "protocol": "B",
  "parsed": { ... }
}
```

---

## 7. Transaction Confirmation Model

Every transaction the bridge sees is tracked through a lifecycle state machine. This is foundational — token balances, proofs, and backfill all depend on it.

### States

| State | Meaning |
|---|---|
| `mempool` | Seen via P2P or broadcast, not yet proven in best chain |
| `confirmed` | Has best-chain block association + merkle proof verified against stored header |
| `orphaned` | Was confirmed, but block disconnected by chain reorg |
| `dropped` | Mempool tx aged out / never confirmed (optional, after 14 days) |

### State Transitions

```
tx:new event ──→ mempool
                    │
     merkle proof ──→ confirmed
                    │       │
                    │   reorg ──→ orphaned
                    │               │
                    │    re-prove ──→ confirmed (new block)
                    │
        14d expiry ──→ dropped
```

### Storage (LevelDB Sublevels)

**txStatus** — authoritative lifecycle:

| Key | Value |
|---|---|
| `s!<txid>` | `{ state, firstSeen, lastSeen, source, blockHash?, height?, updatedAt }` |
| `mempool!<txid>` | `1` (secondary index for fast scans) |

**txBlock** — block placement + reverse index:

| Key | Value |
|---|---|
| `tx!<txid>` | `{ blockHash, height, proof: {nodes[], index}, verified, confirmedAt }` |
| `block!<blockHash>!tx!<txid>` | `1` (reverse index for reorg rollback) |

### Reorg Handling

When the best chain changes, the bridge identifies disconnected blocks and reverses confirmations:

1. Look up `block!<blockHash>!tx!*` reverse index to find affected txids
2. Mark each txid as `orphaned` in txStatus
3. Delete txBlock association
4. Re-enqueue txid for confirmation against new best chain

All rollback operations are executed in a single atomic `batch()` write.

---

## 8. Content-Addressed Storage

Inscription content is stored in a content-addressed system keyed by SHA256 hash. This prevents duplication and reduces LevelDB compaction pressure for large payloads.

### Size Threshold

| Size | Storage |
|---|---|
| < 4 KB | Inline in LevelDB (base64 in `content` sublevel) |
| >= 4 KB | Filesystem at `data/content/<first2chars>/<hash>` |

### LevelDB Schema

**content sublevel:**

| Key | Value |
|---|---|
| `c!<contentHash>` | `{ len, mime, path, inline?: <base64>, createdAt }` |

### Flow

1. Inscription arrives (via `tx:new` or backfill)
2. Raw content hex → SHA256 hash
3. If hash already exists in content sublevel → skip (deduplicated)
4. If < 4 KB → store inline as base64 in LevelDB value
5. If >= 4 KB → write to filesystem, store path in LevelDB
6. Inscription record stores `contentHash` + `contentLen` instead of raw bytes

### HTTP Serving

`GET /inscription/:txid/:vout/content` resolves content via:
1. Read inscription record → get `contentHash`
2. Read content sublevel → get location (inline or filesystem path)
3. Serve with `Content-Type` from inscription mime
4. Cache headers: `Cache-Control: public, max-age=31536000, immutable`

---

## 9. BSV-20 Token State Machine

The bridge indexes BSV-20 deploy and mint operations. **Confirmed-only** — mempool token operations are not indexed to prevent double-spend corruption.

### Owner Identity

Token owners are identified by **scriptHash** — SHA256 of the output's locking script hex. This is universal:

| Script Type | Address? | scriptHash? |
|---|---|---|
| P2PKH | Yes | Yes |
| P2PK | No standard address | Yes |
| P2SH | Yes | Yes |
| Bare script | No | Yes |

### Operations

**Deploy** — creates a new token:
- First deploy for a tick wins (chain-ordered by block height)
- Tick normalized to lowercase
- Stores: `tick`, `max` (supply cap), `lim` (per-mint limit), `decimals`

**Mint** — credits tokens to an owner:
- Validates tick is deployed
- Validates amount <= `lim` (per-mint limit)
- Validates `totalMinted + amount <= max` (supply cap)
- Credits `ownerScriptHash` balance atomically

**Transfers** — deferred to Phase 2 (requires UTXO graph tracking).

### LevelDB Schema

**tokens sublevel:**

| Key | Value |
|---|---|
| `tick!<TICK>` | `{ max, lim, decimals, totalMinted, deployTxid, deployHeight, deployedAt }` |
| `bal!<TICK>!owner!<scriptHash>` | `{ confirmed: {amt}, pending: {amt}, updatedAt }` |
| `op!<height>!<txid>!<opIndex>` | `{ tick, op, ownerScriptHash, amt, valid, reason? }` |
| `applied!<txid>` | `{ height, blockHash }` (idempotency marker) |

### Atomicity

Every token operation (deploy or mint) is applied as a single LevelDB `batch()`:
- Token record update + balance update + operation log + idempotency marker
- If the process crashes mid-write, the batch either fully applies or doesn't
- On restart, `applied!<txid>` markers prevent duplicate processing

### Chain Ordering

Operation keys use zero-padded heights (`0000890123`) for lexicographic ordering. This ensures deterministic replay — if two deploys compete for the same tick, the one at the lower height wins.

---

## 10. Data Relay Protocol

Ephemeral signed data envelopes — topic-routed, TTL-bounded, broadcast to interested peers via gossip. Fills the gap between BRC-22 (UTXO-based overlay sync) and BRC-33 (point-to-point messaging): broadcast ephemeral signals like rates, attestations, and notifications without on-chain transactions.

### 10.1 Wire Messages

Four new message types added to the existing WebSocket protocol.

#### data (gossip push)

Signed data envelope broadcast to all interested peers.

```json
{
  "type": "data",
  "topic": "oracle:rates:bsv",
  "payload": "{\"USD\":42.50}",
  "pubkeyHex": "02abc...",
  "timestamp": 1710300000,
  "ttl": 300,
  "signature": "3045..."
}
```

**Signature payload:** UTF-8 bytes of `topic + payload + timestamp + ttl` → hex → SHA-256 → ECDSA sign → DER hex.

**Validation:**
1. Verify signature against `pubkeyHex`
2. Check timestamp freshness: not more than 30s in future, not expired (`timestamp + ttl >= now`)
3. Reject if payload > 4 KB or TTL > 3600s
4. Deduplicate by SHA-256 of `pubkeyHex:topic:payload:timestamp`
5. Forward to interested peers (by topic prefix match), excluding source

**Storage:** Bounded in-memory ring buffer per topic (default 100 envelopes, FIFO eviction). Expired envelopes pruned on read.

#### topics (interest declaration)

Peer declares which topic prefixes it wants to receive.

```json
{
  "type": "topics",
  "interests": ["oracle:", "attestation:"],
  "pubkeyHex": "02abc...",
  "timestamp": 1710300000,
  "signature": "3045..."
}
```

**Signature payload:** UTF-8 bytes of `interests.join(',') + timestamp` → hex → SHA-256 → ECDSA sign → DER hex.

**Matching:** String prefix match. Interest `"oracle:"` matches `"oracle:rates:bsv"`, `"oracle:rates:eth"`, etc. Wildcard `"*"` matches all topics.

**Default:** Peers with no declared interests receive no data envelopes. Transaction relay and header sync are unaffected.

#### data_request / data_response (pull-based catch-up)

A peer requests cached envelopes from another peer's local ring buffer. Local query only — not forwarded to other peers.

```json
// Request
{
  "type": "data_request",
  "topic": "oracle:rates:bsv",
  "since": 1710299700,
  "limit": 10
}

// Response
{
  "type": "data_response",
  "topic": "oracle:rates:bsv",
  "envelopes": [ /* array of data envelopes */ ],
  "hasMore": false
}
```

**Ingestion:** Envelopes from `data_response` are validated and stored locally but NOT re-forwarded as gossip. Catch-up is point-to-point.

### 10.2 Constraints

| Parameter | Value |
|---|---|
| Max payload size | 4,096 bytes |
| Max TTL | 3,600 seconds (1 hour) |
| Max future timestamp | 30 seconds |
| Ring buffer default | 100 envelopes per topic |
| Dedup set | Bounded FIFO, default 10,000 entries |
| `limit` range | Clamped to 1–100 |

### 10.3 What Data Envelopes Are NOT

- Not persistent (TTL-bounded, in-memory only)
- Not UTXO-based (no on-chain representation)
- Not addressed (broadcast, not point-to-point)
- Not a transaction submission path (use ARC for that)
- Not a proof service (use Teranode Asset Server)

Payment for data operations via BRC-105 on HTTP endpoints is deferred.

---

## Cryptographic Primitives

All cryptographic operations use the BSV SDK (`@bsv/sdk`):

- **Key format:** secp256k1 compressed public keys (33 bytes)
- **Signing:** ECDSA over SHA-256 hash of data
- **Signature format:** DER-encoded, hex string
- **Address derivation:** P2PKH (Base58Check, version byte 0x00)

```javascript
// Sign
const hash = SHA256(dataBytes)
const sig = privateKey.sign(hash)
const derHex = sig.toDER('hex')

// Verify
const hash = SHA256(dataBytes)
const sig = Signature.fromDER(derHex, 'hex')
const valid = publicKey.verify(hash, sig)
```
