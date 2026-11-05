# Handoff — continuar no Claude Code

Documento de passagem. Apague quando a lista de tarefas estiver zerada.

**Contexto e regras invioláveis: leia `CLAUDE.md` primeiro.** O `README.md`
explica o porquê de cada decisão de projeto.

---

## 05/11/2026 — "banco lento" no system-health era rede, não banco

Medido: `EXPLAIN ANALYZE select count(*) from clinics` executa em **0,125 ms**;
cache hit 99,6 %; 59 de 90 conexões, 2 ativas. Chamando o system-health 8 vezes
seguidas daqui: tempo interno da função 190–390 ms, total 0,6–1,0 s. A função
roda em `us-east-1` (cabeçalho `x-sb-edge-region`, a mais perto de quem chama)
e o tempo é a ida até a API do Supabase. No histórico (432 execuções) o tempo
total passava de 900 ms em 20,8 % das vezes. `dbWarn` subiu para **1500 ms**
(5,1 %); `dbFail` segue em 4000. O limite vale para auth, PostgREST, consultas,
storage e system-health — todos medem a mesma rede.

---

## 05/11/2026 — disparo externo ligado (fim dos "dados velhos")

**Problema:** a página mostrava "Estes dados estão velhos". Medido nas 40
execuções `schedule` de 27/10 a 05/11: mesmo com o repositório **público**, o
agendador do GitHub disparou só a cada **4 a 8 horas**, apesar do
`cron: '17,47 * * * *'`. Já o `workflow_dispatch` começa na hora.

**Solução aplicada (opção 2 da seção de 28/08):** cron-job.org, job
"PrimeDoctor - Status", `7 * * * *` (minuto 7 de toda hora), `POST` em
`https://api.github.com/repos/primemedicalcenter/primedoctor-monitor-saude/actions/workflows/monitor.yml/dispatches`
com corpo `{"ref":"main"}` e PAT fine-grained (Actions: read and write, só
este repositório). O token fica **só** no cron-job.org.

- Verificado: o "Test run" devolveu 204 e criou a execução #441
  (`workflow_dispatch`, 16:49:18 UTC) no mesmo segundo.
- **Token expira em 06/11/2027.** Renovar antes, senão o disparo volta a
  depender só do agendador do GitHub. O cron-job.org está com "notify on
  failure" ligado: um 401 na hora da expiração gera e-mail.
- O GitHub responde `Deprecation` para `X-GitHub-Api-Version: 2022-11-28`
  (sunset 10/03/2028). Trocar a versão do cabeçalho até lá.
- O `schedule` do workflow fica como reserva; `concurrency` impede execuções
  simultâneas.
- Mesmo dia: a sonda de arquivos estáticos passou a conferir `/favicon.png`
  (o `.ico` foi removido do PrimeDoctor em 27/09 e deixava o front-end
  degradado desde então) — commit `e8f28e7`.

---

## 28/08 — o cron do GitHub degrada em repositório privado

Medido nas execuções `schedule` reais: em 25/08 o cron das :17 disparava
~de hora em hora com 30-50 min de atraso; a partir da noite de 26/08 abriu
buracos de **4 a 11 horas** (26/08 19:19 → 23:30 → 27/08 09:46 → 20:29 →
28/08 05:22). Não é defeito do YAML — quando dispara, conclui normalmente.
É o agendador do GitHub, que a própria documentação define como best-effort
("pode atrasar ou descartar sob carga"), e que na prática é severamente
despriorizado em repositório **privado** no plano Free.

Mitigação aplicada: `cron: '17,47 * * * *'` (duas tentativas/hora; as
descartadas não custam nada). Isso melhora, mas **não garante** hora em hora.
As soluções definitivas, em ordem de preferência:

1. **Tornar o repositório público** — é a premissa de todo o projeto
   (CLAUDE.md regra 1: a sanitização inteira existe para isso), zera o custo
   de minutos de Actions e melhora a prioridade do agendador. Atenção antes:
   nada de segredo no histórico (a revisão de segurança de 24/08 não achou;
   os secrets vivem só em GitHub Secrets).
