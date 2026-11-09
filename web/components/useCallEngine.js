'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { CallEngine } from '@/lib/rtc-engine';

const TERMINAL = new Set(['ended', 'rejected', 'cancelled', 'missed', 'failed']);
const initial = { local: null, remotes: {}, peerMedia: {}, peerState: {}, mic: true, cam: true, sharing: false, warning: '', error: '' };

/** Owns the WebRTC engine for the current call. Lives in the app provider so a call survives page navigation. */
export function useCallEngine({ rt, me, call, joinPeersRef }) {
  const [state, setState] = useState(initial);
  const engineRef = useRef(null);
  const callId = call?.id;
  const meId = me?.appUserId;
  const joined = !!(call && meId && !TERMINAL.has(call.state) && call.participants.some((p) => p.userId === meId && !p.leftAt));

  useEffect(() => {
    if (!joined || !rt) return undefined;
    let disposed = false; let engine = null;
    (async () => {
      try {
        const info = await api(`calls/${callId}/token`, { method: 'POST' });
        if (disposed) return;
        if (info.provider !== 'mesh') {
          setState((s) => ({ ...s, error: 'This deployment uses the LiveKit video provider. Add the LiveKit client adapter (see README, "Scaling video") to join.' }));
          return;
        }
        engine = new CallEngine({ rt, callId, selfId: meId, callType: info.callType, iceServers: info.iceServers });
        engineRef.current = engine;
        engine.on('local-stream', (stream) => setState((s) => ({ ...s, local: stream, mic: engine.media.mic, cam: engine.media.cam })));
        engine.on('remote-stream', ({ userId, stream }) => setState((s) => ({ ...s, remotes: { ...s.remotes, [userId]: stream } })));
        engine.on('peer-left', ({ userId }) => setState((s) => { const { [userId]: _gone, ...rest } = s.remotes; return { ...s, remotes: rest }; }));
        engine.on('peer-media', ({ userId, media }) => setState((s) => ({ ...s, peerMedia: { ...s.peerMedia, [userId]: media } })));
        engine.on('peer-state', ({ userId, state: st }) => setState((s) => ({ ...s, peerState: { ...s.peerState, [userId]: st } })));
        engine.on('media-warning', (warning) => setState((s) => ({ ...s, warning })));
        engine.on('screen-share', ({ active }) => setState((s) => ({ ...s, sharing: active })));
        engine.on('error', (e) => console.warn('call engine', e));
        const peers = joinPeersRef.current;
        if (peers?.length) await engine.connectToPeers(peers);
      } catch (e) { if (!disposed) setState((s) => ({ ...s, error: e.message || 'Could not start the call' })); }
    })();
    return () => { disposed = true; engine?.close(); engineRef.current = null; setState(initial); };
  }, [joined, callId, rt, meId, joinPeersRef]);

  const toggleMic = useCallback(() => { const e = engineRef.current; if (e) { const on = e.setMic(!e.media.mic); setState((s) => ({ ...s, mic: on })); } }, []);
  const toggleCam = useCallback(() => { const e = engineRef.current; if (e) { const on = e.setCam(!e.media.cam); setState((s) => ({ ...s, cam: on })); } }, []);
  const toggleShare = useCallback(async () => {
    const e = engineRef.current; if (!e) return;
    try { if (e.screenTrack) await e.stopShare(); else await e.shareScreen(); }
    catch (err) { if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') setState((s) => ({ ...s, warning: 'Screen sharing is not available in this browser.' })); }
  }, []);

  return { ...state, toggleMic, toggleCam, toggleShare };
}
