import { eq, and } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { videos, lessons, courses, courseEnrollments } from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError, ForbiddenError } from "../../shared/http/errors.js";
import { presignPut, presignGet } from "../../shared/s3/client.js";
import { getEnv } from "../../config/index.js";
import { QueueName, enqueue } from "../../shared/queue/queues.js";

export const videoService = {
  /** Create a video record (upload intent). */
  async create(userId: string, input: { title: string; originalName?: string }) {
    const db = getDb();
    const [row] = await db.insert(videos).values({ title: input.title, status: "uploaded" }).returning();
    if (!row) throw new BadRequestError("Failed to create video");
    return row;
  },

  /** Presign a PUT URL for the raw file upload (client uploads directly). */
  async presignUpload(videoId: string, contentType: string) {
    const db = getDb();
    const video = await db.select({ id: videos.id, status: videos.status }).from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!video[0]) throw new NotFoundError("Video not found");
    if (video[0].status !== "uploaded") throw new BadRequestError("Video already uploaded or processing");
    const allowed = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];
    if (!allowed.includes(contentType)) throw new BadRequestError("Unsupported video content type", "BAD_CONTENT_TYPE");
    const ext = contentType.split("/")[1] === "quicktime" ? "mov" : contentType.split("/")[1] === "x-matroska" ? "mkv" : contentType.split("/")[1];
    const key = "videos/" + videoId + "/raw/input." + ext;
    const uploadUrl = await presignPut(key, contentType, getEnv().S3_BUCKET_VIDEOS);
    await db.update(videos).set({ rawKey: key }).where(eq(videos.id, videoId));
    return { uploadUrl, key };
  },

  /** Confirm raw upload and enqueue the transcode job. */
  async confirmUpload(videoId: string) {
    const db = getDb();
    const video = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!video[0]) throw new NotFoundError("Video not found");
    if (!video[0].rawKey) throw new BadRequestError("No raw file uploaded yet");
    if (video[0].status === "processing") return { status: "processing", alreadyQueued: true };
    await db.update(videos).set({ status: "processing", error: null, updatedAt: new Date() }).where(eq(videos.id, videoId));
    await enqueue(QueueName.Transcode, { videoId, rawKey: video[0].rawKey }, { jobId: "transcode-" + videoId });
    return { status: "processing", alreadyQueued: false };
  },

  async getById(videoId: string) {
    const db = getDb();
    const row = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!row[0]) throw new NotFoundError("Video not found");
    return row[0];
  },

  /**
   * Streaming gate: user must be enrolled in a course using this video,
   * or be the course owner / admin. Free lessons are exempt.
   */
  async assertCanStream(userId: string, videoId: string, userRoles: string[]) {
    const db = getDb();
    const video = await db.select({ id: videos.id, status: videos.status }).from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!video[0]) throw new NotFoundError("Video not found");
    if (video[0].status !== "ready") throw new BadRequestError("Video is not ready yet", "VIDEO_NOT_READY");
    const lessonRows = await db.select({ id: lessons.id, courseId: lessons.courseId, isFree: lessons.isFree }).from(lessons).where(eq(lessons.videoId, videoId));
    // Not attached to any lesson → only admin/mentor may stream (draft preview)
    if (lessonRows.length === 0) {
      if (userRoles.includes("admin") || userRoles.includes("mentor")) return;
      throw new ForbiddenError("Video is not published in a lesson yet");
    }
    for (const lesson of lessonRows) {
      if (lesson.isFree) return; // free lessons are open
      const course = await db.select({ id: courses.id, mentorId: courses.mentorId }).from(courses).where(eq(courses.id, lesson.courseId)).limit(1);
      const c = course[0];
      if (!c) continue;
      if (userRoles.includes("admin") || c.mentorId === userId) return;
      const enrollment = await db.select({ id: courseEnrollments.id }).from(courseEnrollments).where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.courseId, c.id))).limit(1);
      if (enrollment[0]) return;
    }
    throw new ForbiddenError("Enrollment required to stream this video", "ENROLLMENT_REQUIRED");
  },

  /** Presigned GET for the master playlist (307 redirect target). */
  async streamMasterPlaylist(videoId: string) {
    const db = getDb();
    const video = await db.select({ id: videos.id, masterPlaylistKey: videos.masterPlaylistKey }).from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!video[0]?.masterPlaylistKey) throw new BadRequestError("Video has no master playlist", "VIDEO_NOT_READY");
    const url = await presignGet(video[0].masterPlaylistKey, getEnv().S3_BUCKET_VIDEOS);
    return url;
  },

  /** Presigned GET for an HLS segment (307 redirect target). */
  async streamSegment(videoId: string, filePath: string) {
    const db = getDb();
    const video = await db.select({ id: videos.id, hlsPrefix: videos.hlsPrefix }).from(videos).where(eq(videos.id, videoId)).limit(1);
    if (!video[0]?.hlsPrefix) throw new BadRequestError("Video has no HLS output", "VIDEO_NOT_READY");
    // Path traversal guard: only allow safe relative paths under hlsPrefix
    if (!/^[a-zA-Z0-9_/-]+\.(ts|m3u8|m4s|mp4)$/.test(filePath)) throw new BadRequestError("Invalid segment path", "BAD_SEGMENT_PATH");
    const key = video[0].hlsPrefix + "/" + filePath;
    const url = await presignGet(key, getEnv().S3_BUCKET_VIDEOS);
    return url;
  }
};