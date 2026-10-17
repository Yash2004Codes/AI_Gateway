// ═══════════════════════════════════════════════════════
// Seed ~24h of realistic request history so charts are populated.
// Rows are tagged idempotency_key = 'seed:<n>' and replaced on each run.
// Includes a one-hour OpenAI incident ~6-7h ago, served by Anthropic failover.
// ═══════════════════════════════════════════════════════

import { transaction } from '../db/pool';

export async function seedHistory(): Promise<{ requests: number; ledger: number }> {
  return transaction(async (client) => {
    await client.query(`
      DELETE FROM token_usage_ledger
      WHERE request_id IN (SELECT id FROM gateway_requests WHERE idempotency_key LIKE 'seed:%')
    `);
    await client.query(`DELETE FROM gateway_requests WHERE idempotency_key LIKE 'seed:%'`);

    const inserted = await client.query(`
      WITH tenant_list AS (
        SELECT id, row_number() OVER (ORDER BY name) AS rn, COUNT(*) OVER () AS n
        FROM tenants WHERE is_active = true
      ),
      default_models AS (
        SELECT DISTINCT ON (p.name) p.name AS provider, m.name AS model,
               m.input_cost_per_1k_tokens AS ic, m.output_cost_per_1k_tokens AS oc
        FROM providers p JOIN models m ON m.provider_id = p.id
        WHERE m.is_active = true
        ORDER BY p.name, m.is_default DESC, m.name
      ),
      gen AS (
        SELECT g,
          NOW() - make_interval(secs => g * 50 + random() * 40) AS ts,
          random() AS r_tenant, random() AS r_provider, random() AS r_fail,
          50 + floor(random() * 750)::int AS pt,
          50 + floor(random() * 550)::int AS ct,
          400 + floor(random() * 2600)::int AS lat
        FROM generate_series(40, 1720) g
      ),
      shaped AS (
        SELECT gen.*,
          (ts BETWEEN NOW() - INTERVAL '7 hours' AND NOW() - INTERVAL '6 hours' AND r_provider < 0.6) AS incident,
          CASE WHEN r_provider < 0.6 THEN 'openai'
               WHEN r_provider < 0.85 THEN 'anthropic'
               ELSE 'gemini' END AS primary_provider
        FROM gen
      ),
      seeded AS (
        SELECT s.*, tl.id AS tenant_id,
          CASE WHEN s.incident THEN 'anthropic' ELSE s.primary_provider END AS provider,
          (s.r_fail < 0.03) AS failed
        FROM shaped s
        JOIN tenant_list tl ON tl.rn = 1 + floor(s.r_tenant * tl.n)::int
      )
      INSERT INTO gateway_requests (
        id, tenant_id, idempotency_key, job_id, status, priority, user_message, max_tokens,
        provider_used, model_used, response_text, prompt_tokens, completion_tokens, total_tokens,
        estimated_cost_usd, attempt_count, providers_tried, queued_at, processing_started_at,
        completed_at, total_latency_ms, error_code, error_message, created_at, updated_at
      )
      SELECT
        uuid_generate_v4(), r.tenant_id, 'seed:' || r.g, NULL,
        CASE WHEN r.failed THEN 'failed' ELSE 'completed' END, 5,
        'Seeded demo request', 1024,
        CASE WHEN r.failed THEN NULL ELSE r.provider END,
        CASE WHEN r.failed THEN NULL ELSE dm.model END,
        CASE WHEN r.failed THEN NULL ELSE '[seeded history]' END,
        CASE WHEN r.failed THEN 0 ELSE r.pt END,
        CASE WHEN r.failed THEN 0 ELSE r.ct END,
        CASE WHEN r.failed THEN 0 ELSE r.pt + r.ct END,
        CASE WHEN r.failed THEN 0 ELSE (r.pt / 1000.0) * dm.ic + (r.ct / 1000.0) * dm.oc END,
        CASE WHEN r.failed THEN 3 ELSE 1 END,
        CASE WHEN r.incident AND om.model IS NOT NULL
             THEN jsonb_build_array('openai/' || om.model, r.provider || '/' || dm.model)
             ELSE jsonb_build_array(r.provider || '/' || dm.model) END,
        r.ts,
        r.ts + make_interval(secs => 0.05 + random() * 0.3),
        r.ts + make_interval(secs => r.lat / 1000.0),
        r.lat,
        CASE WHEN r.failed THEN 'ALL_PROVIDERS_FAILED' END,
        CASE WHEN r.failed THEN 'Seeded failure' END,
        r.ts, r.ts
      FROM seeded r
      JOIN default_models dm ON dm.provider = r.provider
      LEFT JOIN (SELECT model FROM default_models WHERE provider = 'openai') om ON true
    `);

    const ledger = await client.query(`
      INSERT INTO token_usage_ledger
        (request_id, tenant_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, recorded_at)
      SELECT id, tenant_id, provider_used, model_used, prompt_tokens, completion_tokens,
             total_tokens, estimated_cost_usd, completed_at
      FROM gateway_requests
      WHERE idempotency_key LIKE 'seed:%' AND status = 'completed'
    `);

    return { requests: inserted.rowCount ?? 0, ledger: ledger.rowCount ?? 0 };
  });
}
