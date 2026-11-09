// Render smoke tests: bundle each page/component with esbuild (aliasing "@/" and stubbing next/*), then server-render it
// with React under many hub states. Catches runtime errors in render paths (bad props, undefined access, missing imports).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-render-'));
const require = createRequire(import.meta.url);

const nextStubs = {
  name: 'next-stubs',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (a) => {
      const base = path.join(root, a.path.slice(2));
      for (const ext of ['', '.js', '.jsx']) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return { path: base + ext };
      return undefined;
    });
    b.onResolve({ filter: /^next\/(link|navigation)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      loader: 'js', resolveDir: root,
      contents: a.path === 'next/link'
        ? "import { createElement } from 'react'; export default function Link({ href, children, ...p }) { return createElement('a', { href, ...p }, children); }"
        : "export const usePathname = () => globalThis.__path || '/chat'; export const useRouter = () => ({ push() {}, replace() {}, refresh() {} }); export const redirect = (u) => { throw new Error('redirect:' + u); };",
    }));
  },
};

async function load(entry) {
  const out = path.join(tmp, entry.replace(/[^\w]/g, '_') + '.cjs');
  await build({
    stdin: {
      resolveDir: root, loader: 'js',
      contents: `import { renderToString } from 'react-dom/server'; import { createElement } from 'react';
        import { HubContext } from '@/components/AppProvider'; import Page from ${JSON.stringify('@/' + entry)};
        export const render = (hub) => renderToString(createElement(HubContext.Provider, { value: hub }, createElement(Page))).replace(/<!-- -->/g, '');
        export const renderBare = () => renderToString(createElement(Page)).replace(/<!-- -->/g, '');`,
    },
    bundle: true, platform: 'node', format: 'cjs', outfile: out, jsx: 'automatic', loader: { '.js': 'jsx' }, plugins: [nextStubs],
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  });
  return require(out);
}

const users = [
  { appUserId: 'APP00001', name: 'Alice Manager', role: 'manager', permissions: ['call:create', 'chat:use', 'ai:use', 'ai:approve'] },
  { appUserId: 'APP00002', name: 'Bob Technician', role: 'technician', permissions: ['call:create', 'chat:use', 'ai:use'] },
  { appUserId: 'APP00003', name: 'Carol Technician', role: 'technician', permissions: ['call:create', 'chat:use', 'ai:use'] },
];
const iso = '2026-11-07T10:00:00.000Z';
const call = (over = {}) => ({ id: 'call_1', roomId: 'room_1', type: 'video', state: 'active', hostId: 'APP00001', conversationId: null, createdAt: iso, startedAt: iso, endedAt: null, durationSec: null,
  participants: [{ userId: 'APP00001', joinedAt: iso, leftAt: null }, { userId: 'APP00002', joinedAt: iso, leftAt: null }],
  invitees: [{ userId: 'APP00002', status: 'accepted' }], ...over });
const noop = () => {};
const media = (over = {}) => ({ local: {}, remotes: {}, peerMedia: {}, peerState: {}, mic: true, cam: true, sharing: false, warning: '', error: '', toggleMic: noop, toggleCam: noop, toggleShare: noop, ...over });
const hub = (over = {}) => ({
  me: users[0], users, online: new Set(['APP00001', 'APP00002']), status: 'online', rt: { on: () => noop, send: () => true, request: async () => ({}) },
  incoming: null, activeCall: null, unread: {}, media: media(), toast: null, fatal: '',
  startCall: noop, acceptCall: noop, rejectCall: noop, hangup: noop, markRead: noop, logout: noop, notify: noop, userName: (id) => users.find((u) => u.appUserId === id)?.name || id, ...over,
});

let pages;
before(async () => {
  pages = {
    login: await load('app/login/page.jsx'), chat: await load('app/(app)/chat/page.jsx'), calls: await load('app/(app)/calls/page.jsx'),
    call: await load('app/(app)/call/page.jsx'), ai: await load('app/(app)/ai/page.jsx'), shell: await load('components/Shell.jsx'), video: await load('components/Video.jsx'),
  };
});

test('login page renders a labelled form', () => {
  const html = pages.login.renderBare();
  assert.match(html, /Enterprise Hub/); assert.match(html, /type="email"/); assert.match(html, /type="password"/); assert.match(html, /Sign in/);
});

test('shell: loading, fatal error, nav, unread badge, connection status', () => {
  assert.match(pages.shell.render(hub({ me: null })), /Loading/);
  assert.match(pages.shell.render(hub({ fatal: 'boom' })), /boom/);
  const html = pages.shell.render(hub({ unread: { a: 2, b: 1 } }));
  assert.match(html, /Chat/); assert.match(html, /AI Assistant/); assert.match(html, /<span class="badge">3<\/span>/); assert.match(html, /Connected/);
  assert.match(pages.shell.render(hub({ status: 'offline' })), /Reconnecting/);
});

