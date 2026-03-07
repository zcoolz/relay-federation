import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BSVPeer } from '../lib/bsv-peer.js'
import { BSVNodeClient } from '../lib/bsv-node-client.js'

// Re-implement helpers for testing (they're not exported)
function sha256d (data) {
  const h1 = createHash('sha256').update(data).digest()
  return createHash('sha256').update(h1).digest()
}

function reverseBuffer (buf) {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[buf.length - 1 - i]
  }
  return out
}

function internalToHash (buf) {
  return reverseBuffer(buf).toString('hex')
}

function hashToInternal (hexStr) {
  return reverseBuffer(Buffer.from(hexStr, 'hex'))
}

// Build a P2P message with proper framing
function buildMessage (command, payload) {
  const magic = Buffer.from('e3e1f3e8', 'hex')
  const header = Buffer.alloc(24)
  magic.copy(header, 0)
  const cmdBuf = Buffer.alloc(12)
  cmdBuf.write(command, 'ascii')
  cmdBuf.copy(header, 4)
  header.writeUInt32LE(payload.length, 16)
  const checksum = sha256d(payload).subarray(0, 4)
  checksum.copy(header, 20)
  return Buffer.concat([header, payload])
}

// Build a minimal version message
function buildVersionPayload (startHeight = 939000) {
  const payload = Buffer.alloc(86)
  let offset = 0
  payload.writeInt32LE(70016, offset); offset += 4 // version
  payload.writeBigUInt64LE(1n, offset); offset += 8 // services
  payload.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), offset); offset += 8 // timestamp
  // addr_recv (26 bytes)
  offset += 26
  // addr_from (26 bytes)
  offset += 26
  // nonce (8 bytes)
  offset += 8
  // user agent length (0)
  payload[offset] = 0; offset += 1
  // start height
  payload.writeInt32LE(startHeight, offset); offset += 4
  // relay
  payload[offset] = 0
  return payload
}

// Build a fake 80-byte header
function buildRawHeader (prevHashHex, timestamp = 1700000000, version = 0x20000000) {
  const header = Buffer.alloc(80)
  let offset = 0
  header.writeInt32LE(version, offset); offset += 4
  // prevHash in internal byte order
  hashToInternal(prevHashHex).copy(header, offset); offset += 32
  // merkle root (random)
  Buffer.alloc(32, 0xab).copy(header, offset); offset += 32
  // timestamp
  header.writeUInt32LE(timestamp, offset); offset += 4
  // bits
  header.writeUInt32LE(0x18234bb9, offset); offset += 4
  // nonce
  header.writeUInt32LE(12345, offset)
  return header
}

// Build a headers response payload
function buildHeadersPayload (rawHeaders) {
  const parts = [Buffer.from([rawHeaders.length])]
  for (const raw of rawHeaders) {
    parts.push(raw)
    parts.push(Buffer.from([0])) // tx_count = 0
  }
  return Buffer.concat(parts)
}

// ── BSVPeer Protocol Tests ───────────────────────────────────

