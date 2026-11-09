import crypto from 'node:crypto';
import { HttpError } from '../lib/http.js';

const MAX_TEXT = 4000;
const id = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

export class ChatService {
  constructor() {
    this.conversations = new Map();
    this.messages = new Map(); // conversationId -> message[]
    this.directIndex = new Map(); // "a|b" -> conversationId
    this.lastRead = new Map(); // `${convId}:${userId}` -> ISO time
    this.clientIds = new Map(); // `${convId}:${senderId}:${clientId}` -> message (idempotent send)
  }

  createConversation(creatorId, { memberIds = [], name = '' }, validIds) {
    const members = [...new Set([creatorId, ...memberIds])];
    if (members.length < 2) throw new HttpError(400, 'A conversation needs at least one other member');
    if (members.length > 50) throw new HttpError(400, 'Too many members');
    for (const m of members) if (!validIds.has(m)) throw new HttpError(404, `Unknown user: ${m}`);
    if (members.length === 2) {
      const key = [...members].sort().join('|');
      const existing = this.directIndex.get(key);
      if (existing) return this.conversations.get(existing);
      const conv = { id: id('conv'), type: 'direct', name: '', memberIds: members, createdAt: new Date().toISOString(), lastMessageAt: null };
      this.conversations.set(conv.id, conv); this.messages.set(conv.id, []); this.directIndex.set(key, conv.id);
      return conv;
    }
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) throw new HttpError(400, 'Group conversations need a name');
    const conv = { id: id('conv'), type: 'group', name: cleanName, memberIds: members, createdAt: new Date().toISOString(), lastMessageAt: null };
    this.conversations.set(conv.id, conv); this.messages.set(conv.id, []);
    return conv;
  }

  #member(userId, convId) {
    const conv = this.conversations.get(convId);
    // Same error for "missing" and "not a member" so conversation ids can't be probed.
    if (!conv || !conv.memberIds.includes(userId)) throw new HttpError(404, 'Conversation not found');
    return conv;
  }

  getConversation(userId, convId) { return this.#member(userId, convId); }

  listFor(userId) {
    return [...this.conversations.values()]
      .filter((c) => c.memberIds.includes(userId))
      .map((c) => {
        const msgs = this.messages.get(c.id);
        const read = this.lastRead.get(`${c.id}:${userId}`) || '';
        return { ...c, lastMessage: msgs.at(-1) || null, unread: msgs.filter((m) => m.senderId !== userId && m.createdAt > read).length };
      })
      .sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt));
  }

  send(userId, convId, text, clientId) {
    const conv = this.#member(userId, convId);
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) throw new HttpError(400, 'Message is empty');
    if (clean.length > MAX_TEXT) throw new HttpError(400, `Message exceeds ${MAX_TEXT} characters`);
    const dedupeKey = clientId ? `${convId}:${userId}:${String(clientId).slice(0, 64)}` : null;
    if (dedupeKey && this.clientIds.has(dedupeKey)) return { message: this.clientIds.get(dedupeKey), conversation: conv, duplicate: true };
    const message = { id: id('msg'), conversationId: convId, senderId: userId, text: clean, createdAt: new Date().toISOString(), clientId: clientId ? String(clientId).slice(0, 64) : undefined };
    this.messages.get(convId).push(message);
    conv.lastMessageAt = message.createdAt;
    if (dedupeKey) this.clientIds.set(dedupeKey, message);
    this.lastRead.set(`${convId}:${userId}`, message.createdAt);
    return { message, conversation: conv, duplicate: false };
  }

  history(userId, convId, { before, limit = 50 } = {}) {
    this.#member(userId, convId);
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    let msgs = this.messages.get(convId);
    if (before) msgs = msgs.filter((m) => m.createdAt < before);
    return msgs.slice(-n);
  }

  markRead(userId, convId) {
    this.#member(userId, convId);
    this.lastRead.set(`${convId}:${userId}`, new Date(Date.now() + 1).toISOString());
  }
}
