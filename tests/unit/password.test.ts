import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../../src/shared/auth/index.js";

describe("Password hashing (argon2id)", () => {
  it("hashes and verifies correctly", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash).toContain("argon2");
    await expect(verifyPassword("correct-horse-battery", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("produces unique hashes for the same password", async () => {
    const a = await hashPassword("same-pass");
    const b = await hashPassword("same-pass");
    expect(a).not.toBe(b);
  });
});
