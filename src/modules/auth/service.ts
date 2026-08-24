import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "../../shared/db/client.js";
import {
  users, refreshTokens, emailVerifications, passwordResets, userIdentities, userRoles, roles, rolePermissions, permissions
} from "../../shared/db/schema/index.js";
import {
  hashPassword, verifyPassword, signAccessToken, generateRefreshToken, hashRefreshToken
} from "../../shared/auth/index.js";
import { ConflictError, NotFoundError, UnauthorizedError, BadRequestError, ForbiddenError } from "../../shared/http/errors.js";
import { QueueName, enqueue } from "../../shared/queue/queues.js";
import { loginLockout } from "../../shared/auth/index.js";
import { getEnv } from "../../config/index.js";
import type { AccessTokenPayload } from "../../shared/auth/index.js";

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string; roles: string[]; permissions: string[] };
}

/** Build the RBAC claims snapshot for JWT embedding. */
export async function getUserClaims(userId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const db = getDb();
  const userRolesRows = await db
    .select({ roleName: roles.name, permCode: permissions.code })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(userRoles.userId, userId));
  const roleSet = new Set(userRolesRows.map((r) => r.roleName));
  const permSet = new Set(userRolesRows.map((r) => r.permCode));
  return { roles: [...roleSet], permissions: [...permSet] };
}

/** Create the access JWT for a user. */
export async function issueAccessToken(userId: string, email: string): Promise<string> {
  const claims = await getUserClaims(userId);
  const payload: AccessTokenPayload = {
    sub: userId,
    email,
    roles: claims.roles,
    permissions: claims.permissions
  };
  return signAccessToken(payload);
}

export async function createRefreshToken(userId: string, familyId: string | null, meta: { userAgent?: string; ip?: string }): Promise<string> {
  const db = getDb();
  const { raw, hash } = generateRefreshToken();
  const family = familyId ?? randomBytes(16).toString("hex");
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hash,
    familyId: family,
    expiresAt: new Date(Date.now() + getEnv().REFRESH_TOKEN_TTL_DAYS * 86400_000),
    userAgent: meta.userAgent,
    ip: meta.ip
  });
  return raw;
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  const db = getDb();
  const hash = hashRefreshToken(raw);
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, hash));
}

/** Revoke the entire token family (token-theft detection). */
export async function revokeFamily(familyId: string): Promise<void> {
  const db = getDb();
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.familyId, familyId));
}

async function buildAuthResult(user: { id: string; email: string; name: string }, meta: { userAgent?: string; ip?: string }): Promise<AuthResult> {
  const accessToken = await issueAccessToken(user.id, user.email);
  const refreshToken = await createRefreshToken(user.id, null, meta);
  const claims = await getUserClaims(user.id);
  return {
    accessToken,
    refreshToken,
    user: { ...user, roles: claims.roles, permissions: claims.permissions }
  };
}

