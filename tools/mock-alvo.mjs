// Alvo simulado: imita o suficiente do PrimeDoctor + Supabase para exercitar a
// lógica de decisão das sondas sem tocar em produção.
// Usado por tools/testar-logica.mjs. Não faz parte do monitor em execução.
import http from 'node:http';
import { createHash } from 'node:crypto';

export function startMock(scenario = {}) {
  const {
    supabaseDown = false,      // Auth/PostgREST/system-health fora do ar
    gatewayAlways401 = false,  // relay recusa antes de rotear (o caso do FN-1)
    canaryBroken = false,      // slug inexistente NÃO devolve 404
    missingFunctions = [],     // funções removidas do deploy
    rlsEmpty = [],             // tabelas que devolvem 200 com zero linhas
    htmlWithoutBundles = false,
    slowMs = 0,
    pingToken = 'ping-mock',   // token esperado no header X-Monitor-Ping
    pingDisabled = false,      // MONITOR_PING_TOKEN não configurado no projeto
    pingAusente = [],          // funções que ainda não têm o endpoint de ping
    faltandoSecrets = {},      // { 'zapi-webhook': ['ZAPI_WEBHOOK_SECRET'] }
  } = scenario;

  const server = http.createServer(async (req, res) => {
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    // ---------- app ----------
    // Atenção: a rota /auth do app colide com /auth/v1 do Supabase.
    // O prefixo do Supabase tem que ser excluído aqui.
    const isSupabaseApi = /^\/(auth\/v1|rest\/v1|functions\/v1|storage\/v1)/.test(p);
    if (!isSupabaseApi && (p === '/' || p.startsWith('/auth') || p.startsWith('/__monitor'))) {
      const bundles = htmlWithoutBundles
        ? ''
        : '<script type="module" src="/assets/index-abc123.js"></script><link rel="stylesheet" href="/assets/index-def456.css">';
      return send(200, `<!doctype html><html><head><title>PrimeDoctor++</title>${bundles}</head><body><div id="root"></div></body></html>`, {
        'Content-Type': 'text/html',
      });
    }
    if (p.startsWith('/assets/') || ['/manifest.json', '/favicon.png', '/robots.txt'].includes(p)) {
      return send(200, '/* ok */', { 'Content-Type': 'text/plain' });
    }

    // ---------- supabase: auth ----------
    if (p === '/auth/v1/health') {
      return supabaseDown ? send(503, { error: 'down' }) : send(200, { version: 'v2.180.0-mock' });
    }
    if (p === '/auth/v1/token') {
      return supabaseDown ? send(503, { error: 'down' }) : send(200, { access_token: 'mock-token', expires_in: 3600 });
    }

    // ---------- supabase: postgrest ----------
    if (p === '/rest/v1/') return supabaseDown ? send(503, {}) : send(200, {});
    if (p.startsWith('/rest/v1/')) {
      if (supabaseDown) return send(503, {});
      const table = p.slice('/rest/v1/'.length);
      const empty = rlsEmpty.includes(table);
      return send(200, empty ? [] : [{ id: '1' }], {
        'Content-Range': empty ? '*/0' : '0-0/42',
      });
    }

    // ---------- supabase: functions ----------
    if (p.startsWith('/functions/v1/')) {
      const slug = p.slice('/functions/v1/'.length);
      // O gateway valida o JWT antes de resolver o slug — este é exatamente
      // o comportamento que fazia a sonda antiga mentir em verde.
      const hasBearer = (req.headers.authorization || '').startsWith('Bearer ');
      if (gatewayAlways401 || !hasBearer) return send(401, { message: 'Missing authorization header' });
      if (canaryBroken && slug.includes('canary')) return send(200, { ok: true });
      if (slug.includes('canary')) return send(404, { code: 'NOT_FOUND' });
      if (missingFunctions.includes(slug)) return send(404, { code: 'NOT_FOUND' });

      // Ping de prontidão (_shared/monitorPing.ts no repositório do PrimeDoctor).
      const pingHeader = req.headers['x-monitor-ping'];
      if (pingHeader && !pingAusente.includes(slug)) {
        if (pingDisabled) {
          return send(503, { ok: false, fn: slug, reason: 'ping_desativado', detail: 'MONITOR_PING_TOKEN não está configurado neste projeto' });
        }
        if (pingHeader !== pingToken) return send(401, { ok: false });
        const missing = faltandoSecrets[slug] || [];
        return send(missing.length ? 503 : 200, {
          ok: true, fn: slug, ready: missing.length === 0,
          missingRequired: missing, missingOptional: [], extra: null, ts: new Date().toISOString(),
        });
      }
      if (slug === 'system-health' && supabaseDown) return send(503, {});
      if (slug === 'system-health') return send(200, { ok: true, db: 'ok', latency_ms: 42, ts: new Date().toISOString() });
      return send(200, { ok: true }, { 'Access-Control-Allow-Origin': '*' });
    }

    // ---------- supabase: storage ----------
    if (p.startsWith('/storage/v1/bucket')) return send(200, []);
    if (p.startsWith('/storage/v1/object')) return send(404, { error: 'not found' });

    // ---------- controle ----------
    if (p === '/__control__') return send(200, { ok: true });

    send(404, { error: 'not found' });
  });

  // Realtime: aceita o upgrade de websocket para a sonda conseguir conectar.
  // Os sockets são rastreados porque um socket em upgrade impede server.close()
  // de terminar — e o teste ficaria pendurado para sempre.
  const upgraded = new Set();
  server.on('upgrade', (req, socket) => {
    if (supabaseDown) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'] || '';
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            for (const s of upgraded) s.destroy();
            upgraded.clear();
            server.close(r);
          }),
      });
    });
  });
}
