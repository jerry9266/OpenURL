const express = require('express');
const { chromium } = require('playwright');
const archiver = require('archiver');
const mime = require('mime-types');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Hardcoded target URL (cannot be modified by client requests)
const TARGET_URL = 'https://wideshares.org/download/eb8819076e60';

// In-memory cache of the latest inspection session
let latestInspection = {
  timestamp: null,
  targetUrl: TARGET_URL,
  originalHtml: '',
  renderedHtml: '',
  resources: [], // Array of resource objects
  networkLog: [], // Serializable array for network-log.json
  error: null
};

app.use(express.json());

// Helper to determine clean file extensions & paths for the ZIP
function sanitizeFilename(urlString, fallbackExt = 'bin') {
  try {
    const parsed = new URL(urlString);
    let pathname = parsed.pathname;
    let base = path.basename(pathname);
    if (!base || base === '/' || base.includes('?') || !base.includes('.')) {
      const hash = crypto.createHash('md5').update(urlString).digest('hex').slice(0, 8);
      base = `resource_${hash}.${fallbackExt}`;
    }
    return base.replace(/[^a-zA-Z0-9._-]/g, '_');
  } catch {
    const hash = crypto.createHash('md5').update(urlString).digest('hex').slice(0, 8);
    return `resource_${hash}.${fallbackExt}`;
  }
}

/**
 * Executes Playwright to load the target URL and collect all network events & source.
 */
