// AI Gateway: classifies/masks data, routes to a provider, audits every call, returns DRAFTS only.
// Provider "anthropic" is used when ANTHROPIC_API_KEY is set; otherwise a deterministic local assistant keeps dev/test offline.
import crypto from 'node:crypto';
import { HttpError } from '../lib/http.js';

const SYSTEM_PROMPT = 'You are the in-app assistant for an enterprise maintenance and collaboration platform. Be concise and accurate. You can explain app features (chat, video calls, history) and help draft messages, call summaries and action items. You cannot change business records: anything that would modify SAP data must be presented as a draft for the user to approve. If you are not sure, say so.';

const digits = (s) => s.replace(/\D/g, '').length;
// Order matters: emails, then long card/ID numbers, then phone numbers (10-15 digits, any common grouping, e.g. +91 98765 43210).
// Identifiers glued to letters or hyphens (WO-4500012345) are left alone so business references survive.
const MASKS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g, '[CARD/ID]'],
  [/(?<![\w-])\+?\(?\d[\d\s().-]{7,18}\d(?![\w-])/g, (m) => (digits(m) >= 10 && digits(m) <= 15 ? '[PHONE]' : m)],
];

export function maskSensitive(text) {
  let masked = String(text);
  let hits = 0;
  for (const [re, label] of MASKS) masked = masked.replace(re, (m) => { const out = typeof label === 'function' ? label(m) : label; if (out !== m) hits++; return out; });
  return { text: masked, redactions: hits };
}

export class AiService {
  constructor(config, sap, fetchImpl = globalThis.fetch) {
    this.cfg = config.ai; this.sap = sap; this.fetch = fetchImpl;
    this.audit = []; // prompt/response audit log (ship to your log platform in production)
    this.drafts = new Map();
    this.usage = new Map(); // `${userId}:${yyyy-mm-dd}` -> count
  }

  get provider() { return this.cfg.anthropicKey ? 'anthropic' : 'local'; }

