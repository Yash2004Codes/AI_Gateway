import { useState } from 'react';
import api from '../api/client';

const SAMPLE_REQUESTS = [
  { label: 'Simple Q&A', message: 'What is the difference between machine learning and deep learning?', system: 'You are a helpful assistant. Be concise.', tokens: 256 },
  { label: 'Code Generation', message: 'Write a TypeScript function that implements exponential backoff with jitter for API retries.', system: 'You are an expert TypeScript engineer.', tokens: 512 },
  { label: 'Long Analysis', message: 'Provide a detailed technical analysis of the CAP theorem in distributed systems, including practical examples and trade-offs.', system: 'You are a senior distributed systems engineer.', tokens: 1024 },
];

interface SubmitResult {
  requestId: string; jobId: string; status: string; statusUrl: string;
}
interface PollResult {
  id: string; status: string; provider_used: string; model_used: string;
  response_text: string; total_tokens: number; estimated_cost_usd: number;
  total_latency_ms: number; providers_tried: string[];
}

export default function PlaygroundPage() {
  const [apiKey, setApiKey] = useState('demo-api-key-change-in-production');
  const [message, setMessage] = useState(SAMPLE_REQUESTS[0].message);
  const [system, setSystem] = useState(SAMPLE_REQUESTS[0].system);
  const [maxTokens, setMaxTokens] = useState(256);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [priority, setPriority] = useState(5);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [pollResult, setPollResult] = useState<PollResult | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'compose'|'result'>('compose');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitResult(null);
    setPollResult(null);
    setLoading(true);

    try {
      const { data } = await api.post('/gateway/completions', {
        userMessage: message,
        systemPrompt: system || undefined,
        maxTokens,
        priority,
        idempotencyKey: idempotencyKey || undefined,
      }, {
        headers: { 'X-Api-Key': apiKey },
      });
      setSubmitResult(data);
      setTab('result');
      pollStatus(data.requestId, data.jobId);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err.message ?? 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const pollStatus = async (requestId: string, _jobId: string) => {
    setPolling(true);
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const { data } = await api.get(`/gateway/requests/${requestId}`, {
          headers: { 'X-Api-Key': apiKey },
        });
        if (data.status === 'completed' || data.status === 'failed') {
          setPollResult(data);
          break;
        }
      } catch {}
    }
    setPolling(false);
  };

  const loadSample = (idx: number) => {
    setMessage(SAMPLE_REQUESTS[idx].message);
    setSystem(SAMPLE_REQUESTS[idx].system);
    setMaxTokens(SAMPLE_REQUESTS[idx].tokens);
  };

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">API <span className="text-gradient">Playground</span></h1>
          <p className="page-subtitle">Test the gateway API interactively — submit requests and watch real-time processing</p>
        </div>
      </div>

      <div className="grid-2">
        {/* ── Left: Compose ──────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Quick samples */}
          <div className="card">
            <div className="card-header"><span className="card-title">Quick Samples</span></div>
            <div className="card-body" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {SAMPLE_REQUESTS.map((s, i) => (
                <button key={i} id={`sample-${i}`} className="btn btn-secondary btn-sm" onClick={() => loadSample(i)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Compose form */}
          <div className="card">
            <div className="card-header"><span className="card-title">Compose Request</span></div>
            <div className="card-body">
              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">API Key (Tenant)</label>
                  <input id="playground-api-key" className="form-input" value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)} placeholder="gw-…" required />
                </div>

                <div className="form-group">
                  <label className="form-label">System Prompt (optional)</label>
                  <textarea id="playground-system" className="form-textarea" rows={2} value={system}
                    onChange={(e) => setSystem(e.target.value)} placeholder="You are a helpful assistant…" />
                </div>

                <div className="form-group">
                  <label className="form-label">User Message</label>
                  <textarea id="playground-message" className="form-textarea" rows={5} value={message}
                    onChange={(e) => setMessage(e.target.value)} placeholder="Type your message…" required />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
                  <div className="form-group">
                    <label className="form-label">Max Tokens</label>
                    <input id="playground-tokens" type="number" className="form-input" value={maxTokens}
                      onChange={(e) => setMaxTokens(+e.target.value)} min={64} max={4096} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Priority (1-10)</label>
                    <input id="playground-priority" type="number" className="form-input" value={priority}
                      onChange={(e) => setPriority(+e.target.value)} min={1} max={10} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Idempotency Key</label>
                    <input id="playground-idempotency" className="form-input" value={idempotencyKey}
                      onChange={(e) => setIdempotencyKey(e.target.value)} placeholder="optional" />
                  </div>
                </div>

                {error && (
                  <div style={{
                    background: 'var(--color-danger-bg)', border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem',
                    fontSize: '0.8125rem', color: 'var(--color-danger)',
                  }}>{error}</div>
                )}

                <button id="playground-submit" type="submit" className="btn btn-primary" disabled={loading}
                  style={{ justifyContent: 'center' }}>
                  {loading ? <><div className="spinner" style={{ width: 16, height: 16 }} /> Submitting…</> : (
                    <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit to Gateway</>
                  )}
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* ── Right: Results ─────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Architecture callout */}
          <div style={{
            background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)',
            borderRadius: 'var(--radius-lg)', padding: '1rem 1.25rem',
          }}>
            <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-primary-light)', marginBottom: '0.5rem' }}>
              🚀 How the Gateway Works
            </div>
            <ol style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <li><strong>202 Accepted</strong> returned instantly — non-blocking ingestion</li>
              <li>Job enqueued to <strong>BullMQ</strong> with your tenant group key (fair-share)</li>
              <li>Worker dispatches to <strong>highest-priority healthy provider</strong></li>
              <li>On 429/5xx: <strong>automatic failover</strong> to next provider</li>
              <li>Results written to <strong>Postgres</strong> + token ledger + pub/sub</li>
            </ol>
          </div>

          {/* Result panel */}
          <div className="card" style={{ flex: 1 }}>
            <div className="card-header">
              <span className="card-title">Response</span>
              {(polling || submitResult) && (
                <span className={`badge ${pollResult?.status === 'completed' ? 'badge-success' : pollResult?.status === 'failed' ? 'badge-danger' : 'badge-warning badge-live'}`}>
                  {pollResult?.status ?? (polling ? 'Processing…' : 'Queued')}
                </span>
              )}
            </div>
            <div className="card-body">
              {!submitResult && !loading && (
                <div className="empty-state">
                  <div className="empty-state-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  </div>
                  <div className="empty-state-title">Submit a request</div>
                  <p className="empty-state-desc">Results will appear here after the gateway processes your request.</p>
                </div>
              )}

              {submitResult && !pollResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--color-success)' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                    <span style={{ fontWeight: 600 }}>Request accepted (HTTP 202)</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem' }}>
                    <InfoRow label="Request ID" value={submitResult.requestId} mono />
                    <InfoRow label="Job ID" value={submitResult.jobId} mono />
                    <InfoRow label="Status" value={submitResult.status} />
                  </div>
                  {polling && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                      <div className="spinner" style={{ width: 14, height: 14 }} />
                      Polling for completion…
                    </div>
                  )}
                </div>
              )}

              {pollResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* Metrics row */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
                    {[
                      { label: 'Provider', value: pollResult.provider_used },
                      { label: 'Tokens', value: pollResult.total_tokens?.toLocaleString() },
                      { label: 'Latency', value: `${pollResult.total_latency_ms}ms` },
                      { label: 'Cost', value: `$${Number(pollResult.estimated_cost_usd).toFixed(5)}` },
                    ].map((m) => (
                      <div key={m.label} style={{ textAlign: 'center', padding: '0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                        <div style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>{m.label}</div>
                        <div style={{ fontSize: '0.875rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{m.value ?? '—'}</div>
                      </div>
                    ))}
                  </div>

                  {/* Failover chain */}
                  {Array.isArray(pollResult.providers_tried) && pollResult.providers_tried.length > 1 && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase' }}>Failover Chain</div>
                      <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        {pollResult.providers_tried.map((p: string, i: number) => (
                          <>
                            <span key={i} style={{
                              padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-full)',
                              fontSize: '0.72rem', fontFamily: 'var(--font-mono)',
                              background: i === pollResult.providers_tried.length - 1 ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
                              color: i === pollResult.providers_tried.length - 1 ? 'var(--color-success)' : 'var(--color-danger)',
                            }}>{p}</span>
                            {i < pollResult.providers_tried.length - 1 && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--color-text-muted)' }}><polyline points="9 18 15 12 9 6"/></svg>
                            )}
                          </>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Response text */}
                  {pollResult.response_text && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase' }}>Response</div>
                      <div style={{
                        background: 'rgba(255,255,255,0.02)', border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)', padding: '0.875rem',
                        fontSize: '0.875rem', color: 'var(--color-text-primary)', lineHeight: '1.65',
                        whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto',
                      }}>
                        {pollResult.response_text}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : 'inherit', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}
