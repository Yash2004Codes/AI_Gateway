import { useEffect, useState } from 'react';
import api from '../api/client';

interface Tenant {
  id: string; name: string; api_key?: string; tpm_limit: number; rpm_limit: number;
  monthly_token_budget: number | null; is_active: boolean; created_at: string;
  total_requests: number; total_tokens: number; total_cost: number;
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', tpmLimit: 10000, rpmLimit: 100 });
  const [creating, setCreating] = useState(false);
  const [newTenant, setNewTenant] = useState<Tenant | null>(null);

  const fetchTenants = async () => {
    try {
      const { data } = await api.get('/admin/tenants');
      setTenants(data.tenants);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchTenants(); }, []);

  const createTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const { data } = await api.post('/admin/tenants', {
        name: form.name, tpmLimit: form.tpmLimit, rpmLimit: form.rpmLimit,
      });
      setNewTenant(data);
      setShowCreate(false);
      setForm({ name: '', tpmLimit: 10000, rpmLimit: 100 });
      fetchTenants();
    } catch (e) { console.error(e); }
    finally { setCreating(false); }
  };

  if (loading) return <div className="loading-overlay"><div className="spinner" /><span>Loading tenants…</span></div>;

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Tenant <span className="text-gradient">Management</span></h1>
          <p className="page-subtitle">Manage API consumers, rate limits, and usage budgets</p>
        </div>
        <button id="create-tenant-btn" className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Tenant
        </button>
      </div>

      {/* New API Key alert */}
      {newTenant && (
        <div style={{
          background: 'var(--color-success-bg)', border: '1px solid rgba(16,185,129,0.3)',
          borderRadius: 'var(--radius-lg)', padding: '1rem 1.25rem', marginBottom: '1.25rem',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem',
        }}>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--color-success)', marginBottom: '0.35rem' }}>
              ✅ Tenant "{newTenant.name}" created
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginBottom: '0.4rem' }}>
              Copy this API key — it won't be shown again:
            </div>
            <code style={{
              background: 'rgba(0,0,0,0.3)', padding: '0.35rem 0.75rem',
              borderRadius: 'var(--radius-md)', fontSize: '0.8rem',
              fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)',
            }}>
              {newTenant.api_key}
            </code>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setNewTenant(null)}>Dismiss</button>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card-header">
            <span className="card-title">New Tenant</span>
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setShowCreate(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="card-body">
            <form onSubmit={createTenant} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '1rem', alignItems: 'flex-end' }}>
              <div className="form-group">
                <label className="form-label">Tenant Name</label>
                <input id="tenant-name" className="form-input" value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Acme Corp" required />
              </div>
              <div className="form-group">
                <label className="form-label">TPM Limit</label>
                <input id="tenant-tpm" type="number" className="form-input" value={form.tpmLimit}
                  onChange={(e) => setForm({ ...form, tpmLimit: +e.target.value })} min={100} />
              </div>
              <div className="form-group">
                <label className="form-label">RPM Limit</label>
                <input id="tenant-rpm" type="number" className="form-input" value={form.rpmLimit}
                  onChange={(e) => setForm({ ...form, rpmLimit: +e.target.value })} min={1} />
              </div>
              <button id="tenant-create-submit" type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? <div className="spinner" style={{ width: 16, height: 16 }} /> : 'Create'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Tenants table */}
      <div className="card">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>TPM Limit</th>
                <th>RPM Limit</th>
                <th>Total Requests</th>
                <th>Total Tokens</th>
                <th>Total Cost</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="primary">{t.name}</td>
                  <td>
                    <span className={`badge ${t.is_active ? 'badge-success' : 'badge-danger'}`}>
                      {t.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="mono">{t.tpm_limit.toLocaleString()}</td>
                  <td className="mono">{t.rpm_limit.toLocaleString()}</td>
                  <td className="mono">{Number(t.total_requests || 0).toLocaleString()}</td>
                  <td className="mono">{Number(t.total_tokens || 0).toLocaleString()}</td>
                  <td className="mono">${Number(t.total_cost || 0).toFixed(4)}</td>
                  <td className="mono text-muted" style={{ fontSize: '0.72rem' }}>
                    {new Date(t.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Architecture notes */}
      <div style={{ marginTop: '1.5rem', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
        {[
          { title: 'Fair-Share Queuing', color: '#6366f1', desc: 'BullMQ Group Keys ensure each tenant\'s jobs are processed in round-robin. No single tenant can starve others.' },
          { title: 'Tenant Isolation', color: '#10b981', desc: 'Each tenant has its own Redis sliding-window TPM counter. A burst from one tenant doesn\'t affect others.' },
          { title: 'Budget Guards', color: '#f59e0b', desc: 'Monthly token budgets in Postgres prevent runaway billing. Pre-flight estimation rejects over-budget requests.' },
        ].map((note) => (
          <div key={note.title} style={{
            background: 'var(--gradient-card)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)', padding: '1.125rem',
            borderTop: `2px solid ${note.color}`,
          }}>
            <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text-primary)', marginBottom: '0.4rem' }}>{note.title}</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>{note.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
