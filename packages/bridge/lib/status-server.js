import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

/**
 * StatusServer — localhost-only HTTP server exposing bridge status.
 *
 * Started by `relay-bridge start`, queried by `relay-bridge status`.
 * Binds to 127.0.0.1 only — not accessible from outside the machine.
 *
 * Endpoints:
 *   GET /       — HTML dashboard (auto-refreshes every 5s)
 *   GET /status — JSON object with bridge state
 */

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay Bridge Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; padding: 24px; }
  h1 { color: #58a6ff; font-size: 20px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 800px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card h2 { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .card.full { grid-column: 1 / -1; }
  .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
  .row .label { color: #8b949e; }
  .row .value { color: #c9d1d9; font-family: monospace; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.green { background: #3fb950; }
  .dot.red { background: #f85149; }
  .dot.yellow { background: #d29922; }
  .peer-row { padding: 6px 0; font-size: 13px; border-bottom: 1px solid #21262d; }
  .peer-row:last-child { border-bottom: none; }
  .mono { font-family: monospace; font-size: 13px; }
  .big { font-size: 28px; font-weight: bold; color: #58a6ff; }
  .updated { color: #484f58; font-size: 11px; margin-top: 16px; text-align: right; }
  .error { color: #f85149; padding: 20px; text-align: center; }
</style>
</head>
<body>
<h1>Relay Bridge Dashboard</h1>
<div id="app" class="error">Loading...</div>
<script>
function fmt(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}
function render(s) {
  const pk = s.bridge.pubkeyHex || '(none)';
  let peers = '';
  if (s.peers.list.length === 0) {
    peers = '<div style="color:#484f58;padding:8px 0">No peers connected</div>';
  } else {
    for (const p of s.peers.list) {
      const dot = p.connected ? 'green' : 'red';
      const tag = p.connected ? 'connected' : 'disconnected';
      const score = p.score !== undefined ? ' score:' + p.score : '';
      const health = p.health && p.health !== 'online' ? ' [' + p.health + ']' : '';
      peers += '<div class="peer-row"><span class="dot ' + dot + '"></span>'
        + '<span class="mono">' + p.pubkeyHex.slice(0, 16) + '...</span> '
        + (p.endpoint || '') + ' <span style="color:#484f58">(' + tag + score + health + ')</span></div>';
    }
  }
  const dot = s.peers.connected > 0 ? 'green' : (s.peers.max > 0 ? 'yellow' : 'red');
  document.getElementById('app').innerHTML =
    '<div class="grid">' +
      '<div class="card">' +
        '<h2>Bridge</h2>' +
        '<div class="row"><span class="label">Pubkey</span><span class="value mono">' + pk.slice(0, 20) + '...</span></div>' +
        '<div class="row"><span class="label">Endpoint</span><span class="value">' + (s.bridge.endpoint || '(not set)') + '</span></div>' +
        '<div class="row"><span class="label">Mesh</span><span class="value">' + (s.bridge.meshId || '(none)') + '</span></div>' +
        '<div class="row"><span class="label">Uptime</span><span class="value">' + fmt(s.bridge.uptimeSeconds) + '</span></div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>Network</h2>' +
        '<div style="text-align:center;padding:8px 0"><span class="dot ' + dot + '"></span><span class="big">' + s.peers.connected + '</span><span style="color:#484f58"> / ' + s.peers.max + ' peers</span></div>' +
        '<div class="row"><span class="label">Headers</span><span class="value">' + s.headers.count + ' stored</span></div>' +
        '<div class="row"><span class="label">Best Height</span><span class="value">' + s.headers.bestHeight + '</span></div>' +
        '<div class="row"><span class="label">Mempool</span><span class="value">' + s.txs.mempool + ' txs</span></div>' +
        '<div class="row"><span class="label">Seen</span><span class="value">' + s.txs.seen + ' txs</span></div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>BSV Node</h2>' +
        '<div class="row"><span class="label">Status</span><span class="value"><span class="dot ' + (s.bsvNode.connected ? 'green' : 'red') + '"></span>' + (s.bsvNode.connected ? 'Connected' : 'Disconnected') + '</span></div>' +
        '<div class="row"><span class="label">Peers</span><span class="value">' + (s.bsvNode.peers || 0) + ' connected</span></div>' +
        '<div class="row"><span class="label">Height</span><span class="value">' + (s.bsvNode.height || '-') + '</span></div>' +
      '</div>' +
      (s.wallet ? '<div class="card">' +
        '<h2>Wallet</h2>' +
        '<div style="text-align:center;padding:8px 0"><span class="big">' + (s.wallet.balanceSats !== null ? s.wallet.balanceSats.toLocaleString() : '-') + '</span><span style="color:#484f58"> sats</span></div>' +
      '</div>' : '') +
      '<div class="card full">' +
        '<h2>Peers (' + s.peers.connected + '/' + s.peers.max + ')</h2>' +
        peers +
      '</div>' +
    '</div>' +
    '<div class="updated">Last updated: ' + new Date().toLocaleTimeString() + ' (refreshes every 5s)</div>';
}
async function poll() {
  try {
    const r = await fetch('/status');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    render(await r.json());
  } catch (e) {
    document.getElementById('app').innerHTML = '<div class="error">Failed to fetch status: ' + e.message + '</div>';
  }
}
poll();
setInterval(poll, 5000);
</script>
</body>
</html>`
export class StatusServer {
  /**
   * @param {object} opts
   * @param {number} [opts.port=9333] — HTTP port for status endpoint
   * @param {import('./peer-manager.js').PeerManager} [opts.peerManager]
   * @param {import('./header-relay.js').HeaderRelay} [opts.headerRelay]
   * @param {import('./tx-relay.js').TxRelay} [opts.txRelay]
   * @param {object} [opts.config] — Bridge config (pubkeyHex, endpoint, meshId)
   * @param {object} [opts.bsvNodeClient] — BSV P2P node client (2.26)
   * @param {object} [opts.store] — PersistentStore for wallet balance (2.27)
   */
  constructor (opts = {}) {
    this._port = opts.port || 9333
    this._peerManager = opts.peerManager || null
    this._headerRelay = opts.headerRelay || null
    this._txRelay = opts.txRelay || null
    this._config = opts.config || {}
    this._scorer = opts.scorer || null
    this._peerHealth = opts.peerHealth || null
    this._bsvNodeClient = opts.bsvNodeClient || null
    this._store = opts.store || null
    this._performOutboundHandshake = opts.performOutboundHandshake || null
    this._registeredPubkeys = opts.registeredPubkeys || null
    this._startedAt = Date.now()
    this._server = null

    // Job system for async actions (register, deregister)
    this._jobs = new Map()
    this._jobCounter = 0

    // Log ring buffer — max 500 entries
    this._logs = []
    this._logListeners = new Set()
    this._maxLogs = 500
  }

  /**
   * Build the status object from current bridge state.
   * @param {object} [opts]
   * @param {boolean} [opts.authenticated=false] — Include operator-only fields
   * @returns {Promise<object>}
   */
  async getStatus ({ authenticated = false } = {}) {
    const peers = []
    if (this._peerManager) {
      for (const [pubkeyHex, conn] of this._peerManager.peers) {
        const entry = {
          pubkeyHex,
          endpoint: conn.endpoint,
          connected: !!conn.connected
        }
        if (this._scorer) {
          entry.score = Math.round(this._scorer.getScore(pubkeyHex) * 100) / 100
          const metrics = this._scorer.getMetrics(pubkeyHex)
          if (metrics) {
            entry.scoreBreakdown = {
              uptime: Math.round(metrics.uptime * 100) / 100,
              responseTime: Math.round(metrics.responseTime * 100) / 100,
              dataAccuracy: Math.round(metrics.dataAccuracy * 100) / 100,
              stakeAge: Math.round(metrics.stakeAge * 100) / 100,
              raw: metrics.raw
            }
          }
        }
        if (this._peerHealth) {
          entry.health = this._peerHealth.getStatus(pubkeyHex)
        }
        peers.push(entry)
      }
    }

    const status = {
      bridge: {
        pubkeyHex: this._config.pubkeyHex || null,
        endpoint: this._config.endpoint || null,
        meshId: this._config.meshId || null,
        uptimeSeconds: Math.floor((Date.now() - this._startedAt) / 1000)
      },
      peers: {
        connected: this._peerManager ? this._peerManager.connectedCount() : 0,
        max: this._peerManager ? this._peerManager.maxPeers : 0,
        list: peers
      },
      headers: {
        bestHeight: this._headerRelay ? this._headerRelay.bestHeight : -1,
        bestHash: this._headerRelay ? this._headerRelay.bestHash : null,
        count: this._headerRelay ? this._headerRelay.headers.size : 0
      },
      txs: {
        mempool: this._txRelay ? this._txRelay.mempool.size : 0,
        seen: this._txRelay ? this._txRelay.seen.size : 0
      },
      bsvNode: {
        connected: this._bsvNodeClient ? this._bsvNodeClient.connectedCount > 0 : false,
        peers: this._bsvNodeClient ? this._bsvNodeClient.connectedCount : 0,
        height: this._bsvNodeClient ? this._bsvNodeClient.bestHeight : null
      }
    }

    // Operator-only fields
    if (authenticated) {
      status.operator = true
      status.bridge.address = this._config.address || null
      status.wallet = { balanceSats: null, utxoCount: 0 }
      if (this._store) {
        try { status.wallet.balanceSats = await this._store.getBalance() } catch {}
        try { status.wallet.utxoCount = (await this._store.getUnspentUtxos()).length } catch {}
      }
    }

    return status
  }

  /**
   * Check if a request is authenticated via statusSecret.
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  _checkAuth (req) {
    const secret = this._config.statusSecret
    if (!secret) return false

    // Check ?auth= query param
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const authParam = url.searchParams.get('auth')
    if (authParam === secret) return true

    // Check Authorization: Bearer header
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7) === secret) return true

    return false
  }

  /**
   * Add a log entry to the ring buffer and notify SSE listeners.
   * @param {string} message
   */
  addLog (message) {
    const entry = { timestamp: Date.now(), message }
    this._logs.push(entry)
    if (this._logs.length > this._maxLogs) {
      this._logs.shift()
    }
    // Notify SSE listeners
    for (const listener of this._logListeners) {
      listener(entry)
    }
  }

  /**
   * Create a job for tracking async actions.
   * @returns {{ jobId: string, log: function }}
   */
  _createJob () {
    const jobId = `job_${++this._jobCounter}_${Date.now()}`
    const job = { status: 'running', events: [], done: false, listeners: new Set() }
    this._jobs.set(jobId, job)

    // Auto-cleanup after 5 minutes
    setTimeout(() => this._jobs.delete(jobId), 5 * 60 * 1000)

    const log = (type, message, data) => {
      const event = { type, message, data, timestamp: Date.now() }
      job.events.push(event)
      if (type === 'done' || type === 'error') {
        job.status = type === 'error' ? 'failed' : 'completed'
        job.done = true
      }
      // Notify SSE listeners
      for (const listener of job.listeners) {
        listener(event)
      }
    }

    return { jobId, log }
  }

  /**
   * Read the full JSON body from a request.
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<object>}
   */
  _readBody (req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })
  }

  /**
   * Start the HTTP server on localhost.
   * @returns {Promise<void>}
   */
  start () {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => {
        // CORS headers for federation dashboard
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        this._handleRequest(req, res).catch(() => {
          res.writeHead(500)
          res.end('Internal Server Error')
        })
      })

      this._server.listen(this._port, '0.0.0.0', () => resolve())
      this._server.on('error', reject)
    })
  }

  /**
   * Route incoming HTTP requests.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handleRequest (req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const authenticated = this._checkAuth(req)

    // GET /status — public or operator status
    if (req.method === 'GET' && path === '/status') {
      const status = await this.getStatus({ authenticated })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    // GET / or /dashboard — built-in HTML dashboard
    if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(DASHBOARD_HTML)
      return
    }

    // POST /broadcast — relay a raw tx to peers
    if (req.method === 'POST' && path === '/broadcast') {
      const body = await this._readBody(req)
      const { rawHex } = body
      if (!rawHex || typeof rawHex !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawHex required' }))
        return
      }
      const buf = Buffer.from(rawHex, 'hex')
      const hash = createHash('sha256').update(createHash('sha256').update(buf).digest()).digest()
      const txid = Buffer.from(hash).reverse().toString('hex')
      const sent = this._txRelay ? this._txRelay.broadcastTx(txid, rawHex) : 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, peers: sent }))
      return
    }

    // POST /register — operator: start async registration
    if (req.method === 'POST' && path === '/register') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runRegister } = await import('./actions.js')
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      // Run async — don't await
      runRegister({ config: this._config, store: this._store, log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // POST /deregister — operator: start async deregistration
    if (req.method === 'POST' && path === '/deregister') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runDeregister } = await import('./actions.js')
      const body = await this._readBody(req)
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      runDeregister({ config: this._config, store: this._store, reason: body.reason || 'shutdown', log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // POST /fund — operator: store a funding tx (synchronous)
    if (req.method === 'POST' && path === '/fund') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runFund } = await import('./actions.js')
      const body = await this._readBody(req)
      if (!body.rawHex) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawHex required' }))
        return
      }
      try {
        const result = await runFund({ config: this._config, store: this._store, rawHex: body.rawHex, log: () => {} })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // POST /connect — operator: connect to a peer endpoint
    if (req.method === 'POST' && path === '/connect') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const body = await this._readBody(req)
      if (!body.endpoint) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'endpoint required (e.g. ws://host:port)' }))
        return
      }
      if (!this._peerManager || !this._performOutboundHandshake) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bridge not running — peer manager unavailable' }))
        return
      }
      try {
        const conn = this._peerManager.connectToPeer({ endpoint: body.endpoint })
        if (conn) {
          conn.on('open', () => this._performOutboundHandshake(conn))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ endpoint: body.endpoint, status: 'connecting' }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ endpoint: body.endpoint, status: 'already_connected_or_failed' }))
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /jobs/:id — SSE stream for job progress
    if (req.method === 'GET' && path.startsWith('/jobs/')) {
      const jobId = path.slice(6)
      const job = this._jobs.get(jobId)
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Job not found' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // Replay past events
      for (const event of job.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      if (job.done) {
        res.write(`data: ${JSON.stringify({ type: 'end', status: job.status })}\n\n`)
        res.end()
        return
      }
      // Stream new events
      const listener = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
        if (event.type === 'done' || event.type === 'error') {
          res.write(`data: ${JSON.stringify({ type: 'end', status: event.type === 'error' ? 'failed' : 'completed' })}\n\n`)
          res.end()
          job.listeners.delete(listener)
        }
      }
      job.listeners.add(listener)
      req.on('close', () => job.listeners.delete(listener))
      return
    }

    // GET /logs — SSE stream of live bridge logs
    if (req.method === 'GET' && path === '/logs') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // Replay buffer
      for (const entry of this._logs) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
      // Stream new
      const listener = (entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
      this._logListeners.add(listener)
      req.on('close', () => this._logListeners.delete(listener))
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }

  /**
   * Stop the HTTP server.
   * @returns {Promise<void>}
   */
  stop () {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => resolve())
        this._server = null
      } else {
        resolve()
      }
    })
  }

  /**
   * Get the port this server is configured to use.
   * @returns {number}
   */
  get port () {
    return this._port
  }
}
