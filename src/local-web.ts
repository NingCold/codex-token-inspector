import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { querySchema, type Dashboard, type ParsedQuery } from './dashboard.js';
import { getService } from './service.js';

export async function startLocalWeb(html: string, port = 0, query: (input: ParsedQuery) => Promise<Dashboard> = input => getService().queryParsed(input)) {
  const secret = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== origin.replace('http://', '')) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'");
      res.end(html); return;
    }
    if (req.url !== '/api/dashboard' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(secret);
    if (req.headers.origin !== origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) { res.writeHead(413).end(); return; } }
      const input = querySchema.parse(JSON.parse(body || '{}'));
      const dashboard = await query(input);
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(dashboard));
    } catch { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '查询参数无效' })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot obtain local server address');
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, url: `${origin}/#access_token=${secret}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(e => e ? reject(e) : resolve()); }) };
}
