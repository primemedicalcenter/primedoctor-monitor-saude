#!/usr/bin/env node
// Testa a regra da Cloudflare (avaliarCloudflare) com resumos fixos.
// O principal aqui são os casos em que a linha PRECISA ficar vermelha ou
// amarela — uma regra que só sabe dar verde é pior que nenhuma.
//
//   node tools/testar-cloudflare.mjs
import assert from 'node:assert/strict';
import { avaliarCloudflare } from '../probe/checks/upstream.mjs';
import { CONFIG } from '../probe/config.mjs';

const CFG = CONFIG.cloudflare;
const dc = (nome, codigo, status = 'operational') => ({ name: `${nome}, Brazil - (${codigo})`, status });
const base = () => ({
  status: { indicator: 'major', description: 'Partial System Outage' },
  incidents: [],
  components: [
    { name: 'CDN/Cache', status: 'operational' },
    { name: 'Authoritative DNS', status: 'operational' },
    { name: 'Durable Objects', status: 'operational' },
    dc('Goiania', 'GYN'), dc('Brasilia', 'BSB'), dc('São Paulo', 'GRU'),
    dc('Belo Horizonte', 'CNF'), dc('Rio de Janeiro', 'GIG'),
    { name: 'Palmas, Brazil - (PMW)', status: 'major_outage' },
    { name: 'Mumbai, India - (BOM)', status: 'major_outage' },
  ],
});

const casos = [];
const caso = (nome, fn) => casos.push({ nome, fn });

caso('datacenters caídos longe e incidente em serviço não usado → ok', () => {
  const s = base();
  s.incidents.push({ name: 'Durable Objects na Europa', impact: 'minor', components: [{ name: 'Durable Objects' }] });
  const r = avaliarCloudflare(s, CFG);
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /nada que afete/);
  assert.match(r.detail, /1 incidente/);
  assert.match(r.detail, /2 datacenter/);
});

caso('incidente maior no CDN → fail', () => {
  const s = base();
  s.incidents.push({ name: 'CDN fora', impact: 'major', components: [{ name: 'CDN/Cache' }] });
  assert.equal(avaliarCloudflare(s, CFG).status, 'fail');
});

caso('incidente menor no DNS → degraded', () => {
  const s = base();
  s.incidents.push({ name: 'DNS lento', impact: 'minor', components: [{ name: 'Authoritative DNS' }] });
  assert.equal(avaliarCloudflare(s, CFG).status, 'degraded');
});

caso('incidente citando Goiânia → aparece', () => {
  const s = base();
  s.incidents.push({ name: 'rede em GYN', impact: 'minor', components: [{ name: 'Goiania, Brazil - (GYN)' }] });
  assert.equal(avaliarCloudflare(s, CFG).status, 'degraded');
});

caso('incidente grave sem componentes → conta (alcance desconhecido)', () => {
  const s = base();
  s.incidents.push({ name: 'problema global', impact: 'critical', components: [] });
  assert.equal(avaliarCloudflare(s, CFG).status, 'fail');
});

caso('incidente menor sem componentes → não conta', () => {
  const s = base();
  s.incidents.push({ name: 'aviso genérico', impact: 'minor', components: [] });
  assert.equal(avaliarCloudflare(s, CFG).status, 'ok');
});

caso('serviço relevante fora do ar sem incidente aberto → fail', () => {
  const s = base();
  s.components[0].status = 'major_outage';
  assert.equal(avaliarCloudflare(s, CFG).status, 'fail');
});

caso('Goiânia fora do ar → degraded (tráfego vai para o vizinho)', () => {
  const s = base();
  s.components.find((c) => c.name.includes('(GYN)')).status = 'major_outage';
  const r = avaliarCloudflare(s, CFG);
  assert.equal(r.status, 'degraded');
  assert.match(r.detail, /GYN/);
});

caso('todos os datacenters monitorados fora → fail', () => {
  const s = base();
  for (const c of s.components) if (/\((GYN|BSB|GRU|CNF|GIG)\)/.test(c.name)) c.status = 'major_outage';
  assert.equal(avaliarCloudflare(s, CFG).status, 'fail');
});

caso('manutenção planejada em Goiânia → ok', () => {
  const s = base();
  s.components.find((c) => c.name.includes('(GYN)')).status = 'under_maintenance';
  assert.equal(avaliarCloudflare(s, CFG).status, 'ok');
});

caso('nenhum datacenter monitorado no resumo (nomes mudaram) → unknown, nunca ok', () => {
  const s = base();
  s.components = s.components.filter((c) => !/\((GYN|BSB|GRU|CNF|GIG)\)/.test(c.name));
  assert.equal(avaliarCloudflare(s, CFG).status, 'unknown');
});

caso('resposta sem componentes (cortada ou inválida) → unknown', () => {
  assert.equal(avaliarCloudflare({}, CFG).status, 'unknown');
  assert.equal(avaliarCloudflare(null, CFG).status, 'unknown');
});

let falhas = 0;
console.log('Regra da Cloudflare');
for (const c of casos) {
  try {
    c.fn();
    console.log(`  \x1b[32m✔\x1b[0m ${c.nome}`);
  } catch (e) {
    falhas++;
    console.log(`  \x1b[31m✖\x1b[0m ${c.nome}\n      ${e.message.split('\n')[0]}`);
  }
}
console.log(`\n${casos.length - falhas}/${casos.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
