'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { RealtimeClient } from '@/lib/realtime';
import { useCallEngine } from './useCallEngine';

const Ctx = createContext(null);
export const HubContext = Ctx; // exported for tests
export const useHub = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHub must be used inside <AppProvider>');
  return v;
};

const TERMINAL_TEXT = { 'call:ended': 'Call ended', 'call:cancelled': 'Call cancelled', 'call:rejected_all': 'Call declined', 'call:missed': 'Missed call' };

export default function AppProvider({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState(null);
  const [users, setUsers] = useState([]);
  const [online, setOnline] = useState(() => new Set());
  const [status, setStatus] = useState('connecting');
  const [rt, setRt] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [unread, setUnread] = useState({});
  const [toast, setToast] = useState(null);
  const [fatal, setFatal] = useState('');

  const ref = useRef({});
  ref.current = { me, users, incoming, activeCall, pathname, router };
  const joinPeersRef = useRef(null);
  const viewingConv = useRef(null);

  const notify = useCallback((text) => {
    const id = Date.now() + Math.random();
    setToast({ id, text });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4000);
  }, []);

  useEffect(() => {
    let cancelled = false; let client = null;
    (async () => {
      try {
        const [meRes, usersRes, convRes] = await Promise.all([
          api('me'), api('users'), api('chat/conversations').catch(() => ({ conversations: [] })),
        ]);
        if (cancelled) return;
        setMe(meRes.user); setUsers(usersRes.users);
        setOnline(new Set(usersRes.users.filter((u) => u.online).map((u) => u.appUserId)));
        setUnread(Object.fromEntries(convRes.conversations.map((c) => [c.id, c.unread])));

        client = new RealtimeClient({
          url: process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000/ws',
          getTicket: async () => (await api('auth/ws-ticket', { method: 'POST' })).ticket,
        });
        client.on('status', setStatus);
        client.on('session-expired', () => window.location.assign('/login'));
        client.on('auth:ok', (m) => {
          setOnline(new Set(m.online));
          const c = m.activeCall; const mine = meRes.user.appUserId;
          if (!c) return;
          const joined = c.participants.some((p) => p.userId === mine && !p.leftAt);
          if (joined) setActiveCall(c);
          else if (c.invitees.some((i) => i.userId === mine && i.status === 'pending')) setIncoming({ call: c, from: { appUserId: c.hostId } });
        });
        client.on('user:online', (m) => setOnline((s) => new Set(s).add(m.userId)));
        client.on('user:offline', (m) => setOnline((s) => { const n = new Set(s); n.delete(m.userId); return n; }));
        client.on('chat:message', (m) => {
          const msg = m.message;
          if (msg.senderId === meRes.user.appUserId || viewingConv.current === msg.conversationId) return;
          setUnread((u) => ({ ...u, [msg.conversationId]: (u[msg.conversationId] || 0) + 1 }));
        });
        client.on('call:incoming', (m) => setIncoming({ call: m.call, from: m.from }));
        client.on('call:ringing', (m) => { joinPeersRef.current = null; setActiveCall(m.call); ref.current.router.push('/call'); });
        client.on('call:joined', (m) => { joinPeersRef.current = m.peers; setIncoming(null); setActiveCall(m.call); ref.current.router.push('/call'); });
        client.on('call:participant_joined', (m) => setActiveCall((c) => (c?.id === m.callId ? m.call : c)));
        client.on('call:participant_left', (m) => setActiveCall((c) => (c?.id === m.callId ? { ...c, participants: c.participants.map((p) => (p.userId === m.userId ? { ...p, leftAt: new Date().toISOString() } : p)) } : c)));
        client.on('call:rejected', (m) => { const u = ref.current.users.find((x) => x.appUserId === m.userId); notify(`${u?.name || 'Someone'} declined the call`); });
        for (const type of Object.keys(TERMINAL_TEXT)) {
          client.on(type, (m) => {
            const { incoming: inc, activeCall: ac, pathname: path, router: r } = ref.current;
            if (inc?.call.id === m.callId) setIncoming(null);
            if (ac?.id === m.callId) { setActiveCall(null); joinPeersRef.current = null; notify(TERMINAL_TEXT[type]); if (path === '/call') r.replace('/calls'); }
            else if (inc?.call.id === m.callId && type === 'call:missed') notify('Missed call');
          });
        }
        client.connect();
        setRt(client);
      } catch (e) { if (!cancelled) setFatal(e.message || 'Could not load the app'); }
    })();
    return () => { cancelled = true; client?.close(); };
  }, [notify]);

  const media = useCallEngine({ rt, me, call: activeCall, joinPeersRef });

  const startCall = useCallback(async (ids, callType = 'video') => {
    if (!rt) return notify('Not connected yet');
    if (ref.current.activeCall) return notify('You are already in a call');
    try {
      const ack = await rt.request({ type: 'call:initiate', to: ids, callType, idempotencyKey: crypto.randomUUID() });
      if (['rejected', 'missed', 'cancelled', 'failed'].includes(ack.call.state)) return notify('They are busy right now');
      joinPeersRef.current = null; setActiveCall(ack.call); ref.current.router.push('/call');
    } catch (e) { notify(e.message); }
  }, [rt, notify]);

  const acceptCall = useCallback(async () => {
    const inc = ref.current.incoming; if (!inc || !rt) return;
    try { await rt.request({ type: 'call:accept', callId: inc.call.id }); } catch (e) { setIncoming(null); notify(e.message); }
  }, [rt, notify]);

  const rejectCall = useCallback(async () => {
    const inc = ref.current.incoming; setIncoming(null);
    if (inc && rt) await rt.request({ type: 'call:reject', callId: inc.call.id }).catch(() => {});
  }, [rt]);

  const hangup = useCallback(async ({ forAll = false } = {}) => {
    const c = ref.current.activeCall; if (!c || !rt) return;
    const type = c.state === 'ringing' && c.hostId === ref.current.me?.appUserId ? 'call:cancel' : forAll ? 'call:end' : 'call:leave';
    await rt.request({ type, callId: c.id }).catch((e) => notify(e.message));
    setActiveCall(null); joinPeersRef.current = null;
    ref.current.router.replace('/calls');
  }, [rt, notify]);

  const markRead = useCallback((convId) => {
    viewingConv.current = convId;
    setUnread((u) => (u[convId] ? { ...u, [convId]: 0 } : u));
    if (convId) api(`chat/conversations/${convId}/read`, { method: 'POST' }).catch(() => {});
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.assign('/login');
  }, []);

  const userName = useCallback((id) => ref.current.users.find((u) => u.appUserId === id)?.name || id, []);

  const value = useMemo(() => ({
    me, users, online, status, rt, incoming, activeCall, unread, media, toast, fatal,
    startCall, acceptCall, rejectCall, hangup, markRead, logout, notify, userName,
  }), [me, users, online, status, rt, incoming, activeCall, unread, media, toast, fatal, startCall, acceptCall, rejectCall, hangup, markRead, logout, notify, userName]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
