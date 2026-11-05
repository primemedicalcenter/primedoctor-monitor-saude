import { CONFIG, STATUS } from '../config.mjs';
import { timedFetch } from '../lib/http.mjs';

const MAP = {
  none: STATUS.OK,
  minor: STATUS.DEGRADED,
  major: STATUS.FAIL,
  critical: STATUS.FAIL,
  maintenance: STATUS.DEGRADED,
};

/**
 * Status oficial das plataformas de que o PrimeDoctor depende.
 * Serve para responder "o problema é meu ou do fornecedor?" — por isso é
 * informativo e NÃO entra no cálculo do status geral do sistema.
 */
export async function checkUpstreams() {
  const items = [];
  for (const up of CONFIG.upstreams) {
    // O summary.json da Cloudflare tem ~220 kB (todos os datacenters); cortar
    // no meio deixaria o JSON inválido e a avaliação viraria "unknown".
    const r = await timedFetch(up.url, { timeoutMs: 12000, maxBody: up.mode === 'cloudflare' ? 2_000_000 : 4000 });
    if (!r.ok) {
      items.push({
        key: up.key,
        label: up.label,
        status: STATUS.UNKNOWN,
        latencyMs: r.ms,
        detail: 'página de status indisponível',
        meta: {},
      });
      continue;
    }
    let json = {};
    try { json = JSON.parse(r.body || '{}'); } catch { /* ignore */ }
    if (up.mode === 'cloudflare') {
      const v = avaliarCloudflare(json, CONFIG.cloudflare);
      items.push({ key: up.key, label: up.label, latencyMs: r.ms, ...v });
      continue;
    }
    const indicator = json?.status?.indicator || 'unknown';
    items.push({
      key: up.key,
      label: up.label,
      status: MAP[indicator] ?? STATUS.UNKNOWN,
      latencyMs: r.ms,
      detail: json?.status?.description || indicator,
      meta: { indicator },
    });
  }

  const problems = items.filter((i) => i.status === STATUS.FAIL || i.status === STATUS.DEGRADED);
  const unknown = items.filter((i) => i.status === STATUS.UNKNOWN);
  let detail;
  if (problems.length) detail = `${problems.map((p) => p.label).join(', ')} relatando incidente`;
  else if (unknown.length === items.length) detail = 'não foi possível consultar as páginas de status';
  else if (unknown.length) detail = `nenhum incidente relatado · ${unknown.length} sem resposta`;
  else detail = 'nenhum incidente relatado';

  // A seção é informativa e não derruba o status geral do produto — mas não
  // pode ficar pregada em verde por construção: quando nenhuma página de
  // status responde, o sinal honesto é "indeterminado".
  const allUnknown = unknown.length === items.length && items.length > 0;

  return {
    key: 'upstream',
    label: 'Plataformas de terceiros',
    informational: true,
    status: allUnknown ? STATUS.UNKNOWN : problems.length ? STATUS.DEGRADED : STATUS.OK,
    latencyMs: null,
    items,
    detail,
    meta: {},
  };
}

const IMPACTO = { critical: STATUS.FAIL, major: STATUS.FAIL, minor: STATUS.DEGRADED, none: STATUS.DEGRADED };
const SITUACAO = {
  operational: STATUS.OK,
  under_maintenance: STATUS.OK, // planejada; o tráfego já foi desviado
  degraded_performance: STATUS.DEGRADED,
  partial_outage: STATUS.DEGRADED,
  major_outage: STATUS.FAIL,
};
const RANK = { [STATUS.OK]: 0, [STATUS.DEGRADED]: 1, [STATUS.FAIL]: 2 };
const pior = (a, b) => (RANK[b] > RANK[a] ? b : a);
const curto = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 100);

/**
 * Julga a Cloudflare pelo que pode afetar o PrimeDoctor, em vez do indicador
 * geral (que vive em "Partial System Outage" por causa de datacenters caídos do
 * outro lado do mundo). Função pura: recebe o summary.json e a config.
 *
 *  - incidente aberto que cite um serviço relevante ou um datacenter da lista
 *    → major/critical = fail, minor = degraded;
 *  - incidente aberto SEM componentes e com impacto major/critical → conta
 *    (não dá para saber o alcance; silêncio não é saúde);
 *  - serviço relevante fora do normal → degraded/fail pela situação dele;
 *  - datacenter da lista caído → degraded (o tráfego vai para o vizinho);
 *    TODOS caídos → fail;
 *  - nenhum datacenter da lista encontrado no summary → unknown (os nomes
 *    mudaram e a sonda ficou cega).
 */
export function avaliarCloudflare(summary, cfg) {
  const comps = Array.isArray(summary?.components) ? summary.components : null;
  if (!comps) {
    return { status: STATUS.UNKNOWN, detail: 'resposta da página de status sem componentes', meta: {} };
  }
  const servicos = new Set(cfg.services);
  const codigo = (nome) => /\(([A-Z]{3})\)\s*$/.exec(nome || '')?.[1] ?? null;
  const dcs = new Map();
  for (const c of comps) {
    const k = codigo(c.name);
    if (k && cfg.datacenters.includes(k)) dcs.set(k, c.status);
  }
  if (dcs.size === 0) {
    return { status: STATUS.UNKNOWN, detail: 'nenhum datacenter monitorado encontrado na página de status', meta: {} };
  }

  let status = STATUS.OK;
  const motivos = [];

  const incidentes = Array.isArray(summary.incidents) ? summary.incidents : [];
  let outros = 0;
  for (const inc of incidentes) {
    const nomes = (inc.components || []).map((c) => c.name);
    const relevante = nomes.length
      ? nomes.some((n) => servicos.has(n) || cfg.datacenters.includes(codigo(n)))
      : inc.impact === 'major' || inc.impact === 'critical';
    if (!relevante) { outros++; continue; }
    status = pior(status, IMPACTO[inc.impact] ?? STATUS.DEGRADED);
    motivos.push(`incidente: ${curto(inc.name)}`);
  }

  for (const c of comps) {
    if (!servicos.has(c.name)) continue;
    const s = SITUACAO[c.status] ?? STATUS.DEGRADED;
    if (s !== STATUS.OK) { status = pior(status, s); motivos.push(`${c.name}: ${c.status}`); }
  }

  const caidos = [...dcs].filter(([, st]) => (SITUACAO[st] ?? STATUS.DEGRADED) !== STATUS.OK);
  if (caidos.length) {
    status = pior(status, caidos.length === dcs.size ? STATUS.FAIL : STATUS.DEGRADED);
    motivos.push(`datacenter ${caidos.map(([k, st]) => `${k} ${st}`).join(', ')}`);
  }

  const foraNoMundo = comps.filter((c) => codigo(c.name) && c.status === 'major_outage').length;
  const contexto = [];
  if (outros) contexto.push(`${outros} incidente(s) em serviços que o PrimeDoctor não usa`);
  if (foraNoMundo) contexto.push(`${foraNoMundo} datacenter(s) fora no mundo`);

  const detail = motivos.length
    ? motivos.join(' · ')
    : ['nada que afete o PrimeDoctor', ...contexto].join(' · ');
  return {
    status,
    detail,
    meta: { indicator: summary?.status?.indicator ?? null, datacenters: Object.fromEntries(dcs) },
  };
}
