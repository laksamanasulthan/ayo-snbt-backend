import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyOauth2 from "@fastify/oauth2";
import { getEnv } from "../../config/index.js";
import { authService } from "./service.js";
import { UnauthorizedError } from "../../shared/http/errors.js";
import { setAccessCookie, setRefreshCookie, setCsrfCookie, clearAuthCookies, refreshCookieName } from "../../shared/auth/index.js";
import { randomBytes } from "node:crypto";

function userSummary(u: { id: string; email: string; name: string; roles: string[]; permissions: string[] }) {
  return { id: u.id, email: u.email, name: u.name, roles: u.roles, permissions: u.permissions };
}

function clientIp(request: FastifyRequest): string {
  const fwd = request.headers["x-forwarded-for"];
  return typeof fwd === "string" ? (fwd.split(",")[0]?.trim() ?? "unknown") : (request.socket.remoteAddress ?? "unknown");
}

export async function authModule(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  // ── OAuth2 (Google) ──────────────────────────────────────────────────
  if (env.OAUTH_ENABLED && env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET) {
    await app.register(fastifyOauth2, {
      name: "googleOAuth2",
      scope: ["openid", "email", "profile"],
      credentials: {
        client: {
          id: env.OAUTH_GOOGLE_CLIENT_ID,
          secret: env.OAUTH_GOOGLE_CLIENT_SECRET
        },
        auth: {
          authorizeHost: "https://accounts.google.com",
          authorizePath: "/o/oauth2/v2/auth",
          tokenHost: "https://oauth2.googleapis.com",
          tokenPath: "/token"
        }
      },
      startRedirectPath: "/auth/oauth2/google",
      callbackUri: env.OAUTH_GOOGLE_CALLBACK_URL ?? "http://localhost:3000/auth/oauth2/google/callback"
    });
  }

  // ── Register ─────────────────────────────────────────────────────────
  app.post("/api/v1/auth/register", {
    schema: {
      body: { type: "object", required: ["email", "password", "name"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 }, name: { type: "string", minLength: 1 } } }
    }
  }, async (request, reply) => {
    const body = request.body as { email: string; password: string; name: string };
    const result = await authService.register(body);
    return reply.created({ userId: result.userId });
  });

  // ── Verify email ─────────────────────────────────────────────────────
  app.get("/api/v1/auth/verify-email", {
    schema: {
      querystring: { type: "object", required: ["token"], properties: { token: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { token } = request.query as { token: string };
    await authService.verifyEmail(token);
    return reply.ok({ verified: true });
  });

  // ── Login ────────────────────────────────────────────────────────────
  app.post("/api/v1/auth/login", {
    schema: {
      body: { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } }
    },
    config: { rateLimit: { max: 5, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const body = request.body as { email: string; password: string };
    const result = await authService.login(body, { ip: clientIp(request), userAgent: request.headers["user-agent"] });
    setAccessCookie(reply, result.accessToken);
    setRefreshCookie(reply, result.refreshToken, env.REFRESH_TOKEN_TTL_DAYS);
    const csrf = randomBytes(24).toString("base64url");
    setCsrfCookie(reply, csrf);
    return reply.ok({ user: userSummary(result.user) });
  });

  // ── Refresh (rotation) ───────────────────────────────────────────────
  app.post("/api/v1/auth/refresh", {
    schema: {},
    config: { rateLimit: { max: 20, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const raw = request.cookies[refreshCookieName()];
    if (!raw) throw new UnauthorizedError("Missing refresh token");
    const result = await authService.refresh(raw, { ip: clientIp(request), userAgent: request.headers["user-agent"] });
    setAccessCookie(reply, result.accessToken);
    setRefreshCookie(reply, result.refreshToken, env.REFRESH_TOKEN_TTL_DAYS);
    return reply.ok({ user: userSummary(result.user) });
  });

  // ── Logout ───────────────────────────────────────────────────────────
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const raw = request.cookies[refreshCookieName()];
    await authService.logout(raw ?? "");
    clearAuthCookies(reply);
    return reply.ok({ loggedOut: true });
  });

  // ── Forgot / reset password ─────────────────────────────────────────
  app.post("/api/v1/auth/forgot-password", {
    schema: {
      body: { type: "object", required: ["email"], properties: { email: { type: "string" } } }
    },
    config: { rateLimit: { max: 5, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const { email } = request.body as { email: string };
    await authService.forgotPassword(email);
    return reply.ok({ sent: true });
  });

  app.post("/api/v1/auth/reset-password", {
    schema: {
      body: { type: "object", required: ["token", "password"], properties: { token: { type: "string" }, password: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { token, password } = request.body as { token: string; password: string };
    await authService.resetPassword(token, password);
    return reply.ok({ reset: true });
  });

  // ── OAuth2 callback ──────────────────────────────────────────────────
  if (env.OAUTH_ENABLED && env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET) {
    app.get("/auth/oauth2/google/callback", async (request, reply) => {
      const result = await (app as unknown as { googleOAuth2: { getAccessTokenFromAuthorizationCodeFlow(req: FastifyRequest): Promise<{ token: { access_token: string } }> } }).googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);
      const accessToken = result.token.access_token;
      const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: "Bearer " + accessToken }
      });
      if (!profileRes.ok) throw new Error("Failed to fetch Google profile");
      const profile = (await profileRes.json()) as { id: string; email?: string; name?: string; picture?: string; verified_email?: boolean };
      if (!profile.id) throw new Error("Google profile missing id");
      const auth = await authService.oauthLogin(
        "google",
        {
          providerUserId: profile.id,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.picture
        },
        { ip: clientIp(request), userAgent: request.headers["user-agent"] }
      );
      setAccessCookie(reply, auth.accessToken);
      setRefreshCookie(reply, auth.refreshToken, env.REFRESH_TOKEN_TTL_DAYS);
      const csrf = randomBytes(24).toString("base64url");
      setCsrfCookie(reply, csrf);
      // Redirect back to frontend with a session-started flag
      return reply.redirect(env.OAUTH_FRONTEND_REDIRECT_URL + "?oauth=success");
    });
  }
}