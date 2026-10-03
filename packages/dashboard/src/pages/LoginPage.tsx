import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@gateway.local');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Login failed. Check credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card animate-in">
        {/* Logo */}
        <div className="login-logo">
          <div className="login-logo-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '1.1rem', letterSpacing: '-0.02em' }}>AI Gateway</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Flight Radar Dashboard</div>
          </div>
        </div>

        {/* Header */}
        <div style={{ marginBottom: '1.75rem' }}>
          <h1 style={{ fontSize: '1.375rem', marginBottom: '0.4rem' }}>Sign in</h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            Access the operational monitoring dashboard
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              id="login-email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@gateway.local"
              required
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              id="login-password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div style={{
              background: 'var(--color-danger-bg)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 'var(--radius-md)',
              padding: '0.75rem 1rem',
              fontSize: '0.8125rem',
              color: 'var(--color-danger)',
            }}>
              {error}
            </div>
          )}

          <button
            id="login-submit"
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{ width: '100%', justifyContent: 'center', padding: '0.75rem', marginTop: '0.25rem' }}
          >
            {loading ? <><div className="spinner" style={{ width: 16, height: 16 }} /> Signing in…</> : 'Sign In'}
          </button>
        </form>

        {/* Demo hint */}
        <div style={{
          marginTop: '1.5rem',
          padding: '0.875rem 1rem',
          background: 'rgba(99,102,241,0.06)',
          border: '1px solid rgba(99,102,241,0.15)',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.78rem',
          color: 'var(--color-text-muted)',
          textAlign: 'center',
        }}>
          Demo credentials: <span style={{ color: 'var(--color-primary-light)', fontFamily: 'var(--font-mono)' }}>admin@gateway.local / admin123</span>
        </div>
      </div>
    </div>
  );
}
