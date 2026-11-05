# PrimeDoctor — Monitor de Saúde

Monitoramento **externo e independente** do sistema [PrimeDoctor](https://primedoctor.app).

Roda inteiramente no GitHub — fora da Lovable, fora do Supabase, fora do DNS do
`primedoctor.app`. Se a hospedagem do sistema cair, esta página continua no ar
justamente para mostrar que caiu.

- **Página de status:** https://devhuander.github.io/primedoctor-monitor-saude/
  (e `https://status.primedoctor.app` depois que o DNS for configurado — veja abaixo)
- **Frequência:** de hora em hora, mais execução manual sob demanda
- **Custo:** zero (Actions ilimitado em repositório público)

---

## O que é verificado

| Área | O que a sonda faz | O que isso prova |
|---|---|---|
| **Hospedagem e front-end** | DNS, certificado TLS (validade **e** se cobre o domínio), documento HTML, cada bundle JS/CSS do build, `manifest.json`/`favicon.png`/`robots.txt`, roteamento de link direto e o **domínio alternativo** servindo o mesmo build | o site está no ar, servindo um build completo, por todos os domínios |
| **Banco de dados e backend** | GoTrue, PostgREST, o healthcheck próprio do PrimeDoctor, leitura de 5 tabelas **com asserção de linhas**, WebSocket do Realtime e o Storage | o caminho rede → PostgREST → Postgres → RLS funciona de ponta a ponta |
| **Funções de borda** | 13 edge functions críticas, via preflight CORS autenticado, mais um **canário 404** que valida a própria sonda | as funções existem, estão roteáveis e sobem |
| **Experiência de carregamento** | Chromium real: TTFB, DOMContentLoaded, FCP, LCP, CLS, tempo até o app montar, login pelo formulário real, erros de console e requisições falhas | um usuário de verdade consegue abrir e entrar no sistema |
| **Plataformas de terceiros** | status oficial de Supabase, Lovable, Cloudflare e GitHub | responde "o problema é meu ou do fornecedor?" — informativo, não derruba o status geral |

### Antes de julgar, o monitor testa a si mesmo

Um runner sem rede produz exatamente a mesma saída de uma queda total do
sistema: tudo vermelho, incidente aberto, alarme disparado. Por isso cada
execução começa batendo em **alvos de controle** externos. Se nenhum responder,
o veredito é *"o monitor está sem rede"* e **nada é alarmado** — o monitor não
tem autoridade para afirmar que o sistema caiu.

### Por que preflight CORS nas edge functions — e o que ele NÃO prova

O relay do Supabase valida o JWT **antes** de resolver o slug da função. Como
quase todas as functions do PrimeDoctor têm `verify_jwt = true`, uma sonda que
mande só a `apikey` recebe 401 tanto de função publicada quanto de função
**deletada**. Traduzir esse 401 para "publicada" deixaria a maioria dos cartões
verdes para sempre. Aqui:

1. a requisição vai com `Authorization: Bearer <anonKey>`, para que um slug
   inexistente devolva 404 de verdade;
2. 401/403 **nunca** vira "ok" — vira *não verificável*;
3. um **canário** (slug que não existe) precisa devolver 404 a cada execução.
   Se parar de devolver, a seção inteira se declara não confiável em vez de
   continuar publicando verde.

`OPTIONS` retorna no topo do handler, então a checagem não dispara mensagem de
WhatsApp, não grava lead e não consome crédito de IA na maioria das funções.

### Prontidão: publicada é diferente de operacional

O preflight prova que a função existe e faz boot. Não prova que ela consegue
trabalhar: `zapi-webhook` sem `ZAPI_WEBHOOK_SECRET` **recusa todas as
requisições** e ainda assim responde o preflight normalmente. De fora, o webhook
parece saudável enquanto nenhuma mensagem entra.

Por isso o repositório do PrimeDoctor ganhou `supabase/functions/_shared/monitorPing.ts`.
Cada função crítica declara de quais variáveis de ambiente depende; o monitor faz
um GET com o header `X-Monitor-Ping` e recebe se a função está pronta. Nada de
lógica de negócio roda — a checagem sai antes de qualquer efeito colateral.

Para ativar, o **mesmo valor** precisa estar nos dois lugares:

| Onde | Nome |
|---|---|
| Secrets do projeto Supabase (Edge Functions) | `MONITOR_PING_TOKEN` |
| Secrets deste repositório (Actions) | `PD_MONITOR_PING_TOKEN` |

Sem isso, o monitor continua checando se a função está publicada e apenas
informa que a prontidão não foi verificada — nada é reprovado por engano.
O ping devolve só **nomes** de variáveis ausentes, nunca valores, e compara o
token por digest SHA-256.

> **O que ainda fica de fora.** O ping confere presença de secrets, não a
> validade deles: um token Z-API presente porém expirado passa. Cobrir isso
> exigiria uma chamada real ao provedor, com custo e efeito colateral.

### Por que a asserção de linhas no banco importa

`HTTP 200` com lista vazia é o sintoma clássico de policy de RLS quebrada por
migration: todo usuário vê telas em branco e um monitor ingênuo fica verde.
As sondas de `profiles`, `clinic_members` e `clinics` exigem **pelo menos uma
linha visível** — o usuário-monitor tem obrigatoriamente que enxergar a própria.

### Erros de JavaScript não derrubam o status

O app tem centenas de `console.error` legítimos, e SPAs disparam exceções
benignas o tempo todo (fetch abortado em unmount, SDK de terceiro). Tratar isso
como falha garantiria vermelho permanente — e uma página vermelha permanente é
uma página que ninguém abre. Os erros aparecem como **informativos**,
categorizados e contados.

### Uma execução ruim não é um alarme

O runner do GitHub tem vizinho barulhento e cold start. `n=1` produz alarme
falso e treina o time a ignorar a página. O alarme só dispara depois de **duas
execuções ruins consecutivas**. A página mostra claramente quando uma falha
ainda não foi confirmada.

---

## Privacidade e segurança

- Nenhum dado de paciente, clínica ou usuário é publicado. As sondas gravam
  **latência, código HTTP e contagem de linhas** — nunca o conteúdo delas.
- **Texto de erro do console nunca é publicado.** Este repositório é público e
  o histórico do git é permanente: uma vez commitado, não dá para desfazer.
  O app loga telefone de paciente e erros do Postgres com valores de linha
  embutidos, então a abordagem é *allowlist*: publica-se apenas uma **categoria
  reconhecida + contagem + hash**, nada reversível.
- URLs têm query string removida e segmentos que parecem id, hash ou nome de
  arquivo viram placeholder — é onde moram UUID de paciente e nome de anexo.
- **Nenhuma captura de tela** é gravada, nem da área pública.
- As sondas de banco leem apenas tabelas estruturais (perfis, membros, clínicas,
  tipos de consulta, status de agenda). **Nenhuma tabela de conversa, contato ou
  lead é consultada.**
- A `anon key` do Supabase está no código porque é pública por design: vai no
  bundle do front-end e é protegida por RLS. A senha do usuário-monitor vive só
  em GitHub Secrets.
- O job que executa dependências de terceiros roda com `npm ci --ignore-scripts`,
  **sem permissão de escrita** no repositório e com `persist-credentials: false`.
  Quem grava o histórico é um job separado e mínimo.
- **Não adicione gatilho `pull_request` a este workflow.** Ele daria a PRs de
  terceiros um caminho para as credenciais de produção.

---

## Configuração

### 1. Ligar o GitHub Pages

`Settings` → `Pages` → **Source: GitHub Actions**.

### 2. Criar o usuário-monitor

Crie no PrimeDoctor um usuário dedicado. Ele precisa de permissão suficiente
para **enxergar a própria linha em `profiles` e `clinic_members`** (senão a
asserção de RLS acusa falso positivo), e não deve ter mais que isso.
Não use uma conta de pessoa real.

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`:

| Secret | Valor |
|---|---|
| `PD_MONITOR_EMAIL` | e-mail do usuário-monitor |
| `PD_MONITOR_PASSWORD` | senha do usuário-monitor |
| `PD_MONITOR_PING_TOKEN` | mesmo valor de `MONITOR_PING_TOKEN` nos secrets do Supabase (veja "Prontidão" acima) |

Sem esses secrets o monitor continua rodando, mas as checagens autenticadas
ficam como *Não verificado* — e o status geral **nunca** exibe "Todos os
sistemas operacionais", porque metade das verificações não aconteceu.

### 3. Canal de alerta (faça isto — sem ele o monitor não acorda ninguém)

| Secret | Para quê |
|---|---|
| `HEARTBEAT_URL` | URL de check do [healthchecks.io](https://healthchecks.io) (plano grátis). Faz **duas** coisas: recebe o pulso de cada execução saudável — se o pulso parar de chegar, o serviço avisa, e essa é a única forma de detectar o monitor em si tendo morrido — e recebe um `POST` em `<URL>/fail` quando há alarme, disparando os canais de notificação já configurados lá (e-mail, push do app, SMS). |
| `MONITOR_WEBHOOK_URL` | *Opcional.* Webhook de Slack, Discord ou Teams. Só configure se você já usa alguma dessas ferramentas — o healthchecks.io sozinho já entrega o alerta. |

Com apenas o `HEARTBEAT_URL` você tem alerta completo — queda do PrimeDoctor
**e** morte do próprio monitor — sem depender de nenhuma ferramenta de chat.

O job de alerta dispara em três situações: falha confirmada no PrimeDoctor,
falha ao publicar/persistir, e **falha do próprio job de verificação** — o caso
que a maioria dos monitores esquece, porque um monitor quebrado fica quieto.

### 4. Domínio customizado (opcional, nesta ordem)

1. No DNS de `primedoctor.app`, crie um **CNAME**: `status` → `devhuander.github.io`
2. Espere propagar (`nslookup status.primedoctor.app`)
3. Só então crie a variável `PD_CUSTOM_DOMAIN` = `status.primedoctor.app`
   em `Settings` → `Secrets and variables` → `Actions` → aba **Variables**
4. Rode o workflow de novo

> **A ordem importa.** Se o arquivo `CNAME` for publicado antes do DNS existir,
> o GitHub passa a redirecionar o endereço `.github.io` para um domínio que não
> resolve, e a página fica inacessível pelos dois caminhos. Por isso o domínio é
> aplicado por variável, e não por arquivo comitado.

### Variáveis opcionais

| Variável | Padrão | Para quê |
|---|---|---|
| `PD_APP_URL` | `https://primedoctor.app` | apontar para outro ambiente |
| `PD_APP_ALT_URLS` | `https://primedoctor.primemedicalgo.com.br` | domínios alternativos, separados por vírgula (vazio desativa) |
| `PD_SUPABASE_URL` | projeto de produção | apontar para outro projeto Supabase |
| `PD_SUPABASE_ANON_KEY` | anon key de produção | **obrigatória** se mudar `PD_SUPABASE_URL` |
| `PD_CUSTOM_DOMAIN` | *(vazio)* | domínio customizado do Pages |

---

## Rodar e testar localmente

```bash
npm install
npx playwright install chromium

npm run check         # verificação completa (precisa de rede até os alvos)
npm run check:fast    # sem navegador, bem mais rápido

npm test              # testes de lógica + ponta a ponta contra um alvo simulado
npm run test:page     # renderiza a página num DOM e verifica render e XSS

npm run demo          # dados sintéticos para conferir o visual
npm run preview       # http://localhost:4173
node tools/gerar-preview-local.mjs   # arquivo único, abre com file://
```

Para checar a área autenticada localmente:

```bash
export PD_MONITOR_EMAIL='...'
export PD_MONITOR_PASSWORD='...'
```

### Sobre os testes

`npm test` sobe um **alvo simulado** que reproduz o comportamento real do
Supabase — inclusive o gateway devolvendo 401 antes de rotear — e verifica que
as sondas chegam ao veredito certo. Cada caso de teste corresponde a um defeito
real encontrado em revisão. Os principais:

- gateway devolvendo 401 para tudo **nunca** pode virar verde;
- canário quebrado torna a seção de integrações não confiável;
- função crítica removida do deploy é detectada; função não crítica não tinge a página;
- RLS devolvendo zero linhas é falha, não sucesso;
- Supabase fora do ar nomeia a causa raiz e suprime a cascata;
- a primeira execução ruim não alarma; a segunda consecutiva sim;
- e-mail e senha do monitor não aparecem no JSON publicado.

---

## Estrutura

```
probe/
  run.mjs              orquestra, decide o veredito, escreve data/
  config.mjs           alvos, limiares, funções e tabelas monitoradas
  lib/http.mjs         fetch com timeout, DNS, TLS, identificação do host
  lib/sanitize.mjs     allowlist de categorias de erro, mascaramento de URL
  checks/
    selftest.mjs       o monitor tem rede? roda antes de tudo
    frontend.mjs       hospedagem, TLS, HTML, bundles, assets, domínios alternativos
    backend.mjs        Auth, PostgREST, Postgres com asserção de RLS, Realtime, Storage
    edge.mjs           edge functions via preflight autenticado + canário
    browser.mjs        Chromium: performance, componentes montados, console
    upstream.mjs       páginas de status de terceiros
site/                  página estática, sem build
data/                  relatórios gerados — comitados pelo próprio workflow
tools/                 testes, alvo simulado, preview local, dados de demonstração
```

| Arquivo publicado | Conteúdo |
|---|---|
| `data/status.json` | último relatório completo |
| `data/history.jsonl` | uma linha por execução, ~30 dias (append-only, para o git conseguir fazer delta) |
| `data/incidents.json` | execuções ruins consecutivas, agrupadas em incidentes |

---

## Limites honestos

- Verde significa que **o caminho verificado** respondeu. Não significa que
  todos os fluxos do produto estejam corretos.
- O preflight prova que a edge function existe e sobe, **não** que ela funciona.
- A frequência é horária e o cron do GitHub atrasa em horários de pico: uma
  queda curta entre dois ciclos pode não aparecer.
- A verificação "ao vivo" da página usa a rede de quem está olhando e alcança
  apenas endpoints com CORS aberto. O teste do site em si é `no-cors` — prova
  DNS, TCP e TLS, mas não o código HTTP. Por isso ele é exibido em cinza,
  nunca em verde.
- Sem `MONITOR_WEBHOOK_URL` e `HEARTBEAT_URL`, isto é um **painel de status**,
  não um sistema de alerta.
