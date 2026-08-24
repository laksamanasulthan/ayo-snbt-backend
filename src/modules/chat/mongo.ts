import { getChatDb } from "../../shared/mongo/client.js";

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

/** Ensure collections + indexes (idempotent, called at module boot). */
export async function ensureChatIndexes(): Promise<void> {
  const db = getChatDb();
  const rooms = db.collection<ChatRoomDoc>(COLLECTIONS.rooms);
  const messages = db.collection<ChatMessageDoc>(COLLECTIONS.messages);
  await Promise.all([
    // messages: paginate by (roomId, seq desc); unique seq per room
    messages.createIndex({ roomId: 1, seq: -1 }),
    messages.createIndex({ roomId: 1, seq: 1 }, { unique: true }),
    // rooms: one chat per course (partial index on course rooms)
    rooms.createIndex({ courseId: 1 }, { unique: true, partialFilterExpression: { type: "course" } }),
    rooms.createIndex({ memberIds: 1 }),
    rooms.createIndex({ lastMessageAt: -1 })
  ]);
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
