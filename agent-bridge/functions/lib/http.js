// The HTTP side of the bridge. An access link looks like
//   https://<function address>/mcp/<token>
// which is what Grok, Claude and ChatGPT take as a custom connector's MCP
// server URL. A client that can send headers may use /mcp with
// "Authorization: Bearer <token>" instead.
//
// MCP over Streamable HTTP, stateless: every POST builds a fresh server and
// answers with plain JSON, so any function instance can take any request.
// Never log the request URL here — it holds the token.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './mcp.js';
import { authenticate, loadSnapshot } from './store.js';

const rpcError = (res, status, code, message) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

export function makeHandler(getDb) {
  return async (req, res) => {
    const path = String(req.path || '').replace(/\/+$/, '') || '/';
    if (path === '/' && req.method === 'GET') {
      res.status(200).type('text/plain').send('Lock & Scroll agent bridge is running.');
      return;
    }
    const m = /^\/mcp(?:\/([^/]+))?$/.exec(path);
    if (!m) { res.status(404).type('text/plain').send('Not found'); return; }

    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const token = m[1] || (bearer ? bearer[1] : null);
    const db = getDb();
    let access;
    try {
      access = await authenticate(db, token);
    } catch (e) {
      console.error('Access check failed:', e.message);
      rpcError(res, 500, -32603, 'Could not check the access link. Try again.');
      return;
    }
    if (!access) {
      rpcError(res, 401, -32001, 'This access link is not valid or was revoked. Make a new one in Lock & Scroll: Settings, AI Agents.');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no standing event stream to open, and no session to end.
      res.set('Allow', 'POST');
      rpcError(res, 405, -32000, 'Method not allowed.');
      return;
    }

    let data = null;
    const getData = async () => data || (data = await loadSnapshot(db, access.uid));
    const server = buildServer({ getData, access });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP request failed:', e);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error.');
    }
  };
}
