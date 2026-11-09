'use client';
import { useEffect, useState } from 'react';
import { api, fmtDuration, fmtTime } from '@/lib/api';
import { useHub } from '@/components/AppProvider';

const LABEL = { ended: 'Completed', rejected: 'Declined', cancelled: 'Cancelled', missed: 'Missed', failed: 'Failed' };

export default function CallsPage() {
  const { me, users, online, startCall, userName, activeCall } = useHub();
  const [history, setHistory] = useState([]);
  const [picked, setPicked] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let off = false;
    api('calls').then((r) => { if (!off) setHistory(r.calls); }).catch(() => {}).finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [activeCall]); // refresh after each call finishes

  const others = users.filter((u) => u.appUserId !== me?.appUserId);
  const withWho = (c) => [c.hostId, ...c.invitees.map((i) => i.userId)].filter((id) => id !== me?.appUserId).map(userName).join(', ');

  return (
    <div className="page">
      <h1>Calls</h1>
      <div className="grid2">
        <section className="card">
          <h2>Start a call</h2>
          {others.map((u) => (
            <div key={u.appUserId} className="row between person">
              <label className="check">
                <input type="checkbox" checked={picked.includes(u.appUserId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, u.appUserId] : p.filter((x) => x !== u.appUserId)))} aria-label={`Select ${u.name}`} />
                <span className={`dot ${online.has(u.appUserId) ? 'on' : ''}`} />{u.name} <span className="muted small">{u.role}</span>
              </label>
              <div className="row gap">
                <button className="btn small" onClick={() => startCall([u.appUserId], 'audio')}>Audio</button>
                <button className="btn small primary" onClick={() => startCall([u.appUserId], 'video')}>Video</button>
              </div>
            </div>
          ))}
          <div className="row end gap top">
            <button className="btn primary" disabled={picked.length < 2} onClick={() => startCall(picked, 'video')}>Group video call ({picked.length})</button>
          </div>
          <p className="muted small">Offline colleagues still get a notification. Group calls use a mesh and work best with up to 8 people.</p>
        </section>
        <section className="card">
          <h2>History</h2>
          {loading && <p className="muted">Loading…</p>}
          {!loading && !history.length && <p className="muted">No calls yet.</p>}
          {history.map((c) => (
            <div key={c.id} className="row between person">
              <div>
                <strong>{withWho(c) || 'Call'}</strong>
                <div className="muted small">{fmtTime(c.createdAt)} · {c.type}{c.hostId === me?.appUserId ? ' · outgoing' : ' · incoming'}</div>
              </div>
              <div className="right"><span className={`pill ${c.state}`}>{LABEL[c.state] || c.state}</span>{c.durationSec > 0 && <div className="muted small">{fmtDuration(c.durationSec)}</div>}</div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