2. **Disparador externo**: um cron confiável (ex.: cron-job.org, gratuito)
   fazendo POST de hora em hora em
   `https://api.github.com/repos/devhuander/primedoctor-monitor-saude/actions/workflows/monitor.yml/dispatches`
   com corpo `{"ref":"main"}` e o PAT fine-grained que já existe (escopo
   Actions: write só neste repo). GitHub cron vira redundância.
3. Enquanto (1)/(2) não acontecem: ajustar o *grace period* do check no
   healthchecks.io para ~2-3h, senão o dead-man's switch alarma por culpa do
   agendador, não do PrimeDoctor.

**Custo de minutos (só relevante enquanto privado):** cada execução cobra
~4 min (jobs arredondados para cima). 1/hora ≈ 2.900 min/mês — já acima dos
2.000 do plano Free; 2 tentativas/hora, se o agendador voltar a disparar
todas, ≈ 5.800/mês. Público: ilimitado. Se for manter privado por muito
tempo, considerar voltar a 1 tentativa/hora e usar a solução (2).

---

## Situação em 21/08/2026

### Já concluído e publicado

| O quê | Onde | Estado |
|---|---|---|
| Sondas, página de status, testes, documentação | `devhuander/primedoctor-monitor-saude`, `main` até `186e5fe` | publicado |
| `_shared/monitorPing.ts` + ping em 7 edge functions | `devhuander/primedoctor`, `feature/claude`, commit `acb74c563` | publicado e **deployado pelo Lovable** |
| Secrets do repositório | `PD_MONITOR_EMAIL`, `PD_MONITOR_PASSWORD`, `PD_MONITOR_PING_TOKEN`, `HEARTBEAT_URL` | criados pelo usuário |
| Secret do Supabase | `MONITOR_PING_TOKEN` | criado pelo usuário |
| PAT com escopo `workflow` | fine-grained, `Read and write` em code and workflows | liberado |

### Pendente — não commitado, apenas no disco

A VM Linux da sessão anterior caiu antes do último push. Estes arquivos estão
alterados no diretório de trabalho e **ainda não foram commitados**:

- `.github/workflows/monitor.yml` — **nunca foi enviado ao GitHub** (o PAT
  anterior não tinha escopo `workflow`). É o arquivo mais importante: sem ele
  nada roda automaticamente.
- `README.md` — seção de alerta reescrita em torno do healthchecks.io.
- `HANDOFF.md` — este arquivo.

---

## Situação em 24/08/2026 (sessão remota)

A tarefa 1 foi cumprida: o usuário empurrou o pendente na `main` (commit
`58d3ffc`) e `npm test` + `npm run test:page` passam integralmente sobre esse
estado.

O push disparou a primeira execução — e ela morreu em `startup_failure`,
antes de criar qualquer job. Bisseção com um workflow descartável (9
execuções na branch `claude/handoff-task-continuation-hqns9k`) provou:

- o `monitor.yml` é **válido** (actionlint zero achados; uma cópia estrutural
  com os mesmos gatilhos, permissões, `environment` e expressões roda);
- qualquer passo `uses:` de action externa mata a execução na partida —
  `actions/checkout@v4` sozinho reproduz, e `@v5` falha igual, o que descarta
  depreciação de versão;
- sem nenhum `uses:`, os jobs nascem e rodam.

**Causa: a política de GitHub Actions do repositório está bloqueando actions
externas** (modo "Allow select actions" sem liberar nem as do próprio GitHub,
ou "local only"). Isso é configuração, só o dono altera:

> `Settings` → `Actions` → `General` → **Actions permissions** →
> marcar **"Allow all actions and reusable workflows"** (ou, no mínimo,
> "Allow <owner>, and select non-<owner>, actions" + caixa
> **"Allow actions created by GitHub"** — o workflow só usa actions oficiais).

Depois de mudar, basta `Actions` → `Monitor de saúde` → `Run workflow` (ou
esperar o cron das :17).

**Atenção: o repositório está PRIVADO.** Duas consequências:

1. O `CLAUDE.md` e toda a política de sanitização partem de "repositório
   público" — privado hoje não fere nada, mas se a intenção é abrir depois,
   nada muda; se a intenção é manter privado, o GitHub Pages de repositório
   privado exige plano pago (senão o job `publicar` falha mesmo com a
   política corrigida).
2. Página pública de status em repo privado continua acessível a qualquer um
   que tenha a URL do Pages — o Pages publicado é sempre público.

