import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { PeerConnection } from './peer-connection.js'

/**
 * PeerManager — manages multiple peer connections.
 *
 * Handles:
 * - Outbound connections to discovered peers
 * - Inbound connections from other bridges (via WSS server)
 * - Broadcasting messages to all connected peers
 * - Peer lifecycle (connect, disconnect, reconnect)
 *
 * Events:
 *   'peer:connect'    — { pubkeyHex, endpoint }
 *   'peer:disconnect' — { pubkeyHex, endpoint }
 *   'peer:message'    — { pubkeyHex, message }
 *   'peer:error'      — { pubkeyHex, error }
 */
export class PeerManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPeers=20] - Maximum number of peer connections
   */
  constructor (opts = {}) {
    super()
    this.maxPeers = opts.maxPeers || 20
    /** @type {Map<string, PeerConnection>} pubkeyHex → PeerConnection */
    this.peers = new Map()
    this._server = null
  }

  /**
   * Connect to a discovered peer (outbound).
   *
   * @param {object} peer - Peer from buildPeerList()
   * @param {string} peer.pubkeyHex
   * @param {string} peer.endpoint
   * @returns {PeerConnection|null} The connection, or null if at capacity
   */
  connectToPeer (peer) {
    if (this.peers.has(peer.pubkeyHex)) {
      return this.peers.get(peer.pubkeyHex)
    }

    if (this.peers.size >= this.maxPeers) {
      return null
    }

    const conn = new PeerConnection({
      endpoint: peer.endpoint,
      pubkeyHex: peer.pubkeyHex
    })

    this._attachPeerEvents(conn)
    this.peers.set(peer.pubkeyHex, conn)
    conn.connect()

    return conn
  }

  /**
   * Accept an inbound peer connection.
   *
   * @param {WebSocket} socket - Incoming WebSocket
   * @param {string} pubkeyHex - Peer's pubkey (from handshake)
   * @param {string} endpoint - Peer's advertised endpoint
   * @returns {PeerConnection|null}
   */
  acceptPeer (socket, pubkeyHex, endpoint) {
    if (this.peers.has(pubkeyHex)) {
      // Already connected — close the duplicate
      socket.close()
      return this.peers.get(pubkeyHex)
    }

    if (this.peers.size >= this.maxPeers) {
      socket.close()
      return null
    }

    const conn = new PeerConnection({
      endpoint,
      pubkeyHex,
      socket
    })

    this._attachPeerEvents(conn)
    this.peers.set(pubkeyHex, conn)

    return conn
  }

  /**
   * Disconnect a specific peer.
   *
   * @param {string} pubkeyHex
   */
  disconnectPeer (pubkeyHex) {
    const conn = this.peers.get(pubkeyHex)
    if (conn) {
      conn.destroy()
      this.peers.delete(pubkeyHex)
    }
  }

  /**
   * Broadcast a message to all connected peers.
   *
   * @param {object} msg - JSON message with `type` field
   * @param {string} [excludePubkey] - Optional pubkey to exclude (e.g. message source)
   * @returns {number} Number of peers the message was sent to
   */
  broadcast (msg, excludePubkey) {
    let sent = 0
    for (const [pubkeyHex, conn] of this.peers) {
      if (pubkeyHex === excludePubkey) continue
      if (conn.send(msg)) sent++
    }
    return sent
  }

  /**
   * Get count of currently connected peers.
   * @returns {number}
   */
  connectedCount () {
    let count = 0
    for (const conn of this.peers.values()) {
      if (conn.connected) count++
    }
    return count
  }

  /**
   * Start a WebSocket server for inbound connections.
   *
   * @param {object} opts
   * @param {number} opts.port - Port to listen on
   * @param {string} [opts.host='0.0.0.0'] - Host to bind to
   * @returns {Promise<void>}
   */
  startServer (opts) {
    return new Promise((resolve, reject) => {
      this._server = new WebSocketServer({
        port: opts.port,
        host: opts.host || '0.0.0.0'
      })

      this._server.on('listening', () => resolve())
      this._server.on('error', (err) => reject(err))

      this._server.on('connection', (ws) => {
        // Inbound connections need to identify themselves via handshake.
        // For now, we hold the socket and wait for a 'hello' message.
        const timeout = setTimeout(() => {
          ws.close() // No hello within 10 seconds
        }, 10000)

        ws.once('message', (data) => {
          clearTimeout(timeout)
          try {
            const msg = JSON.parse(data.toString())
            if (msg.type === 'hello' && msg.pubkey && msg.endpoint) {
              const conn = this.acceptPeer(ws, msg.pubkey, msg.endpoint)
              if (conn) {
                // Send our identity back so the client knows who we are
                if (opts.pubkeyHex && opts.endpoint) {
                  ws.send(JSON.stringify({
                    type: 'hello',
                    pubkey: opts.pubkeyHex,
                    endpoint: opts.endpoint
                  }))
                }
                this.emit('peer:connect', { pubkeyHex: msg.pubkey, endpoint: msg.endpoint })
                // Forward the hello as a regular message too
                conn.emit('message', msg)
              }
            } else {
              ws.close() // Invalid hello
            }
          } catch {
            ws.close() // Invalid JSON
          }
        })
      })
    })
  }

  /**
   * Stop the WebSocket server and disconnect all peers.
   */
  async shutdown () {
    for (const [pubkeyHex, conn] of this.peers) {
      conn.destroy()
    }
    this.peers.clear()

    if (this._server) {
      await new Promise(resolve => this._server.close(resolve))
      this._server = null
    }
  }

  _attachPeerEvents (conn) {
    conn.on('open', () => {
      this.emit('peer:connect', { pubkeyHex: conn.pubkeyHex, endpoint: conn.endpoint })
    })

    conn.on('message', (msg) => {
      this.emit('peer:message', { pubkeyHex: conn.pubkeyHex, message: msg })
    })

    conn.on('close', () => {
      this.peers.delete(conn.pubkeyHex)
      this.emit('peer:disconnect', { pubkeyHex: conn.pubkeyHex, endpoint: conn.endpoint })
    })

    conn.on('error', (err) => {
      this.emit('peer:error', { pubkeyHex: conn.pubkeyHex, error: err })
    })
  }
}
