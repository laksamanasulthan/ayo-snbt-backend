import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

const ARGON2_OPTIONS = {
  memoryCost: 19456,  // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
};

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // @node-rs/argon2: verify(hashed, password) — order matters!
  return argon2Verify(hash, password);
}