describe('BSVPeer', () => {
  let peer

  afterEach(() => {
    if (peer) peer.disconnect()
  })

  it('initializes with default checkpoint', () => {
    peer = new BSVPeer()
    assert.equal(peer.bestHeight, 930000)
    assert.equal(peer.bestHash, '00000000000000001c2e04e4375cfa4b46588aa27795b2c7f8d4d34cb568a382')
  })

  it('initializes with custom checkpoint', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: 'aabbcc', prevHash: '112233' }
    })
    assert.equal(peer.bestHeight, 100)
    assert.equal(peer.bestHash, 'aabbcc')
  })

  it('seedHeader updates best height', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: 'aabbcc', prevHash: '112233' }
    })
    peer.seedHeader(200, 'ddeeff')
    assert.equal(peer.bestHeight, 200)
    assert.equal(peer.bestHash, 'ddeeff')
  })

  it('seedHeader does not lower best height', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: 'aabbcc', prevHash: '112233' }
    })
    peer.seedHeader(50, '001122')
    assert.equal(peer.bestHeight, 100)
  })

  it('parses version message and emits handshake after verack', async () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '00'.repeat(32) }
    })

    peer._connected = true
    peer._socket = { write: () => {}, destroy: () => {} }

    const handshakePromise = new Promise(resolve => {
      peer.once('handshake', resolve)
    })

    const versionPayload = buildVersionPayload(939000)
    const versionMsg = buildMessage('version', versionPayload)
    peer._onData(versionMsg)

    const verackMsg = buildMessage('verack', Buffer.alloc(0))
    peer._onData(verackMsg)

    const info = await handshakePromise
    assert.equal(info.version, 70016)
    assert.equal(info.startHeight, 939000)
  })

  it('sends protoconf after verack', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '00'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    // Feed version + verack
    peer._onData(buildMessage('version', buildVersionPayload()))
    peer._onData(buildMessage('verack', Buffer.alloc(0)))

    // Should have sent: verack, protoconf, getheaders (from syncHeaders)
    const commands = sent.map(d => d.subarray(4, 16).toString('ascii').replace(/\0/g, ''))
    assert.ok(commands.includes('verack'), 'should send verack')
    assert.ok(commands.includes('protoconf'), 'should send protoconf')
    assert.ok(commands.includes('getheaders'), 'should start header sync')
  })

  it('parses headers response and emits headers event', async () => {
    const checkpointHash = '00'.repeat(32)
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: checkpointHash, prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = { write: () => {}, destroy: () => {} }

    const raw1 = buildRawHeader(checkpointHash, 1700000001)
    const hash1 = internalToHash(sha256d(raw1))
    const raw2 = buildRawHeader(hash1, 1700000002)
    const hash2 = internalToHash(sha256d(raw2))
    const raw3 = buildRawHeader(hash2, 1700000003)
    const hash3 = internalToHash(sha256d(raw3))

    const headersPayload = buildHeadersPayload([raw1, raw2, raw3])
    const headersMsg = buildMessage('headers', headersPayload)

    const headersPromise = new Promise(resolve => {
      peer.once('headers', resolve)
    })

    peer._onData(headersMsg)

    const result = await headersPromise
    assert.equal(result.count, 3)
    assert.equal(result.headers[0].height, 101)
    assert.equal(result.headers[0].prevHash, checkpointHash)
    assert.equal(result.headers[0].hash, hash1)
    assert.equal(result.headers[1].height, 102)
    assert.equal(result.headers[1].hash, hash2)
    assert.equal(result.headers[2].height, 103)
    assert.equal(result.headers[2].hash, hash3)

    assert.equal(peer.bestHeight, 103)
    assert.equal(peer.bestHash, hash3)
  })

  it('handles split TCP packets', async () => {
    const checkpointHash = '00'.repeat(32)
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: checkpointHash, prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = { write: () => {}, destroy: () => {} }

    const raw1 = buildRawHeader(checkpointHash, 1700000001)
    const headersPayload = buildHeadersPayload([raw1])
    const fullMsg = buildMessage('headers', headersPayload)

    const headersPromise = new Promise(resolve => {
      peer.once('headers', resolve)
    })

    const mid = Math.floor(fullMsg.length / 2)
    peer._onData(fullMsg.subarray(0, mid))
    peer._onData(fullMsg.subarray(mid))

    const result = await headersPromise
    assert.equal(result.count, 1)
    assert.equal(result.headers[0].height, 101)
  })

  it('rejects messages with bad checksum', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._socket = { write: () => {}, destroy: () => {} }

    let gotHeaders = false
    peer.on('headers', () => { gotHeaders = true })

    const raw = buildRawHeader('00'.repeat(32))
    const payload = buildHeadersPayload([raw])
    const msg = buildMessage('headers', payload)
    msg[20] = 0xff
    msg[21] = 0xff

    peer._onData(msg)
    assert.equal(gotHeaders, false)
  })

  it('responds to ping with pong', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const nonce = Buffer.from('0102030405060708', 'hex')
    const pingMsg = buildMessage('ping', nonce)
    peer._onData(pingMsg)

    assert.ok(sent.length > 0)
    const pongData = sent[0]
    const pongCmd = pongData.subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(pongCmd, 'pong')
    const pongPayload = pongData.subarray(24)
    assert.ok(pongPayload.equals(nonce))
  })

  it('triggers sync on block inv', async () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const invPayload = Buffer.alloc(37)
    invPayload[0] = 1
    invPayload.writeUInt32LE(2, 1) // type = MSG_BLOCK

    const invMsg = buildMessage('inv', invPayload)
    peer._onData(invMsg)

    assert.ok(sent.length > 0)
    const cmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(cmd, 'getheaders')
  })

  it('block locator includes checkpoint', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: 'checkpoint_hash', prevHash: 'prev_hash' }
    })

    const locator = peer._buildBlockLocator()
    assert.ok(locator.includes('checkpoint_hash'))
  })

  it('block locator uses exponential backoff', () => {
    peer = new BSVPeer({
      checkpoint: { height: 0, hash: 'genesis', prevHash: '' }
    })

    for (let i = 1; i <= 100; i++) {
      peer.seedHeader(i, `hash_${i}`)
    }

    const locator = peer._buildBlockLocator()
    assert.equal(locator[0], 'hash_100')
    assert.equal(locator[locator.length - 1], 'genesis')
    assert.ok(locator.length < 30)
  })

  it('handles empty headers response', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = { write: () => {}, destroy: () => {} }
    peer._syncing = true

    let gotHeaders = false
    peer.on('headers', () => { gotHeaders = true })

    const emptyPayload = Buffer.from([0])
    const msg = buildMessage('headers', emptyPayload)
    peer._onData(msg)

    assert.equal(gotHeaders, false)
    assert.equal(peer._syncing, false)
  })

  it('disconnect stops timers and sets destroyed', () => {
    peer = new BSVPeer()
    peer._syncTimer = setInterval(() => {}, 10000)
    peer._pingTimer = setInterval(() => {}, 10000)

    peer.disconnect()
    assert.equal(peer._destroyed, true)
    assert.equal(peer._connected, false)
  })

  // ── Transaction Tests ──────────────────────────────────────

  it('getTx rejects when not connected', async () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })
    await assert.rejects(
      () => peer.getTx('aa'.repeat(32)),
      { message: 'not connected to BSV node' }
    )
  })

  it('getTx sends getdata MSG_TX and resolves on tx response', async () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const fakeTxBytes = Buffer.from('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0704ffff001d0104ffffffff0100f2052a0100000043410496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858eeac00000000', 'hex')
    const expectedTxid = internalToHash(sha256d(fakeTxBytes))

    const txPromise = peer.getTx(expectedTxid)

    assert.ok(sent.length > 0)
    const getdataCmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(getdataCmd, 'getdata')

    const getdataPayload = sent[0].subarray(24)
    assert.equal(getdataPayload[0], 1)
    assert.equal(getdataPayload.readUInt32LE(1), 1)
    const requestedHash = internalToHash(getdataPayload.subarray(5, 37))
    assert.equal(requestedHash, expectedTxid)

    const txMsg = buildMessage('tx', fakeTxBytes)
    peer._onData(txMsg)

    const result = await txPromise
    assert.equal(result.txid, expectedTxid)
    assert.equal(result.rawHex, fakeTxBytes.toString('hex'))
  })

  it('getTx rejects on timeout', async () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: () => {},
      destroy: () => {}
    }

    await assert.rejects(
      () => peer.getTx('bb'.repeat(32), 50),
      { message: /timeout fetching tx/ }
    )

    assert.equal(peer._pendingTxRequests.size, 0)
  })

  it('getTx rejects on notfound response', async () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: () => {},
      destroy: () => {}
    }

    const txid = 'cc'.repeat(32)
    const txPromise = peer.getTx(txid)

    const notfoundPayload = Buffer.alloc(37)
    notfoundPayload[0] = 1
    notfoundPayload.writeUInt32LE(1, 1)
    hashToInternal(txid).copy(notfoundPayload, 5)
    const notfoundMsg = buildMessage('notfound', notfoundPayload)
    peer._onData(notfoundMsg)

    await assert.rejects(
      () => txPromise,
      { message: /tx not found/ }
    )

    assert.equal(peer._pendingTxRequests.size, 0)
  })

  it('getTx rejects duplicate request for same txid', async () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: () => {},
      destroy: () => {}
    }

    const txid = 'dd'.repeat(32)
    const p1 = peer.getTx(txid, 200)
    await assert.rejects(
      () => peer.getTx(txid),
      { message: /already fetching tx/ }
    )

    await assert.rejects(() => p1, { message: /timeout/ })
  })

  it('_onTx emits tx event for unsolicited transactions', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = { write: () => {}, destroy: () => {} }

    const fakeTxBytes = Buffer.alloc(64, 0xab)
    const expectedTxid = internalToHash(sha256d(fakeTxBytes))

    let emittedTx = null
    peer.on('tx', (tx) => { emittedTx = tx })

    const txMsg = buildMessage('tx', fakeTxBytes)
    peer._onData(txMsg)

    assert.ok(emittedTx)
    assert.equal(emittedTx.txid, expectedTxid)
    assert.equal(emittedTx.rawHex, fakeTxBytes.toString('hex'))
  })

  it('broadcastTx sends inv message (not raw tx) and returns txid', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const fakeTxHex = Buffer.alloc(64, 0xcd).toString('hex')
    const expectedTxid = internalToHash(sha256d(Buffer.from(fakeTxHex, 'hex')))

    const txid = peer.broadcastTx(fakeTxHex)

    assert.equal(txid, expectedTxid)

    // Should have sent an inv message (correct protocol), NOT a raw tx
    assert.ok(sent.length > 0)
    const invCmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(invCmd, 'inv', 'should send inv, not raw tx')

    // Parse inv payload: [varint count=1] [type=1 MSG_TX] [hash 32B internal]
    const invPayload = sent[0].subarray(24)
    assert.equal(invPayload[0], 1) // count = 1
    assert.equal(invPayload.readUInt32LE(1), 1) // MSG_TX
    const announcedHash = internalToHash(invPayload.subarray(5, 37))
    assert.equal(announcedHash, expectedTxid)

    // Should be cached in _pendingBroadcasts for serving getdata
    assert.equal(peer._pendingBroadcasts.get(txid), fakeTxHex)
  })

  it('_onGetdata serves cached tx from _pendingBroadcasts', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const fakeTxHex = Buffer.alloc(32, 0xef).toString('hex')
    const txid = peer.broadcastTx(fakeTxHex)
    sent.length = 0 // clear (the inv message)

    // Build getdata request for that txid
    const getdataPayload = Buffer.alloc(37)
    getdataPayload[0] = 1
    getdataPayload.writeUInt32LE(1, 1) // MSG_TX
    hashToInternal(txid).copy(getdataPayload, 5)
    const getdataMsg = buildMessage('getdata', getdataPayload)
    peer._onData(getdataMsg)

    // Should have responded with the cached tx
    assert.ok(sent.length > 0)
    const respCmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(respCmd, 'tx')
    const respPayload = sent[0].subarray(24)
    assert.equal(respPayload.toString('hex'), fakeTxHex)
  })

  it('_onGetdata ignores unknown txids', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const getdataPayload = Buffer.alloc(37)
    getdataPayload[0] = 1
    getdataPayload.writeUInt32LE(1, 1)
    Buffer.alloc(32, 0xff).copy(getdataPayload, 5)
    const getdataMsg = buildMessage('getdata', getdataPayload)
    peer._onData(getdataMsg)

    assert.equal(sent.length, 0)
  })

  it('_onInv emits tx:inv for MSG_TX inventory', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = { write: () => {}, destroy: () => {} }

    let emittedInv = null
    peer.on('tx:inv', (inv) => { emittedInv = inv })

    const invPayload = Buffer.alloc(1 + 36 * 2)
    invPayload[0] = 2
    invPayload.writeUInt32LE(1, 1) // MSG_TX
    hashToInternal('aa'.repeat(32)).copy(invPayload, 5)
    invPayload.writeUInt32LE(1, 37) // MSG_TX
    hashToInternal('bb'.repeat(32)).copy(invPayload, 41)

    const invMsg = buildMessage('inv', invPayload)
    peer._onData(invMsg)

    assert.ok(emittedInv)
    assert.equal(emittedInv.txids.length, 2)
    assert.equal(emittedInv.txids[0], 'aa'.repeat(32))
    assert.equal(emittedInv.txids[1], 'bb'.repeat(32))
  })

  it('_onInv handles mixed block and tx inventory', () => {
    peer = new BSVPeer({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    peer._connected = true
    peer._handshakeComplete = true
    peer._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    let emittedInv = null
    peer.on('tx:inv', (inv) => { emittedInv = inv })

    const invPayload = Buffer.alloc(1 + 36 * 2)
    invPayload[0] = 2
    invPayload.writeUInt32LE(2, 1) // MSG_BLOCK
    Buffer.alloc(32, 0x11).copy(invPayload, 5)
    invPayload.writeUInt32LE(1, 37) // MSG_TX
    hashToInternal('ee'.repeat(32)).copy(invPayload, 41)

    const invMsg = buildMessage('inv', invPayload)
    peer._onData(invMsg)

    assert.ok(sent.length > 0)
    const cmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(cmd, 'getheaders')

    assert.ok(emittedInv)
    assert.equal(emittedInv.txids.length, 1)
    assert.equal(emittedInv.txids[0], 'ee'.repeat(32))
  })
})

