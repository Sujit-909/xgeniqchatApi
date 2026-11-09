// Video calling engine: browser WebRTC with signaling relayed through the gateway (rtc:signal).
// Mesh topology (each participant connects to each other), best for 1:1 and small groups (<= 8).
// Uses the "perfect negotiation" pattern so simultaneous offers (glare) and renegotiation are safe.
// For larger rooms, switch the gateway to the LiveKit SFU provider (see README).

class Emitter {
  constructor() { this.l = new Map(); }
  on(t, f) { if (!this.l.has(t)) this.l.set(t, new Set()); this.l.get(t).add(f); return () => this.l.get(t)?.delete(f); }
  emit(t, p) { for (const f of [...(this.l.get(t) || [])]) { try { f(p); } catch (e) { console.error(e); } } }
}

class Peer {
  /** passive=true: created because the remote side offered first; local tracks are attached when answering (no glare). */
  constructor(engine, userId, { passive = false } = {}) {
    this.engine = engine; this.userId = userId;
    this.polite = engine.selfId > userId; // deterministic roles; the polite peer yields on collisions
    this.makingOffer = false; this.ignoreOffer = false; this.queue = Promise.resolve(); this.closed = false;
    const pc = this.pc = engine.createPeerConnection({ iceServers: engine.iceServers });
    pc.onicecandidate = ({ candidate }) => { if (candidate) engine.signal(userId, { candidate: candidate.toJSON ? candidate.toJSON() : candidate }); };
    pc.ontrack = ({ streams, track }) => {
      const stream = streams?.[0] || (this.remote ||= new engine.MediaStreamImpl());
      if (!streams?.[0]) stream.addTrack(track);
      this.stream = stream;
      engine.emit('remote-stream', { userId, stream });
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        engine.signal(userId, { description: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
      } catch (e) { engine.emit('error', e); } finally { this.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      engine.emit('peer-state', { userId, state: pc.connectionState });
      clearTimeout(this.restartTimer);
      if (pc.connectionState === 'failed') pc.restartIce?.();
      // Wi-Fi <-> mobile switches surface as "disconnected": give it a moment, then restart ICE.
      if (pc.connectionState === 'disconnected') this.restartTimer = setTimeout(() => { if (!this.closed && pc.connectionState === 'disconnected') pc.restartIce?.(); }, 3000);
    };
    this.localAttached = false; this.pendingCandidates = [];
    if (!passive) this.#attachLocal();
  }

  #attachLocal() {
    if (this.localAttached) return;
    this.localAttached = true;
    const { engine, pc } = this;
    const tracks = engine.localStream?.getTracks() || [];
    if (tracks.length) for (const t of tracks) pc.addTrack(t, engine.localStream);
    else if (!this.passiveAnswered) { pc.addTransceiver('audio', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); } // media denied: still receive
  }

  handle(data) {
    this.queue = this.queue.then(() => this.#process(data)).catch((e) => this.engine.emit('error', e));
    return this.queue;
  }

  async #process({ description, candidate }) {
    const pc = this.pc;
    if (this.closed) return;
    if (description) {
      const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      for (const c of this.pendingCandidates.splice(0)) { try { await pc.addIceCandidate(c); } catch { /* stale candidate */ } }
      if (description.type === 'offer') {
        // Passive side: reuse the transceivers created by the offer so our answer carries our media without a second offer.
        this.passiveAnswered = true;
        this.#attachLocal();
        await pc.setLocalDescription();
        this.engine.signal(this.userId, { description: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
      }
    } else if (candidate) {
      if (!pc.remoteDescription) { this.pendingCandidates.push(candidate); return; } // arrived before the offer: hold it
      try { await pc.addIceCandidate(candidate); } catch (e) { if (!this.ignoreOffer) throw e; }
    }
  }

  close() { this.closed = true; clearTimeout(this.restartTimer); try { this.pc.close(); } catch { /* ignore */ } }
}

export class CallEngine extends Emitter {
  constructor({ rt, callId, selfId, callType = 'video', iceServers = [], getUserMedia, getDisplayMedia, createPeerConnection, MediaStreamImpl = globalThis.MediaStream }) {
    super();
    Object.assign(this, { rt, callId, selfId, callType, iceServers, MediaStreamImpl });
    this.getUserMedia = getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c));
    this.getDisplayMedia = getDisplayMedia || ((c) => navigator.mediaDevices.getDisplayMedia(c));
    this.createPeerConnection = createPeerConnection || ((cfg) => new RTCPeerConnection(cfg));
    this.peers = new Map();
    this.localStream = null; this.screenTrack = null; this.cameraTrack = null;
    this.media = { mic: true, cam: callType === 'video' };
    this.closed = false;
    this.unsubs = [
      rt.on('rtc:signal', (m) => this.#onSignal(m)),
      rt.on('call:participant_left', (m) => { if (m.callId === callId) this.removePeer(m.userId); }),
      rt.on('call:participant_joined', (m) => { if (m.callId === callId) this.emit('peer-joined', { userId: m.userId }); }),
    ];
    this.ready = this.#startMedia();
  }

  signal(to, data) { if (!this.closed) this.rt.send({ type: 'rtc:signal', callId: this.callId, to, data }); }

  async #startMedia() {
    const attempts = this.callType === 'video'
      ? [{ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }, { audio: true }]
      : [{ audio: true }];
    let lastErr;
    for (const c of attempts) {
      try {
        const stream = await this.getUserMedia(c);
        if (this.closed) { for (const t of stream.getTracks()) t.stop(); return; } // closed while the permission prompt was open
        this.localStream = stream;
        this.cameraTrack = this.localStream.getVideoTracks()[0] || null;
        this.media = { mic: this.localStream.getAudioTracks().length > 0, cam: !!this.cameraTrack };
        if (c !== attempts[0]) this.emit('media-warning', 'Camera unavailable or denied: joined with audio only.');
        this.emit('local-stream', this.localStream);
        return;
      } catch (e) { lastErr = e; }
    }
    this.media = { mic: false, cam: false };
    this.emit('media-warning', `Microphone and camera unavailable (${lastErr?.name || 'error'}). You can still see and hear others.`);
    this.emit('local-stream', null);
  }

  /** Joiner side: open a connection to every participant already in the call. */
  async connectToPeers(peerIds) {
    await this.ready;
    if (this.closed) return;
    for (const id of peerIds) this.#peer(id);
    this.#announceMedia();
  }

  #peer(userId, opts) {
    let p = this.peers.get(userId);
    if (!p) { p = new Peer(this, userId, opts); this.peers.set(userId, p); }
    return p;
  }

