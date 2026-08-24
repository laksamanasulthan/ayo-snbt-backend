import { randomUUID } from "node:crypto";
import { getChatDb } from "../../shared/mongo/client.js";
import { COLLECTIONS, nextRoomSeq, type ChatRoomDoc, type ChatMessageDoc } from "./mongo.js";
import { BadRequestError, NotFoundError, ForbiddenError } from "../../shared/http/errors.js";
import { coursesService } from "../courses/index.js";

export const chatService = {
  // ── Rooms ───────────────────────────────────────────────────────────
  async createRoom(user: { id: string; name: string; roles: string[] }, input: { type: string; name?: string; courseId?: string; mentorId?: string; memberIds?: string[] }) {
    const db = getChatDb();
    const rooms = db.collection<ChatRoomDoc>(COLLECTIONS.rooms);
    const isMentor = user.roles.includes("mentor");
    const isAdmin = user.roles.includes("admin");

    if (input.type === "course") {
      if (!input.courseId) throw new BadRequestError("courseId is required for course rooms");
      // Only mentors/admins create course rooms; students join via enroll+join
      if (!isMentor && !isAdmin) throw new ForbiddenError("Only mentors can create course chats");
      const existing = await rooms.findOne({ courseId: input.courseId });
      if (existing) return existing;
      const course = await coursesService.getById(input.courseId);
      const [room] = await Promise.all([
        rooms.insertOne({
          _id: randomUUID(),
          type: "course",
          name: input.name ?? "Diskusi " + course.title,
          courseId: input.courseId,
          memberIds: [user.id],
          unreadCounts: {},
          lastSeq: 0,
          lastMessageAt: null,
          createdAt: new Date()
        }),
      ]);
      return rooms.findOne({ _id: room.insertedId });
    }

    if (input.type === "mentor") {
      if (!input.mentorId) throw new BadRequestError("mentorId is required for mentor rooms");
      const ids = [user.id, input.mentorId].sort();
      const key = "1:1:" + ids.join(":");
      const existing = await rooms.findOne({ _id: key });
      if (existing) return existing;
      const [room] = await Promise.all([
        rooms.insertOne({
          _id: key,
          type: "mentor",
          name: input.name ?? "Chat dengan Mentor",
          mentorId: input.mentorId,
          memberIds: ids,
          unreadCounts: {},
          lastSeq: 0,
          lastMessageAt: null,
          createdAt: new Date()
        }),
      ]);
      return rooms.findOne({ _id: room.insertedId });
    }

    if (input.type === "group") {
      const members = [...new Set([user.id, ...(input.memberIds ?? [])])];
      const [room] = await Promise.all([
        rooms.insertOne({
          _id: randomUUID(),
          type: "group",
          name: input.name ?? "Grup Belajar",
          memberIds: members,
          unreadCounts: {},
          lastSeq: 0,
          lastMessageAt: null,
          createdAt: new Date()
        }),
      ]);
      return rooms.findOne({ _id: room.insertedId });
    }

    throw new BadRequestError("Unknown room type");
  },

  async getRoom(roomId: string) {
    const db = getChatDb();
    const room = await db.collection<ChatRoomDoc>(COLLECTIONS.rooms).findOne({ _id: roomId });
    if (!room) throw new NotFoundError("Room not found");
    return room;
  },

  /**
   * Membership check: course → enrolled (or mentor/admin), mentor → 1:1 participants,
   * group → member list.
   */
  async assertMember(user: { id: string; roles: string[] }, room: ChatRoomDoc): Promise<void> {
    if (room.memberIds.includes(user.id)) return;
    if (room.type === "course") {
      if (user.roles.includes("admin") || user.roles.includes("mentor")) return;
      if (room.courseId) {
        const enrolled = await coursesService.isEnrolled(user.id, room.courseId);
        if (enrolled) return;
      }
    }
    throw new ForbiddenError("You are not a member of this room", "NOT_ROOM_MEMBER");
  },

  async addMember(roomId: string, userId: string, byUser: { id: string; roles: string[] }): Promise<void> {
    const db = getChatDb();
    const room = await this.getRoom(roomId);
    if (room.type === "course" && !byUser.roles.includes("admin") && !byUser.roles.includes("mentor")) {
      throw new ForbiddenError("Only mentors can add members to course rooms");
    }
    await db.collection<ChatRoomDoc>(COLLECTIONS.rooms).updateOne({ _id: roomId }, { $addToSet: { memberIds: userId } });
  },

  async listMyRooms(userId: string, limit = 50) {
    const db = getChatDb();
    const rooms = await db
      .collection<ChatRoomDoc>(COLLECTIONS.rooms)
      .find({ memberIds: userId })
      .sort({ lastMessageAt: -1 })
      .limit(limit)
      .toArray();
    return rooms.map((r) => ({
      id: r._id,
      type: r.type,
      name: r.name,
      unreadCount: r.unreadCounts?.[userId] ?? 0,
      lastMessageAt: r.lastMessageAt,
    }));
  },

  // ── Messages ────────────────────────────────────────────────────────
  async history(roomId: string, beforeSeq?: number, limit = 50) {
    const db = getChatDb();
    const filter: { roomId: string; seq?: { $lt: number } } = { roomId };
    if (beforeSeq) filter.seq = { $lt: beforeSeq };
    const rows = await db
      .collection<ChatMessageDoc>(COLLECTIONS.messages)
      .find(filter)
      .sort({ seq: -1 })
      .limit(Math.min(limit, 100))
      .toArray();
    return rows.reverse();
  },

  async persistMessage(input: { roomId: string; senderId: string; senderName: string; body: string }) {
    const db = getChatDb();
    const room = await this.getRoom(input.roomId);
    const seq = await nextRoomSeq(input.roomId);
    const message: ChatMessageDoc = {
      _id: randomUUID(),
      roomId: input.roomId,
      senderId: input.senderId,
      senderName: input.senderName,
      type: "text",
      body: input.body.slice(0, 2000),
      seq,
      createdAt: new Date()
    };
    await db.collection<ChatMessageDoc>(COLLECTIONS.messages).insertOne(message);
    // Room metadata + unread counters (all members except sender)
    const unreadIncs: Record<string, number> = {};
    for (const memberId of room.memberIds) {
      if (memberId !== input.senderId) unreadIncs["unreadCounts." + memberId] = 1;
    }
    await db.collection<ChatRoomDoc>(COLLECTIONS.rooms).updateOne({ _id: input.roomId }, {
      $set: { lastMessageAt: message.createdAt },
      ...(Object.keys(unreadIncs).length ? { $inc: unreadIncs } : {}),
    });
    return message;
  },

  async markRead(userId: string, roomId: string): Promise<void> {
    const db = getChatDb();
    await this.getRoom(roomId);
    await db
      .collection<ChatRoomDoc>(COLLECTIONS.rooms)
      .updateOne({ _id: roomId }, { $set: { ["unreadCounts." + userId]: 0 } });
  },
};
