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
// SSRF Protection: validate provider URLs
// Restrict to known public domains only
// ─────────────────────────────────────────────
const ALLOWED_PROVIDER_DOMAINS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'bedrock-runtime.amazonaws.com',
];

export function isAllowedProviderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Block private/internal IP ranges (SSRF protection)
    const hostname = parsed.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('192.168.') ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }
    return ALLOWED_PROVIDER_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
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
  // Get ordered provider fallback chain
  const providers = await query<{
    name: string;
    health_status: string;
    priority: number;
    model_name: string;
  }>(
    `SELECT p.name, p.health_status, p.priority, m.name AS model_name
     FROM providers p
     JOIN models m ON m.provider_id = p.id
     WHERE p.is_active = true AND m.is_active = true
     ORDER BY p.priority ASC, p.avg_latency_ms ASC`
  );

  if (providers.length === 0) {
    throw new Error('No active providers configured');
  }

  // If a specific model is requested, prefer its provider first
  let orderedProviders = [...providers];
  if (requestedModel) {
    orderedProviders = [
      ...providers.filter((p) => p.model_name === requestedModel),
      ...providers.filter((p) => p.model_name !== requestedModel),
    ];
  }

  const providersTried: string[] = [];
  let lastError: Error | null = null;

  for (const provider of orderedProviders) {
    // Check Redis-backed Circuit Breaker state (CLOSED, OPEN, HALF_OPEN)
    const canExecute = await circuitBreaker.canExecute(provider.name);
    if (!canExecute || provider.health_status === 'down') {
      logger.warn(`Skipping provider ${provider.name} - Circuit Breaker OPEN or HALF_OPEN limit reached`);
      continue;
    }

    const providerKey = `${provider.name}/${provider.model_name}`;
    if (providersTried.includes(providerKey)) continue;
    providersTried.push(providerKey);

    try {
      logger.info(`Attempting provider ${provider.name} with model ${provider.model_name}`);

      // Polymorphism: every provider exposes the same complete() method
      const result: LLMResponse = await getProvider(provider.name).complete(
        provider.model_name,
        request
      );

      // Record success in Circuit Breaker state machine (recovers HALF_OPEN -> CLOSED)
      await circuitBreaker.recordSuccess(provider.name);
      await recordHealthEvent(provider.name, 'success', result.latencyMs, 200, null);
      logger.info(`Provider ${provider.name} succeeded`, {
        model: result.model,
        latencyMs: result.latencyMs,
        tokens: result.totalTokens,
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
    `All providers failed. Tried: ${providersTried.join(', ')}. Last error: ${lastError?.message}`
  );
}
