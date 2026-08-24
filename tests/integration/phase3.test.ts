import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { getPool } from "../../src/shared/db/client.js";
import { accessCookieName } from "../../src/shared/auth/index.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let mentorToken: string;
let studentToken: string;
let outsiderToken: string;
let courseId: string;
let videoId: string;

async function truncateDb() {
  const pool = getPool();
  await pool.query("TRUNCATE TABLE course_enrollments, lesson_progress, lessons, courses, videos, questions, question_options, user_roles, users RESTART IDENTITY CASCADE");
}

/** Auth + CSRF headers for mutating requests (double-submit token). */
function authHeaders(token: string): Record<string, string> {
  return { cookie: accessCookieName() + "=" + token + "; csrf_token=test-csrf", "x-csrf-token": "test-csrf" };
}

async function loginAs(email: string, name: string, role: string): Promise<string> {
  const db = getPool();
  const user = await db.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id", [email, "argon2test", name, "active"]);
  const userId = user.rows[0]?.id as string;
  const roleRow = await db.query("SELECT id FROM roles WHERE name = $1", [role]);
  if (roleRow.rows[0]) await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleRow.rows[0].id]);
  const { issueAccessToken } = await import("../../src/modules/auth/index.js");
  return issueAccessToken(userId, email);
}

describe("Phase 3: courses, questions, video pipeline", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildApp({ minimal: true, logger: false, degradation: new DegradationManager(), healthRegistry: new HealthRegistry() });
    await app.ready();
        mentorToken = await loginAs("mentor@c.id", "Mentor", "mentor");
    studentToken = await loginAs("student@c.id", "Student", "student");
    outsiderToken = await loginAs("outsider@c.id", "Outsider", "student");
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Courses ─────────────────────────────────────────────────────────
  it("creates a course (mentor)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses",
      headers: authHeaders(mentorToken),
      payload: { title: "SNBT TPS - Pengetahuan Kuantitatif", description: "Persiapan TPS PK", category: "TPS", level: "intermediate" }
    });
    expect(res.statusCode).toBe(201);
    courseId = res.json().data.id;
    expect(courseId).toBeTruthy();
  });

  it("publishes the course", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + courseId + "/publish",
      headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.published).toBe(true);
  });

  it("lists published courses (public)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it("enrolls a student", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + courseId + "/enroll",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.enrolled).toBe(true);
  });

  // ── Questions ───────────────────────────────────────────────────────
  it("creates a question with options (mentor)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      headers: authHeaders(mentorToken),
      payload: { text: "Berapa hasil dari 2 + 2?", category: "TPS_PK", difficulty: "easy", options: [{ text: "3", isCorrect: false }, { text: "4", isCorrect: true }, { text: "5", isCorrect: false }] }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.options.length).toBe(3);
  });

  it("lists questions (mentor)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/questions",
      headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks students from questions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/questions",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Video pipeline (end-to-end with real ffmpeg) ────────────────────
  it("creates a video record", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/videos",
      headers: authHeaders(mentorToken),
      payload: { title: "Test Video", originalName: "test.mp4" }
    });
    expect(res.statusCode).toBe(201);
    videoId = res.json().data.id;
  });

  it("presigns an upload URL, uploads, and confirms", async () => {
    // 1. Get presigned PUT
    const presign = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/upload-url",
      headers: authHeaders(mentorToken),
      payload: { contentType: "video/mp4" }
    });
    expect(presign.statusCode).toBe(200);
    const uploadUrl = presign.json().data.uploadUrl;
    expect(uploadUrl).toBeTruthy();

    // 2. Generate a tiny test video via ffmpeg
    const { execFileSync } = await import("node:child_process");
    const ffmpeg = (await import("ffmpeg-static")).default as unknown as string;
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240", "-c:v", "libx264", "-preset", "ultrafast", "test.mp4"], { timeout: 30000 });

    // 3. Upload directly to S3 via the presigned URL
    const { createReadStream } = await import("node:fs");
    const { statSync } = await import("node:fs");
    const uploadRes = await fetch(uploadUrl, { method: "PUT", body: createReadStream("test.mp4"), duplex: "half", headers: { "content-type": "video/mp4", "content-length": String(statSync("test.mp4").size) } });
    expect(uploadRes.ok).toBe(true);

    // 4. Confirm upload → enqueue transcode
    const confirm = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/confirm",
      headers: authHeaders(mentorToken)
    });
    expect(confirm.statusCode).toBe(202);
  });

  it("transcodes the video and reaches ready status", async () => {
    // Run the transcode processor directly (this is a unit test of the processor)
    const { processTranscodeJob } = await import("../../src/modules/video/index.js");
    const db = getPool();
    const video = await db.query("SELECT raw_key FROM videos WHERE id = $1", [videoId]);
    const rawKey = video.rows[0]?.raw_key as string;
    expect(rawKey).toBeTruthy();
    await processTranscodeJob({ videoId, rawKey });

    // Verify status is ready
    const updated = await db.query("SELECT status, master_playlist_key, hls_prefix, duration_seconds FROM videos WHERE id = $1", [videoId]);
    expect(updated.rows[0]?.status).toBe("ready");
    expect(updated.rows[0]?.master_playlist_key).toBeTruthy();
    expect(updated.rows[0]?.duration_seconds).toBe(3);
  });

  it("adds a lesson to the course", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + courseId + "/lessons",
      headers: authHeaders(mentorToken),
      payload: { title: "Pengenalan TPS", videoId, isFree: false }
    });
    expect(res.statusCode).toBe(201);
  });
  it("streams the master playlist via 307 redirect", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/master.m3u8",
      headers: { cookie: accessCookieName() + "=" + mentorToken, "x-csrf-token": "" }
    });
    // 307 redirect to presigned URL
    expect(res.statusCode).toBe(307);
    const location = res.headers.location;
    expect(location).toBeTruthy();
    // The presigned URL points to S3 (MinIO)
    expect(location).toContain("localhost:9000");
  });

  it("blocks unenrolled students from streaming", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/master.m3u8",
      headers: authHeaders(outsiderToken)
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ENROLLMENT_REQUIRED");
  });

  // ── Lessons & progress ──────────────────────────────────────────────

  it("records lesson progress", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/lessons/" + (await app.inject({ method: "GET", url: "/api/v1/courses/" + courseId })).json().data.lessons[0].id + "/progress",
      headers: authHeaders(studentToken),
      payload: { status: "completed", progressPercent: 100 }
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Cleanup tmp file ────────────────────────────────────────────────
  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm("test.mp4", { force: true }).catch(() => {});
  });
});