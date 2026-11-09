import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { maskSensitive } from '../src/services/ai.js';

let t; const calls = [];
const fakeFetch = async (url, init) => {
  const body = JSON.parse(init.body); calls.push({ url, init, body });
  const wantsJson = body.system.includes('Return ONLY JSON');
  const text = wantsJson ? '```json\n{"summary":"Pump P-101 inspected.","actionItems":["Order seal kit"]}\n```' : 'Here is a draft reply.';
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) };
};
before(async () => { t = await startApp({ ai: { anthropicKey: 'sk-test', model: 'claude-sonnet-5-5', dailyBudgetPerUser: 5, maxInputChars: 8000 } }, { fetch: fakeFetch }); });
after(async () => { await t.stop(); });

test('masking removes emails, phone numbers and card-like numbers', () => {
  const r = maskSensitive('mail bob@company.com or call +91 98765 43210, card 4111 1111 1111 1111');
  assert.ok(!r.text.includes('bob@company.com') && !r.text.includes('98765') && !r.text.includes('4111'));
  assert.ok(r.redactions >= 3);
});

test('ai chat: validates input, masks PII before the provider, audits, returns a draft, never leaks the key to the client', async () => {
  const s = await t.login('bob');
  assert.equal((await t.api('POST', '/v1/ai/chat', { token: s.accessToken, body: {} })).status, 400);
  assert.equal((await t.api('POST', '/v1/ai/chat', { token: s.accessToken, body: { messages: [{ role: 'system', content: 'x' }] } })).status, 400);
  assert.equal((await t.api('POST', '/v1/ai/chat', { token: s.accessToken, body: { messages: [{ role: 'assistant', content: 'x' }] } })).status, 400);
  assert.equal((await t.api('POST', '/v1/ai/chat')).status, 401);
  const r = await t.api('POST', '/v1/ai/chat', { token: s.accessToken, body: { messages: [{ role: 'user', content: 'Email alice@company.com the status' }] } });
  assert.equal(r.status, 200); assert.equal(r.body.reply, 'Here is a draft reply.'); assert.equal(r.body.draft, true); assert.equal(r.body.redactions, 1);
  const sent = calls.at(-1);
  assert.equal(sent.init.headers['x-api-key'], 'sk-test');
  assert.ok(!JSON.stringify(sent.body).includes('alice@company.com'));
  assert.equal(sent.body.model, 'claude-sonnet-5-5');
  assert.ok(!JSON.stringify(r.body).includes('sk-test'));
  assert.equal(t.app.ai.audit.at(-1).userId, s.id);
});

test('ai: per-user daily budget is enforced', async () => {
  const s = await t.login('carol');
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await t.api('POST', '/v1/ai/chat', { token: s.accessToken, body: { messages: [{ role: 'user', content: 'hi' }] } })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
});

test('ai: provider failure surfaces as 502, not a crash', async () => {
  const x = await startApp({ ai: { anthropicKey: 'k', model: 'm', dailyBudgetPerUser: 5, maxInputChars: 100 } }, { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const s = await x.login('alice');
  const r = await x.api('POST', '/v1/ai/chat', { token: s.accessToken, body: { messages: [{ role: 'user', content: 'hi' }] } });
  await x.stop();
  assert.equal(r.status, 502);
});

test('ai summary: draft -> human approval -> saved to SAP; technicians cannot approve; only owner can approve', async () => {
  const mgr = await t.login('alice'); const tech = await t.login('bob');
  const draft = await t.api('POST', '/v1/ai/summarize', { token: mgr.accessToken, body: { transcript: 'Alice: pump P-101 leaks.\nBob: I will order a seal kit.', title: 'Pump review' } });
  assert.equal(draft.status, 200); assert.equal(draft.body.status, 'pending_approval');
  assert.deepEqual(draft.body.actionItems, ['Order seal kit']);
  assert.equal((await t.api('POST', '/v1/ai/summarize', { token: mgr.accessToken, body: { transcript: 'short' } })).status, 400);
  const techDraft = await t.api('POST', '/v1/ai/summarize', { token: tech.accessToken, body: { transcript: 'Bob: we will check the valve tomorrow.' } });
  assert.equal((await t.api('POST', `/v1/ai/drafts/${techDraft.body.id}/approve`, { token: tech.accessToken, body: {} })).status, 403);
  assert.equal((await t.api('POST', `/v1/ai/drafts/${draft.body.id}/approve`, { token: tech.accessToken, body: {} })).status, 403);
  assert.equal(t.app.sap.backend.summaries.size, 0, 'nothing in SAP before approval');
  const ok = await t.api('POST', `/v1/ai/drafts/${draft.body.id}/approve`, { token: mgr.accessToken, body: { summary: 'Edited by manager', callId: 'call_1' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'approved');
  assert.equal([...t.app.sap.backend.summaries.values()][0].summaryText, 'Edited by manager');
  assert.equal((await t.api('POST', `/v1/ai/drafts/${draft.body.id}/approve`, { token: mgr.accessToken, body: {} })).status, 200, 'idempotent');
  assert.equal(t.app.sap.backend.summaries.size, 1);
});

test('ai approve: SAP outage keeps draft pending and reports 503', async () => {
  const mgr = await t.login('dave');
  const d = await t.api('POST', '/v1/ai/summarize', { token: mgr.accessToken, body: { transcript: 'Dave: we must replace the filter.' } });
  t.app.sap.backend.failing = true;
  const r = await t.api('POST', `/v1/ai/drafts/${d.body.id}/approve`, { token: mgr.accessToken, body: {} });
  t.app.sap.backend.failing = false; t.app.sap.breaker.failures = 0;
  assert.equal(r.status, 503);
  assert.equal(t.app.ai.drafts.get(d.body.id).status, 'pending_approval');
});

test('ai local fallback works without a provider key', async () => {
  const x = await startApp();
  const s = await x.login('alice');
  const r = await x.api('POST', '/v1/ai/chat', { token: s.accessToken, body: { messages: [{ role: 'user', content: 'How do I start a video call?' }] } });
  await x.stop();
  assert.equal(r.status, 200); assert.equal(r.body.provider, 'local'); assert.match(r.body.reply, /Calls/);
});
