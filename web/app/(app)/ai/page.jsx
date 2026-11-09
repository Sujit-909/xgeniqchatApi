'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useHub } from '@/components/AppProvider';

export default function AiPage() {
  const { me, notify } = useHub();
  const [msgs, setMsgs] = useState([{ role: 'assistant', content: 'Hi! Ask me about chats, calls, or paste a call transcript below to get a draft summary and action items.' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [draft, setDraft] = useState(null);
  const [sumBusy, setSumBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  const canApprove = me?.permissions?.includes('ai:approve') || me?.role === 'admin';

  async function send(e) {
    e.preventDefault();
    const content = input.trim();
    if (!content || busy) return;
    const next = [...msgs, { role: 'user', content }];
    setMsgs(next); setInput(''); setBusy(true);
    try {
      // The opening greeting is UI-only; the API wants the conversation to start with a user turn.
      const history = next.filter((m, i) => !(i === 0 && m.role === 'assistant')).slice(-20);
      const r = await api('ai/chat', { method: 'POST', body: { messages: history } });
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply }]);
      setMeta({ provider: r.provider, redactions: r.redactions });
    } catch (err) { setMsgs((m) => [...m, { role: 'assistant', content: `Sorry, that failed: ${err.message}`, error: true }]); }
    finally { setBusy(false); }
  }

  async function summarize() {
    setSumBusy(true);
    try { setDraft(await api('ai/summarize', { method: 'POST', body: { transcript, title: 'Call' } })); }
    catch (err) { notify(err.message); } finally { setSumBusy(false); }
  }

  async function approve() {
    try {
      const r = await api(`ai/drafts/${draft.id}/approve`, { method: 'POST', body: { summary: draft.summary, actionItems: draft.actionItems } });
      setDraft(r); notify('Approved and saved to SAP');
    } catch (err) { notify(err.message); }
  }

  return (
    <div className="page">
      <h1>AI Assistant</h1>
      <div className="grid2">
        <section className="card chatcard">
          <div className="messages">
            {msgs.map((m, i) => <div key={i} className={`msg ${m.role === 'user' ? 'mine' : ''}`}><div className={`bubble ${m.error ? 'err' : ''}`}>{m.content}</div></div>)}
            {busy && <div className="muted small">Thinking…</div>}
            <div ref={endRef} />
          </div>
          {meta && <div className="muted small">Draft answer · provider: {meta.provider}{meta.redactions > 0 && ` · ${meta.redactions} sensitive item(s) masked before sending`}</div>}
          <form className="composer" onSubmit={send}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask the assistant…" aria-label="Ask the assistant" maxLength={8000} />
            <button className="btn primary" disabled={busy || !input.trim()}>Send</button>
          </form>
        </section>
        <section className="card">
          <h2>Call summary</h2>
          <p className="muted small">Paste a transcript. The AI prepares a draft; nothing is saved to SAP until an authorized person approves it.</p>
          <textarea rows={7} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={'Alice: The pump P-101 is leaking.\nBob: I will order a seal kit tomorrow.'} />
          <div className="row end top"><button className="btn primary" disabled={sumBusy || transcript.trim().length < 10} onClick={summarize}>{sumBusy ? 'Summarizing…' : 'Summarize'}</button></div>
          {draft && (
            <div className="draft">
              <div className="row between"><strong>Draft</strong><span className={`pill ${draft.status === 'approved' ? 'ended' : 'missed'}`}>{draft.status === 'approved' ? 'Approved' : 'Pending approval'}</span></div>
              <label>Summary<textarea rows={4} value={draft.summary} disabled={draft.status === 'approved'} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
              <label>Action items (one per line)<textarea rows={4} value={draft.actionItems.join('\n')} disabled={draft.status === 'approved'} onChange={(e) => setDraft({ ...draft, actionItems: e.target.value.split('\n').filter(Boolean) })} /></label>
              {draft.status !== 'approved' && (canApprove
                ? <button className="btn ok" onClick={approve}>Approve &amp; save to SAP</button>
                : <p className="muted small">A manager or admin must approve this draft.</p>)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
