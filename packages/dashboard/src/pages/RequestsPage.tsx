import { useEffect, useState } from 'react';
import api from '../api/client';

interface Request {
  id: string; status: string; provider_used: string | null; model_used: string | null;
  total_tokens: number; estimated_cost_usd: number; total_latency_ms: number | null;
  attempt_count: number; providers_tried: string[]; error_code: string | null;
  created_at: string; completed_at: string | null; tenant_name: string;
}

const STATUS_FILTERS = ['all', 'completed', 'failed', 'processing', 'queued', 'pending'];

const statusBadge = (status: string) => {
  const map: Record<string, string> = {
    completed: 'badge-success', failed: 'badge-danger',
    processing: 'badge-info', queued: 'badge-warning',
    pending: 'badge-neutral',
  };
  return <span className={`badge ${map[status] ?? 'badge-neutral'}`}>{status}</span>;
};

export default function RequestsPage() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Request | null>(null);
  const [search, setSearch] = useState('');

  const fetchRequests = async (statusFilter: string) => {
    setLoading(true);
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}&limit=100` : '?limit=100';
      const { data } = await api.get(`/admin/dashboard/requests${params}`);
      setRequests(data.requests);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchRequests(filter); }, [filter]);
  useEffect(() => {
    const t = setInterval(() => fetchRequests(filter), 10000);
    return () => clearInterval(t);
  }, [filter]);

  const filtered = requests.filter((r) =>
    !search || r.id.includes(search) || r.tenant_name?.includes(search) ||
    r.provider_used?.includes(search) || r.model_used?.includes(search)
  );

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Request <span className="text-gradient">Ledger</span></h1>
          <p className="page-subtitle">Full audit trail of all gateway requests</p>
        </div>
        <button id="refresh-requests" className="btn btn-secondary btn-sm" onClick={() => fetchRequests(filter)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div className="tabs" style={{ margin: 0, borderBottom: 'none', gap: 0 }}>
          {STATUS_FILTERS.map((s) => (
            <button key={s} id={`filter-${s}`} className={`tab-item ${filter === s ? 'active' : ''}`}
              onClick={() => setFilter(s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <input
            id="request-search"
            className="form-input"
            style={{ padding: '0.4rem 0.75rem' }}
            placeholder="Search by ID, tenant, provider…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
          {filtered.length} results
        </span>
      </div>

      {/* Table */}
      <div className="card">
        <div className="table-wrapper">
          {loading ? (
            <div className="loading-overlay"><div className="spinner" /> <span>Loading requests…</span></div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
              </div>
              <div className="empty-state-title">No requests found</div>
              <p className="empty-state-desc">Try changing your filter or search term.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Tenant</th>
                  <th>Status</th>
                  <th>Provider / Model</th>
                  <th>Tokens</th>
                  <th>Cost (USD)</th>
                  <th>Latency</th>
                  <th>Attempts</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(r)}>
                    <td className="mono primary">{r.id.slice(0, 8)}…</td>
                    <td>{r.tenant_name}</td>
                    <td>{statusBadge(r.status)}</td>
                    <td>
                      {r.provider_used ? (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{r.provider_used}</span>
                          <span className="mono" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>{r.model_used}</span>
                        </div>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="mono">{r.total_tokens ? r.total_tokens.toLocaleString() : '—'}</td>
                    <td className="mono">{r.estimated_cost_usd ? `$${Number(r.estimated_cost_usd).toFixed(5)}` : '—'}</td>
                    <td className="mono">{r.total_latency_ms ? `${r.total_latency_ms}ms` : '—'}</td>
                    <td>
                      <span style={{ color: r.attempt_count > 1 ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
                        {r.attempt_count}
                        {r.attempt_count > 1 && <span style={{ fontSize: '0.7rem', marginLeft: '0.25rem' }}>⚡</span>}
                      </span>
                    </td>
                    <td className="mono text-muted" style={{ fontSize: '0.72rem' }}>
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Detail Drawer */}
      {selected && (
        <RequestDetailDrawer request={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function RequestDetailDrawer({ request: r, onClose }: { request: Request; onClose: () => void }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, backdropFilter: 'blur(4px)' }}
      />
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 480,
        background: 'var(--color-bg-elevated)', borderLeft: '1px solid var(--color-border-light)',
        zIndex: 201, overflow: 'auto', padding: '1.5rem',
        animation: 'slide-in 0.3s ease-out',
        boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3>Request Detail</h3>
          <button id="close-detail" className="btn btn-secondary btn-sm btn-icon" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <DetailRow label="Request ID" value={r.id} mono />
        <DetailRow label="Tenant" value={r.tenant_name} />
        <DetailRow label="Status">
          {<span className={`badge ${r.status === 'completed' ? 'badge-success' : r.status === 'failed' ? 'badge-danger' : 'badge-warning'}`}>{r.status}</span>}
        </DetailRow>
        <DetailRow label="Provider Used" value={r.provider_used ?? '—'} />
        <DetailRow label="Model Used" value={r.model_used ?? '—'} mono />
        <DetailRow label="Tokens" value={r.total_tokens ? `${r.total_tokens.toLocaleString()} total` : '—'} />
        <DetailRow label="Cost" value={r.estimated_cost_usd ? `$${Number(r.estimated_cost_usd).toFixed(6)}` : '—'} mono />
        <DetailRow label="Latency" value={r.total_latency_ms ? `${r.total_latency_ms}ms` : '—'} mono />
        <DetailRow label="Attempts" value={r.attempt_count.toString()} />

        {Array.isArray(r.providers_tried) && r.providers_tried.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <div className="form-label" style={{ marginBottom: '0.4rem' }}>Failover Chain</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {r.providers_tried.map((p: string, i: number) => (
                <span key={i} style={{
                  padding: '0.2rem 0.6rem',
                  background: i === 0 ? 'var(--color-success-bg)' : 'rgba(239,68,68,0.1)',
                  color: i === 0 ? 'var(--color-success)' : 'var(--color-danger)',
                  borderRadius: 'var(--radius-full)',
                  fontSize: '0.72rem', fontFamily: 'var(--font-mono)',
                  border: `1px solid ${i === 0 ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
                }}>
                  {i + 1}. {p}
                </span>
              ))}
            </div>
          </div>
        )}

        {r.error_code && (
          <div style={{
            marginTop: '1rem', padding: '0.875rem',
            background: 'var(--color-danger-bg)', borderRadius: 'var(--radius-md)',
            border: '1px solid rgba(239,68,68,0.2)',
          }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-danger)', marginBottom: '0.3rem' }}>{r.error_code}</div>
          </div>
        )}

        <DetailRow label="Created" value={new Date(r.created_at).toLocaleString()} />
        {r.completed_at && <DetailRow label="Completed" value={new Date(r.completed_at).toLocaleString()} />}
      </div>
    </>
  );
}

function DetailRow({ label, value, mono, children }: {
  label: string; value?: string; mono?: boolean; children?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.875rem' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)' }}>{label}</span>
      {children ?? (
        <span style={{ fontSize: '0.875rem', color: 'var(--color-text-primary)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', wordBreak: 'break-all' }}>
          {value}
        </span>
      )}
    </div>
  );
}
