import { useEffect, useState } from 'react';
import api from '../api/client';
import { useSocket } from '../contexts/SocketContext';

interface Provider {
  id: string; name: string; display_name: string; is_active: boolean;
  priority: number; health_status: string; error_rate: number;
  avg_latency_ms: number; last_health_check: string | null; model_count: number;
  mode: 'live' | 'mock';
}

interface Model {
  id: string; provider_id: string; name: string; display_name: string;
  context_window: number; input_cost_per_1k_tokens: number;
  output_cost_per_1k_tokens: number; is_active: boolean;
}

export default function ProvidersPage() {
  const { providers: liveProviders } = useSocket();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchProviders = async () => {
    try {
      const { data } = await api.get('/admin/providers');
      setProviders(data.providers);
      setModels(data.models);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchProviders(); }, []);

  // Merge live socket data for real-time health updates
  const mergedProviders = providers.map((p) => {
    const live = liveProviders.find((lp) => lp.name === p.name);
    if (live) {
      return { ...p, health_status: live.health_status, error_rate: live.error_rate, avg_latency_ms: live.avg_latency_ms };
    }
    return p;
  });

  const toggleProvider = async (id: string, current: boolean) => {
    setToggling(id);
    try {
      await api.patch(`/admin/providers/${id}/status`, { isActive: !current });
      setProviders((prev) => prev.map((p) => p.id === id ? { ...p, is_active: !current } : p));
    } catch (e) { console.error(e); }
    finally { setToggling(null); }
  };

  if (loading) {
    return <div className="loading-overlay"><div className="spinner" /><span>Loading providers…</span></div>;
  }

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Provider <span className="text-gradient">Control</span></h1>
          <p className="page-subtitle">Manage LLM providers, health status, and failover routing</p>
        </div>
        <span className="badge badge-success badge-live">Live Health</span>
      </div>

      {/* Provider Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
        {mergedProviders.map((p) => {
          const provModels = models.filter((m) => m.provider_id === p.id);
          const statusColors: Record<string, string> = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' };
          const statusColor = statusColors[p.health_status] ?? 'var(--color-text-muted)';

          return (
            <div key={p.id} className="card">
              <div className="card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
                  {/* Provider Logo placeholder */}
                  <div style={{
                    width: 40, height: 40, borderRadius: 'var(--radius-md)',
                    background: p.name === 'openai' ? 'rgba(16,185,129,0.12)' : p.name === 'anthropic' ? 'rgba(245,158,11,0.12)' : 'rgba(99,102,241,0.12)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${statusColor}33`,
                  }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 800, color: statusColor, letterSpacing: '0.01em', textTransform: 'uppercase' }}>
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{p.display_name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                      Priority {p.priority} · {p.model_count} models ·{' '}
                      <span style={{ color: p.mode === 'live' ? 'var(--color-info)' : 'var(--color-text-muted)' }}>
                        {p.mode === 'live' ? 'live API' : 'mock (no API key)'}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <span className={`badge ${p.health_status === 'healthy' ? 'badge-success' : p.health_status === 'degraded' ? 'badge-warning' : 'badge-danger'}`}>
                    {p.health_status}
                  </span>
                  <label className="toggle" title={p.is_active ? 'Disable provider' : 'Enable provider'}>
                    <input
                      type="checkbox"
                      id={`toggle-${p.name}`}
                      checked={p.is_active}
                      disabled={toggling === p.id}
                      onChange={() => toggleProvider(p.id, p.is_active)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>

              <div className="card-body">
                {/* Metrics Row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.25rem' }}>
                  {[
                    { label: 'Error Rate', value: `${Number(p.error_rate).toFixed(1)}%`, color: p.error_rate > 20 ? 'var(--color-danger)' : p.error_rate > 5 ? 'var(--color-warning)' : 'var(--color-success)' },
                    { label: 'Avg Latency', value: `${p.avg_latency_ms}ms`, color: p.avg_latency_ms > 5000 ? 'var(--color-danger)' : 'var(--color-text-primary)' },
                    { label: 'Last Check', value: p.last_health_check ? new Date(p.last_health_check).toLocaleTimeString() : '—', color: 'var(--color-text-muted)' },
                    { label: 'Status', value: p.is_active ? 'Active' : 'Disabled', color: p.is_active ? 'var(--color-success)' : 'var(--color-danger)' },
                  ].map((m) => (
                    <div key={m.label}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>{m.label}</div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: m.color }}>{m.value}</div>
                    </div>
                  ))}
                </div>

                {/* Models table */}
                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Models</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                    {provModels.map((m) => (
                      <span key={m.id} style={{
                        padding: '0.25rem 0.625rem',
                        background: m.is_active ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${m.is_active ? 'rgba(99,102,241,0.2)' : 'var(--color-border)'}`,
                        borderRadius: 'var(--radius-full)',
                        fontSize: '0.72rem',
                        fontFamily: 'var(--font-mono)',
                        color: m.is_active ? 'var(--color-primary-light)' : 'var(--color-text-muted)',
                      }}>
                        {m.name}
                        <span style={{ marginLeft: '0.4rem', opacity: 0.7 }}>
                          ${Number(m.input_cost_per_1k_tokens).toFixed(4)}/1K in
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Routing Info Box */}
      <div style={{
        background: 'rgba(99,102,241,0.06)',
        border: '1px solid rgba(99,102,241,0.15)',
        borderRadius: 'var(--radius-lg)',
        padding: '1.25rem 1.5rem',
      }}>
        <h3 style={{ marginBottom: '0.75rem', color: 'var(--color-primary-light)' }}>⚡ Failover Routing Logic</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
          {[
            { icon: '1️⃣', title: 'Priority-Based Selection', desc: 'Each request tries active providers in priority order (lower = preferred), using each provider’s default model unless a model is requested.' },
            { icon: '⚡', title: 'Automatic Failover', desc: 'On 429 (Rate Limit) or 5xx errors, the gateway instantly falls back to the next provider in the chain.' },
            { icon: '🩺', title: 'Distributed Circuit Breaker', desc: 'After 3 consecutive failures a provider is skipped (OPEN) for 10s, then probed (HALF-OPEN); 2 successful probes close it. State is shared by all workers via Redis.' },
            { icon: '🛡️', title: 'SSRF Protection', desc: 'Callback URLs are DNS-resolved, every IP is checked against private/metadata ranges, the connection is pinned to the validated IP, and redirects are refused.' },
          ].map((item) => (
            <div key={item.title} style={{ display: 'flex', gap: '0.75rem' }}>
              <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{item.icon}</span>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '0.2rem', fontSize: '0.85rem' }}>{item.title}</div>
                <div style={{ fontSize: '0.8rem' }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
