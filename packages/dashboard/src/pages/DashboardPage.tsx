import { useEffect, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { useSocket } from '../contexts/SocketContext';
import api from '../api/client';

interface OverviewData {
  requests: {
    completed: string; failed: string; in_flight: string;
    last_hour: string; last_24h: string;
    avg_latency_ms: string; success_rate: string;
  };
  tokens: { total_tokens: string; total_cost_usd: string; active_tenants: string; };
  queue: { waiting: number; active: number; completed: number; failed: number; delayed: number; };
  providers: Array<{ name: string; display_name: string; health_status: string; error_rate: number; avg_latency_ms: number; }>;
}

interface TimeSeriesPoint {
  hour: string; provider: string; tokens: number; cost_usd: number; request_count: number;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10b981',
  anthropic: '#f59e0b',
  gemini: '#6366f1',
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-border-light)',
      borderRadius: 'var(--radius-md)',
      padding: '0.75rem 1rem',
      fontSize: '0.8rem',
      boxShadow: 'var(--shadow-lg)',
    }}>
      <div style={{ color: 'var(--color-text-muted)', marginBottom: '0.5rem', fontSize: '0.72rem' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: '1.5rem' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
            {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

export default function DashboardPage() {
  const { providers, queueMetrics, liveEvents } = useSocket();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [series, setSeries] = useState<TimeSeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [overviewRes, seriesRes] = await Promise.all([
          api.get('/admin/dashboard/overview'),
          api.get('/admin/dashboard/time-series?hours=24'),
        ]);
        setOverview(overviewRes.data);
        setSeries(seriesRes.data.series);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Build chart data - pivot provider series by hour
  const chartData = (() => {
    const hourMap: Record<string, Record<string, number>> = {};
    series.forEach((s) => {
      const hour = format(parseISO(s.hour), 'HH:mm');
      if (!hourMap[hour]) hourMap[hour] = {};
      hourMap[hour][s.provider] = s.tokens;
    });
    return Object.entries(hourMap).map(([hour, provMap]) => ({ hour, ...provMap }));
  })();

  const queueTotal = Object.values(queueMetrics).reduce((a, b) => a + b, 0);

  if (loading) {
    return (
      <div className="loading-overlay">
        <div className="spinner" style={{ width: 32, height: 32 }} />
        <span>Loading dashboard…</span>
      </div>
    );
  }

  const req = overview?.requests;
  const tok = overview?.tokens;

  return (
    <div className="animate-in">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Flight Radar <span className="text-gradient">Dashboard</span></h1>
          <p className="page-subtitle">Real-time LLM traffic monitoring and failover control</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button id="refresh-dashboard" className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Stat Cards ──────────────────────────── */}
      <div className="stat-grid animate-in">
        <StatCard
          label="Requests (24h)"
          value={Number(req?.last_24h ?? 0).toLocaleString()}
          sub={`${req?.in_flight ?? 0} in-flight`}
          gradient="linear-gradient(135deg,#6366f1,#8b5cf6)"
          iconBg="rgba(99,102,241,0.15)"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>}
        />
        <StatCard
          label="Success Rate"
          value={`${req?.success_rate ?? 0}%`}
          sub={`${req?.failed ?? 0} failed`}
          gradient="linear-gradient(135deg,#10b981,#14b8a6)"
          iconBg="rgba(16,185,129,0.15)"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>}
        />
        <StatCard
          label="Tokens (24h)"
          value={formatLargeNumber(Number(tok?.total_tokens ?? 0))}
          sub={`$${Number(tok?.total_cost_usd ?? 0).toFixed(4)} cost`}
          gradient="linear-gradient(135deg,#f59e0b,#ef4444)"
          iconBg="rgba(245,158,11,0.15)"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
        />
        <StatCard
          label="Avg Latency"
          value={`${req?.avg_latency_ms ?? 0}ms`}
          sub={`${tok?.active_tenants ?? 0} active tenants`}
          gradient="linear-gradient(135deg,#06b6d4,#6366f1)"
          iconBg="rgba(6,182,212,0.15)"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
        />
        <StatCard
          label="Queue Depth"
          value={(queueMetrics.waiting + queueMetrics.active).toString()}
          sub={`${queueMetrics.active} active workers`}
          gradient="linear-gradient(135deg,#a855f7,#ec4899)"
          iconBg="rgba(168,85,247,0.15)"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>}
        />
      </div>

      {/* ── Provider Health Grid ─────────────────── */}
      <div style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="badge badge-success badge-live" style={{ fontSize: '0.65rem' }}>LIVE</span>
          Provider Health
        </h3>
        <div className="provider-grid">
          {providers.map((p) => <ProviderCard key={p.name} provider={p} />)}
          {providers.length === 0 && (
            <div className="empty-state" style={{ gridColumn: '1/-1' }}>
              <div className="empty-state-title">No providers configured</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Charts Row ───────────────────────────── */}
      <div className="grid-2" style={{ marginTop: '1.5rem' }}>
        {/* Token Usage Chart */}
        <div className="card animate-in animate-in-delay-1">
          <div className="card-header">
            <span className="card-title">Token Usage by Provider (24h)</span>
          </div>
          <div className="card-body">
            <div className="chart-container">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <defs>
                    {Object.entries(PROVIDER_COLORS).map(([p, c]) => (
                      <linearGradient key={p} id={`grad-${p}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={c} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={c} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="hour" tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatLargeNumber} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }} />
                  {Object.entries(PROVIDER_COLORS).map(([p, c]) => (
                    <Area key={p} type="monotone" dataKey={p} stroke={c} strokeWidth={2}
                      fill={`url(#grad-${p})`} dot={false} name={p.charAt(0).toUpperCase() + p.slice(1)} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Queue Breakdown + Live Events */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Queue Metrics */}
          <div className="card animate-in animate-in-delay-2">
            <div className="card-header">
              <span className="card-title">Queue Breakdown</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>{queueTotal} total</span>
            </div>
            <div className="card-body">
              <div className="queue-bar-wrapper">
                {[
                  { key: 'waiting',   label: 'Waiting',   color: '#6366f1', bg: 'linear-gradient(90deg,#6366f1,#8b5cf6)' },
                  { key: 'active',    label: 'Active',    color: '#10b981', bg: 'linear-gradient(90deg,#10b981,#14b8a6)' },
                  { key: 'completed', label: 'Completed', color: '#06b6d4', bg: 'linear-gradient(90deg,#06b6d4,#3b82f6)' },
                  { key: 'failed',    label: 'Failed',    color: '#ef4444', bg: 'linear-gradient(90deg,#ef4444,#f59e0b)' },
                  { key: 'delayed',   label: 'Delayed',   color: '#f59e0b', bg: 'linear-gradient(90deg,#f59e0b,#f97316)' },
                ].map(({ key, label, bg }) => {
                  const val = queueMetrics[key as keyof typeof queueMetrics];
                  const pct = queueTotal > 0 ? Math.round((val / queueTotal) * 100) : 0;
                  return (
                    <div className="queue-bar-item" key={key}>
                      <div className="queue-bar-header">
                        <span className="queue-bar-label">{label}</span>
                        <span className="queue-bar-count">{val.toLocaleString()}</span>
                      </div>
                      <div className="queue-bar-track">
                        <div className="queue-bar-fill" style={{ width: `${Math.max(pct, val > 0 ? 2 : 0)}%`, background: bg }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Live Events */}
          <div className="card animate-in animate-in-delay-3" style={{ flex: 1 }}>
            <div className="card-header">
              <span className="card-title">Live Activity</span>
              <span className="badge badge-success badge-live" style={{ fontSize: '0.65rem' }}>LIVE</span>
            </div>
            <div className="card-body" style={{ padding: '0.5rem 1rem' }}>
              <div className="activity-feed">
                {liveEvents.slice(0, 8).map((ev, i) => (
                  <ActivityItem key={`${ev.requestId}-${i}`} event={ev} />
                ))}
                {liveEvents.length === 0 && (
                  <div className="empty-state" style={{ padding: '1.5rem' }}>
                    <div className="empty-state-icon">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                    </div>
                    <div className="empty-state-title">Waiting for events…</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────── */

function StatCard({ label, value, sub, gradient, iconBg, icon }: {
  label: string; value: string; sub: string;
  gradient: string; iconBg: string; icon: React.ReactNode;
}) {
  return (
    <div className="stat-card" style={{ '--stat-gradient': gradient, '--icon-bg': iconBg } as any}>
      <div className="stat-card-header">
        <span className="stat-card-label">{label}</span>
        <div className="stat-card-icon">{icon}</div>
      </div>
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-sub">{sub}</div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: any }) {
  const statusColor = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' };
  const badgeClass = { healthy: 'badge-success', degraded: 'badge-warning', down: 'badge-danger' };

  return (
    <div className={`provider-card ${provider.health_status}`}>
      <div className="provider-card-header">
        <span className="provider-name">{provider.display_name}</span>
        <span className={`badge ${badgeClass[provider.health_status as keyof typeof badgeClass] ?? 'badge-neutral'}`}>
          {provider.health_status}
        </span>
      </div>
      <div className="provider-metrics">
        <div className="provider-metric">
          <span className="provider-metric-label">Error Rate</span>
          <span className="provider-metric-value" style={{ color: provider.error_rate > 20 ? 'var(--color-danger)' : 'var(--color-text-primary)' }}>
            {Number(provider.error_rate).toFixed(1)}%
          </span>
        </div>
        <div className="provider-metric">
          <span className="provider-metric-label">Avg Latency</span>
          <span className="provider-metric-value">{provider.avg_latency_ms}ms</span>
        </div>
      </div>
    </div>
  );
}

function ActivityItem({ event }: { event: any }) {
  const colors: Record<string, string> = {
    completed: 'var(--color-success)',
    failed: 'var(--color-danger)',
    processing: 'var(--color-info)',
    queued: 'var(--color-warning)',
  };
  const color = colors[event.status] ?? 'var(--color-text-muted)';

  return (
    <div className="activity-item">
      <div className="activity-dot" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      <div className="activity-content">
        <div className="activity-title">
          {event.status === 'completed' ? `${event.provider} / ${event.model}` : event.status.charAt(0).toUpperCase() + event.status.slice(1)}
          {event.totalTokens ? <span style={{ color: 'var(--color-text-muted)', fontWeight: 400, marginLeft: '0.5rem', fontSize: '0.75rem' }}>{event.totalTokens.toLocaleString()} tokens</span> : null}
        </div>
        <div className="activity-meta">
          <span className="font-mono">{event.requestId.slice(0, 8)}…</span>
          {event.latencyMs && <span>{event.latencyMs}ms</span>}
          {event.costUsd && <span>${Number(event.costUsd).toFixed(5)}</span>}
        </div>
      </div>
      <div className="activity-time">{new Date(event.timestamp).toLocaleTimeString()}</div>
    </div>
  );
}

function formatLargeNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
