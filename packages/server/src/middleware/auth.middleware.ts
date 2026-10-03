import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { queryOne } from '../db/pool';
import { logger } from '../utils/logger';

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
    const tenant = await queryOne<{
      id: string;
      name: string;
      tpm_limit: number;
      rpm_limit: number;
      is_active: boolean;
    }>(
      'SELECT id, name, tpm_limit, rpm_limit, is_active FROM tenants WHERE api_key = $1',
      [apiKey]
    );

    if (!tenant || !tenant.is_active) {
      res.status(401).json({ error: 'Invalid or inactive API key', code: 'INVALID_API_KEY' });
      return;
    }

    req.tenant = {
      id: tenant.id,
      name: tenant.name,
      tpmLimit: tenant.tpm_limit,
      rpmLimit: tenant.rpm_limit,
    };

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
    const secret = process.env.JWT_SECRET ?? 'default_secret';
    const decoded = jwt.verify(token, secret) as {
      userId: string;
      email: string;
      role: string;
      tenantId?: string;
    };

    req.user = {
      id: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      tenantId: decoded.tenantId,
    };

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }
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
