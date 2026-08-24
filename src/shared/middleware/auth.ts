import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken, accessCookieName, csrfCookieName } from "../auth/index.js";
import { AppError, ForbiddenError, UnauthorizedError } from "../http/errors.js";
import { hasPermission, type Permission } from "../rbac/permissions.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      roles: string[];
      permissions: string[];
    };
  }
  interface FastifyContextConfig {
    /** Set false on provider webhooks / callbacks that auth via signatures. */
    csrf?: boolean;
  }
}

/**
 * Authenticate from the access_token cookie. Sets request.user on success.
 * Returns 401 on missing/invalid token.
 */
export async function authGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = request.cookies[accessCookieName()];
  if (!token) throw new UnauthorizedError("Missing access token");
  try {
    const payload = await verifyAccessToken(token);
    request.user = {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles,
      permissions: payload.permissions
    };
  } catch {
    throw new UnauthorizedError("Invalid or expired access token", "TOKEN_EXPIRED");
  }
}

/**
 * Optional auth: sets request.user if valid token present, does nothing if missing.
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = request.cookies[accessCookieName()];
  if (!token) return;
  try {
    const payload = await verifyAccessToken(token);
    request.user = {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles,
      permissions: payload.permissions
    };
  } catch {
    // ignore invalid token on optional auth
  }
}

/**
 * Require a specific permission. Must be used AFTER authGuard.
 * Returns 403 if the user lacks the required permission.
 */
export function requirePermission(permission: Permission) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.user) throw new UnauthorizedError("Authentication required");
    if (!hasPermission(request.user.permissions, permission)) {
      throw new ForbiddenError("Missing required permission: " + permission);
    }
  };
}

const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF double-submit cookie guard: on mutating requests, check that
 * x-csrf-token header matches the csrf_token cookie value.
 */
export async function csrfGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (CSRF_SAFE_METHODS.has(request.method)) return;
  // Provider webhooks / payment callbacks are exempt (they authenticate via
  // signatures or tokens, not browser cookies).
  if (request.routeOptions.config?.csrf === false) return;
  const cookie = request.cookies[csrfCookieName()];
  const header = request.headers["x-csrf-token"];
  if (!cookie || !header || cookie !== header) {
    throw new AppError(403, "CSRF_TOKEN_MISMATCH", "CSRF token mismatch or missing");
  }
}