export const authService = {
  /** Register a new account (email verification required before login). */
  async register(input: { email: string; password: string; name: string }): Promise<{ userId: string }> {
    const db = getDb();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    if (existing.length > 0) throw new ConflictError("Email already registered", "EMAIL_TAKEN");
    const passwordHash = await hashPassword(input.password);
    const [user] = await db
      .insert(users)
      .values({ email: input.email, passwordHash, name: input.name, status: "pending" })
      .returning({ id: users.id });
    if (!user) throw new BadRequestError("Failed to create user");
    // Assign default student role
    const studentRole = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "student")).limit(1);
    if (studentRole[0]) await db.insert(userRoles).values({ userId: user.id, roleId: studentRole[0].id });
    // Email verification token
    const token = randomBytes(32).toString("hex");
    await db.insert(emailVerifications).values({
      userId: user.id,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + 24 * 3600_000)
    });
    await enqueue(QueueName.Email, {
      to: input.email,
      template: "verify-email",
      data: { token, name: input.name }
    });
    return { userId: user.id };
  },

  /** Verify a user's email address. */
  async verifyEmail(token: string): Promise<void> {
    const db = getDb();
    const hash = hashRefreshToken(token);
    const row = await db
      .select({ id: emailVerifications.id, userId: emailVerifications.userId, expiresAt: emailVerifications.expiresAt, usedAt: emailVerifications.usedAt })
      .from(emailVerifications)
      .where(eq(emailVerifications.tokenHash, hash))
      .limit(1);
    const item = row[0];
    if (!item || item.usedAt) throw new BadRequestError("Invalid or already used verification token");
    if (item.expiresAt < new Date()) throw new BadRequestError("Verification token expired");
    await db.update(emailVerifications).set({ usedAt: new Date() }).where(eq(emailVerifications.id, item.id));
    await db.update(users).set({ emailVerifiedAt: new Date(), status: "active" }).where(eq(users.id, item.userId));
  },

  /** Login with email + password (lockout + exponential backoff windows). */
  async login(input: { email: string; password: string }, meta: { ip: string; userAgent?: string }): Promise<AuthResult> {
    const db = getDb();
    const status = await loginLockout.recordFailed(input.email, meta.ip);
    if (status.locked) throw new UnauthorizedError("Too many failed attempts — account temporarily locked", "ACCOUNT_LOCKED");
    const row = await db
      .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash, emailVerifiedAt: users.emailVerifiedAt, status: users.status })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    const user = row[0];
    // Constant-ish behavior: verify against a dummy hash when user not found
    const hash = user?.passwordHash ?? "$argon2id$v=19$m=19456,t=2,p=1$dummy";
    const valid = await verifyPassword(input.password, hash).catch(() => false);
    if (!user || !valid) throw new UnauthorizedError("Invalid email or password", "AUTH_INVALID_CREDENTIALS");
    if (user.status === "pending" || !user.emailVerifiedAt) throw new ForbiddenError("Email not verified", "EMAIL_NOT_VERIFIED");
    await loginLockout.clear(input.email, meta.ip);
    return buildAuthResult({ id: user.id, email: user.email, name: user.name }, meta);
  },

  /** Rotate refresh token (reuse detection revokes the whole family). */
  async refresh(raw: string, meta: { ip: string; userAgent?: string }): Promise<AuthResult> {
    const db = getDb();
    const hash = hashRefreshToken(raw);
    const row = await db
      .select({ id: refreshTokens.id, userId: refreshTokens.userId, familyId: refreshTokens.familyId, expiresAt: refreshTokens.expiresAt, revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    const token = row[0];
    if (!token) throw new UnauthorizedError("Invalid refresh token");
    // Reuse detection: a revoked token presented again = stolen session family
    if (token.revokedAt) {
      await revokeFamily(token.familyId);
      throw new UnauthorizedError("Refresh token reuse detected — session family revoked", "TOKEN_REUSE_DETECTED");
    }
    if (token.expiresAt < new Date()) throw new UnauthorizedError("Refresh token expired", "TOKEN_EXPIRED");
    const userRow = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, token.userId)).limit(1);
    const user = userRow[0];
    if (!user) throw new UnauthorizedError("User not found");
    // Rotate: revoke old, issue new in the same family
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, token.id));
    const accessToken = await issueAccessToken(user.id, user.email);
    const refreshToken = await createRefreshToken(user.id, token.familyId, meta);
    const claims = await getUserClaims(user.id);
    return { accessToken, refreshToken, user: { ...user, roles: claims.roles, permissions: claims.permissions } };
  },

  /** Logout: revoke the presented refresh token. */
  async logout(raw: string): Promise<void> {
    if (!raw) return;
    await revokeRefreshToken(raw);
  },

  /** Forgot password: issue a reset token and email it. */
  async forgotPassword(email: string): Promise<void> {
    const db = getDb();
    const user = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email)).limit(1);
    // Always succeed (no user enumeration); only email when account exists
    if (!user[0]) return;
    const token = randomBytes(32).toString("hex");
    await db.insert(passwordResets).values({
      email,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + 15 * 60_000)
    });
    await enqueue(QueueName.Email, {
      to: email,
      template: "reset-password",
      data: { token, name: user[0].name }
    });
  },

  /** Reset password with a valid token; revoke all sessions. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const db = getDb();
    const hash = hashRefreshToken(token);
    const row = await db.select().from(passwordResets).where(eq(passwordResets.tokenHash, hash)).limit(1);
    const item = row[0];
    if (!item || item.usedAt) throw new BadRequestError("Invalid or already used reset token");
    if (item.expiresAt < new Date()) throw new BadRequestError("Reset token expired");
    const user = await db.select({ id: users.id }).from(users).where(eq(users.email, item.email)).limit(1);
    if (!user[0]) throw new NotFoundError("User not found");
    const passwordHash = await hashPassword(newPassword);
    await db.update(users).set({ passwordHash }).where(eq(users.id, user[0].id));
    await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, item.id));
    // Revoke all sessions
    const sessions = await db.select({ id: refreshTokens.id }).from(refreshTokens).where(eq(refreshTokens.userId, user[0].id));
    for (const s of sessions) await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, s.id));
  },

  /** OAuth2 social login: find-or-create via provider identity + link by email. */
  async oauthLogin(provider: string, profile: { providerUserId: string; email?: string; name?: string; avatarUrl?: string }, meta: { ip: string; userAgent?: string }): Promise<AuthResult> {
    const db = getDb();
    // 1. Identity exists → login
    const identity = await db
      .select({ id: userIdentities.id, userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerUserId, profile.providerUserId)))
      .limit(1);
    if (identity[0]) {
      const user = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, identity[0].userId)).limit(1);
      if (user[0]) return buildAuthResult(user[0], meta);
    }
    if (!profile.email) throw new BadRequestError("OAuth provider did not return an email", "OAUTH_NO_EMAIL");
    // 2. Identity absent → find user by email (account linking)
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, profile.email)).limit(1);
    let userId: string;
    if (existing[0]) {
      userId = existing[0].id;
      if (!profile.email) throw new BadRequestError("Email already in use", "ACCOUNT_LINKING_CONFLICT");
    } else {
      const [created] = await db
        .insert(users)
        .values({ email: profile.email, name: profile.name ?? "New User", emailVerifiedAt: new Date(), status: "active", avatarUrl: profile.avatarUrl })
        .returning({ id: users.id });
      if (!created) throw new BadRequestError("Failed to create user");
      userId = created.id;
      const studentRole = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "student")).limit(1);
      if (studentRole[0]) await db.insert(userRoles).values({ userId, roleId: studentRole[0].id });
    }
    // 3. Link identity
    await db.insert(userIdentities).values({
      userId,
      provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
      avatarUrl: profile.avatarUrl
    });
    const user = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    const found = user[0];
    if (!found) throw new NotFoundError("User not found");
    return buildAuthResult(found, meta);
  }
};