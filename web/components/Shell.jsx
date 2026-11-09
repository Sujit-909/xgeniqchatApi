'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useHub } from './AppProvider';

const NAV = [['/chat', 'Chat'], ['/calls', 'Calls'], ['/ai', 'AI Assistant']];

export default function Shell({ children }) {
  const { me, status, unread, incoming, activeCall, acceptCall, rejectCall, logout, toast, fatal, userName } = useHub();
  const pathname = usePathname();
  const unreadTotal = Object.values(unread).reduce((a, b) => a + b, 0);
  if (fatal) return <div className="center"><div className="card"><h2>Something went wrong</h2><p className="muted">{fatal}</p><button className="btn" onClick={() => window.location.reload()}>Reload</button></div></div>;
  if (!me) return <div className="center muted">Loading…</div>;
  const caller = incoming ? userName(incoming.from?.appUserId || incoming.call.hostId) : '';

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Enterprise Hub</div>
        <nav>
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className={pathname === href ? 'active' : ''}>
              {label}{href === '/chat' && unreadTotal > 0 && <span className="badge">{unreadTotal}</span>}
            </Link>
          ))}
        </nav>
        <div className="me">
          <div className="avatar">{me.name[0]}</div>
          <div><div>{me.name}</div><div className="muted small">{me.role}</div></div>
        </div>
        <div className={`conn ${status}`}>{status === 'online' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</div>
        <button className="btn ghost" onClick={logout}>Sign out</button>
      </aside>
      <main className="main">
        {activeCall && pathname !== '/call' && (
          <Link href="/call" className="callbar">{activeCall.state === 'ringing' ? 'Calling…' : 'Call in progress'} — tap to return</Link>
        )}
        {children}
      </main>
      {incoming && (
        <div className="modal" role="alertdialog" aria-label="Incoming call">
          <div className="card ring">
            <div className="avatar big">{caller[0]}</div>
            <h2>{caller}</h2>
            <p className="muted">Incoming {incoming.call.type} call{incoming.call.invitees.length > 1 ? ` (group of ${incoming.call.invitees.length + 1})` : ''}</p>
            <div className="row center-row">
              <button className="btn danger" onClick={rejectCall}>Decline</button>
              <button className="btn ok" onClick={acceptCall}>Accept</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast.text}</div>}
    </div>
  );
}
