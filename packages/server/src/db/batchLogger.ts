import { query } from './pool';
import { logger } from '../utils/logger';

export interface TokenLedgerEntry {
  requestId: string;
  tenantId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  recordedAt?: string;
}

export interface RequestLogEntry {
  id: string;
  tenantId: string;
  idempotencyKey?: string | null;
  jobId?: string | null;
  status: string;
  priority: number;
  requestedModel?: string | null;
  systemPrompt?: string | null;
  userMessage: string;
  maxTokens: number;
  providerUsed?: string | null;
  modelUsed?: string | null;
  responseText?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  attemptCount?: number;
  providersTried?: unknown[];
  queuedAt?: string;
  processingStartedAt?: string;
  completedAt?: string;
  totalLatencyMs?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

class BatchLoggerService {
  private ledgerQueue: TokenLedgerEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private maxBatchSize = 100;
  private flushIntervalMs = 500;

  constructor() {
    this.startFlushTimer();
    process.on('beforeExit', () => this.flushAllSync());
  }

  private startFlushTimer() {
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        this.flushLedger().catch((err) => {
          logger.error('Error during scheduled batch ledger flush', { error: err.message });
        });
      }, this.flushIntervalMs);
    }
  }

  public async logTokenUsage(entry: TokenLedgerEntry): Promise<void> {
    this.ledgerQueue.push(entry);
    if (this.ledgerQueue.length >= this.maxBatchSize) {
      await this.flushLedger();
    }
  }

  public async flushLedger(): Promise<void> {
    if (this.ledgerQueue.length === 0) return;

    const batch = [...this.ledgerQueue];
    this.ledgerQueue = [];

    const valueTuples: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const item of batch) {
      valueTuples.push(
        `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`
      );
      params.push(
        item.requestId,
        item.tenantId,
        item.provider,
        item.model,
        item.promptTokens,
        item.completionTokens,
        item.totalTokens,
        item.costUsd
      );
      idx += 8;
    }

    const sql = `
      INSERT INTO token_usage_ledger
        (request_id, tenant_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd)
      VALUES ${valueTuples.join(', ')}
    `;

    try {
      await query(sql, params);
      logger.info(`Flushed ${batch.length} token ledger entries to Postgres`);
    } catch (err: any) {
      logger.error('Failed to execute batched write for token ledger', {
        error: err.message,
        batchSize: batch.length,
      });
      // Re-queue items on failure so no audit log is lost
      this.ledgerQueue.unshift(...batch);
    }
  }

  public async flushAllSync(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushLedger();
  }
}

export const batchLogger = new BatchLoggerService();
