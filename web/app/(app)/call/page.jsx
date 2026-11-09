'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtDuration } from '@/lib/api';
import { useHub } from '@/components/AppProvider';
import Video from '@/components/Video';

export default function CallPage() {
  const { me, activeCall, media, hangup, userName } = useHub();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  if (!activeCall) return <div className="center"><div className="card"><h2>No active call</h2><p className="muted">Start one from Calls or Chat.</p><Link className="btn primary" href="/calls">Go to Calls</Link></div></div>;

  const ringing = activeCall.state === 'ringing';
  const isHost = activeCall.hostId === me.appUserId;
  const group = activeCall.invitees.length > 1;
  const peers = activeCall.participants.filter((p) => !p.leftAt && p.userId !== me.appUserId);
  const duration = activeCall.startedAt ? (now - Date.parse(activeCall.startedAt)) / 1000 : 0;
  const names = activeCall.invitees.map((i) => userName(i.userId)).join(', ');

  return (
    <div className="room">
      <header className="row between">
        <div><strong>{ringing ? `Calling ${names}…` : peers.map((p) => userName(p.userId)).join(', ') || 'Waiting for others'}</strong>
          <div className="muted small">{ringing ? 'Waiting for an answer' : fmtDuration(duration)}</div></div>
        <span className="pill">{activeCall.type}</span>
      </header>
      {media.error && <div className="error">{media.error}</div>}
      {media.warning && <div className="warn">{media.warning}</div>}
      <div className={`tiles n${Math.min(peers.length + 1, 4)}`}>
        {peers.map((p) => (
          <div key={p.userId} className="tile">
            {media.remotes[p.userId] && activeCall.type === 'audio' && <Video stream={media.remotes[p.userId]} className="audio-only" />}
            {media.remotes[p.userId] && activeCall.type !== 'audio' ? <Video stream={media.remotes[p.userId]} className="fill" /> : <div className="placeholder"><div className="avatar big">{userName(p.userId)[0]}</div><div className="muted">{media.peerState[p.userId] === 'failed' ? 'Connection failed' : 'Connecting…'}</div></div>}
            <div className="label">{userName(p.userId)}{media.peerMedia[p.userId]?.mic === false && ' 🔇'}{media.peerMedia[p.userId]?.cam === false && ' 📷✕'}{['disconnected', 'failed'].includes(media.peerState[p.userId]) && ' ⚠ reconnecting'}</div>
          </div>
        ))}
        <div className="tile self">
          {media.local && media.cam ? <Video stream={media.local} muted mirror={!media.sharing} className="fill" /> : <div className="placeholder"><div className="avatar big">{me.name[0]}</div><div className="muted">{media.local ? 'Camera off' : 'No camera / mic'}</div></div>}
          <div className="label">You{!media.mic && ' 🔇'}{media.sharing && ' · sharing screen'}</div>
        </div>
        {ringing && !peers.length && <div className="tile"><div className="placeholder"><div className="ringing-dot" /><div className="muted">Ringing…</div></div></div>}
      </div>
      <footer className="controls">
        <button className={`btn round ${media.mic ? '' : 'off'}`} onClick={media.toggleMic} aria-pressed={!media.mic} aria-label={media.mic ? 'Mute microphone' : 'Unmute microphone'} title="Microphone">{media.mic ? '🎤' : '🔇'}</button>
        {activeCall.type === 'video' && <button className={`btn round ${media.cam ? '' : 'off'}`} onClick={media.toggleCam} aria-label={media.cam ? 'Turn camera off' : 'Turn camera on'} title="Camera">{media.cam ? '📹' : '🚫'}</button>}
        {!ringing && <button className={`btn round ${media.sharing ? 'on' : ''}`} onClick={media.toggleShare} aria-label="Share screen" title="Share screen">🖥️</button>}
        <button className="btn round danger" onClick={() => hangup()} aria-label={ringing && isHost ? 'Cancel call' : 'Leave call'} title="Hang up">📞</button>
        {isHost && group && !ringing && <button className="btn danger" onClick={() => hangup({ forAll: true })}>End for everyone</button>}
      </footer>
    </div>
  );
}
