import type { FastifyReply } from "fastify";
import { getEnv } from "../../config/index.js";

export function accessCookieName(): string {
  return getEnv().COOKIE_SECURE ? "__Host-access" : "access_token";
}

export function refreshCookieName(): string {
  return getEnv().COOKIE_SECURE ? "__Host-refresh" : "refresh_token";
}

export function csrfCookieName(): string {
  return "csrf_token";
}

function cookieOptions(): Record<string, string | boolean> {
  const env = getEnv();
  return {
    path: "/",
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax" as const,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {})
  };
}

/** Set the access token cookie (short-lived JWT). */
export function setAccessCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(accessCookieName(), token, {
    ...cookieOptions(),
    maxAge: 15 * 60 // 15 min
  });
}

/** Set the refresh token cookie (long-lived opaque token). */
export function setRefreshCookie(reply: FastifyReply, token: string, maxAgeDays: number): void {
  void reply.setCookie(refreshCookieName(), token, {
    ...cookieOptions(),
    maxAge: maxAgeDays * 86400
  });
}

/** Set the CSRF token cookie (non-httpOnly, for double-submit). */
export function setCsrfCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(csrfCookieName(), token, {
    path: "/",
    httpOnly: false,
    secure: getEnv().COOKIE_SECURE,
    sameSite: "lax" as const,
    maxAge: 86400 // 24h; regenerated on login
  });
}

/** Clear all auth cookies (logout). */
export function clearAuthCookies(reply: FastifyReply): void {
  void reply.clearCookie(accessCookieName(), { path: "/" });
  void reply.clearCookie(refreshCookieName(), { path: "/" });
  void reply.clearCookie(csrfCookieName(), { path: "/" });
}
