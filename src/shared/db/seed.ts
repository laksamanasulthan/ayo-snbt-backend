import { eq } from "drizzle-orm";
import { getDirectPool, getDb } from "./client.js";
import { permissions, roles, rolePermissions, users, userRoles } from "./schema/index.js";
import { ROLE_SEED, RoleName } from "../rbac/permissions.js";
import { getLogger } from "../logger.js";

/**
 * Idempotent RBAC seed: inserts roles + permissions + role→permission
 * mappings (ON CONFLICT DO NOTHING style). Run via npm run db:seed.
 */
export async function seedRbac(): Promise<void> {
  const db = getDb();
  const log = getLogger();

  // Permissions
  for (const code of Object.values(ROLE_SEED[RoleName.ADMIN])) {
    await db
      .insert(permissions)
      .values({ code, description: code })
      .onConflictDoNothing({ target: permissions.code });
  }
  const permRows = await db.select({ id: permissions.id, code: permissions.code }).from(permissions);
  const permIdByCode = new Map(permRows.map((r) => [r.code, r.id]));

  // Roles + role_permissions
  for (const [roleName, perms] of Object.entries(ROLE_SEED)) {
    const inserted = await db
      .insert(roles)
      .values({ name: roleName, description: `Default ${roleName} role` })
      .onConflictDoNothing({ target: roles.name })
      .returning({ id: roles.id, name: roles.name });
    const roleId =
    inserted[0]?.id ?? (await db.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName)))[0]?.id;
    if (!roleId) throw new Error(`role not found: ${roleName}`);
    for (const code of perms) {
      const permId = permIdByCode.get(code);
      if (!permId) throw new Error(`permission not found: ${code}`);
      await db
        .insert(rolePermissions)
        .values({ roleId, permissionId: permId })
        .onConflictDoNothing();
    }
  }
  log.info("RBAC seeded: roles + permissions OK");
}

/** Optional: create a bootstrap admin from env (ADMIN_EMAIL, ADMIN_PASSWORD). */
export async function seedAdmin(): Promise<void> {
  const env = process.env;
  const adminEmail = env.ADMIN_EMAIL;
  if (!adminEmail || !env.ADMIN_PASSWORD) return;
  const db = getDb();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, adminEmail)).limit(1);
  if (existing.length > 0) {
    getLogger().info("admin already exists");
    return;
  }
  // Password hashing lands in the auth slice (Phase 2); seed without password for now.
  const [admin] = await db
    .insert(users)
    .values({ email: adminEmail, name: "Admin", emailVerifiedAt: new Date() })
    .returning({ id: users.id });
  const role = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, RoleName.ADMIN)).limit(1);
  if (admin && role[0]) {
    await db.insert(userRoles).values({ userId: admin.id, roleId: role[0].id });
    getLogger().info("bootstrap admin created");
  }
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const pool = getDirectPool();
  try {
    await seedRbac();
    await seedAdmin();
  } finally {
    await pool.end();
  }
}