  async #onSignal(m) {
    if (m.callId !== this.callId || this.closed) return;
    await this.ready;
    if (this.closed) return;
    const data = m.data || {};
    if (data.media) { this.emit('peer-media', { userId: m.from, media: data.media }); return; }
    const passive = !this.peers.has(m.from); // first contact came from them: answer, don't offer
    this.#peer(m.from, { passive }).handle(data);
    this.#sendMediaTo(m.from);
  }

  #sendMediaTo(userId) { this.signal(userId, { media: { ...this.media } }); }
  #announceMedia() { for (const id of this.peers.keys()) this.#sendMediaTo(id); }

  setMic(on) {
    for (const t of this.localStream?.getAudioTracks() || []) t.enabled = on;
    this.media.mic = on && (this.localStream?.getAudioTracks().length > 0);
    this.#announceMedia(); return this.media.mic;
  }

  setCam(on) {
    if (!this.cameraTrack) return false;
    this.cameraTrack.enabled = on; this.media.cam = on;
    this.#announceMedia(); return on;
  }

  async shareScreen() {
    if (this.screenTrack) return;
    const display = await this.getDisplayMedia({ video: true, audio: false });
    const track = display.getVideoTracks()[0];
    if (!track) return;
    this.screenTrack = track;
    track.onended = () => this.stopShare();
    await this.#replaceVideo(track);
    this.emit('screen-share', { active: true, stream: display });
  }

  async stopShare() {
    if (!this.screenTrack) return;
    const t = this.screenTrack; this.screenTrack = null;
    try { t.stop(); } catch { /* ignore */ }
    await this.#replaceVideo(this.cameraTrack);
    this.emit('screen-share', { active: false });
  }

  async #replaceVideo(track) {
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video') || pc.getTransceivers?.().find((x) => x.receiver?.track?.kind === 'video')?.sender;
      if (sender) await sender.replaceTrack(track);
    }
  }

  removePeer(userId) {
    const p = this.peers.get(userId);
    if (!p) return;
    p.close(); this.peers.delete(userId);
    this.emit('peer-left', { userId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const u of this.unsubs) u();
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    for (const t of this.localStream?.getTracks() || []) { try { t.stop(); } catch { /* ignore */ } }
    try { this.screenTrack?.stop(); } catch { /* ignore */ }
    this.localStream = null;
    this.emit('closed');
  }
}
