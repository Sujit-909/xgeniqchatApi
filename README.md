# Enterprise Hub

Node.js gateway + Next.js web app with **chat**, **video calling** (own WebRTC engine) and an **AI assistant**, following the SAP / React Native / Next.js / Video / AI architecture document.

```
web/      Next.js 15 (App Router): login, Chat, Calls, Call room, AI Assistant, BFF proxy (HTTP-only cookies)
gateway/  Node.js (zero runtime dependencies): REST + WebSocket, auth, chat, call state machine,
          video join service, AI gateway, SAP integration layer
```

## Run
```bash
npm run install:all          # needs network (installs next/react)
npm run gateway              # http://localhost:4000   (demo SAP data is built in)
cp web/.env.example web/.env.local
npm run web                  # http://localhost:3000
```
Demo users (dev only): `alice|bob|carol|dave@company.com`, password `Password@123`.
Open two browsers (or one normal + one private window), sign in as different users, chat and call each other.

## Test
`npm test` runs gateway tests (33) and web tests (27).

## What is real vs. stand-in
| Area | Status |
|---|---|
| Auth (JWT access + rotating refresh, WS tickets, rate limits, deactivation check) | implemented, tested |
| Chat (direct/group, history, unread, idempotent send, typing, presence) | implemented, tested |
| Call state machine (ring, accept, reject, cancel, missed, busy, group, reconnect grace) | implemented, tested |
| WebRTC engine (perfect negotiation, mute/camera, screen share, ICE restart, permission fallbacks) | implemented; tested with a **fake** RTCPeerConnection against the real gateway |
| AI gateway (PII masking, audit log, daily budget, draft-then-approve) | implemented, tested; `ANTHROPIC_API_KEY` enables the real model |
| SAP layer | **mock backend** (`gateway/src/services/sap.js`): replace `MockSapBackend` with OData/REST calls; circuit breaker, cache and retry queue are real |
| Storage | **in memory** (restart = data loss). Swap the Maps in `chat.js`/`calls.js` for Redis/PostgreSQL before production |
| LiveKit SFU | gateway issues real LiveKit tokens when configured; the **web client adapter is not built** (mesh only, up to ~8 people) |
| Push notifications | stub (`notifications.js`) |
| React Native app | not included |

## Not verified in this build environment
No network was available, so `npm install`, `next build` and real browsers were **not** run. The pages were syntax-checked with esbuild and server-rendered with React in tests, but click-through behaviour, real camera/mic, and cross-network calls (TURN) need a manual pass. For calls across NAT/mobile networks configure a TURN server via `ICE_SERVERS`.

## Production checklist
Set `JWT_SECRET`, `CORS_ORIGINS`, `NODE_ENV=production`, serve both apps over HTTPS/WSS, add TURN, move state to Redis/PostgreSQL, run multiple gateway instances only after state is external.
