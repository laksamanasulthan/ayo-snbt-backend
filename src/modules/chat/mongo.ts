import { getChatDb, discardMongoClient } from "../../shared/mongo/client.js";
import { getLogger } from "../../shared/logger.js";

export const COLLECTIONS = {
  rooms: "chat_rooms",
  messages: "chat_messages"
} as const;

export interface ChatRoomDoc {
  _id: string; // uuid
  type: "course" | "mentor" | "group";
  name: string;
  courseId?: string;
  mentorId?: string;
  memberIds: string[];
  unreadCounts: Record<string, number>;
  lastSeq: number;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export interface ChatMessageDoc {
  _id: string; // uuid
  roomId: string;
  senderId: string;
  senderName: string;
  type: string;
  body: string;
  seq: number;
  createdAt: Date;
}

/**
 * Ensure collections + indexes (idempotent, called at module boot).
 * Resilient: when MongoDB is unreachable the app must still boot — chat
 * features degrade at use time instead.
 */
/**
 * Message retention (I1): messages older than this are purged by the
 * MongoDB TTL monitor. 90 days default; change via env if needed.
 */
export const MESSAGE_RETENTION_SECONDS = (Number(process.env.CHAT_RETENTION_DAYS ?? 90) || 90) * 24 * 3600;

export async function ensureChatIndexes(): Promise<void> {
  try {
    const db = getChatDb();
    const rooms = db.collection<ChatRoomDoc>(COLLECTIONS.rooms);
    const messages = db.collection<ChatMessageDoc>(COLLECTIONS.messages);
    await Promise.all([
      messages.createIndex({ roomId: 1, seq: -1 }),
      messages.createIndex({ roomId: 1, seq: 1 }, { unique: true }),
      // I1: TTL index — the Mongo monitor deletes docs where createdAt < now - retention.
      // Re-running with a different expireAfterSeconds updates it in place.
      messages.createIndex({ createdAt: 1 }, { expireAfterSeconds: MESSAGE_RETENTION_SECONDS }),
      rooms.createIndex({ courseId: 1 }, { unique: true, partialFilterExpression: { type: "course" } }),
      rooms.createIndex({ memberIds: 1 }),
      rooms.createIndex({ lastMessageAt: -1 })
    ]);
  } catch (err) {
    getLogger().warn({ err }, "chat indexes not created (MongoDB may be down)");
    discardMongoClient();
  }
}

/** Atomic per-room sequence allocation (server-side message ordering). */
export async function nextRoomSeq(roomId: string): Promise<number> {
  const db = getChatDb();
  const res = await db.collection<ChatRoomDoc>(COLLECTIONS.rooms).findOneAndUpdate(
    { _id: roomId },
    { $inc: { lastSeq: 1 } },
    { returnDocument: "after" }
  );
  return res?.lastSeq ?? 1;
}
