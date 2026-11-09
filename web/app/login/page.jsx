'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
      router.replace('/chat');
      router.refresh();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Enterprise Hub</h1>
        <p className="muted">Sign in to chat, call and use the AI assistant.</p>
        <label>Email<input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alice@company.com" /></label>
        <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {process.env.NODE_ENV !== 'production' && <p className="muted small">Demo: alice / bob / carol / dave @company.com — Password@123</p>}
      </form>
    </div>
  );
}
