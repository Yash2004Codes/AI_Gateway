import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { queryOne } from '../db/pool';
import { logger } from '../utils/logger';
import { hashApiKey, getCachedTenant, cacheTenant, CachedTenant } from '../utils/apiKey';

export interface AuthenticatedRequest extends Request {
  tenant?: {
    id: string;
    name: string;
    tpmLimit: number;
    rpmLimit: number;
  };
  user?: {
    id: string;
    email: string;
    role: string;
    tenantId?: string;
  };
}

// ─────────────────────────────────────────────
// API Key authentication (for gateway consumers)
// ─────────────────────────────────────────────
export async function apiKeyAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const apiKey =
    req.headers['x-api-key'] as string ||
    req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    res.status(401).json({ error: 'Missing API key', code: 'MISSING_API_KEY' });
    return;
  }

  try {
    const hash = hashApiKey(apiKey);

    // Redis cache first (positive + negative), then Postgres on miss
    let tenant: CachedTenant | null | undefined = await getCachedTenant(hash);

    if (tenant === undefined) {
      const row = await queryOne<{
        id: string;
        name: string;
        tpm_limit: number;
        rpm_limit: number;
      }>(
        'SELECT id, name, tpm_limit, rpm_limit FROM tenants WHERE api_key_hash = $1 AND is_active = true',
        [hash]
      );

      tenant = row
        ? { id: row.id, name: row.name, tpmLimit: row.tpm_limit, rpmLimit: row.rpm_limit }
        : null;
      await cacheTenant(hash, tenant);
    }

    if (!tenant) {
      res.status(401).json({ error: 'Invalid or inactive API key', code: 'INVALID_API_KEY' });
      return;
    }

    req.tenant = tenant;

    next();
  } catch (err) {
    logger.error('API key auth error', { error: (err as Error).message });
    res.status(500).json({ error: 'Authentication service error' });
  }
}

// ─────────────────────────────────────────────
// JWT authentication (for admin dashboard)
// ─────────────────────────────────────────────
export async function jwtAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Missing authorization token', code: 'MISSING_TOKEN' });
    return;
  }

  try {
    req.user = verifyJwt(token);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }
}

// Shared by the HTTP middleware and the Socket.IO handshake
export function verifyJwt(token: string): NonNullable<AuthenticatedRequest['user']> {
  const decoded = jwt.verify(token, getJwtSecret()) as {
    userId: string;
    email: string;
    role: string;
    tenantId?: string;
  };

  return {
    id: decoded.userId,
    email: decoded.email,
    role: decoded.role,
    tenantId: decoded.tenantId,
  };
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

// ─────────────────────────────────────────────
// Role-based access control
// ─────────────────────────────────────────────
export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions', required: roles });
      return;
    }
    next();
  };
}
