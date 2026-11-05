/* PrimeDoctor — Monitor de Saúde
   Página estática. Lê os relatórios gerados pelo GitHub Actions e, opcionalmente,
   executa uma verificação ao vivo direto do navegador de quem está olhando. */

'use strict';

const SCHEMA_SUPORTADO = 3;
const REFRESH_MS = 5 * 60 * 1000;

const META = {
  ok:       { color: 'var(--ok)',       bg: 'var(--ok-bg)',       icon: '✓', label: 'Operacional' },
  degraded: { color: 'var(--degraded)', bg: 'var(--degraded-bg)', icon: '!', label: 'Degradado' },
  fail:     { color: 'var(--fail)',     bg: 'var(--fail-bg)',     icon: '✕', label: 'Falha' },
  skipped:  { color: 'var(--skipped)',  bg: 'var(--skipped-bg)',  icon: '–', label: 'Não verificado' },
  unknown:  { color: 'var(--unknown)',  bg: 'var(--unknown-bg)',  icon: '?', label: 'Indeterminado' },
};
const metaOf = (s) => META[s] || META.unknown;

const CARDS = ['frontend', 'backend', 'edge', 'experience'];
const LETRA = { frontend: 'f', backend: 'b', edge: 'e', experience: 'x' };

const state = { status: null, history: [], incidents: [], lastOk: null, staleFetch: false, timer: null };

boot(true);

/* ------------------------------------------------------------------ carga */

async function boot(first) {
  try {
    const [status, history, incidents] = await Promise.all([
      loadJson('./data/status.json'),
      loadJsonl('./data/history.jsonl').catch(() => []),
      loadJson('./data/incidents.json').catch(() => []),
    ]);
    state.status = status;
    state.history = history;
    state.incidents = Array.isArray(incidents) ? incidents : [];
    state.lastOk = Date.now();
    state.staleFetch = false;
    render();
  } catch (err) {
    // Um 404 transitório do CDN NÃO pode apagar a página durante um incidente
    // e substituí-la por uma explicação tranquilizadora e errada.
    if (state.status) {
      state.staleFetch = true;
      marcarAtualizacaoFalhou(err);
      return;
    }
    if (first) mostrarSemDados(err);
  }
  agendarProximaAtualizacao();
}

function agendarProximaAtualizacao() {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => boot(false), REFRESH_MS);
}

async function loadJson(url) {
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} devolveu HTTP ${res.status}`);
  return res.json();
}

async function loadJsonl(url) {
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} devolveu HTTP ${res.status}`);
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function mostrarSemDados(err) {
  document.getElementById('content').innerHTML = `
    <div class="banner" style="--st-color:var(--unknown);--st-bg:var(--unknown-bg)">
      <div class="pulse">?</div>
      <div>
        <h2>Sem dados de verificação</h2>
        <p>Nenhum relatório foi encontrado. Se o monitor acabou de ser instalado, isso é esperado
        até a primeira execução — rode o workflow <b>Monitor de saúde</b> nas Actions do repositório.
        <br><small>${escapeHtml(err.message)}</small></p>
      </div>
    </div>`;
  document.getElementById('meta').textContent = 'aguardando primeira execução';
}

function marcarAtualizacaoFalhou() {
  const el = document.getElementById('refresh-chip');
  if (el) {
    el.className = 'chip chip-warn';
    el.textContent = `não foi possível atualizar · dados de ${relTime(state.status.generatedAt)}`;
  }
}

/* ----------------------------------------------------------------- render */

