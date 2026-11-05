// Configuração central do monitor.
// Nada aqui é segredo: a anon key do Supabase é pública por design (vai no bundle
// do front-end e é protegida por RLS). Credenciais do usuário-monitor vêm de
// variáveis de ambiente (GitHub Secrets) e nunca são gravadas em disco.

export const CONFIG = {
  app: {
    name: 'PrimeDoctor',
    baseUrl: process.env.PD_APP_URL || 'https://primedoctor.app',
    publicRoute: '/auth',
    spaFallbackRoute: '/__monitor_spa_fallback_check__',
    // favicon.png, não .ico: é o ícone que o index.html do PrimeDoctor declara
    // (`<link rel="icon" href="/favicon.png">`). O favicon.ico foi removido do
    // projeto em 27/09/2026 e o site não usa mais — exigir o .ico deixava a
    // seção degradada para sempre sem nenhum efeito para o usuário.
    staticAssets: ['/manifest.json', '/favicon.png', '/robots.txt'],

    // O mesmo app responde por mais de um endereço. Cada domínio tem seu
    // próprio DNS e seu próprio certificado, então um pode quebrar sozinho —
    // e saber QUAL quebrou é metade do diagnóstico. Estes recebem uma sonda
    // mais leve (DNS + TLS + documento), sem navegador.
    // Atenção ao `??`: com `||`, definir a variável como string vazia (para
    // desativar a checagem) caía silenciosamente no valor padrão.
    alternateUrls: (process.env.PD_APP_ALT_URLS ?? 'https://primedoctor.primemedicalgo.com.br')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  supabase: {
    url: process.env.PD_SUPABASE_URL || 'https://iewdxiggqwyjdqbtmojm.supabase.co',
    anonKey:
      process.env.PD_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlld2R4aWdncXd5amRxYnRtb2ptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxMjUxNDQsImV4cCI6MjA4NDcwMTE0NH0.p6bj0810m9NK9YJL6fs5QcbNKYBJ69xg7-tTsj1TJ9U',
  },

  auth: {
    email: process.env.PD_MONITOR_EMAIL || '',
    password: process.env.PD_MONITOR_PASSWORD || '',
  },

  // Token do ping de prontidão das edge functions (_shared/monitorPing.ts no
  // repositório do PrimeDoctor). Precisa ter o MESMO valor do secret
  // MONITOR_PING_TOKEN no projeto Supabase. Sem ele, o monitor continua
  // checando se a função está publicada, mas não se ela está pronta.
  pingToken: process.env.PD_MONITOR_PING_TOKEN || '',

  // Alvos de controle: servem para distinguir "o PrimeDoctor caiu" de
  // "o runner do monitor está sem rede". Se TODOS falharem, o veredito da
  // execução inteira vira "indeterminado" e nenhum alarme é disparado.
  controlTargets: (
    process.env.PD_CONTROL_TARGETS ??
    'https://www.githubstatus.com/api/v2/status.json,https://cloudflare-dns.com/dns-query?name=example.com&type=A'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  edge: {
    // Slug que garantidamente não existe. Se ele responder qualquer coisa
    // diferente de 404, a técnica de detecção está quebrada e a seção inteira
    // é marcada como não confiável, em vez de mentir em verde.
    canarySlug: '__monitor_canary_nao_existe__',
    functions: [
      { name: 'system-health', label: 'Healthcheck do backend', critical: true },
      { name: 'whatsapp-gateway', label: 'Gateway WhatsApp', critical: true },
      { name: 'zapi-webhook', label: 'Webhook Z-API', critical: true },
      { name: 'meta-whatsapp-webhook', label: 'Webhook Meta WhatsApp', critical: true },
      { name: 'lead-capture-webhook', label: 'Captação de leads', critical: true },
      { name: 'send-whatsapp', label: 'Envio de WhatsApp', critical: true },
      { name: 'google-calendar', label: 'Google Agenda', critical: true },
      { name: 'ai-engine', label: 'Motor de IA', critical: false },
      { name: 'ai-attendant', label: 'Atendente IA', critical: false },
      { name: 'inngest', label: 'Fila de jobs (Inngest)', critical: false },
      { name: 'submit-form-response', label: 'Fichas de paciente', critical: false },
      { name: 'print-job-create', label: 'Impressão', critical: false },
      { name: 'embed-form-config', label: 'Formulários embed', critical: false },
    ],
  },

  // Tabelas lidas para provar o caminho completo: rede → PostgREST → Postgres → RLS.
  // Gravamos apenas latência, contagem e sucesso/erro — nunca o conteúdo das linhas.
  //
  // `expectRows` é o que transforma esta sonda em algo útil: HTTP 200 com lista
  // vazia é o sintoma clássico de policy de RLS quebrada por migration. Sem essa
  // asserção, o modo de falha mais caro deste stack passa despercebido.
  dbProbes: [
    { table: 'profiles', label: 'Perfis', authOnly: true, expectRows: true },
    { table: 'clinic_members', label: 'Membros de clínica', authOnly: true, expectRows: true },
    { table: 'clinics', label: 'Clínicas', authOnly: true, expectRows: true },
    { table: 'consultation_types', label: 'Tipos de consulta', authOnly: true, expectRows: false },
    { table: 'event_statuses', label: 'Status de agenda', authOnly: true, expectRows: false },
  ],

  upstreams: [
    { key: 'supabase', label: 'Supabase', url: 'https://status.supabase.com/api/v2/status.json' },
    { key: 'lovable', label: 'Lovable', url: 'https://status.lovable.dev/api/v2/status.json' },
    { key: 'cloudflare', label: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
    { key: 'github', label: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json' },
  ],

  thresholds: {
    httpWarn: 1500,
    httpFail: 6000,
    dbWarn: 900,
    dbFail: 4000,
    edgeWarn: 2500,
    edgeFail: 9000,
    pageLoadWarn: 6000,
    pageLoadFail: 15000,
    lcpWarn: 2500,
    lcpFail: 4500,
    tlsExpiryWarnDays: 21,
    tlsExpiryFailDays: 7,
  },

  timeouts: {
    http: 15000,
    edge: 12000,
    browser: 45000,
    realtime: 10000,
  },

  alarm: {
    // Uma execução ruim isolada não vira alarme. O runner do GitHub tem vizinho
    // barulhento e cold start; n=1 produz alarme falso e treina o time a ignorar.
    consecutiveBadRuns: 2,
  },

  history: {
    // 30 dias de execuções horárias. Arquivo append-only (JSONL) para que o git
    // consiga fazer delta entre commits em vez de gravar um blob novo por hora.
    maxEntries: 24 * 30,
  },
};

export const STATUS = {
  OK: 'ok',
  DEGRADED: 'degraded',
  FAIL: 'fail',
  SKIPPED: 'skipped',
  UNKNOWN: 'unknown',
};

// Severidade. `skipped` e `unknown` valem MAIS que `ok` de propósito: uma
// verificação que não rodou não pode produzir a frase "todos os sistemas
// operacionais". Silêncio não é sinal de saúde.
const RANK = { ok: 0, skipped: 1, unknown: 2, degraded: 3, fail: 4 };

export function worstStatus(list) {
  const values = list.filter(Boolean);
  if (!values.length) return STATUS.UNKNOWN;
  let worst = STATUS.OK;
  for (const s of values) {
    const rank = RANK[s];
    if (rank === undefined) return STATUS.UNKNOWN; // status desconhecido = não confie
    if (rank > RANK[worst]) worst = s;
  }
  return worst;
}

/** Status considerado "ruim" para efeito de incidente e alarme. */
export function isBad(status) {
  return status === STATUS.FAIL || status === STATUS.DEGRADED;
}

export function statusFromLatency(ms, warn, fail) {
  if (ms == null) return STATUS.UNKNOWN;
  if (ms >= fail) return STATUS.FAIL;
  if (ms >= warn) return STATUS.DEGRADED;
  return STATUS.OK;
}
