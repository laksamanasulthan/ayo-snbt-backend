import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken } from "../../src/shared/auth/index.js";

describe("JWT service", () => {
  it("signs and verifies an access token roundtrip", async () => {
    const token = await signAccessToken({ sub: "user-1", email: "a@b.c", roles: ["student"], permissions: ["user:read"] });
    const payload = await verifyAccessToken(token);
    expect(payload.sub).toBe("user-1");
    expect(payload.email).toBe("a@b.c");
    expect(payload.roles).toEqual(["student"]);
    expect(payload.permissions).toEqual(["user:read"]);
  });

  it("rejects a tampered token", async () => {
    const token = await signAccessToken({ sub: "u1", email: "a@b.c", roles: [], permissions: [] });
    const tampered = token.slice(0, -4) + "AAAA";
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const encoder = new TextEncoder();
    const expired = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Date.now() / 1000 - 2000)
      .setExpirationTime(Date.now() / 1000 - 1000)
      .sign(encoder.encode("dev-only-jwt-access-secret-change-me-0123456789"));
    await expect(verifyAccessToken(expired)).rejects.toThrow();
  });

  it("generates unique refresh tokens with matching hashes", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).toBe(hashRefreshToken(a.raw));
    expect(a.raw).toHaveLength(64); // 48 bytes base64url
  });
});