async function runInspection() {
  let browser = null;
  const capturedResources = [];
  const networkLog = [];
  let originalHtml = '';
  let renderedHtml = '';

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    // Listen to network responses
    page.on('response', async (response) => {
      const request = response.request();
      const url = response.url();
      const method = request.method();
      const status = response.status();
      const headers = response.headers();
      const contentType = headers['content-type'] || 'application/octet-stream';
      const resourceType = request.resourceType();

      // Collect redirect chain info if present
      const redirectChain = [];
      let reqChain = request.redirectedFrom();
      while (reqChain) {
        redirectChain.unshift(reqChain.url());
        reqChain = reqChain.redirectedFrom();
      }

      const logEntry = {
        id: crypto.randomUUID(),
        method,
        url,
        status,
        contentType,
        resourceType,
        redirectChain: redirectChain.length ? redirectChain : undefined,
        timestamp: new Date().toISOString()
      };
      networkLog.push(logEntry);

      // Attempt to capture response body (ignore failures on redirects, 204s, or stream interruptions)
      let bodyBuffer = null;
      try {
        if (status >= 200 && status < 300) {
          bodyBuffer = await response.body();
        }
      } catch (err) {
        bodyBuffer = null;
      }

      // Check if this response represents the initial target HTML document
      if (url === TARGET_URL && resourceType === 'document' && bodyBuffer) {
        originalHtml = bodyBuffer.toString('utf-8');
      }

      capturedResources.push({
        ...logEntry,
        body: bodyBuffer
      });
    });

    // Navigate to target URL
    await page.goto(TARGET_URL, {
      waitUntil: 'networkidle',
      timeout: 45000
    });

    // Allow slight grace period for any deferred post-load XHR/fetch routines
    await page.waitForTimeout(3000);

    // Capture final rendered DOM
    renderedHtml = await page.content();

    // Fallback: if originalHtml was not populated via document response, fallback to rendered DOM
    if (!originalHtml) {
      originalHtml = renderedHtml;
    }

    latestInspection = {
      timestamp: new Date().toISOString(),
      targetUrl: TARGET_URL,
      originalHtml,
      renderedHtml,
      resources: capturedResources,
      networkLog,
      error: null
    };

    return latestInspection;
  } catch (err) {
    latestInspection = {
      timestamp: new Date().toISOString(),
      targetUrl: TARGET_URL,
      originalHtml: '',
      renderedHtml: '',
      resources: capturedResources,
      networkLog,
      error: err.message
    };
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// -----------------------------------------
// Express Routes
// -----------------------------------------

// Trigger or re-run inspection
app.get('/api/inspect', async (req, res) => {
  try {
    const result = await runInspection();
    res.json({
      success: true,
      timestamp: result.timestamp,
      totalResources: result.resources.length,
      resources: result.networkLog
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: `Failed to inspect URL: ${err.message}`
    });
  }
});

// Get current state / summary
app.get('/api/status', (req, res) => {
  res.json({
    targetUrl: TARGET_URL,
    lastInspected: latestInspection.timestamp,
    resourceCount: latestInspection.resources.length,
    error: latestInspection.error,
    resources: latestInspection.networkLog
  });
});

// Download individual captured resource by ID
app.get('/api/resource/:id', (req, res) => {
  const resource = latestInspection.resources.find((r) => r.id === req.params.id);
  if (!resource || !resource.body) {
    return res.status(404).send('Resource not found or body not captured.');
  }

  const ext = mime.extension(resource.contentType) || 'bin';
  const filename = sanitizeFilename(resource.url, ext);

  res.setHeader('Content-Type', resource.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(resource.body);
});

// Download original raw HTML
app.get('/api/download/original-html', (req, res) => {
  if (!latestInspection.originalHtml) {
    return res.status(404).send('Original HTML not captured yet. Run inspect first.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="original_index.html"');
  res.send(latestInspection.originalHtml);
});

// Download rendered DOM HTML
app.get('/api/download/rendered-html', (req, res) => {
  if (!latestInspection.renderedHtml) {
    return res.status(404).send('Rendered HTML not captured yet. Run inspect first.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rendered_index.html"');
  res.send(latestInspection.renderedHtml);
});

// Download network-log.json
app.get('/api/download/network-log', (req, res) => {
  if (!latestInspection.networkLog.length) {
    return res.status(404).send('No network log available. Run inspect first.');
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="network-log.json"');
  res.send(JSON.stringify(latestInspection.networkLog, null, 2));
});

// Package all retrieved resources into ZIP
app.get('/api/download-all', (req, res) => {
  if (!latestInspection.timestamp) {
    return res.status(400).send('No inspection data available. Run inspection first.');
  }

  const archive = archiver('zip', { zlib: { level: 9 } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="page-inspection-bundle.zip"');

  archive.pipe(res);

  // 1. Original and Rendered HTML
  if (latestInspection.originalHtml) {
    archive.append(latestInspection.originalHtml, { name: 'source/original_index.html' });
  }
  if (latestInspection.renderedHtml) {
    archive.append(latestInspection.renderedHtml, { name: 'source/rendered_index.html' });
  }

  // 2. Network Log JSON
  archive.append(JSON.stringify(latestInspection.networkLog, null, 2), {
    name: 'network-log.json'
  });

  // 3. Organize categorized assets
  latestInspection.resources.forEach((r) => {
    if (!r.body) return;

    let folder = 'assets/';
    const ext = mime.extension(r.contentType) || 'bin';

    if (r.resourceType === 'script' || r.contentType.includes('javascript')) {
      folder = 'js/';
    } else if (r.resourceType === 'stylesheet' || r.contentType.includes('css')) {
      folder = 'css/';
    } else if (r.resourceType === 'xhr' || r.resourceType === 'fetch' || r.contentType.includes('json')) {
      folder = 'data/';
    } else if (r.resourceType === 'image' || r.contentType.includes('image')) {
      folder = 'assets/images/';
    } else if (r.resourceType === 'font' || r.contentType.includes('font')) {
      folder = 'assets/fonts/';
    }

    const filename = sanitizeFilename(r.url, ext);
    archive.append(r.body, { name: `${folder}${filename}` });
  });

  archive.finalize();
});

// Web UI at "/"
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Target Page Inspector</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --success: #22c55e;
      --warn: #eab308;
      --danger: #ef4444;
    }
    body {
      margin: 0;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .header {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .target-box {
      background: #0b1120;
      border: 1px solid var(--border);
      padding: 10px 14px;
      border-radius: 6px;
      font-family: monospace;
      color: var(--primary);
      margin: 8px 0 16px 0;
      word-break: break-all;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 15px;
    }
    button, .btn {
      background: var(--primary);
      color: #0f172a;
      border: none;
      font-weight: 600;
      padding: 10px 18px;
      border-radius: 6px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
    }
    button:hover, .btn:hover { background: var(--primary-hover); }
    .btn-secondary { background: #334155; color: #fff; }
    .btn-secondary:hover { background: #475569; }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }
    .status-200 { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .status-300 { background: rgba(234, 179, 8, 0.2); color: var(--warn); }
    .status-400, .status-500 { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
      background: var(--card-bg);
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    th, td {
      padding: 12px 14px;
      text-align: left;
      font-size: 13px;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: #182234;
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }
    tr:hover { background: #26354a; }
    .url-cell {
      max-width: 450px;
      word-break: break-all;
      font-family: monospace;
    }
    .loading {
      display: none;
      color: var(--primary);
      font-weight: bold;
      margin: 10px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin:0 0 10px 0;">Target Page Inspection Tool</h2>
      <div style="color: var(--muted); font-size: 14px;">Target URL (Hardcoded):</div>
      <div class="target-box">${TARGET_URL}</div>

      <div id="stats" style="margin-bottom: 10px; font-size: 14px; color: var(--muted);">
        Status: <span id="status-text">Not run yet</span>
      </div>

      <div class="actions">
        <button id="inspect-btn" onclick="triggerInspect()">🔍 Run Full Page Inspection</button>
        <a id="download-zip-btn" href="/api/download-all" class="btn btn-secondary" style="display: none;">📦 Download All (ZIP)</a>
        <a id="download-orig-btn" href="/api/download/original-html" class="btn btn-secondary" style="display: none;">📄 Original HTML</a>
        <a id="download-rend-btn" href="/api/download/rendered-html" class="btn btn-secondary" style="display: none;">🖥️ Rendered DOM</a>
        <a id="download-log-btn" href="/api/download/network-log" class="btn btn-secondary" style="display: none;">📋 Network Log (JSON)</a>
      </div>
      <div id="loading-spinner" class="loading">⏳ Chromium is loading the page and collecting assets. Please wait (~10-20s)...</div>
    </div>

    <table id="resources-table" style="display: none;">
      <thead>
        <tr>
          <th>Method</th>
          <th>Status</th>
          <th>Type</th>
          <th>Content-Type</th>
          <th>URL</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="resources-body"></tbody>
    </table>
  </div>

  <script>
    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.lastInspected) {
        renderResults(data);
      }
    }

    async function triggerInspect() {
      const btn = document.getElementById('inspect-btn');
      const spinner = document.getElementById('loading-spinner');
      btn.disabled = true;
      spinner.style.display = 'block';

      try {
        const res = await fetch('/api/inspect');
        const data = await res.json();
        if (!data.success) {
          alert('Inspection error: ' + data.error);
        } else {
          await loadStatus();
        }
      } catch (e) {
        alert('Request failed: ' + e.message);
      } finally {
        btn.disabled = false;
        spinner.style.display = 'none';
      }
    }

    function renderResults(data) {
      document.getElementById('status-text').innerHTML = 
        'Last Inspected: <strong>' + new Date(data.lastInspected).toLocaleString() + '</strong> | Resources Discovered: <strong>' + data.resourceCount + '</strong>';

      document.getElementById('download-zip-btn').style.display = 'inline-flex';
      document.getElementById('download-orig-btn').style.display = 'inline-flex';
      document.getElementById('download-rend-btn').style.display = 'inline-flex';
      document.getElementById('download-log-btn').style.display = 'inline-flex';

      const tbody = document.getElementById('resources-body');
      tbody.innerHTML = '';

      data.resources.forEach(r => {
        let statusClass = 'status-200';
        if (r.status >= 300 && r.status < 400) statusClass = 'status-300';
        if (r.status >= 400) statusClass = 'status-400';

        const row = document.createElement('tr');
        row.innerHTML = \`
          <td><strong>\${r.method}</strong></td>
          <td><span class="status-badge \${statusClass}">\${r.status}</span></td>
          <td>\${r.resourceType}</td>
          <td>\${r.contentType.split(';')[0]}</td>
          <td class="url-cell" title="\${r.url}">\${r.url}</td>
          <td>
            <a href="/api/resource/\${r.id}" class="btn" style="padding: 4px 8px; font-size: 11px;">Download</a>
          </td>
        \`;
        tbody.appendChild(row);
      });

      document.getElementById('resources-table').style.display = 'table';
    }

    loadStatus();
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`Inspector server listening on port ${PORT}`);
  console.log(`Target URL locked to: ${TARGET_URL}`);
});