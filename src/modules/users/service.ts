import { and, eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { userRepo } from "./repository.js";
import { users, follows } from "../../shared/db/schema/index.js";
import { NotFoundError, ConflictError, BadRequestError } from "../../shared/http/errors.js";
import { presignPut } from "../../shared/s3/client.js";
import { getEnv } from "../../config/index.js";
import { randomUUID } from "node:crypto";

export const usersService = {
  async getProfile(userId: string) {
    const row = await userRepo.findActiveById(userId);
    const user = row[0];
    if (!user) throw new NotFoundError("User not found");
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt
    };
  },

  /** A7: follow another user (idempotent, cannot follow yourself). */
  async follow(userId: string, followeeId: string) {
    if (userId === followeeId) throw new BadRequestError("Cannot follow yourself", "VALIDATION_ERROR");
    const target = await userRepo.findActiveById(followeeId);
    if (!target[0]) throw new NotFoundError("User not found");
    await getDb().insert(follows).values({ followerId: userId, followeeId }).onConflictDoNothing();
    return { following: true };
  },

  /** A7: unfollow (idempotent). */
  async unfollow(userId: string, followeeId: string) {
    await getDb().delete(follows).where(and(eq(follows.followerId, userId), eq(follows.followeeId, followeeId)));
    return { following: false };
  },

  /** A7: users I follow (ids + names). */
  async listFollowing(userId: string) {
    const rows = await getDb()
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followeeId))
      .where(eq(follows.followerId, userId));
    return rows;
  },

  /** A7: is userId following followeeId? (single check) */
  async isFollowing(userId: string, followeeId: string): Promise<boolean> {
    const rows = await getDb()
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(and(eq(follows.followerId, userId), eq(follows.followeeId, followeeId)))
      .limit(1);
    return rows.length > 0;
  },

  async updateProfile(userId: string, input: { name?: string }) {
    const db = getDb();
    const row = await db
      .update(users)
      .set({ ...(input.name ? { name: input.name } : {}), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl });
    const user = row[0];
    if (!user) throw new NotFoundError("User not found");
    return user;
  },

  /** Presign an S3 PUT for the user's avatar (client uploads directly). */
  async presignAvatar(userId: string, contentType: string): Promise<{ uploadUrl: string; key: string }> {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(contentType)) throw new ConflictError("Unsupported avatar content type", "BAD_CONTENT_TYPE");
    const ext = contentType.split("/")[1];
    const key = "avatars/" + userId + "/" + randomUUID() + "." + ext;
    const uploadUrl = await presignPut(key, contentType, getEnv().S3_BUCKET_IMAGES);
    return { uploadUrl, key };
  },

  async updateAvatarUrl(userId: string, key: string): Promise<void> {
    const db = getDb();
    await db.update(users).set({ avatarUrl: key, updatedAt: new Date() }).where(eq(users.id, userId));
  }
};