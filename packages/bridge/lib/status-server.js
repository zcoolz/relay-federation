import { createServer } from 'node:http'

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
      peers += '<div class="peer-row"><span class="dot ' + dot + '"></span>'
        + '<span class="mono">' + p.pubkeyHex.slice(0, 16) + '...</span> '
        + (p.endpoint || '') + ' <span style="color:#484f58">(' + tag + ')</span></div>';
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
   */
  constructor (opts = {}) {
    this._port = opts.port || 9333
    this._peerManager = opts.peerManager || null
    this._headerRelay = opts.headerRelay || null
    this._txRelay = opts.txRelay || null
    this._config = opts.config || {}
    this._startedAt = Date.now()
    this._server = null
  }

  /**
   * Build the status object from current bridge state.
   * @returns {object}
   */
  getStatus () {
    const peers = []
    if (this._peerManager) {
      for (const [pubkeyHex, conn] of this._peerManager.peers) {
        peers.push({
          pubkeyHex,
          endpoint: conn.endpoint,
          connected: !!conn.connected
        })
      }
    }

    return {
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
      }
    }
  }

  /**
   * Start the HTTP server on localhost.
   * @returns {Promise<void>}
   */
  start () {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/status') {
          const status = this.getStatus()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(status))
        } else if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(DASHBOARD_HTML)
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      this._server.listen(this._port, '127.0.0.1', () => resolve())
      this._server.on('error', reject)
    })
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
