import { useEffect, useState } from 'react';
import api from '../api/client';
import { useSocket, ProviderControl, TenantLive, TrafficStatus } from '../contexts/SocketContext';

interface LiveState {
  controls: ProviderControl[];
  tenants: TenantLive[];
  fairShare: boolean;
}

const BREAKER_BADGE: Record<string, string> = { CLOSED: 'badge-success', HALF_OPEN: 'badge-warning', OPEN: 'badge-danger' };
const CHAOS_LEVELS = [0, 0.5, 1];

export default function DemoPage() {
  const socket = useSocket();
  const [live, setLive] = useState<LiveState>({ controls: [], tenants: [], fairShare: true });
  const [traffic, setTraffic] = useState<TrafficStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Socket pushes every 2s; the REST snapshot gives instant feedback after a click
  useEffect(() => {
    if (socket.controls.length || socket.tenants.length) {
      setLive({ controls: socket.controls, tenants: socket.tenants, fairShare: socket.fairShare });
    }
  }, [socket.controls, socket.tenants, socket.fairShare]);

  useEffect(() => {
    if (socket.traffic) setTraffic(socket.traffic);
  }, [socket.traffic]);

  const refresh = async () => {
    const { data } = await api.get('/admin/live');
    setLive({ controls: data.controls, tenants: data.tenants, fairShare: data.fairShare });
  };

  useEffect(() => {
    refresh().catch(console.error);
    api.get('/admin/demo/traffic')
      .then(({ data }) => setTraffic(data))
      .catch(() => setMessage({ kind: 'error', text: 'Demo mode is disabled on the server (set DEMO_MODE=true).' }));
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      await refresh();
      if (success) setMessage({ kind: 'ok', text: success });
    } catch (e: any) {
      setMessage({ kind: 'error', text: e?.response?.data?.error ?? 'Action failed' });
    } finally {
      setBusy(null);
    }
  };

  const trafficAction = (action: string) =>
    run(action, async () => setTraffic((await api.post('/admin/demo/traffic', { action })).data));

  const demoTenants = traffic ? Object.entries(traffic.tenants) : [];
  const activeTenants = live.tenants.filter(
    (t) => t.laneDepth > 0 || t.inFlight > 0 || t.tpmUsed > 0 || t.completedRecent > 0 || t.rejectedLastMinute > 0
  );

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Demo <span className="text-gradient">Control Room</span></h1>
          <p className="page-subtitle">Generate traffic, break providers, and watch fair-share, rate limiting and failover react live</p>
        </div>
        <span className="badge badge-success badge-live">Live</span>
      </div>

      {message && (
        <div className="card" style={{ marginBottom: '1rem', borderColor: message.kind === 'ok' ? 'var(--color-success)' : 'var(--color-danger)' }}>
          <div className="card-body" style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: message.kind === 'ok' ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {message.text}
          </div>
        </div>
      )}

      {/* ── Traffic generator ─────────────────────── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-header">
          <span className="card-title">1 · Traffic generator</span>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {traffic?.steady && <span className="badge badge-success badge-live">steady running</span>}
            {traffic?.burst && <span className="badge badge-danger badge-live">burst running</span>}
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <button id="demo-steady" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => trafficAction('steady')}>
              ▶ Steady traffic (Acme + Globex)
            </button>
            <button id="demo-burst" className="btn btn-danger btn-sm" disabled={!!busy || traffic?.burst} onClick={() => trafficAction('burst')}>
              💥 Noisy-neighbour burst (Initech × 300)
            </button>
            <button id="demo-stop" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => trafficAction('stop')}>
              ■ Stop
            </button>
            <button id="demo-reset" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => trafficAction('reset')}>
              Reset counters
            </button>
            <button
              id="demo-seed"
              className="btn btn-secondary btn-sm"
              disabled={!!busy}
              onClick={() =>
                run('seed', async () => {
                  const { data } = await api.post('/admin/demo/seed-history');
                  setMessage({ kind: 'ok', text: `Seeded ${data.requests} historical requests — open Flight Radar to see the 24h charts.` });
                })
              }
            >
              {busy === 'seed' ? 'Seeding…' : '⟲ Seed 24h history'}
            </button>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Client tenant</th><th>Sent</th><th>Accepted (202)</th><th>Rate-limited (429)</th><th>Errors</th></tr>
              </thead>
              <tbody>
                {demoTenants.map(([id, t]) => (
                  <tr key={id}>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td className="font-mono">{t.sent}</td>
                    <td className="font-mono text-success">{t.accepted}</td>
                    <td className="font-mono" style={{ color: t.rateLimited ? 'var(--color-danger)' : undefined }}>{t.rateLimited}</td>
                    <td className="font-mono">{t.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Fair-share + sliding window ───────────── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-header">
          <span className="card-title">2 · Fair-share scheduling & sliding-window limits</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
              {live.fairShare ? 'Round-robin per tenant' : 'Global FIFO (unfair)'}
            </span>
            <label className="toggle" title="Toggle fair-share scheduling">
              <input
                id="toggle-fair-share"
                type="checkbox"
                checked={live.fairShare}
                disabled={!!busy}
                onChange={() => run('fair', () => api.put('/admin/fair-share', { enabled: !live.fairShare }))}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="card-body">
          <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', marginBottom: '1rem' }}>
            Queue wait = time from 202 Accepted to a worker picking the job up. With fair-share on, the quiet tenants'
            wait stays low during the burst; switch to FIFO and run the burst again to see it explode.
          </p>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Tenant</th><th>Lane backlog</th><th>In flight</th>
                  <th>Avg wait</th><th>p95 wait</th>
                  <th style={{ minWidth: 180 }}>Tokens / min (sliding 60s)</th>
                  <th>Req / min</th><th>429s (60s)</th>
                </tr>
              </thead>
              <tbody>
                {activeTenants.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td className="font-mono">{t.laneDepth}</td>
                    <td className="font-mono">{t.inFlight}</td>
                    <td className="font-mono" style={{ color: waitColor(t.avgWaitMs) }}>{formatMs(t.avgWaitMs)}</td>
                    <td className="font-mono" style={{ color: waitColor(t.p95WaitMs) }}>{formatMs(t.p95WaitMs)}</td>
                    <td><Gauge used={t.tpmUsed} limit={t.tpmLimit} /></td>
                    <td className="font-mono" style={{ color: t.rpmUsed >= t.rpmLimit ? 'var(--color-danger)' : undefined }}>
                      {t.rpmUsed}/{t.rpmLimit}
                    </td>
                    <td className="font-mono" style={{ color: t.rejectedLastMinute ? 'var(--color-danger)' : undefined }}>
                      {t.rejectedLastMinute}
                    </td>
                  </tr>
                ))}
                {activeTenants.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '1.5rem' }}>
                    No recent traffic — start the generator above.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Chaos + circuit breakers ──────────────── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-header">
          <span className="card-title">3 · Chaos & circuit breakers</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Failover order: priority (OpenAI → Anthropic → Gemini)</span>
        </div>
        <div className="card-body">
          <div className="provider-grid">
            {live.controls.map((c) => (
              <div key={c.name} className={`provider-card ${c.breaker.state === 'OPEN' ? 'down' : c.breaker.state === 'HALF_OPEN' ? 'degraded' : 'healthy'}`}>
                <div className="provider-card-header">
                  <span className="provider-name" style={{ textTransform: 'capitalize' }}>{c.name}</span>
                  <span className={`badge ${c.mode === 'live' ? 'badge-info' : 'badge-neutral'}`}>{c.mode}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.6rem 0' }}>
                  <span className={`badge ${BREAKER_BADGE[c.breaker.state]}`}>{c.breaker.state}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
                    {c.breaker.consecutiveFailures} consecutive failures
                  </span>
                </div>
                {c.breaker.lastError && c.breaker.state !== 'CLOSED' && (
                  <div className="truncate" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginBottom: '0.6rem' }} title={c.breaker.lastError}>
                    {c.breaker.lastError}
                  </div>
                )}
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginBottom: '0.35rem' }}>Injected failure rate</div>
                <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.6rem' }}>
                  {CHAOS_LEVELS.map((level) => (
                    <button
                      key={level}
                      id={`chaos-${c.name}-${level * 100}`}
                      className={`btn btn-sm ${c.chaos.failureRate === level ? (level ? 'btn-danger' : 'btn-primary') : 'btn-secondary'}`}
                      disabled={!!busy}
                      onClick={() => run(`chaos-${c.name}`, () => api.put(`/admin/chaos/${c.name}`, { failureRate: level }))}
                    >
                      {level * 100}%
                    </button>
                  ))}
                </div>
                <button
                  id={`reset-breaker-${c.name}`}
                  className="btn btn-secondary btn-sm"
                  disabled={!!busy || c.breaker.state === 'CLOSED'}
                  onClick={() => run(`reset-${c.name}`, () => api.post(`/admin/circuit-breaker/${c.name}/reset`))}
                >
                  Reset breaker
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Suggested flow ────────────────────────── */}
      <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 'var(--radius-lg)', padding: '1.25rem 1.5rem' }}>
        <h3 style={{ marginBottom: '0.75rem', color: 'var(--color-primary-light)' }}>Suggested 5-minute flow</h3>
        <ol style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', paddingLeft: '1.2rem', lineHeight: 1.8 }}>
          <li>Start <b>steady traffic</b> — two tenants, low queue wait.</li>
          <li>Fire the <b>noisy-neighbour burst</b> — Initech's lane fills, it hits its RPM limit (429s), yet Acme/Globex wait stays low.</li>
          <li>Toggle fair-share <b>off</b>, burst again — quiet tenants now queue behind Initech. Toggle back on.</li>
          <li>Set <b>OpenAI chaos to 100%</b> — breaker trips OPEN after 3 failures, traffic fails over to Anthropic (see Flight Radar activity).</li>
          <li>Set chaos back to <b>0%</b> — after the 10s cooldown the breaker goes HALF-OPEN, probes succeed, and it closes.</li>
        </ol>
      </div>
    </div>
  );
}

function Gauge({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const bg = pct >= 90 ? 'linear-gradient(90deg,#ef4444,#f59e0b)' : pct >= 60 ? 'linear-gradient(90deg,#f59e0b,#f97316)' : 'linear-gradient(90deg,#10b981,#14b8a6)';
  return (
    <div>
      <div className="queue-bar-track">
        <div className="queue-bar-fill" style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%`, background: bg }} />
      </div>
      <div className="font-mono" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '0.2rem' }}>
        {used.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
      </div>
    </div>
  );
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function waitColor(ms: number | null): string | undefined {
  if (ms === null) return undefined;
  return ms > 5000 ? 'var(--color-danger)' : ms > 1500 ? 'var(--color-warning)' : 'var(--color-success)';
}
