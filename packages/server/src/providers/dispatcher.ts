// ═══════════════════════════════════════════════════════
// LLM Provider Adapters
// Handles OpenAI, Anthropic, and Google Gemini
// Implements the circuit-breaker + failover pattern
// ═══════════════════════════════════════════════════════

import { getProvider } from './llmProviders';
import { logger } from '../utils/logger';
import { query, queryOne } from '../db/pool';
import { publishProviderHealth } from '../db/redis';
import { circuitBreaker } from '../utils/redisCircuitBreaker';
import { applyChaos } from '../utils/chaos';

export interface LLMRequest {
  systemPrompt?: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  provider: string;
  model: string;
  responseText: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  displayName: string;
  priority: number;
  healthStatus: string;
  errorRate: number;
  avgLatencyMs: number;
}

// ─────────────────────────────────────────────
// Record health event to DB
// ─────────────────────────────────────────────
async function recordHealthEvent(
  providerName: string,
  eventType: string,
  latencyMs: number | null,
  statusCode: number | null,
  errorMessage: string | null
): Promise<void> {
  try {
    const provider = await queryOne<{ id: string }>(
      'SELECT id FROM providers WHERE name = $1',
      [providerName]
    );
    if (!provider) return;

    await query(
      `INSERT INTO provider_health_events (provider_id, event_type, status_code, latency_ms, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [provider.id, eventType, statusCode, latencyMs, errorMessage]
    );

    // Update provider rolling stats
    const stats = await queryOne<{ error_rate: number; avg_latency: number }>(
      `SELECT
         ROUND(100.0 * SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) / COUNT(*), 2) AS error_rate,
         ROUND(AVG(latency_ms)) AS avg_latency
       FROM provider_health_events
       WHERE provider_id = $1 AND recorded_at > NOW() - INTERVAL '5 minutes'`,
      [provider.id]
    );

    const errorRate = stats?.error_rate ?? 0;
    const avgLatency = stats?.avg_latency ?? 0;
    const healthStatus =
      errorRate > 50 ? 'down' : errorRate > 20 ? 'degraded' : 'healthy';

    await query(
      `UPDATE providers SET health_status = $1, error_rate = $2, avg_latency_ms = $3, last_health_check = NOW()
       WHERE id = $4`,
      [healthStatus, errorRate, avgLatency, provider.id]
    );

    // Broadcast health update via Redis pub/sub
    // Field names match the providers table so the dashboard can merge rows directly
    await publishProviderHealth({
      name: providerName,
      health_status: healthStatus,
      error_rate: errorRate,
      avg_latency_ms: avgLatency,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Failed to record health event', { error: (err as Error).message });
  }
}

// ─────────────────────────────────────────────
// Main Dispatcher: Try providers in priority order
// ─────────────────────────────────────────────
export async function dispatchToProvider(
  requestedModel: string | undefined,
  request: LLMRequest,
  tenantId: string
): Promise<LLMResponse & { providersTried: string[] }> {
  // One model per provider: the requested model if this provider serves it,
  // otherwise the provider's default (first-registered active model).
  // Failover therefore moves to a *different vendor* rather than retrying
  // the same vendor with another model.
  const providers = await query<{
    name: string;
    priority: number;
    model_name: string;
    input_cost: string;
    output_cost: string;
  }>(
    `SELECT DISTINCT ON (p.name)
            p.name, p.priority, m.name AS model_name,
            m.input_cost_per_1k_tokens AS input_cost,
            m.output_cost_per_1k_tokens AS output_cost
     FROM providers p
     JOIN models m ON m.provider_id = p.id
     WHERE p.is_active = true AND m.is_active = true
     ORDER BY p.name, (m.name = $1) DESC, m.is_default DESC, m.name ASC`,
    [requestedModel ?? null]
  );

  if (providers.length === 0) {
    throw new Error('No active providers configured');
  }

  // Priority order; the provider that owns the requested model goes first
  const orderedProviders = providers.sort((a, b) => {
    if (requestedModel) {
      if (a.model_name === requestedModel && b.model_name !== requestedModel) return -1;
      if (b.model_name === requestedModel && a.model_name !== requestedModel) return 1;
    }
    return a.priority - b.priority;
  });

  const providersTried: string[] = [];
  let lastError: Error | null = null;

  for (const provider of orderedProviders) {
    // The circuit breaker owns the skip decision. (Skipping on the DB
    // health_status would never let a 'down' provider recover, since no
    // new health events would be recorded for it.)
    const canExecute = await circuitBreaker.canExecute(provider.name);
    if (!canExecute) {
      logger.warn(`Skipping provider ${provider.name} - circuit breaker OPEN`);
      continue;
    }

    providersTried.push(`${provider.name}/${provider.model_name}`);

    try {
      logger.info(`Attempting provider ${provider.name} with model ${provider.model_name}`);

      // Fault injection (demo / resilience testing) happens before the vendor call
      await applyChaos(provider.name);

      // Polymorphism: every provider exposes the same complete() method
      const result: LLMResponse = await getProvider(provider.name).complete(
        provider.model_name,
        request,
        { inputPer1k: Number(provider.input_cost), outputPer1k: Number(provider.output_cost) }
      );

      // Record success in Circuit Breaker state machine (recovers HALF_OPEN -> CLOSED)
      await circuitBreaker.recordSuccess(provider.name);
      await recordHealthEvent(provider.name, 'success', result.latencyMs, 200, null);
      logger.info(`Provider ${provider.name} succeeded`, {
        model: result.model,
        latencyMs: result.latencyMs,
        tokens: result.totalTokens,
        tenantId,
      });

      return { ...result, providersTried };
    } catch (err: any) {
      lastError = err;
      const statusCode = err?.status ?? err?.response?.status ?? null;
      const isRateLimit = statusCode === 429 || statusCode === 529;
      const eventType = isRateLimit ? 'rate_limit' : 'error';

      logger.warn(`Provider ${provider.name} failed`, {
        error: err.message,
        statusCode,
        eventType,
      });

      // Record failure in Circuit Breaker (CLOSED -> OPEN or HALF_OPEN -> OPEN)
      await circuitBreaker.recordFailure(provider.name, err.message);
      await recordHealthEvent(provider.name, eventType, null, statusCode, err.message);

      // Continue to next provider (failover)
    }
  }

  throw new Error(
    providersTried.length === 0
      ? 'All providers unavailable (circuit breakers open)'
      : `All providers failed. Tried: ${providersTried.join(', ')}. Last error: ${lastError?.message}`
  );
}
