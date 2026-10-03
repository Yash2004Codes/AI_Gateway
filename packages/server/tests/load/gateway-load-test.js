// ═══════════════════════════════════════════════════════
// k6 Load Test - AI Gateway Performance Benchmark
// Tests: throughput, latency, rate limiting, failover
// Run: k6 run tests/load/gateway-load-test.js
// ═══════════════════════════════════════════════════════

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

// ─────────────────────────────────────────────
// Custom metrics
// ─────────────────────────────────────────────
const rateLimitedRate = new Rate('rate_limited_requests');
const failoverTriggered = new Counter('failover_triggered');
const p99Latency = new Trend('p99_latency_ms', true);
const queuedSuccessfully = new Rate('queued_successfully');

// ─────────────────────────────────────────────
// Test Configuration
// Simulates real-world traffic patterns:
// Phase 1: Ramp up (0-50 VUs over 1 min)
// Phase 2: Sustained load (50 VUs for 3 min)
// Phase 3: Spike (200 VUs - triggers rate limiting)
// Phase 4: Cool down
// ─────────────────────────────────────────────
export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Ramp up - baseline
    { duration: '1m', target: 50 },    // Sustained load
    { duration: '30s', target: 200 },  // Spike - triggers rate limiting
    { duration: '1m', target: 50 },    // Back to normal
    { duration: '30s', target: 0 },    // Cool down
  ],
  thresholds: {
    // 95% of requests should get 202 within 500ms
    http_req_duration: ['p(95)<500'],
    // Less than 5% should be rate limited at normal load
    rate_limited_requests: ['rate<0.05'],
    // 99% should queue successfully
    queued_successfully: ['rate>0.99'],
  },
};

const BASE_URL = __ENV.GATEWAY_URL || 'http://localhost:3001';
const API_KEY = __ENV.API_KEY || 'demo-api-key-change-in-production';

// ─────────────────────────────────────────────
// Test scenarios
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Main VU function
// ─────────────────────────────────────────────
export default function () {
  const message = TEST_MESSAGES[Math.floor(Math.random() * TEST_MESSAGES.length)];
  const idempotencyKey = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const priority = Math.ceil(Math.random() * 10);

  // ── Test 1: Submit completion request ─────────────
  const submitResponse = http.post(
    `${BASE_URL}/api/v1/gateway/completions`,
    JSON.stringify({
      userMessage: message,
      systemPrompt: 'You are a helpful assistant. Be concise.',
      maxTokens: 256,
      idempotencyKey,
      priority,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
      },
      tags: { name: 'submit_completion' },
    }
  );

  const submitOk = check(submitResponse, {
    'submit: status is 202 (accepted)': (r) => r.status === 202,
    'submit: has requestId': (r) => {
      try {
        return !!JSON.parse(r.body as string).requestId;
      } catch {
        return false;
      }
    },
    'submit: response time < 500ms': (r) => r.timings.duration < 500,
  });

  queuedSuccessfully.add(submitOk);

  if (submitResponse.status === 429) {
    rateLimitedRate.add(1);
    sleep(1);
    return;
  } else {
    rateLimitedRate.add(0);
  }

  p99Latency.add(submitResponse.timings.duration);

  if (!submitOk) {
    sleep(1);
    return;
  }

  const { requestId } = JSON.parse(submitResponse.body as string);

  // ── Test 2: Poll status endpoint ──────────────────
  sleep(0.5);
  const statusResponse = http.get(
    `${BASE_URL}/api/v1/gateway/requests/${requestId}`,
    {
      headers: { 'X-Api-Key': API_KEY },
      tags: { name: 'poll_status' },
    }
  );

  check(statusResponse, {
    'status poll: 200': (r) => r.status === 200,
    'status poll: has status field': (r) => {
      try {
        const body = JSON.parse(r.body as string);
        return ['queued', 'processing', 'completed', 'failed'].includes(body.status);
      } catch {
        return false;
      }
    },
  });

  // ── Test 3: Idempotency check ─────────────────────
  sleep(0.1);
  const idempotentResponse = http.post(
    `${BASE_URL}/api/v1/gateway/completions`,
    JSON.stringify({
      userMessage: message,
      idempotencyKey, // Same key = should return cached response
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
      },
      tags: { name: 'idempotency_check' },
    }
  );

  check(idempotentResponse, {
    'idempotency: returns 200 for duplicate key': (r) => r.status === 200,
    'idempotency: marks as idempotent': (r) => {
      try {
        return JSON.parse(r.body as string).idempotent === true;
      } catch {
        return false;
      }
    },
  });

  // Check if failover was triggered
  if (statusResponse.status === 200) {
    try {
      const body = JSON.parse(statusResponse.body as string);
      if (body.providers_tried && body.providers_tried.length > 1) {
        failoverTriggered.add(1);
      }
    } catch {}
  }

  sleep(Math.random() * 2 + 0.5);
}

// ─────────────────────────────────────────────
// Health check setup
// ─────────────────────────────────────────────
export function setup() {
  const healthRes = http.get(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error(`Gateway health check failed: ${healthRes.status}`);
  }
  console.log('✅ Gateway health check passed');
  return {};
}

// ─────────────────────────────────────────────
// Teardown: Print summary
// ─────────────────────────────────────────────
export function teardown(_data: unknown) {
  console.log('🏁 Load test complete');
}
