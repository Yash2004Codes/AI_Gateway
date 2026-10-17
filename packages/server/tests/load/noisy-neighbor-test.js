// ═══════════════════════════════════════════════════════
// k6 Noisy-Neighbor Test
// One tenant floods the queue; a quiet tenant sends 1 request/second and
// measures time from submit to *completed* (queue wait + processing).
// With fair-share on, the quiet tenant's completion time should stay low.
// Run: k6 run tests/load/noisy-neighbor-test.js
// Compare: toggle fair-share off in Demo Control (or PUT /admin/fair-share)
//          and run again.
// ═══════════════════════════════════════════════════════

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const quietCompletion = new Trend('quiet_tenant_completion_ms', true);
const quietCompleted = new Counter('quiet_tenant_completed');
const noisyAccepted = new Counter('noisy_tenant_accepted');

export const options = {
  scenarios: {
    // Noisy tenant: 20 VUs firing as fast as they can (no rate limit on this tenant)
    noisy_flood: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30s',
      exec: 'noisy',
    },
    // Quiet tenant: a steady 1 request/second, starting once the flood is underway
    quiet_paced: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: '30s',
      startTime: '5s',
      preAllocatedVUs: 5,
      maxVUs: 40,
      exec: 'quiet',
    },
  },
  thresholds: {
    // The fair-share claim: the quiet tenant stays fast while the queue is flooded
    quiet_tenant_completion_ms: ['p(95)<3000'],
    quiet_tenant_completed: ['count>=25'],
  },
};

const BASE_URL = __ENV.GATEWAY_URL || 'http://localhost:3001';
const QUIET_KEY = __ENV.QUIET_API_KEY || 'demo-key-acme';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@gateway.local';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'admin123';

export function setup() {
  const login = http.post(
    `${BASE_URL}/api/v1/admin/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (login.status !== 200) throw new Error(`Admin login failed: ${login.status}`);
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.json('token')}` };

  // An unthrottled noisy tenant, so it actually floods the queue
  const tenant = http.post(
    `${BASE_URL}/api/v1/admin/tenants`,
    JSON.stringify({ name: `k6-noisy-${Date.now()}`, tpmLimit: 100000000, rpmLimit: 1000000 }),
    { headers: auth }
  );
  if (tenant.status !== 201) throw new Error(`Tenant creation failed: ${tenant.status}`);

  const live = http.get(`${BASE_URL}/api/v1/admin/live`, { headers: auth });
  console.log(`Fair-share is ${live.json('fairShare') ? 'ON' : 'OFF (FIFO)'}`);
  return { noisyKey: tenant.json('api_key') };
}

export function noisy(data) {
  const res = http.post(
    `${BASE_URL}/api/v1/gateway/completions`,
    JSON.stringify({ userMessage: 'Noisy neighbour bulk job', maxTokens: 64 }),
    { headers: { 'Content-Type': 'application/json', 'X-Api-Key': data.noisyKey }, tags: { name: 'noisy' } }
  );
  if (res.status === 202) noisyAccepted.add(1);
  sleep(0.05);
}

export function quiet() {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/gateway/completions`,
    JSON.stringify({ userMessage: 'Quiet tenant query', maxTokens: 64 }),
    { headers: { 'Content-Type': 'application/json', 'X-Api-Key': QUIET_KEY }, tags: { name: 'quiet' } }
  );
  if (!check(res, { 'quiet: 202 Accepted': (r) => r.status === 202 })) return;
  const requestId = res.json('requestId');

  // Poll until the job completes (up to 60s)
  while (Date.now() - start < 60000) {
    sleep(0.2);
    const status = http.get(`${BASE_URL}/api/v1/gateway/requests/${requestId}`, {
      headers: { 'X-Api-Key': QUIET_KEY },
      tags: { name: 'quiet_poll' },
    });
    const s = status.status === 200 ? status.json('status') : null;
    if (s === 'completed') {
      quietCompletion.add(Date.now() - start);
      quietCompleted.add(1);
      return;
    }
    if (s === 'failed') return;
  }
}
