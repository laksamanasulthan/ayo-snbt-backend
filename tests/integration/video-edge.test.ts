import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, insertLesson, insertVideo, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let adminToken: string;
let studentToken: string;
let outsiderToken: string;

describe("Video pipeline edge cases", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("v-edge-mentor@t.id", "V Mentor", "mentor");
    adminToken = await loginAs("v-edge-admin@t.id", "V Admin", "admin");
    studentToken = await loginAs("v-edge-student@t.id", "V Student", "student");
    outsiderToken = await loginAs("v-edge-outsider@t.id", "V Outsider", "student");
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Create + upload flow ─────────────────────────────────────────────
  it("creates a video (mentor) and rejects missing titles", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/videos",
      headers: authHeaders(mentorToken),
      payload: { title: "Materi Vektor" }
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.status).toBe("uploaded");
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/videos",
      headers: authHeaders(mentorToken),
      payload: {}
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects presign for unknown videos and unsupported content types", async () => {
    const ghost = await app.inject({
      method: "POST",
      url: "/api/v1/videos/00000000-0000-0000-0000-000000000000/upload-url",
      headers: authHeaders(mentorToken),
      payload: { contentType: "video/mp4" }
    });
    expect(ghost.statusCode).toBe(404);

    const videoId = await insertVideo();
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/upload-url",
      headers: authHeaders(mentorToken),
      payload: { contentType: "text/html" }
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("BAD_CONTENT_TYPE");
  });

  it("presigns an upload URL and maps extensions", async () => {
    const videoId = await insertVideo();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/upload-url",
      headers: authHeaders(mentorToken),
      payload: { contentType: "video/quicktime" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.key).toContain(".mov");
    expect(res.json().data.uploadUrl).toContain("http");
    const mp4 = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/upload-url",
      headers: authHeaders(mentorToken),
      payload: { contentType: "video/mp4" }
    });
    expect(mp4.json().data.key).toContain(".mp4");
  });

  it("confirming without a raw upload is a 400", async () => {
    const videoId = await insertVideo();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/confirm",
      headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/No raw file/i);
  });

  it("confirm upload is idempotent (alreadyQueued)", async () => {
    const videoId = await insertVideo({ rawKey: "videos/x/raw/input.mp4" });
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/confirm",
      headers: authHeaders(mentorToken)
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().data.status).toBe("processing");
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/videos/" + videoId + "/confirm",
      headers: authHeaders(mentorToken)
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().data.alreadyQueued).toBe(true);
  });

  it("getById returns 404 for unknown videos", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/00000000-0000-0000-0000-000000000000",
      headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Streaming gates ──────────────────────────────────────────────────
  it("blocks streaming a video that is not ready (VIDEO_NOT_READY)", async () => {
    const videoId = await insertVideo({ status: "processing", rawKey: "k", hlsPrefix: "videos/x/hls" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/master.m3u8",
      headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VIDEO_NOT_READY");
  });

  it("blocks streaming a deleted video (404)", async () => {
    const videoId = await insertVideo({ status: "ready", deletedAt: new Date().toISOString(), hlsPrefix: "v/x", masterPlaylistKey: "v/x/master.m3u8" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/master.m3u8",
      headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires enrollment for paid-lesson videos", async () => {
    const mentorId = await userIdByEmail("v-edge-mentor@t.id");
    // Free course: enrollment is direct (paid courses would need an order)
    const course = await insertCourse({ title: "Stream Gate", mentorId, priceCents: 0, status: "published" });
    const videoId = await insertVideo({ status: "ready", hlsPrefix: "v/" + course.id, masterPlaylistKey: "v/" + course.id + "/master.m3u8" });
    await insertLesson({ courseId: course.id, videoId });
    // Unenrolled student → 403
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/master.m3u8",
      headers: authHeaders(outsiderToken)
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("ENROLLMENT_REQUIRED");
    // Enrolled → 307 to presigned S3
    const enrollRes = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + course.id + "/enroll",
      headers: authHeaders(studentToken)
    });
    expect(enrollRes.statusCode).toBe(200);
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/master.m3u8",
      headers: authHeaders(studentToken)
    });
    expect(ok.statusCode).toBe(307);
    expect(ok.headers.location).toContain("http");
  });

  it("free lessons stream without enrollment; owner streams paid ones", async () => {
    const mentorId = await userIdByEmail("v-edge-mentor@t.id");
    // Free lesson
    const freeCourse = await insertCourse({ title: "Free Stream", mentorId, status: "published" });
    const freeVideo = await insertVideo({ status: "ready", hlsPrefix: "v/free", masterPlaylistKey: "v/free/master.m3u8" });
    await insertLesson({ courseId: freeCourse.id, videoId: freeVideo, isFree: true });
    const free = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + freeVideo + "/master.m3u8",
      headers: authHeaders(outsiderToken)
    });
    expect(free.statusCode).toBe(307);
    // Owner of the paid course streams without enrollment
    const paidCourse = await insertCourse({ title: "Paid Stream 2", mentorId, priceCents: 1000, status: "published" });
    const paidVideo = await insertVideo({ status: "ready", hlsPrefix: "v/paid", masterPlaylistKey: "v/paid/master.m3u8" });
    await insertLesson({ courseId: paidCourse.id, videoId: paidVideo });
    const owner = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + paidVideo + "/master.m3u8",
      headers: authHeaders(mentorToken)
    });
    expect(owner.statusCode).toBe(307);
    // Admin too
    const admin = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + paidVideo + "/master.m3u8",
      headers: authHeaders(adminToken)
    });
    expect(admin.statusCode).toBe(307);
  });

  it("blocks a video not attached to any lesson for students", async () => {
    const videoId = await insertVideo({ status: "ready", hlsPrefix: "v/orphan", masterPlaylistKey: "v/orphan/master.m3u8" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/master.m3u8",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Segments ─────────────────────────────────────────────────────────
  it("rejects path traversal in segment requests", async () => {
    const mentorId = await userIdByEmail("v-edge-mentor@t.id");
    const course = await insertCourse({ title: "Seg Course", mentorId, status: "published" });
    const videoId = await insertVideo({ status: "ready", hlsPrefix: "v/seg", masterPlaylistKey: "v/seg/master.m3u8" });
    await insertLesson({ courseId: course.id, videoId, isFree: true });
    // Paths that fail the whitelist regex (BAD_SEGMENT_PATH) — all must be 4xx.
    // NOTE: "file.ts?x=1" is NOT evil — the query string never enters the path
    // wildcard param, so the segment is just "file.ts" (a safe path).
    const evilPaths = ["evil.exe", "a b.ts", "seg.ts/"];
    for (const path of evilPaths) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/videos/" + videoId + "/segments/" + path,
        headers: authHeaders(studentToken)
      });
      expect(res.statusCode, path).toBe(400);
      expect(res.json().error.code, path).toBe("BAD_SEGMENT_PATH");
    }
    // Traversal paths: either rejected (400), unroutable (404), or URL-
    // normalized to a SAFE subpath (307) — the critical properties are:
    //  1. never a 200 (no content is ever served directly)
    //  2. never a 500
    //  3. when redirected, the key stays UNDER the video's hlsPrefix
    const traversal = ["../secret.txt", "a/../b.ts", "..%2F..%2Fetc%2Fpasswd", "....//x.ts", "a/b.ts/../x.ts"];
    for (const path of traversal) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/videos/" + videoId + "/segments/" + path,
        headers: authHeaders(studentToken)
      });
      expect(res.statusCode, path).not.toBe(200);
      expect(res.statusCode, path).not.toBe(500);
      if (res.statusCode === 307) {
        // Redirect target must still live under the video's HLS prefix
        expect(res.headers.location, path).toContain("v/seg/");
      } else {
        expect([400, 404], path).toContain(res.statusCode);
      }
    }
  });

  it("streams a safe segment path", async () => {
    const mentorId = await userIdByEmail("v-edge-mentor@t.id");
    const course = await insertCourse({ title: "Seg Course 2", mentorId, status: "published" });
    const videoId = await insertVideo({ status: "ready", hlsPrefix: "v/seg2", masterPlaylistKey: "v/seg2/master.m3u8" });
    await insertLesson({ courseId: course.id, videoId, isFree: true });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/segments/720p/seg-0001.ts",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toContain("v/seg2/720p/seg-0001.ts");
  });

  it("rejects segments when the video has no HLS output", async () => {
    const videoId = await insertVideo({ status: "ready" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/videos/" + videoId + "/segments/720p/seg-1.ts",
      headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VIDEO_NOT_READY");
  });
});
