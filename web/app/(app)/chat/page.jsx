'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime } from '@/lib/api';
import { useHub } from '@/components/AppProvider';

export default function ChatPage() {
  const { me, users, online, rt, markRead, startCall, userName, notify } = useHub();
  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(null);
  const [picker, setPicker] = useState(false);
  const [picked, setPicked] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [loading, setLoading] = useState(true);
  const endRef = useRef(null);
  const typingTimer = useRef(null);
  const lastTypingSent = useRef(0);
  const activeRef = useRef(null);
  activeRef.current = activeId;

  const loadConvs = useCallback(async () => {
    try { setConvs((await api('chat/conversations')).conversations); } catch (e) { notify(e.message); } finally { setLoading(false); }
  }, [notify]);
  useEffect(() => { loadConvs(); }, [loadConvs]);

  const active = useMemo(() => convs.find((c) => c.id === activeId) || null, [convs, activeId]);
  const title = useCallback((c) => (c.type === 'group' ? c.name : userName(c.memberIds.find((id) => id !== me?.appUserId))), [me, userName]);

  // Leaving the page must stop suppressing unread badges for the last-viewed conversation.
  useEffect(() => () => markRead(null), [markRead]);

  useEffect(() => {
    if (!activeId) { markRead(null); return undefined; }
    let stale = false;
    setMessages([]);
    api(`chat/conversations/${activeId}/messages?limit=100`).then((r) => { if (!stale) setMessages(r.messages); }).catch((e) => notify(e.message));
    markRead(activeId);
    return () => { stale = true; };
  }, [activeId, markRead, notify]);

  useEffect(() => {
    if (!rt) return undefined;
    const offs = [
      rt.on('chat:message', ({ message }) => {
        setConvs((cs) => cs.map((c) => (c.id === message.conversationId ? { ...c, lastMessage: message, lastMessageAt: message.createdAt, unread: message.conversationId === activeRef.current || message.senderId === me?.appUserId ? 0 : (c.unread || 0) + 1 } : c))
          .sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt)));
        if (message.conversationId === activeRef.current) {
          setMessages((ms) => (ms.some((m) => m.id === message.id) ? ms : [...ms, message]));
          if (message.senderId !== me?.appUserId) markRead(message.conversationId);
        }
      }),
      rt.on('chat:conversation', ({ conversation }) => setConvs((cs) => (cs.some((c) => c.id === conversation.id) ? cs : [{ ...conversation, lastMessage: null, unread: 0 }, ...cs]))),
      rt.on('chat:typing', ({ conversationId, userId }) => {
        if (conversationId !== activeRef.current) return;
        setTyping(userId); clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTyping(null), 2500);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [rt, me, markRead]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body || !activeId) return;
    setText('');
    const clientId = crypto.randomUUID();
    try {
      const ack = await rt.request({ type: 'chat:send', conversationId: activeId, text: body, clientId });
      setMessages((ms) => (ms.some((m) => m.id === ack.message.id) ? ms : [...ms, ack.message]));
    } catch {
      try { // socket down: REST fallback (same clientId keeps it idempotent)
        const r = await api(`chat/conversations/${activeId}/messages`, { method: 'POST', body: { text: body, clientId } });
        setMessages((ms) => (ms.some((m) => m.id === r.message.id) ? ms : [...ms, r.message]));
      } catch (err) { setText(body); notify(err.message); }
    }
  }

  function onType(v) {
    setText(v);
    if (activeId && Date.now() - lastTypingSent.current > 1500) { lastTypingSent.current = Date.now(); rt?.send({ type: 'chat:typing', conversationId: activeId }); }
  }

  async function createConv() {
    try {
      const body = { memberIds: picked, ...(picked.length > 1 ? { name: groupName } : {}) };
      const { conversation } = await api('chat/conversations', { method: 'POST', body });
      await loadConvs();
      setActiveId(conversation.id); setPicker(false); setPicked([]); setGroupName('');
    } catch (e) { notify(e.message); }
  }

  const others = users.filter((u) => u.appUserId !== me?.appUserId);

  return (
    <div className="split">
      <section className="list">
        <div className="list-head"><h2>Chats</h2><button className="btn small" onClick={() => setPicker(true)}>+ New</button></div>
        {loading && <p className="muted pad">Loading…</p>}
        {!loading && !convs.length && <p className="muted pad">No conversations yet. Start one with “+ New”.</p>}
        {convs.map((c) => (
          <button key={c.id} className={`item ${c.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.id)}>
            <div className="avatar">{(title(c) || '?')[0]}</div>
            <div className="grow">
              <div className="row between"><strong>{title(c)}</strong>{c.unread > 0 && <span className="badge">{c.unread}</span>}</div>
              <div className="muted small ellipsis">{c.lastMessage ? c.lastMessage.text : 'No messages yet'}</div>
            </div>
          </button>
        ))}
      </section>
      <section className="pane">
        {!active ? <div className="center muted">Select a conversation</div> : (
          <>
            <header className="pane-head">
              <div><strong>{title(active)}</strong>{active.type === 'direct' && <span className={`dot ${online.has(active.memberIds.find((i) => i !== me.appUserId)) ? 'on' : ''}`} />}
                {active.type === 'group' && <div className="muted small">{active.memberIds.length} members</div>}</div>
              <div className="row gap">
                <button className="btn small" onClick={() => startCall(active.memberIds.filter((i) => i !== me.appUserId), 'audio')}>Audio call</button>
                <button className="btn small primary" onClick={() => startCall(active.memberIds.filter((i) => i !== me.appUserId), 'video')}>Video call</button>
              </div>
            </header>
            <div className="messages">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.senderId === me.appUserId ? 'mine' : ''}`}>
                  {active.type === 'group' && m.senderId !== me.appUserId && <div className="small muted">{userName(m.senderId)}</div>}
                  <div className="bubble">{m.text}</div>
                  <div className="small muted">{fmtTime(m.createdAt)}</div>
                </div>
              ))}
              {typing && <div className="small muted">{userName(typing)} is typing…</div>}
              <div ref={endRef} />
            </div>
            <form className="composer" onSubmit={send}>
              <input value={text} onChange={(e) => onType(e.target.value)} placeholder="Type a message" maxLength={4000} aria-label="Message" />
              <button className="btn primary" disabled={!text.trim()}>Send</button>
            </form>
          </>
        )}
      </section>
      {picker && (
        <div className="modal">
          <div className="card">
            <h2>New conversation</h2>
            <div className="people">
              {others.map((u) => (
                <label key={u.appUserId} className="check">
                  <input type="checkbox" checked={picked.includes(u.appUserId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, u.appUserId] : p.filter((x) => x !== u.appUserId)))} />
                  {u.name} <span className="muted small">{u.role}</span>
                </label>
              ))}
            </div>
            {picked.length > 1 && <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Group name" maxLength={80} />}
            <div className="row gap end">
              <button className="btn" onClick={() => { setPicker(false); setPicked([]); }}>Cancel</button>
              <button className="btn primary" disabled={!picked.length || (picked.length > 1 && !groupName.trim())} onClick={createConv}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
