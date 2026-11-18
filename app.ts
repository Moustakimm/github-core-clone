// app.ts — HTTP server and router for the forge.
//
// Routes:
//   GET  /healthz                      -> {"ok": true}
//   /api/v3/*                          -> REST v3 (rest.ts)
//   POST /api/graphql                  -> GraphQL (graphql.ts)
//   POST /mcp, DELETE /mcp            -> MCP (mcp.ts)
//   /{owner}/{repo}.git/*              -> git smart HTTP (git.ts)
//   everything else                    -> JSON 404
//
// Every JSON reply carries application/json and a non-empty
// X-GitHub-Request-Id. Auth is a Bearer token: when MAKEFUN_SHOP_TOKEN is set
// it must match exactly; when it is unset (local development) any non-empty
// Bearer token is accepted. /healthz, GET /api/v3/ and GET /api/v3/meta are
// auth-free, matching GitHub.

import http from 'node:http';
import { createStore } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function isAuthed(headers) {
  const auth = headers.authorization ?? '';
  const bearer = /^Bearer\s+(\S+)$/.exec(auth);
  if (bearer) {
    if (SHOP_TOKEN === '') return bearer[1].length > 0;
    return bearer[1] === SHOP_TOKEN;
  }
  // Real git clients authenticate with Basic (token as password, or as the
  // username when no password is given). The suite's own clients use Bearer;
  // accepting Basic as well makes the forge usable from a plain `git clone`.
  const basic = /^Basic\s+(\S+)$/.exec(auth);
  if (basic) {
    let decoded = '';
    try { decoded = Buffer.from(basic[1], 'base64').toString('utf8'); } catch { return false; }
    const colon = decoded.indexOf(':');
    const user = colon >= 0 ? decoded.slice(0, colon) : decoded;
    const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
    if (SHOP_TOKEN === '') return decoded.length > 0;
    return pass === SHOP_TOKEN || user === SHOP_TOKEN;
  }
  return false;
}

export function createApp() {
  const store = createStore();
  let requestCounter = 0;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, store, () => `req-${++requestCounter}`);
  });
  return server;
}

async function handleRequest(req, res, store, nextRequestId) {
  const requestId = nextRequestId();
  let sent = false;

  const sendJson = (status, payload, extraHeaders = {}) => {
    if (sent) return;
    sent = true;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
      'content-length': body.length,
      ...extraHeaders,
    });
    res.end(body);
  };

  const sendRaw = (status, body, contentType, extraHeaders = {}) => {
    if (sent) return;
    sent = true;
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': requestId,
      'content-length': buffer.length,
      ...extraHeaders,
    });
    res.end(buffer);
  };

  const sendEmpty = (status, extraHeaders = {}) => {
    if (sent) return;
    sent = true;
    res.writeHead(status, { 'x-github-request-id': requestId, ...extraHeaders });
    res.end();
  };

  try {
    const chunks = [];
    let bodyLength = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_BYTES) { tooLarge = true; break; }
      chunks.push(chunk);
    }
    if (tooLarge) return sendJson(413, { message: 'Request body too large' });
    const body = Buffer.concat(chunks);

    let rawPath;
    try {
      rawPath = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return sendJson(400, { message: 'Bad request URL' });
    }
    let path;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return sendJson(400, { message: 'Bad request path' });
    }
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    const segments = path.split('/').filter((s) => s !== '');
    const method = (req.method ?? 'GET').toUpperCase();
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }
    const host = headers.host ?? 'localhost';

    // JSON body, parsed once for the JSON APIs. A malformed body is flagged
    // (not thrown) so each handler can answer with its own error shape.
    let jsonBody = null;
    let bodyParseError = false;
    const contentType = headers['content-type'] ?? '';
    if (body.length > 0 && contentType.includes('application/json')) {
      try {
        jsonBody = JSON.parse(body.toString('utf8'));
      } catch {
        bodyParseError = true;
      }
    }

    const ctx = {
      store,
      method,
      path,
      segments,
      query,
      headers,
      body,
      host,
      requestId,
      authed: isAuthed(headers),
      jsonBody,
      bodyParseError,
      json: sendJson,
      raw: sendRaw,
      empty: sendEmpty,
      notFound: (message = 'Not Found') => sendJson(404, { message }),
    };

    // GET /healthz
    if (method === 'GET' && path === '/healthz') {
      return sendJson(200, { ok: true });
    }

    // REST v3 (root and meta are auth-free; the rest checks auth itself).
    if (segments[0] === 'api' && segments[1] === 'v3') {
      await handleRest(ctx);
      return;
    }

    // GraphQL — POST only; auth required.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') return ctx.notFound();
      if (!ctx.authed) return sendJson(401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="github-core-clone", Bearer' });
      handleGraphQL(ctx);
      return;
    }

    // MCP — POST for JSON-RPC, DELETE closes a session (any 2xx is fine).
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'DELETE') return sendEmpty(200);
      if (method !== 'POST') return sendJson(405, { message: 'Method not allowed' });
      if (!ctx.authed) {
        return sendJson(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }, { 'www-authenticate': 'Basic realm="github-core-clone", Bearer' });
      }
      handleMcp(ctx);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1].endsWith('.git')) {
      if (!ctx.authed) return sendJson(401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="github-core-clone", Bearer' });
      await handleGit(ctx);
      return;
    }

    return ctx.notFound();
  } catch (err) {
    if (!sent) {
      process.stderr.write(`[app] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      sendJson(500, { message: 'Internal server error' });
    }
  }
}
