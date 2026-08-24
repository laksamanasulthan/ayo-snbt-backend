const base = "http://localhost:3000";
const db = await import("pg").then(p => new p.default.Pool({ connectionString: "postgres://ayosnbt:ayosnbt@localhost:5433/ayosnbt" }));
const sah = (t: string) => ({ cookie: "access_token=" + t + "; csrf_token=c", "x-csrf-token": "c" });

const adminEmail = "live-admin-" + Date.now() + "@t.id";
const admin = await db.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id", [adminEmail, "ignored", "Admin", "active"]);
const aid = admin.rows[0].id;
const role = await db.query("SELECT id FROM roles WHERE name = $1", ["admin"]);
await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [aid, role.rows[0].id]);
const { issueAccessToken } = await import("../dist/modules/auth/index.js");
const token = await issueAccessToken(aid, adminEmail);
console.log("TOKEN:", token.slice(0, 20) + "...");

// 1. Create course
let res = await fetch(base + "/api/v1/courses", { method: "POST", headers: { ...sah(token), "content-type": "application/json" }, body: JSON.stringify({ title: "TPS Kuantitatif", description: "Persiapan TPS", category: "TPS", level: "intermediate" }) });
const cid = (await res.json()).data.id;
console.log("COURSE:", res.status, cid);

// 2. Publish
res = await fetch(base + "/api/v1/courses/" + cid + "/publish", { method: "POST", headers: sah(token) });
console.log("PUBLISH:", res.status);

// 3. Create video
res = await fetch(base + "/api/v1/videos", { method: "POST", headers: { ...sah(token), "content-type": "application/json" }, body: JSON.stringify({ title: "Test Video", originalName: "test.mp4" }) });
const vid = (await res.json()).data.id;
console.log("VIDEO:", res.status, vid);

// 4. Presign upload URL
res = await fetch(base + "/api/v1/videos/" + vid + "/upload-url", { method: "POST", headers: { ...sah(token), "content-type": "application/json" }, body: JSON.stringify({ contentType: "video/mp4" }) });
const uploadUrl = (await res.json()).data.uploadUrl;
console.log("UPLOAD URL:", uploadUrl.slice(0, 60) + "...");

// 5. Generate test video + upload via presigned URL
const { execFileSync } = await import("node:child_process");
const ffmpeg = (await import("ffmpeg-static")).default;
execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240", "-c:v", "libx264", "-preset", "ultrafast", "live-test.mp4"], { timeout: 30000 });
const { createReadStream, statSync } = await import("node:fs");
const upRes = await fetch(uploadUrl, { method: "PUT", body: createReadStream("live-test.mp4"), duplex: "half", headers: { "content-type": "video/mp4", "content-length": String(statSync("live-test.mp4").size) } });
console.log("UPLOAD:", upRes.ok ? "OK" : "FAILED " + upRes.status);

// 6. Confirm → BullMQ transcode job enqueued
res = await fetch(base + "/api/v1/videos/" + vid + "/confirm", { method: "POST", headers: sah(token) });
console.log("CONFIRM:", res.status, JSON.stringify(await res.json()));

// 7. Wait for transcode to complete (worker processes via BullMQ)
let status = "processing";
for (let i = 0; i < 20 && status === "processing"; i++) {
  await new Promise(r => setTimeout(r, 2000));
  res = await fetch(base + "/api/v1/videos/" + vid, { headers: { cookie: "access_token=" + token } });
  status = (await res.json()).data.status;
  if (i % 5 === 4) console.log("WAITING...", status);
}
console.log("TRANSCODE:", status);

// 8. Add lesson + stream
res = await fetch(base + "/api/v1/courses/" + cid + "/lessons", { method: "POST", headers: { ...sah(token), "content-type": "application/json" }, body: JSON.stringify({ title: "Lesson 1", videoId: vid }) });
console.log("LESSON:", res.status);

// 9. Stream master playlist → 307 redirect
res = await fetch(base + "/api/v1/videos/" + vid + "/master.m3u8", { headers: { cookie: "access_token=" + token } });
console.log("STREAM:", res.status, "→", (res.headers.get("location") ?? "").slice(0, 80));
if (res.status === 307) {
  const loc = res.headers.get("location")!;
  const streamRes = await fetch(loc);
  console.log("HLS CONTENT:", streamRes.ok ? "OK (" + (await streamRes.text()).slice(0, 40) + "...)" : "FAIL " + streamRes.status);
}

// 10. Cleanup
await import("node:fs/promises").then(fs => fs.rm("live-test.mp4", { force: true }).catch(() => {}));
await db.end();
console.log("LIVE FLOW DONE");
process.exit(0);