function render() {
  const abertos = capturarSecoesAbertas();
  const s = state.status;

  if (s.schemaVersion !== SCHEMA_SUPORTADO) {
    document.getElementById('content').innerHTML = `
      <div class="banner" style="--st-color:var(--degraded);--st-bg:var(--degraded-bg)">
        <div class="pulse">!</div>
        <div><h2>Esta página está desatualizada</h2>
        <p>O relatório está no formato <b>v${escapeHtml(s.schemaVersion)}</b> e esta página entende
        <b>v${SCHEMA_SUPORTADO}</b>. Recarregue com cache limpo (Ctrl+Shift+R). Se persistir,
        o deploy do site ficou para trás em relação ao probe.</p></div>
      </div>`;
    return;
  }

  const target = safeExternalUrl(s.target?.url) || 'https://primedoctor.app';
  document.getElementById('target-url').textContent = target.replace(/^https?:\/\//, '');

  const idade = Date.now() - new Date(s.generatedAt).getTime();
  const velho = idade > 3 * 3600 * 1000;

  document.getElementById('meta').innerHTML = `
    <span id="refresh-chip" class="chip">${state.staleFetch ? 'não foi possível atualizar' : 'atualizado'}</span><br>
    Última verificação <b>${relTime(s.generatedAt)}</b><br>
    <span class="mono">${fmtLocal(s.generatedAt)}</span><br>
    <span class="mono dim">${fmtUtc(s.generatedAt)}</span>
    ${Number.isFinite(s.durationMs) ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ''}
    ${s.runner?.runUrl ? ` · <a href="${escapeHtml(safeExternalUrl(s.runner.runUrl) || '#')}" target="_blank" rel="noopener">execução</a>` : ''}`;

  const graded = (s.sections || []).filter((x) => !x.informational);
  const upstream = (s.sections || []).find((x) => x.key === 'upstream');

  document.getElementById('content').innerHTML = [
    velho ? avisoDadosVelhos(s.generatedAt) : '',
    s.monitorFault ? avisoMonitorMalConfigurado(s) : '',
    banner(s),
    deployBox(s),
    `<div class="cards">${CARDS.map((k) => card(s, k)).join('')}</div>`,
    charts(),
    graded.map(section).join(''),
    upstream ? section(upstream) : '',
    incidentesBlock(),
    liveBlock(),
    runbookBlock(s),
    notasBlock(),
    rodape(s),
  ].join('');

  restaurarSecoesAbertas(abertos);
  drawCharts();
  wireLive();
}

/* --------- preserva o que o operador abriu, para o refresh não atrapalhar --- */

function capturarSecoesAbertas() {
  return new Set([...document.querySelectorAll('details.section[open]')].map((d) => d.dataset.key));
}
function restaurarSecoesAbertas(abertos) {
  for (const d of document.querySelectorAll('details.section')) {
    if (abertos.has(d.dataset.key)) d.open = true;
  }
}

/* ------------------------------------------------------------- componentes */

function avisoDadosVelhos(ts) {
  return `<div class="banner" style="--st-color:var(--degraded);--st-bg:var(--degraded-bg)">
    <div class="pulse">!</div>
    <div><h2>Estes dados estão velhos</h2>
    <p>A última verificação foi ${relTime(ts)}, mas o monitor deveria rodar de hora em hora.
    O próprio robô pode estar parado — verifique as GitHub Actions do repositório.
    <b>Não trate os status abaixo como a situação atual.</b></p></div>
  </div>`;
}

function avisoMonitorMalConfigurado(s) {
  return `<div class="banner" style="--st-color:var(--unknown);--st-bg:var(--unknown-bg)">
    <div class="pulse">⚙</div>
    <div><h2>O monitor está mal configurado</h2>
    <p>${escapeHtml(s.monitorFaultReason || 'não foi possível autenticar com o usuário-monitor')}.
    <b>Isto é um problema do monitor, não necessariamente do PrimeDoctor</b> — parte das verificações
    não rodou, então os cartões abaixo cobrem menos coisa do que deveriam.</p></div>
  </div>`;
}

function banner(s) {
  const st = metaOf(s.overall.status);
  const j24 = state.history.slice(-24);
  const ok24 = j24.filter((h) => h.s === 'ok').length;
  return `<div class="banner" style="--st-color:${st.color};--st-bg:${st.bg}">
    <div class="pulse">${st.icon}</div>
    <div style="flex:1">
      <h2>${escapeHtml(s.overall.label)}</h2>
      <p>${escapeHtml(s.overall.summary)}
      ${j24.length ? `<br>Nas últimas ${j24.length} verificações: <b>${ok24}</b> totalmente OK.` : ''}
      ${s.overall.status === 'fail' && !s.overall.confirmed
        ? '<br><b>Ainda não confirmado:</b> é a primeira execução ruim. O alarme só dispara se a próxima também falhar.'
        : ''}
      </p>
    </div>
  </div>`;
}

/** O bundle mudou logo antes de ficar vermelho? É a primeira pergunta numa madrugada. */
function deployBox(s) {
  if (!s.buildFingerprint) return '';
  const hashes = state.history.map((h) => h.fp).filter(Boolean);
  const atual = hashes.length ? hashes[hashes.length - 1] : null;
  let quando = null;
  for (let i = hashes.length - 2; i >= 0; i--) {
    if (hashes[i] !== atual) { quando = state.history[i + 1]?.t; break; }
  }
  const arquivos = s.buildFingerprint.split('|').slice(0, 4);
  const recente = quando && Date.now() - new Date(quando).getTime() < 6 * 3600 * 1000;
  return `<div class="deploy ${recente ? 'deploy-recent' : ''}">
    <div>
      <div class="deploy-label">Build publicado no site</div>
      <div class="mono deploy-files">${arquivos.map(escapeHtml).join(' · ')}</div>
    </div>
    <div class="deploy-when">
      ${quando
        ? `${recente ? '<b>mudou</b>' : 'mudou'} ${relTime(quando)}<br><span class="mono dim">${fmtUtc(quando)}</span>`
        : 'sem troca de build no histórico'}
    </div>
  </div>`;
}

function card(s, key) {
  const sec = (s.sections || []).find((x) => x.key === key);
  if (!sec) return '';
  const st = metaOf(sec.status);
  const hist = state.history.slice(-60);
  const letra = LETRA[key];
  const bars = hist
    .map((h) => `<i data-s="${escapeHtml(h[letra] || 'unknown')}" title="${escapeHtml(fmtLocal(h.t))} — ${escapeHtml(metaOf(h[letra]).label)}"></i>`)
    .join('');
  const okN = hist.filter((h) => h[letra] === 'ok').length;

  return `<div class="card" style="--st-color:${st.color};--st-bg:${st.bg}">
    <div class="card-head">
      <span class="dot"></span>
      <h3>${escapeHtml(sec.label)}</h3>
      <span class="badge">${st.label}</span>
    </div>
    <div class="sub">${escapeHtml(sec.detail || '')}</div>
    <div class="num">${hist.length ? okN : '—'}<small>/${hist.length} verificações OK</small></div>
    <div class="bars">${bars || '<i data-s="unknown"></i>'}</div>
    <div class="bars-legend"><span>${hist.length ? relTime(hist[0].t) : ''}</span><span>agora</span></div>
  </div>`;
}

const CHARTS = [
  { k: 'doc', title: 'Resposta do site', hint: 'tempo do HTML principal' },
  { k: 'db', title: 'Banco de dados', hint: 'healthcheck com consulta real' },
  { k: 'edge', title: 'Funções de borda', hint: 'média das integrações' },
  { k: 'load', title: 'App pronto na tela', hint: 'Chromium até montar o app' },
];

function charts() {
  return `<div class="charts">${CHARTS.map((c) => {
    const vals = state.history.map((h) => h.lat?.[c.k]).filter((v) => typeof v === 'number');
    const last = vals.length ? vals[vals.length - 1] : null;
    return `<div class="chart">
      <h4>${escapeHtml(c.title)}</h4>
      <div class="now">${fmt(last)}</div>
      <svg data-chart="${c.k}" viewBox="0 0 300 46" preserveAspectRatio="none" aria-hidden="true"></svg>
      <div class="foot">${escapeHtml(c.hint)}${vals.length ? ` · mediana ${fmt(median(vals))}` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

function drawCharts() {
  for (const c of CHARTS) {
    const svg = document.querySelector(`svg[data-chart="${c.k}"]`);
    if (!svg) continue;
    const vals = state.history.map((h) => h.lat?.[c.k]).filter((v) => typeof v === 'number').slice(-120);
    if (vals.length < 2) {
      svg.innerHTML = '<text x="150" y="28" text-anchor="middle" fill="var(--text-faint)" font-size="10">sem histórico suficiente</text>';
      continue;
    }
    const max = Math.max(...vals) * 1.12 || 1;
    const min = Math.min(...vals) * 0.9;
    const span = Math.max(max - min, 1);
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * 300).toFixed(1)},${(44 - ((v - min) / span) * 40).toFixed(1)}`);
    svg.innerHTML =
      `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />` +
      `<polygon points="0,46 ${pts.join(' ')} 300,46" fill="var(--accent)" opacity=".10" />`;
  }
}

function section(sec) {
  const st = metaOf(sec.status);
  const abrir = sec.status === 'fail' || sec.status === 'degraded';
  return `<details class="section" data-key="${escapeHtml(sec.key)}" ${abrir ? 'open' : ''} style="--st-color:${st.color};--st-bg:${st.bg}">
    <summary>
      <span class="chev">▶</span><span class="dot"></span>
      <h3>${escapeHtml(sec.label)}</h3>
      <span class="hint">${escapeHtml(sec.detail || '')}</span>
      <span class="badge">${sec.informational ? 'Informativo' : st.label}</span>
    </summary>
    <div class="items">${(sec.items || []).map(itemRow).join('') || '<div class="item"><span></span><div class="desc">Sem detalhes nesta execução.</div><span></span></div>'}</div>
  </details>`;
}

function itemRow(it) {
  const st = metaOf(it.status);
  return `<div class="item ${it.informational ? 'item-info' : ''}" style="--st-color:${st.color};--st-bg:${st.bg}">
    <span class="dot idot"></span>
    <div>
      <div class="name">${escapeHtml(it.label)}
        ${it.critical === false ? '<span class="tag">não crítica</span>' : ''}
        ${it.informational ? '<span class="tag">informativo</span>' : ''}
      </div>
      <div class="desc">${escapeHtml(it.detail || st.label)}</div>
      ${detalhesExtras(it)}
    </div>
    <span class="lat">${it.latencyMs != null ? fmt(it.latencyMs) : ''}</span>
  </div>`;
}

function detalhesExtras(it) {
  const m = it.meta || {};
  if (m.categories?.length) {
    return `<div class="samples">${m.categories
      .map((c) => escapeHtml(`${String(c.count).padStart(3)}× ${c.category.padEnd(20)} ${c.description}`))
      .join('\n')}</div>`;
  }
  if (m.probes?.length) {
    return `<div class="samples">${m.probes
      .map((p) => escapeHtml(`${pad(p.table, 20)} ${pad(p.status, 10)} ${p.ms != null ? p.ms + 'ms' : '—'}  ${p.detail || ''}`))
      .join('\n')}</div>`;
  }
  if (m.failed?.length) {
    return `<div class="samples">${m.failed.map((f) => escapeHtml(`${pad(f.reason, 12)} ${f.type || ''} ${f.url}`)).join('\n')}</div>`;
  }
  if (m.files?.length && m.files.some((f) => !f.ok)) {
    return `<div class="samples">${m.files.map((f) => escapeHtml(`${pad(f.path, 20)} ${f.ok ? 'ok' : 'FALHOU'} ${f.status || ''}`)).join('\n')}</div>`;
  }
  return '';
}

function incidentesBlock() {
  const list = state.incidents || [];
  if (!list.length) {
    return `<details class="section" data-key="incidentes" style="--st-color:var(--ok);--st-bg:var(--ok-bg)">
      <summary><span class="chev">▶</span><span class="dot"></span><h3>Histórico de incidentes</h3>
      <span class="hint">nenhum incidente registrado</span><span class="badge">Limpo</span></summary>
      <div class="items"><div class="item"><span></span><div class="desc">Um incidente é aberto quando duas verificações consecutivas saem do verde. Perder visibilidade no meio de uma queda não encerra o incidente.</div><span></span></div></div>
    </details>`;
  }
  const abertos = list.filter((i) => !i.endedAt).length;
  const st = abertos ? META.fail : META.degraded;
  return `<details class="section" data-key="incidentes" ${abertos ? 'open' : ''} style="--st-color:${st.color};--st-bg:${st.bg}">
    <summary><span class="chev">▶</span><span class="dot"></span><h3>Histórico de incidentes</h3>
    <span class="hint">${list.length} registrado(s)${abertos ? ` · ${abertos} em aberto` : ''}</span>
    <span class="badge">${abertos ? 'Em aberto' : 'Resolvidos'}</span></summary>
    <div class="items">${list.slice(0, 20).map((i) => {
      const m = metaOf(i.worst);
      return `<div class="item" style="--st-color:${m.color};--st-bg:${m.bg}">
        <span class="dot idot"></span>
        <div>
          <div class="name">${escapeHtml(fmtLocal(i.startedAt))}${i.endedAt ? '' : ' — em andamento'}</div>
          <div class="desc"><span class="mono dim">${escapeHtml(fmtUtc(i.startedAt))}</span><br>
            Afetou: ${escapeHtml(i.areas.join(', ') || 'não classificado')} · ${i.checks} verificação(ões)${
              i.durationMinutes != null ? ` · durou ~${formatDuration(i.durationMinutes)}` : ''
            }${i.blindSpots ? ` · ${i.blindSpots} sem visibilidade` : ''}</div>
          ${i.items?.length ? `<div class="samples">${i.items.map(escapeHtml).join('\n')}</div>` : ''}
        </div>
        <span class="lat">${m.label}</span>
      </div>`;
    }).join('')}</div>
  </details>`;
}

/* -------------------------------------------------- verificação ao vivo */

function liveBlock() {
  return `<details class="section" data-key="live" style="--st-color:var(--accent);--st-bg:var(--accent-soft)">
    <summary><span class="chev">▶</span><span class="dot"></span><h3>Verificar agora, do seu navegador</h3>
    <span class="hint">pulso em tempo real, sem esperar o próximo ciclo</span><span class="badge">Ao vivo</span></summary>
    <div class="items">
      <div class="item" style="grid-template-columns:1fr">
        <div>
          <div class="live-head">
            <button class="btn" id="live-btn">Executar verificação ao vivo</button>
            <span class="desc" id="live-status">Testa os endpoints públicos a partir do seu computador e da sua rede.</span>
          </div>
          <div id="live-results"></div>
        </div>
      </div>
    </div>
  </details>`;
}

function wireLive() {
  document.getElementById('live-btn')?.addEventListener('click', runLive);
}

async function runLive() {
  const btn = document.getElementById('live-btn');
  const statusEl = document.getElementById('live-status');
  const out = document.getElementById('live-results');
  if (!btn || !out) return;
  btn.disabled = true;
  statusEl.textContent = 'verificando…';
  out.innerHTML = '';

  const ref = state.status?.target?.supabaseRef;
  const supa = ref && /^[a-z0-9-]+$/i.test(ref) ? `https://${ref}.supabase.co` : null;
  const app = safeExternalUrl(state.status?.target?.url) || 'https://primedoctor.app';

  const tests = [
    { label: 'Site alcançável', neutral: true, note: 'requisição sem CORS: prova DNS, TCP e TLS — NÃO prova que o site respondeu certo', run: () => opaque(app + '/favicon.png') },
    supa && { label: 'Autenticação (Supabase)', note: 'GET /auth/v1/health', run: () => probe(`${supa}/auth/v1/health`) },
    supa && { label: 'Healthcheck do backend', note: 'GET /functions/v1/system-health — consulta real no banco', run: () => probe(`${supa}/functions/v1/system-health`) },
  ].filter(Boolean);

  const rows = [];
  for (const t of tests) {
    let r;
    try { r = await t.run(); } catch (e) { r = { ok: false, ms: null, detail: String(e.message || e) }; }
    // O teste opaco nunca pinta verde: ele não sabe se a resposta prestava.
    const st = t.neutral ? META.unknown : r.ok ? META.ok : META.fail;
    rows.push(`<div class="item" style="--st-color:${st.color};--st-bg:${st.bg};padding-left:0;padding-right:0">
      <span class="dot idot"></span>
      <div><div class="name">${escapeHtml(t.label)}${t.neutral ? '<span class="tag">inconclusivo por natureza</span>' : ''}</div>
      <div class="desc">${escapeHtml(r.detail)} — <span class="dim">${escapeHtml(t.note)}</span></div></div>
      <span class="lat">${r.ms != null ? r.ms + 'ms' : ''}</span>
    </div>`);
    out.innerHTML = rows.join('');
  }

  statusEl.textContent = `verificado às ${new Date().toLocaleTimeString('pt-BR')}`;
  btn.disabled = false;
}

async function probe(url) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    let extra = '';
    try {
      const j = await res.json();
      if (j.db) extra = ` · banco: ${j.db}${j.latency_ms != null ? ` (${j.latency_ms}ms)` : ''}`;
      else if (j.version) extra = ` · ${j.version}`;
    } catch { /* corpo não-JSON */ }
    return { ok: res.ok, ms, detail: `HTTP ${res.status}${extra}` };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), detail: e.name === 'AbortError' ? 'tempo esgotado' : 'não respondeu' };
  } finally {
    clearTimeout(timer);
  }
}

