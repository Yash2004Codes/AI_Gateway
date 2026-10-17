// ═══════════════════════════════════════════════════════
// k6 Load Test - AI Gateway ingestion benchmark
// Measures: 202 latency/throughput under ramp + spike, status polling,
// idempotent replay, and correct 429s from the sliding-window limiter.
// Run: k6 run tests/load/gateway-load-test.js
// ═══════════════════════════════════════════════════════

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

// ─────────────────────────────────────────────
// Custom metrics
// ─────────────────────────────────────────────
const accepted = new Rate('accepted_202');                 // throughput tenant: share of 202s
const serverErrors = new Rate('server_errors_5xx');        // any tenant: must stay at 0
const correct429 = new Rate('rate_limit_429_correct');     // limited tenant: 429 carries Retry-After
const replayHits = new Rate('idempotent_replay_hit');      // same Idempotency-Key → cached 202
const failoverTriggered = new Counter('failover_triggered');

// ─────────────────────────────────────────────
// Scenarios
//   ingest:  ramp → sustained → spike → back down, on a tenant with very
//            high limits, so this measures the gateway, not the limiter
//   limited: a steady stream from Initech (200 req/min) above its limit,
//            to check the limiter rejects correctly under load
// ─────────────────────────────────────────────
export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-vus',
      exec: 'ingest',
      stages: [
        { duration: '20s', target: 10 },  // ramp up
        { duration: '40s', target: 50 },  // sustained
        { duration: '20s', target: 150 }, // spike
        { duration: '30s', target: 50 },  // back to normal
        { duration: '20s', target: 0 },   // cool down
      ],
    },
    limited: {
      executor: 'constant-arrival-rate',
      exec: 'limited',
      rate: 5, // 300 req/min against a 200 req/min limit
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    'http_req_duration{name:submit}': ['p(95)<500'],
    accepted_202: ['rate>0.99'],
    server_errors_5xx: ['rate==0'],
    rate_limit_429_correct: ['rate==1'],
    idempotent_replay_hit: ['rate>0.99'],
  },
};

const BASE_URL = __ENV.GATEWAY_URL || 'http://localhost:3001';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@gateway.local';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'admin123';
const LIMITED_KEY = __ENV.LIMITED_API_KEY || 'demo-key-initech';

const TEST_MESSAGES = [
  'Explain quantum entanglement in simple terms.',
  'Write a short poem about the ocean at night.',
  'What are the key differences between TCP and UDP?',
  'Summarize the main causes of the French Revolution.',
  'How does garbage collection work in Python?',
  'Describe the architecture of a microservices system.',
  'What is the CAP theorem in distributed systems?',
  'Write a JavaScript function to debounce a callback.',
];

function submit(apiKey, body, idempotencyKey) {
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = http.post(`${BASE_URL}/api/v1/gateway/completions`, JSON.stringify(body), {
    headers,
    tags: { name: 'submit' },
  });
  serverErrors.add(res.status >= 500);
  return res;
}

// ─────────────────────────────────────────────
// Setup: health check + a throwaway tenant with very high limits
// ─────────────────────────────────────────────
export function setup() {
  const health = http.get(`${BASE_URL}/health`);
  if (health.status !== 200) throw new Error(`Gateway health check failed: ${health.status}`);

  const login = http.post(
    `${BASE_URL}/api/v1/admin/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (login.status !== 200) throw new Error(`Admin login failed: ${login.status}`);

  const tenant = http.post(
    `${BASE_URL}/api/v1/admin/tenants`,
    JSON.stringify({ name: `k6-load-${Date.now()}`, tpmLimit: 100000000, rpmLimit: 1000000 }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.json('token')}` } }
  );
  if (tenant.status !== 201) throw new Error(`Tenant creation failed: ${tenant.status} ${tenant.body}`);

  console.log(`Created load-test tenant ${tenant.json('name')}`);
  return { apiKey: tenant.json('api_key') };
}

// ─────────────────────────────────────────────
// Scenario: ingest
// ─────────────────────────────────────────────
export function ingest(data) {
  const message = TEST_MESSAGES[Math.floor(Math.random() * TEST_MESSAGES.length)];
  const idempotencyKey = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const body = {
    userMessage: message,
    systemPrompt: 'You are a helpful assistant. Be concise.',
    maxTokens: 256,
    priority: Math.ceil(Math.random() * 10),
  };

  // 1. Submit
  const res = submit(data.apiKey, body, idempotencyKey);
  const ok = check(res, {
    'submit: 202 Accepted': (r) => r.status === 202,
    'submit: has requestId': (r) => r.status === 202 && !!r.json('requestId'),
  });
  accepted.add(res.status === 202);
  if (!ok) {
    sleep(1);
    return;
  }
  const requestId = res.json('requestId');

  // 2. Poll status
  sleep(0.5);
  const status = http.get(`${BASE_URL}/api/v1/gateway/requests/${requestId}`, {
    headers: { 'X-Api-Key': data.apiKey },
    tags: { name: 'poll' },
  });
  serverErrors.add(status.status >= 500);
  check(status, {
    'poll: 200': (r) => r.status === 200,
    'poll: valid status': (r) =>
      r.status === 200 && ['queued', 'processing', 'completed', 'failed'].includes(r.json('status')),
  });
  if (status.status === 200) {
    const tried = status.json('providers_tried');
    if (Array.isArray(tried) && tried.length > 1) failoverTriggered.add(1);
  }

  // 3. Replay with the same Idempotency-Key → same requestId, served from cache
  const replay = submit(data.apiKey, body, idempotencyKey);
  const hit =
    replay.status === 202 &&
    replay.headers['X-Cache-Lookup'] !== undefined &&
    replay.json('requestId') === requestId;
  replayHits.add(hit);
  check(replay, { 'replay: same requestId from cache': () => hit });

  sleep(Math.random() * 2 + 0.5);
}

// ─────────────────────────────────────────────
// Scenario: limited (Initech, above its RPM limit)
// ─────────────────────────────────────────────
export function limited() {
  const res = submit(LIMITED_KEY, { userMessage: 'Limiter check', maxTokens: 32 });
  if (res.status === 429) {
    const retryAfter = Number(res.headers['Retry-After']);
    const good = retryAfter > 0 && ['RPM_EXCEEDED', 'TPM_EXCEEDED'].includes(res.json('code'));
    correct429.add(good);
    check(res, { '429: has Retry-After and reason code': () => good });
  } else {
    check(res, { 'limited: 202 or 429 only': (r) => r.status === 202 });
  }
}

export function teardown() {
  console.log('Load test complete. The queued jobs keep draining in the background.');
}
