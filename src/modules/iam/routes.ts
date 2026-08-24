import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { roles, permissions, userRoles } from "../../shared/db/schema/index.js";
import { authGuard, requirePermission, csrfGuard } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { NotFoundError } from "../../shared/http/errors.js";

export async function iamModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);
  const adminGuard = [authGuard, requirePermission(Permissions.IAM_MANAGE)];

  // ── List roles ───────────────────────────────────────────────────────
  app.get("/api/v1/iam/roles", { preHandler: adminGuard }, async (_request, reply) => {
    const db = getDb();
    const rows = await db.select().from(roles);
    return reply.ok(rows);
  });

  // ── List permissions ─────────────────────────────────────────────────
  app.get("/api/v1/iam/permissions", { preHandler: adminGuard }, async (_request, reply) => {
    const db = getDb();
    const rows = await db.select().from(permissions);
    return reply.ok(rows);
  });

  // ── Assign role to user ──────────────────────────────────────────────
  app.post("/api/v1/iam/users/:userId/roles", {
    preHandler: adminGuard,
    schema: {
      params: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
      body: { type: "object", required: ["roleId"], properties: { roleId: { type: "string" } } }
    }
  }, async (request, reply) => {
    const db = getDb();
    const { userId } = request.params as { userId: string };
    const { roleId } = request.body as { roleId: string };
    const role = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role[0]) throw new NotFoundError("Role not found");
    await db.insert(userRoles).values({ userId, roleId }).onConflictDoNothing();
    return reply.created({ assigned: true });
  });
}