## Atualização 24/08 ~18h UTC — política liberada, primeira execução real rodou

O dono liberou a política de Actions e ligou o Pages. A execução nº 3 completou
os 4 jobs: `verificar` ✓, `publicar` ✓ (página no ar), `persistir` ✓ (dados na
`main`), `alertar` pulado (1ª execução ruim não alarma — correto). Resultado da
primeira rodada real, item a item:

- canário `__canary__`: **ok** — detecção validada em produção;
- 13 funções publicadas e roteáveis;
- **nenhum secret chegou à execução**: `prontidão não verificada (sem
  PD_MONITOR_PING_TOKEN)`, `database: sem sessão`, `authed.flow: usuário-monitor
  não configurado`, e o pulso de heartbeat foi *skipped* (HEARTBEAT_URL vazio).
  Os quatro secrets do repositório não estão visíveis ao workflow — conferir se
  foram criados como **Repository secrets** deste repositório (Settings →
  Secrets and variables → Actions → aba "Secrets" → "Repository secrets"), e
  não como Variables, secrets de Environment (`github-pages`) ou no repositório
  errado;
- `postgrest: HTTP 401` com a anon key (idêntica à do app, conferida no código
  do PrimeDoctor). Hipóteses: transitório (upstream registrou "Supabase:
  Partially Degraded Service") ou JWT secret do projeto rotacionado (o gateway
  aceita a anon key como apikey literal, mas o PostgREST valida a ASSINATURA —
  explica auth/storage/functions ok com REST 401). Se persistir nas próximas
  execuções com os secrets configurados (bearer vira o token da sessão), o
  item resolve sozinho; se persistir mesmo assim, é rotação de chave.

**Defeito real pego pela execução nº 4 (cron, enfileirada atrás da nº 3):**
ela nasceu com o SHA de antes do commit de dados da nº 3 — o `persistir`
conflitou em add/add nas 5 tentativas (o `alertar` disparou por isso,
corretamente), e o `verificar` rodou sem enxergar o histórico, então a regra
de "2 ruins consecutivas ⇒ alarme" não contou a segunda como segunda. Conserto
nesta branch: `ref: main` nos dois checkouts. Até chegar à `main`, o cron
horário sozinho não sofre disso (só execuções enfileiradas atrás de outra).

**Workflow Jekyll intruso**: ao ligar o Pages, o assistente do GitHub commitou
`.github/workflows/jekyll-gh-pages.yml` na `main` (9f9257c). Ele deploya o
README renderizado por cima do painel a cada push na `main` (os commits do
monitor têm `[skip ci]`, mas pushes manuais disparam os dois deploys em
corrida). A remoção está nesta branch.

## Tarefas, em ordem

### 1. ~~Commitar e enviar o que ficou pendente~~ — FEITO (58d3ffc)

### 1b. ~~Destravar a política de Actions~~ — FEITO pelo dono (24/08 ~17:33 UTC)

### 1c. Fazer os secrets chegarem ao workflow — pendente, só o dono consegue

### 1-original. Commitar e enviar o que ficou pendente

```bash
cd D:\GitHub\primedoctor-monitor-saude
git status                      # confirmar os 3 arquivos acima
npm test                        # 14 casos de lógica + 15 verificações e2e
npm run test:page               # render em jsdom + XSS  (precisa de: npm i --no-save jsdom)
git add -A
git commit
git push origin main
```

Mensagem de commit sugerida:

```
feat(alerta): healthchecks.io vira o canal principal, sem exigir Slack ou Discord

Quem não usa Slack nem Discord ficava sem canal de alerta — e sem canal, isto é
um painel de status, não um monitor: ninguém é acordado às 3h.

O HEARTBEAT_URL já estava configurado como dead-man's switch. O mesmo endpoint
aceita <URL>/fail, que marca a checagem como down e dispara os canais de
notificação já cadastrados lá. Passa a servir para as duas coisas:

- pulso de sucesso só quando NÃO há alarme (antes era enviado sempre, o que
  mascararia uma falha confirmada);
- POST em /fail quando há alarme, com o resumo e o link da execução.

MONITOR_WEBHOOK_URL continua existindo, agora explicitamente opcional.

Inclui o workflow, que não pôde ser enviado antes por falta do escopo `workflow`
no token.
```

