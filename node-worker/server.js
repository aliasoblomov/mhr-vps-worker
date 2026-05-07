const http = require('http');
const https = require('https');
const dns = require('dns');
const url = require('url');

dns.setDefaultResultOrder('ipv4first');

const BAD_HEADERS = [
  'host', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-proto',
  'cf-connecting-ip', 'connection', 'keep-alive', 'proxy-connection'
];

const SLOW_SITES = [
  'gemini.google.com', 'ai.google.dev', 'makersuite.google.com',
  'generativelanguage.googleapis.com', '.googleapis.com',
  'chatgpt.com', '.chatgpt.com', 'openai.com', '.openai.com',
  'api.openai.com', '.oaistatic.com', '.oaiusercontent.com',
  'meet.google.com', '.google.com'
];

const TIMEOUT_SLOW_MS = 120000; // 2 minutes for AI prompts
const TIMEOUT_FAST_MS = 30000;

const agentOptions = { rejectUnauthorized: false, keepAlive: true, maxSockets: 100 };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

function isSlowHost(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  for (const rule of SLOW_SITES) {
    const r = rule.toLowerCase().trim();
    if (!r) continue;
    if (r.startsWith('.')) {
      if (host.endsWith(r) || host === r.slice(1)) return true;
    } else if (host === r) return true;
  }
  return false;
}

/**
 * Main Request Handler
 */
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // 1. Determine Mode: GAS Relay (POST + JSON) or Direct Raw (GET/Other)
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    handleGasRelay(req, res);
  } else {
    handleDirectRelay(req, res, parsedUrl);
  }
});

/**
 * GAS Relay Mode: Buffers entire response and returns JSON for UrlFetchApp
 */
function handleGasRelay(req, res) {
  let bodyParts = [];
  req.on('data', chunk => bodyParts.push(chunk));
  req.on('end', () => {
    let isResponded = false;
    const sendResponse = (status, headers, base64Body) => {
      if (isResponded) return;
      isResponded = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ s: status, h: headers, b: base64Body }));
    };

    try {
      const data = JSON.parse(Buffer.concat(bodyParts).toString());
      if (!data.u) return sendResponse(400, {}, Buffer.from("no url").toString('base64'));

      const targetUrl = new URL(data.u);
      const isHttps = targetUrl.protocol === 'https:';
      const slow = isSlowHost(targetUrl.hostname);

      const options = {
        method: data.m || 'GET',
        headers: {},
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: slow ? TIMEOUT_SLOW_MS : TIMEOUT_FAST_MS
      };

      if (data.h) {
        for (const [k, v] of Object.entries(data.h)) {
          if (!BAD_HEADERS.includes(k.toLowerCase())) options.headers[k] = v;
        }
      }

      const proxyReq = (isHttps ? https : http).request(targetUrl, options, (proxyRes) => {
        const responseHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (k.toLowerCase() !== 'transfer-encoding') responseHeaders[k] = v;
        }

        let chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          sendResponse(proxyRes.statusCode, responseHeaders, Buffer.concat(chunks).toString('base64'));
        });
      });

      proxyReq.on('timeout', () => { proxyReq.destroy(); sendResponse(504, {}, Buffer.from("Timeout").toString('base64')); });
      proxyReq.on('error', err => sendResponse(502, {}, Buffer.from("Relay Error: " + err.message).toString('base64')));

      if (data.b && !['GET', 'HEAD'].includes(options.method)) {
        proxyReq.write(Buffer.from(data.b, 'base64'));
      }
      proxyReq.end();
    } catch (err) {
      sendResponse(500, {}, Buffer.from("Logic Error: " + err.message).toString('base64'));
    }
  });
}

/**
 * Direct Relay Mode: Pipes raw data (Video, Fonts, SSE)
 */
function handleDirectRelay(req, res, parsedUrl) {
  // Get target URL from query param 'u' or header 'x-target-url'
  const targetUrlStr = parsedUrl.query.u || req.headers['x-target-url'];
  if (!targetUrlStr) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end("<h1>Worker Active</h1><p>Usage: <code>/raw?u=https://example.com</code></p>");
  }

  try {
    const targetUrl = new URL(targetUrlStr);
    const isHttps = targetUrl.protocol === 'https:';

    const options = {
      method: req.method,
      headers: {},
      agent: isHttps ? httpsAgent : httpAgent,
      timeout: isSlowHost(targetUrl.hostname) ? TIMEOUT_SLOW_MS : TIMEOUT_FAST_MS
    };

    // Forward headers from client to target
    for (const [k, v] of Object.entries(req.headers)) {
      if (!BAD_HEADERS.includes(k.toLowerCase())) options.headers[k] = v;
    }

    const proxyReq = (isHttps ? https : http).request(targetUrl, options, (proxyRes) => {
      // Forward headers from target to client
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Direct Relay Error: " + err.message);
    });

    req.pipe(proxyReq);
  } catch (err) {
    res.writeHead(400);
    res.end("Invalid target URL");
  }
}

/**
 * WebSocket Support (for Google Meet, etc.)
 */
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = url.parse(req.url, true);
  const targetUrlStr = parsedUrl.query.u || req.headers['x-target-url'];
  if (!targetUrlStr) return socket.destroy();

  try {
    const targetUrl = new URL(targetUrlStr);
    const isHttps = targetUrl.protocol === 'https:';

    const options = {
      port: targetUrl.port || (isHttps ? 443 : 80),
      host: targetUrl.hostname,
      method: 'GET',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        ...req.headers
      }
    };

    // Clean up headers
    delete options.headers['host'];

    const proxyReq = (isHttps ? https : http).request(options);
    proxyReq.end();

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        Object.keys(proxyRes.headers).map(h => `${h}: ${proxyRes.headers[h]}`).join('\r\n') +
        '\r\n\r\n');
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on('error', () => socket.destroy());
  } catch (err) {
    socket.destroy();
  }
});

server.listen(8081, '0.0.0.0', () => {
  console.log("Stream-Ready Worker running on port 8081");
});

