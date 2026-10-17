# Demo Script (≈5 minutes)

## Before you start

```bash
docker compose up -d redis postgres
npm run dev                                   # API :3001, worker, dashboard :3000
npm run seed:demo --workspace=packages/server # 24h of history for the charts
```

`.env` and `packages/server/.env` need `DEMO_MODE=true`. Vendor keys are optional — any vendor
without a key is simulated (`LLM_MOCK_MODE=auto`), and its badge says **mock**.

Log in at http://localhost:3000 as `admin@gateway.local` / `admin123`.
Keep **Flight Radar** open in a second tab for the live activity feed.

---

## 1. The problem (30s) — Flight Radar

> "Every team calling LLM vendors directly means no shared rate limits, no failover, and one
> noisy team can starve everyone else. This gateway sits in front of all of them."

Point at: 24h token chart per provider (note the OpenAI dip ~6h ago — that hour was served by
Anthropic failover), success rate, cost, and the provider cards with live breaker state.

## 2. Async ingestion (30s) — Playground

Send a prompt. It returns **202 Accepted** with a `requestId` immediately; the worker processes
it and the result appears when polled.

> "Clients never hold a connection open waiting on a vendor. Ingestion is cheap, the expensive
> part is queued."

## 3. Fair-share under a noisy neighbour (90s) — Demo Control

1. Click **Steady traffic**. Acme and Globex each send a request every 1.5s; their queue wait
   is well under a second.
2. Click **Noisy-neighbour burst**. Initech fires 300 requests:
   - Its **lane backlog** jumps to ~200, and its **Req / min** hits 200/200 — the sliding-window
     RPM limit returns **429** for the other ~100 (see the 429 column and the red feed items).
   - Acme and Globex **avg wait stays ~1s** — the scheduler takes one job per tenant per turn.
3. Toggle fair-share **off** (FIFO) and burst again (wait ~60s for Initech's window to slide, or
   just compare with the numbers below). Acme/Globex wait climbs to **~15s** — they're stuck
   behind Initech's backlog. Toggle it back on.

Measured locally (same traffic both runs, 1 worker × concurrency 5):

| Tenant | Avg queue wait, fair-share | Avg queue wait, FIFO |
|---|---|---|
| Acme Corp | 0.8 s | 14.5 s |
| Globex | 0.9 s | 14.6 s |
| Initech (noisy) | 16.1 s | 13.5 s |

> "The noisy tenant only competes with itself. And the limiter is a true sliding window in one
> Lua script — no double-spend at a minute boundary, no over-admission across API replicas."

## 4. Failover + circuit breaker (90s) — Demo Control, chaos panel

1. With steady traffic running, set **OpenAI → 100%**.
2. Flight Radar feed shows `failover: openai → anthropic`. After 3 consecutive failures the
   OpenAI breaker goes **OPEN** — subsequent requests skip OpenAI entirely (no wasted calls,
   no added latency).
3. Set **OpenAI → 0%**. After the 10s cooldown the breaker goes **HALF-OPEN**, a few probe
   requests are let through, and after 2 successes it returns to **CLOSED**.

> "Breaker state lives in Redis and every transition is atomic, so all worker replicas share
> one view of vendor health."

## 5. Security close (30s)

- API keys are stored only as SHA-256 hashes; a new tenant's key is shown once (Tenants page).
- Idempotency-Key header: retries are deduplicated per tenant.
- Webhook callbacks are SSRF-safe: resolve → validate every IP → pin the IP → refuse redirects.
- Admin API and WebSocket require a JWT with role checks.

---

## Reset between runs

Demo Control → **Stop**, **Reset counters**. To reset everything:
`docker compose down -v && docker compose up -d redis postgres`.
