import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Custom metrics for quiet tenant vs noisy tenant
const quietLatencyTrend = new Trend('quiet_tenant_latency_ms');
const quietSuccessCounter = new Counter('quiet_tenant_success');
const noisyLatencyTrend = new Trend('noisy_tenant_latency_ms');

export const options = {
  scenarios: {
    // Scenario 1: Noisy Neighbor (Spamming requests at high concurrency)
    noisy_neighbor_spam: {
      executor: 'constant-vus',
      vus: 15,
      duration: '30s',
      exec: 'runNoisyNeighbor',
    },
    // Scenario 2: Quiet Tenant (Paces requests smoothly at low rate)
    quiet_tenant_paced: {
      executor: 'constant-arrival-rate',
      rate: 2, // 2 requests per second
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 2,
      maxVUs: 5,
      exec: 'runQuietTenant',
    },
  },
  thresholds: {
    // PROOF: Quiet tenant's p95 latency must remain < 350ms even when noisy neighbor is spamming!
    quiet_tenant_latency_ms: ['p(95)<350', 'p(99)<500'],
    quiet_tenant_success: ['count>20'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001/api/v1/gateway';

// Noisy Tenant configuration
const NOISY_TENANT_KEY = __ENV.NOISY_API_KEY || 'demo-api-key-change-in-production';

// Quiet Tenant configuration
const QUIET_TENANT_KEY = __ENV.QUIET_API_KEY || 'quiet-tenant-key-789';

export function runNoisyNeighbor() {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Noisy neighbor heavy prompt load testing request.' },
    ],
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NOISY_TENANT_KEY}`,
      'X-Tenant-Tag': 'noisy',
    },
    timeout: '5s',
  };

  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, params);
  noisyLatencyTrend.add(res.timings.duration);
  check(res, {
    'noisy request completed or queued': (r) => r.status === 200 || r.status === 202 || r.status === 429,
  });

  sleep(0.05); // Rapid fire
}

export function runQuietTenant() {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Quiet tenant priority query.' },
    ],
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${QUIET_TENANT_KEY}`,
      'X-Tenant-Tag': 'quiet',
    },
    timeout: '5s',
  };

  const start = Date.now();
  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, params);
  const latency = Date.now() - start;

  quietLatencyTrend.add(latency);

  const isSuccess = check(res, {
    'quiet tenant status is 200/202': (r) => r.status === 200 || r.status === 202,
    'quiet tenant latency under 350ms': () => latency < 350,
  });

  if (isSuccess) {
    quietSuccessCounter.add(1);
  }
}
