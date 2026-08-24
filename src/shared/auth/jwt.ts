import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getEnv } from "../../config/index.js";
import { randomBytes, createHash } from "node:crypto";

export interface AccessTokenPayload {
  sub: string;       // userId
  email: string;
  roles: string[];
  permissions: string[];
}

export interface RefreshTokenPayload {
  sub: string;       // userId
  familyId: string;
}

const textEncoder = new TextEncoder();

function getSecret(): Uint8Array {
  return textEncoder.encode(getEnv().JWT_ACCESS_SECRET);
}

/** Sign a short-lived access JWT (15 min). */
export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new SignJWT(payload as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(getEnv().JWT_ACCESS_TTL)
    .sign(getSecret());
}

/** Verify an access JWT and return its payload. */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ["HS256"]
  });
  return payload as unknown as AccessTokenPayload;
}

/** Generate an opaque 256-bit refresh token (raw + sha256 hash). */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(48).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** Hash a refresh token string (for lookup). */
export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