O push já dispara a primeira execução: o gatilho `push` cobre
`.github/workflows/monitor.yml`.

### 2. Ligar o GitHub Pages

`Settings` → `Pages` → **Source: GitHub Actions**.

Se ainda não estiver ligado, o job `publicar` falha e o `alertar` dispara — é o
comportamento correto, não um bug.

### 3. Validar a primeira execução de verdade

Nenhuma sessão anterior conseguiu rodar as sondas contra a produção: o sandbox
só alcançava `github.com` e o registry do npm. **Esta é a primeira validação
real.** Confira, em `Actions` → última execução:

- [ ] `verificar` terminou. O *step summary* traz a tabela por área.
- [ ] `persistir` commitou `data/status.json` e `data/history.jsonl` na `main`.
- [ ] `publicar` deployou; a página abre em
      https://devhuander.github.io/primedoctor-monitor-saude/
- [ ] O check no healthchecks.io recebeu o pulso.

Depois abra `data/status.json` e verifique item por item:

| O que olhar | Esperado | Se vier diferente |
|---|---|---|
| `sections[].items` do `edge`, item `__canary__` | `ok` | Se vier `unknown`, a técnica de detecção quebrou e **nenhuma função foi verificada**. Investigue antes de qualquer outra coisa. |
| Demais funções de `edge` | `ok`, detalhe com `pronta (secrets presentes)` | `não verificável` significa que o gateway recusou antes de rotear — reveja o `Authorization: Bearer <anonKey>` em `probe/checks/edge.mjs`. |
| `backend` → `database` → `meta.probes` | `profiles`, `clinic_members` e `clinics` com `rows >= 1` | `ZERO linhas` provavelmente é permissão do usuário-monitor, não RLS quebrada. Confira antes de sair caçando bug. |
| `experience` → `authed.components` | `ok` | `sonda desatualizada` = os seletores `#signin-email` / `#signin-password` mudaram no app. |
| `overall.status` | `ok` | `skipped`/`unknown` indica verificação que não rodou — veja qual seção. |
| `monitorFault` | `false` | `true` = credencial do monitor recusada. É configuração, não falha do produto. |

**Cuidado com o falso alarme na estreia:** o `alertar` só dispara com duas
execuções ruins consecutivas, então a primeira execução nunca alarma, mesmo com
algo vermelho. Isso é intencional.

### 4. Rodar `security-review` antes de considerar pronto

O repositório é público e o workflow autentica em produção. Vale a passada extra.

### 5. Domínio `status.primedoctor.app` — nesta ordem

1. DNS de `primedoctor.app`: CNAME `status` → `devhuander.github.io`
2. Esperar propagar: `nslookup status.primedoctor.app`
3. **Só então** criar a variável (aba *Variables*, não *Secrets*)
   `PD_CUSTOM_DOMAIN` = `status.primedoctor.app`
4. Rodar o workflow de novo

Inverter a ordem faz o GitHub redirecionar o endereço `.github.io` para um
domínio que ainda não resolve — a página fica inacessível pelos dois caminhos.

---

## Pontos de atenção herdados

- **`data/` nunca é commitado à mão.** Quem escreve ali é o workflow. Os testes
  limpam sozinhos ao terminar.
- **Mudou o formato do relatório?** Incremente `schemaVersion` em
  `probe/run.mjs` **e** `SCHEMA_SUPORTADO` em `site/app.js`, e atualize
  `tools/gerar-dados-demo.mjs`. A página detecta divergência e avisa em vez de
  renderizar lixo.
- **Nunca adicione gatilho `pull_request`** ao workflow: daria a PRs de
  terceiros um caminho para as credenciais de produção.
- **O repositório `D:\GitHub\primedoctor` tem outras sessões trabalhando.**
  Na sessão anterior havia um `.git/index.lock` órfão e alterações não
  commitadas de outra tarefa. Antes de commitar ali, confira `git status` e
  commite apenas os seus arquivos.

## Limitação conhecida que continua aberta

O ping confere se os secrets estão **presentes**, não se são **válidos**: um
token Z-API presente porém expirado passa como pronto. Cobrir isso exigiria uma
chamada real ao provedor, com custo e efeito colateral — decisão consciente de
não fazer.