// ── BSVNodeClient Pool Tests ─────────────────────────────────

describe('BSVNodeClient (pool)', () => {
  it('initializes with default checkpoint', () => {
    const client = new BSVNodeClient()
    assert.equal(client.bestHeight, 930000)
    assert.equal(client.connectedCount, 0)
    assert.deepEqual(client.peerList, [])
    client.disconnect()
  })

  it('initializes with custom options', () => {
    const client = new BSVNodeClient({
      maxPeers: 4,
      checkpoint: { height: 100, hash: 'aabb', prevHash: '1122' }
    })
    assert.equal(client.bestHeight, 100)
    assert.equal(client._maxPeers, 4)
    client.disconnect()
  })

  it('seedHeader updates best height', () => {
    const client = new BSVNodeClient({
      checkpoint: { height: 100, hash: 'aabb', prevHash: '1122' }
    })
    client.seedHeader(200, 'ccdd')
    assert.equal(client.bestHeight, 200)
    assert.equal(client.bestHash, 'ccdd')
    client.disconnect()
  })

  it('getTx rejects when no peers connected', async () => {
    const client = new BSVNodeClient()
    await assert.rejects(
      () => client.getTx('aa'.repeat(32)),
      { message: 'not connected to BSV node' }
    )
    client.disconnect()
  })

  it('broadcastTx returns null when no peers connected', () => {
    const client = new BSVNodeClient()
    const txid = client.broadcastTx('aabb')
    assert.equal(txid, null)
    client.disconnect()
  })

  it('disconnect is idempotent', () => {
    const client = new BSVNodeClient()
    client.disconnect()
    client.disconnect()
    assert.equal(client._destroyed, true)
  })

  it('connectedCount tracks handshaked peers', () => {
    const client = new BSVNodeClient()
    // Manually add mock peers
    const fakePeer1 = { _connected: true, _handshakeComplete: true, _bestHeight: 100, _peerUserAgent: 'test', disconnect: () => {} }
    const fakePeer2 = { _connected: true, _handshakeComplete: false, _bestHeight: 0, _peerUserAgent: '', disconnect: () => {} }
    client._peers.set('1.2.3.4', fakePeer1)
    client._peers.set('5.6.7.8', fakePeer2)
    assert.equal(client.connectedCount, 1) // only peer1 has handshake
    assert.equal(client.peerList.length, 2) // both in list
    client._peers.clear()
    client.disconnect()
  })
})
