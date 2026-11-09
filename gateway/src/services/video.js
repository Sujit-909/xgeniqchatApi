// Video Service: issues short-lived, room-scoped join credentials. Clients never see provider secrets.
// provider "mesh"    -> built-in WebRTC engine (signaling through the gateway WebSocket), best for 1:1 and small groups.
// provider "livekit" -> SFU; returns a LiveKit access token (set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).
import { signJwt } from '../lib/jwt.js';

export class VideoService {
  constructor(config) { this.cfg = config.video; }

  get provider() { return this.cfg.livekitUrl && this.cfg.livekitKey && this.cfg.livekitSecret ? 'livekit' : 'mesh'; }

  createLiveKitToken({ identity, name, roomId, canPublish = true }) {
    return signJwt(
      { iss: this.cfg.livekitKey, sub: identity, name, nbf: Math.floor(Date.now() / 1000) - 5, video: { room: roomId, roomJoin: true, canPublish, canSubscribe: true, canPublishData: true } },
      this.cfg.livekitSecret,
      { expiresInSec: this.cfg.tokenTtlSec },
    );
  }

  joinInfo(user, call) {
    // Provider identity is the application user ID, never the email.
    const base = { callId: call.id, roomId: call.roomId, identity: user.appUserId, callType: call.type };
    if (this.provider === 'livekit') {
      return { ...base, provider: 'livekit', url: this.cfg.livekitUrl, token: this.createLiveKitToken({ identity: user.appUserId, name: user.name, roomId: call.roomId }), expiresIn: this.cfg.tokenTtlSec };
    }
    return { ...base, provider: 'mesh', iceServers: this.cfg.iceServers };
  }
}