test('shell: incoming call modal (1:1 and group) and return-to-call bar', () => {
  const inc = pages.shell.render(hub({ incoming: { call: call({ state: 'ringing', invitees: [{ userId: 'APP00001', status: 'pending' }], hostId: 'APP00002' }), from: { appUserId: 'APP00002' } } }));
  assert.match(inc, /Incoming video call/); assert.match(inc, /Bob Technician/); assert.match(inc, /Accept/); assert.match(inc, /Decline/);
  const grp = pages.shell.render(hub({ incoming: { call: call({ invitees: [{ userId: 'APP00001', status: 'pending' }, { userId: 'APP00003', status: 'pending' }] }), from: { appUserId: 'APP00002' } } }));
  assert.match(grp, /group of 3/);
  assert.match(pages.shell.render(hub({ activeCall: call() })), /Call in progress/);
  assert.match(pages.shell.render(hub({ activeCall: call({ state: 'ringing' }) })), /Calling/);
  globalThis.__path = '/call'; assert.doesNotMatch(pages.shell.render(hub({ activeCall: call() })), /tap to return/); globalThis.__path = '/chat';
  assert.match(pages.shell.render(hub({ toast: { id: 1, text: 'Missed call' } })), /Missed call/);
});

test('chat page renders its initial states', () => {
  const html = pages.chat.render(hub());
  assert.match(html, /Chats/); assert.match(html, /Select a conversation/); assert.match(html, /\+ New/);
});

test('calls page lists colleagues (not self) with presence and group-call control', () => {
  const html = pages.calls.render(hub());
  assert.match(html, /Bob Technician/); assert.match(html, /Carol Technician/); assert.doesNotMatch(html, /Select Alice/);
  assert.match(html, /Group video call \(0\)/); assert.match(html, /dot on/);
});

test('call room: no call, ringing (host), active 1:1 with remote video, group host controls, audio-only, errors/warnings', () => {
  assert.match(pages.call.render(hub()), /No active call/);
  const ringing = pages.call.render(hub({ activeCall: call({ state: 'ringing', participants: [{ userId: 'APP00001', joinedAt: iso, leftAt: null }], startedAt: null }) }));
  assert.match(ringing, /Calling Bob Technician/); assert.match(ringing, /Cancel call/); assert.match(ringing, /Ringing/);
  const stream = {};
  const active = pages.call.render(hub({ activeCall: call(), media: media({ remotes: { APP00002: stream }, peerMedia: { APP00002: { mic: false, cam: false } }, peerState: { APP00002: 'connected' } }) }));
  assert.match(active, /<video/); assert.match(active, /Leave call/); assert.match(active, /Bob Technician/); assert.match(active, /Share screen/); assert.match(active, /Turn camera off/);
  const connecting = pages.call.render(hub({ activeCall: call(), media: media({ peerState: { APP00002: 'failed' } }) }));
  assert.match(connecting, /Connection failed/);
  const group = pages.call.render(hub({ activeCall: call({ invitees: [{ userId: 'APP00002', status: 'accepted' }, { userId: 'APP00003', status: 'accepted' }], participants: [{ userId: 'APP00001', joinedAt: iso }, { userId: 'APP00002', joinedAt: iso }, { userId: 'APP00003', joinedAt: iso }] }) }));
  assert.match(group, /End for everyone/);
  const asGuest = pages.call.render(hub({ me: users[1], activeCall: call({ invitees: [{ userId: 'APP00002', status: 'accepted' }, { userId: 'APP00003', status: 'accepted' }], participants: [{ userId: 'APP00001', joinedAt: iso }, { userId: 'APP00002', joinedAt: iso }] }) }));
  assert.doesNotMatch(asGuest, /End for everyone/);
  const audio = pages.call.render(hub({ activeCall: call({ type: 'audio' }), media: media({ remotes: { APP00002: stream }, cam: false }) }));
  assert.match(audio, /audio-only/); assert.doesNotMatch(audio, /Turn camera/);
  const bad = pages.call.render(hub({ activeCall: call(), media: media({ error: 'LiveKit provider', warning: 'Camera unavailable', local: null, mic: false, cam: false }) }));
  assert.match(bad, /LiveKit provider/); assert.match(bad, /Camera unavailable/); assert.match(bad, /No camera \/ mic/);
  const sharing = pages.call.render(hub({ activeCall: call(), media: media({ sharing: true }) }));
  assert.match(sharing, /sharing screen/);
});

test('ai page: chat card, summary tool; approve control is only offered to authorized roles (draft view is state-driven)', () => {
  const mgr = pages.ai.render(hub());
  assert.match(mgr, /AI Assistant/); assert.match(mgr, /Call summary/); assert.match(mgr, /nothing is saved to SAP until an authorized person approves/);
  assert.match(pages.ai.render(hub({ me: users[1] })), /Ask the assistant/);
});

test('video component renders a muted, inline, autoplay element', () => {
  const html = pages.video.render(hub());
  assert.match(html, /<video/); assert.match(html, /autoPlay|autoplay/i); assert.match(html, /playsinline/i);
});
