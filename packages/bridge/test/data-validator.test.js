import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { validateHeader, validateTx, validateHeaderChain, DataValidator } from '../lib/data-validator.js'
import { PeerScorer } from '../lib/peer-scorer.js'

const PEER_A = 'aa'.repeat(33)

/**
 * Create a fake raw tx hex and compute its double-SHA256 txid.
 */
function makeTx (data = 'deadbeef01020304050607080910') {
  const rawHex = data
  const hash1 = createHash('sha256').update(Buffer.from(rawHex, 'hex')).digest()
  const hash2 = createHash('sha256').update(hash1).digest()
  const txid = hash2.reverse().toString('hex')
  return { txid, rawHex }
}

describe('validateHeader', () => {
  it('accepts valid header', () => {
    const result = validateHeader({
      height: 100,
      hash: 'aa'.repeat(32),
      prevHash: 'bb'.repeat(32)
    })
    assert.ok(result.valid)
  })

  it('rejects non-object', () => {
    assert.equal(validateHeader(null).valid, false)
    assert.equal(validateHeader('string').valid, false)
  })

  it('rejects negative height', () => {
    assert.equal(validateHeader({ height: -1, hash: 'aa'.repeat(32), prevHash: 'bb'.repeat(32) }).valid, false)
  })

  it('rejects non-hex hash', () => {
    assert.equal(validateHeader({ height: 1, hash: 'zz'.repeat(32), prevHash: 'bb'.repeat(32) }).valid, false)
  })

  it('rejects short hash', () => {
    assert.equal(validateHeader({ height: 1, hash: 'aa'.repeat(16), prevHash: 'bb'.repeat(32) }).valid, false)
  })

  it('rejects invalid prevHash', () => {
    assert.equal(validateHeader({ height: 1, hash: 'aa'.repeat(32), prevHash: 'short' }).valid, false)
  })
})

describe('validateTx', () => {
  it('accepts valid tx with matching txid', () => {
    const { txid, rawHex } = makeTx()
    const result = validateTx(txid, rawHex)
    assert.ok(result.valid, `should be valid, got: ${result.reason}`)
  })

  it('rejects invalid txid format', () => {
    assert.equal(validateTx('short', 'aabb').valid, false)
    assert.equal(validateTx('zz'.repeat(32), 'aabb').valid, false)
  })

  it('rejects too-short rawHex', () => {
    assert.equal(validateTx('aa'.repeat(32), 'aabb').valid, false)
  })

  it('rejects non-hex rawHex', () => {
    assert.equal(validateTx('aa'.repeat(32), 'not_hex_data_here!').valid, false)
  })

  it('rejects txid mismatch', () => {
    const { rawHex } = makeTx()
    const wrongTxid = 'ff'.repeat(32) // doesn't match
    const result = validateTx(wrongTxid, rawHex)
    assert.equal(result.valid, false)
    assert.equal(result.reason, 'txid_mismatch')
  })
})

describe('validateHeaderChain', () => {
  it('accepts empty array', () => {
    assert.ok(validateHeaderChain([]).valid)
  })

  it('accepts single valid header', () => {
    assert.ok(validateHeaderChain([{
      height: 0,
      hash: 'aa'.repeat(32),
      prevHash: '00'.repeat(32)
    }]).valid)
  })

  it('accepts linked chain', () => {
    const chain = [
      { height: 0, hash: 'aa'.repeat(32), prevHash: '00'.repeat(32) },
      { height: 1, hash: 'bb'.repeat(32), prevHash: 'aa'.repeat(32) },
      { height: 2, hash: 'cc'.repeat(32), prevHash: 'bb'.repeat(32) }
    ]
    assert.ok(validateHeaderChain(chain).valid)
  })

  it('rejects broken chain', () => {
    const chain = [
      { height: 0, hash: 'aa'.repeat(32), prevHash: '00'.repeat(32) },
      { height: 1, hash: 'bb'.repeat(32), prevHash: 'ff'.repeat(32) } // wrong prevHash
    ]
    const result = validateHeaderChain(chain)
    assert.equal(result.valid, false)
    assert.ok(result.reason.includes('chain_break'))
    assert.equal(result.invalidAt, 1)
  })

  it('rejects chain with invalid header', () => {
    const chain = [
      { height: 0, hash: 'aa'.repeat(32), prevHash: '00'.repeat(32) },
      { height: -1, hash: 'bb'.repeat(32), prevHash: 'aa'.repeat(32) } // invalid height
    ]
    const result = validateHeaderChain(chain)
    assert.equal(result.valid, false)
    assert.equal(result.invalidAt, 1)
  })
})

describe('DataValidator (integration)', () => {
  function createMockPeerManager () {
    return new EventEmitter()
  }

  it('reports good data for valid headers', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: {
        type: 'headers',
        headers: [
          { height: 0, hash: 'aa'.repeat(32), prevHash: '00'.repeat(32) },
          { height: 1, hash: 'bb'.repeat(32), prevHash: 'aa'.repeat(32) }
        ]
      }
    })

    const m = scorer.getMetrics(PEER_A)
    assert.equal(m.raw.accuracySamples, 2) // 2 good headers
    assert.equal(m.dataAccuracy, 1.0)
  })

  it('reports bad data for invalid header chain', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)
    const failures = []
    validator.on('validation:fail', (e) => failures.push(e))

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: {
        type: 'headers',
        headers: [
          { height: 0, hash: 'aa'.repeat(32), prevHash: '00'.repeat(32) },
          { height: 1, hash: 'bb'.repeat(32), prevHash: 'ff'.repeat(32) } // broken chain
        ]
      }
    })

    const m = scorer.getMetrics(PEER_A)
    assert.equal(m.dataAccuracy, 0.0) // 1 bad data point
    assert.equal(failures.length, 1)
    assert.equal(failures[0].type, 'headers')
  })

  it('reports bad data for empty headers', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: { type: 'headers', headers: [] }
    })

    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 0.0)
  })

  it('reports good data for valid tx', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)

    const { txid, rawHex } = makeTx()

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: { type: 'tx', txid, rawHex }
    })

    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 1.0)
  })

  it('reports bad data for tx with wrong txid', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)
    const failures = []
    validator.on('validation:fail', (e) => failures.push(e))

    const { rawHex } = makeTx()

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: { type: 'tx', txid: 'ff'.repeat(32), rawHex }
    })

    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 0.0)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].reason, 'txid_mismatch')
  })

  it('reports good data for valid header_announce', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: { type: 'header_announce', height: 100, hash: 'aa'.repeat(32) }
    })

    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 1.0)
  })

  it('reports bad data for header_announce with invalid hash', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: { type: 'header_announce', height: 100, hash: 'short' }
    })

    assert.equal(scorer.getMetrics(PEER_A).dataAccuracy, 0.0)
  })

  it('ignores unknown message types', () => {
    const pm = createMockPeerManager()
    const scorer = new PeerScorer()
    const validator = new DataValidator(pm, scorer)

    pm.emit('peer:message', {
      pubkeyHex: PEER_A,
      message: { type: 'hello', pubkey: 'test' }
    })

    assert.equal(scorer.getMetrics(PEER_A), null) // no data recorded
  })
})
