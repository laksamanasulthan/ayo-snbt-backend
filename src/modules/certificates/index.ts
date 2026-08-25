import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { certificatesService } from "./service.js";

export async function certificatesModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  app.get("/api/v1/certificates/mine", { preHandler: [authGuard] }, async (request, reply) => {
    const rows = await certificatesService.listMine(getUser(request).id);
    return reply.ok(rows);
  });
}