  #budget(userId) {
    const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
    const n = (this.usage.get(key) || 0) + 1;
    if (n > this.cfg.dailyBudgetPerUser) throw new HttpError(429, 'Daily AI usage limit reached');
    this.usage.set(key, n);
  }

  #validateMessages(messages) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 40) throw new HttpError(400, 'messages must be an array of 1-40 items');
    const clean = messages.map((m) => {
      if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) throw new HttpError(400, 'Each message needs role (user|assistant) and non-empty content');
      return { role: m.role, content: m.content.slice(0, this.cfg.maxInputChars) };
    });
    if (clean.at(-1).role !== 'user') throw new HttpError(400, 'Last message must be from the user');
    return clean;
  }

  async #complete(system, messages) {
    if (this.provider === 'anthropic') {
      const res = await this.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.cfg.model, max_tokens: 1000, system, messages }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => { throw new HttpError(502, 'AI provider unreachable'); });
      if (!res.ok) throw new HttpError(502, `AI provider error (${res.status})`);
      const data = await res.json();
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!text) throw new HttpError(502, 'AI provider returned no text');
      return text;
    }
    return localAssistant(messages.at(-1).content);
  }

  async chat(user, rawMessages) {
    if (!user.permissions.includes('ai:use') && user.role !== 'admin') throw new HttpError(403, 'Missing permission: ai:use');
    const messages = this.#validateMessages(rawMessages);
    this.#budget(user.appUserId);
    let redactions = 0;
    const safe = messages.map((m) => { const r = maskSensitive(m.content); redactions += r.redactions; return { role: m.role, content: r.text }; });
    const reply = await this.#complete(SYSTEM_PROMPT, safe);
    this.audit.push({ at: new Date().toISOString(), userId: user.appUserId, kind: 'chat', provider: this.provider, model: this.provider === 'anthropic' ? this.cfg.model : 'local', redactions, promptChars: safe.reduce((n, m) => n + m.content.length, 0), responseChars: reply.length });
    if (this.audit.length > 5000) this.audit.shift();
    return { reply, provider: this.provider, redactions, draft: true };
  }

  async summarize(user, { transcript, title = 'Call' } = {}) {
    if (!user.permissions.includes('ai:use') && user.role !== 'admin') throw new HttpError(403, 'Missing permission: ai:use');
    if (typeof transcript !== 'string' || transcript.trim().length < 10) throw new HttpError(400, 'transcript must be at least 10 characters');
    this.#budget(user.appUserId);
    const masked = maskSensitive(transcript.slice(0, this.cfg.maxInputChars * 4));
    let summary; let actionItems;
    if (this.provider === 'anthropic') {
      const out = await this.#complete(`${SYSTEM_PROMPT}\nReturn ONLY JSON: {"summary": string, "actionItems": string[]}.`, [{ role: 'user', content: `Summarize this ${String(title).slice(0, 80)} transcript and list action items.\n\n${masked.text}` }]);
      try { const j = JSON.parse(out.replace(/^```json|```$/g, '').trim()); summary = String(j.summary); actionItems = Array.isArray(j.actionItems) ? j.actionItems.map(String) : []; }
      catch { summary = out; actionItems = []; }
    } else ({ summary, actionItems } = localSummary(masked.text));
    const draft = { id: `draft_${crypto.randomBytes(8).toString('hex')}`, ownerId: user.appUserId, title: String(title).slice(0, 80), summary, actionItems, status: 'pending_approval', createdAt: new Date().toISOString(), model: this.provider === 'anthropic' ? this.cfg.model : 'local' };
    this.drafts.set(draft.id, draft);
    this.audit.push({ at: draft.createdAt, userId: user.appUserId, kind: 'summarize', provider: this.provider, redactions: masked.redactions });
    return draft;
  }

  /** Human-in-the-loop: nothing reaches SAP until an authorized person approves (optionally edited) text. */
  async approve(user, draftId, { summary, actionItems, callId } = {}) {
    if (!user.permissions.includes('ai:approve') && user.role !== 'admin') throw new HttpError(403, 'Missing permission: ai:approve');
    const draft = this.drafts.get(draftId);
    if (!draft || draft.ownerId !== user.appUserId) throw new HttpError(404, 'Draft not found');
    if (draft.status === 'approved') return draft; // idempotent
    if (summary !== undefined) draft.summary = String(summary).slice(0, 8000);
    if (actionItems !== undefined) draft.actionItems = (Array.isArray(actionItems) ? actionItems : []).map((s) => String(s).slice(0, 500)).slice(0, 50);
    draft.status = 'approved'; draft.approvedBy = user.appUserId; draft.approvedAt = new Date().toISOString();
    try {
      await this.sap.saveSummary({ callId: callId || draft.id, summaryText: draft.summary, actionItems: draft.actionItems, approvedBy: user.appUserId, approvedAt: draft.approvedAt, modelInfo: draft.model });
    } catch { draft.status = 'pending_approval'; delete draft.approvedBy; delete draft.approvedAt; throw new HttpError(503, 'SAP unavailable; summary was not saved. Try again.'); }
    return draft;
  }
}

function localAssistant(q) {
  const s = q.toLowerCase();
  if (/(call|video)/.test(s)) return 'To start a video call, open Calls, pick a colleague and press the video button. You can mute, switch the camera off, or share your screen from the call controls. Finished calls appear in call history.';
  if (/(chat|message)/.test(s)) return 'Open Chat to message a colleague or create a group. Messages are delivered in real time and unread counts show in the sidebar.';
  if (/(summar|action item)/.test(s)) return 'Paste a call transcript into the summary tool and I will draft a summary and action items. A manager reviews and approves the draft before it is saved to SAP.';
  if (/(equipment|maintenance|order|sap)/.test(s)) return 'SAP business data is read through authorized APIs under your own permissions, and I never change SAP records on my own: I prepare drafts for you to approve. (Local demo assistant: connect an AI provider key for full answers.)';
  if (/^(hi|hello|hey)\b/.test(s)) return 'Hello! I can help with chat, video calls, drafting messages and summarizing call transcripts. What do you need?';
  return 'I am running in local demo mode (no AI provider key configured), so my answers are limited. Set ANTHROPIC_API_KEY on the gateway for full assistant answers.';
}

function localSummary(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const actions = lines.filter((l) => /\b(will|todo|to do|action|need to|must|should|please)\b/i.test(l)).slice(0, 10);
  const summary = lines.slice(0, 3).join(' ').slice(0, 600);
  return { summary: summary || 'No content.', actionItems: actions };
}