async function opaque(url) {
  const t0 = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store' });
    return { ok: true, ms: Math.round(performance.now() - t0), detail: 'o servidor aceitou a conexão' };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t0), detail: 'não foi possível conectar' };
  }
}

/* ------------------------------------------------------------- rodapé */

function runbookBlock(s) {
  const ref = s.target?.supabaseRef;
  const links = [
    ref && /^[a-z0-9-]+$/i.test(ref) && [`Logs das edge functions`, `https://supabase.com/dashboard/project/${ref}/functions`],
    ref && /^[a-z0-9-]+$/i.test(ref) && [`Saúde do banco (Supabase)`, `https://supabase.com/dashboard/project/${ref}/reports/database`],
    ref && /^[a-z0-9-]+$/i.test(ref) && [`Logs de autenticação`, `https://supabase.com/dashboard/project/${ref}/logs/auth-logs`],
    ['Status oficial do Supabase', 'https://status.supabase.com'],
    ['Execuções do monitor', 'https://github.com/devhuander/primedoctor-monitor-saude/actions'],
  ].filter(Boolean);

  return `<details class="section" data-key="runbook" style="--st-color:var(--accent);--st-bg:var(--accent-soft)">
    <summary><span class="chev">▶</span><span class="dot"></span><h3>Para onde ir quando algo está vermelho</h3>
    <span class="hint">atalhos de diagnóstico</span><span class="badge">Runbook</span></summary>
    <div class="items">
      <div class="item" style="grid-template-columns:1fr">
        <div>
          <div class="desc" style="margin-bottom:8px">
            <b>Ordem sugerida:</b> confira acima se o build mudou logo antes da falha →
            veja se alguma plataforma de terceiros relatou incidente →
            abra os logs da área que ficou vermelha.
          </div>
          <div class="links">${links.map(([t, u]) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(t)}</a>`).join('')}</div>
        </div>
      </div>
    </div>
  </details>`;
}

function notasBlock() {
  return `<div class="note">
    <b>Como ler esta página.</b>
    O monitor roda de hora em hora num servidor do GitHub, fora da infraestrutura do PrimeDoctor —
    se a hospedagem do sistema cair, esta página continua no ar. Antes de julgar qualquer coisa, ele
    testa a própria conexão: sem rede, o veredito é "sem informação", nunca "o sistema caiu".
    <br><br>
    <b>Limites honestos.</b>
    Verde significa que o caminho verificado respondeu — não que todos os fluxos do produto estejam
    corretos. As integrações são checadas por preflight: isso prova que a função está publicada e
    sobe, <b>não</b> que a lógica interna dela funciona. A frequência é horária, então uma queda
    curta entre dois ciclos pode não aparecer.
    <br><br>
    <b>Privacidade.</b> Nenhum dado de paciente, clínica ou usuário é publicado. As sondas gravam
    latência, código de resposta e contagem de linhas — nunca o conteúdo delas. Erros de JavaScript
    são publicados apenas como <i>categoria e contagem</i>: o texto original nunca sai daqui, porque
    este repositório é público e o histórico do git é permanente.
  </div>`;
}

function rodape(s) {
  const url = safeExternalUrl(s.target.url) || '#';
  return `<footer>
    Alvo: <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
    ${(s.target.alternateUrls || []).map((u) => { const safe = safeExternalUrl(u); return safe ? ` · <a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(safe.replace(/^https?:\/\//, ''))}</a>` : ''; }).join('')}
    · <a href="https://github.com/devhuander/primedoctor-monitor-saude" target="_blank" rel="noopener">código-fonte</a>
    <br>Esta página se atualiza sozinha a cada 5 minutos. Os horários aparecem no seu fuso e em UTC — os logs do Supabase e do GitHub usam UTC.
  </footer>`;
}

/* ------------------------------------------------------------- helpers */

/** Só deixa passar http/https: bloqueia javascript: vindo de uma variável mal preenchida. */
function safeExternalUrl(u) {
  try {
    const p = new URL(String(u));
    return /^https?:$/.test(p.protocol) ? p.toString().replace(/\/$/, '') : null;
  } catch { return null; }
}

function fmt(v) {
  if (v == null) return '—';
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function relTime(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.round(h / 24)} dia(s)`;
}

function fmtLocal(iso) {
  const d = new Date(iso);
  return Number.isNaN(+d) ? '—' : d.toLocaleString('pt-BR');
}

function fmtUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function pad(s, n) {
  const v = String(s ?? '');
  return v.length >= n ? v.slice(0, n) : v + ' '.repeat(n - v.length);
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
