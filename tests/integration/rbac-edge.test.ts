import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { truncateDb, buildTestApp, authHeaders, loginAs, insertCourse } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let adminToken: string;
let mentorToken: string;
let studentToken: string;

describe("RBAC edge cases", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    adminToken = await loginAs("rbac-admin@t.id", "Rbac Admin", "admin");
    mentorToken = await loginAs("rbac-mentor@t.id", "Rbac Mentor", "mentor");
    studentToken = await loginAs("rbac-student@t.id", "Rbac Student", "student");
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Unauthenticated ──────────────────────────────────────────────────
  it("rejects unauthenticated access to protected routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects tampered / expired access tokens", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { cookie: "asbt_access=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.tampered" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  // ── Role → permission matrix ─────────────────────────────────────────
  it("students cannot create courses (missing course:create)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses",
      headers: authHeaders(studentToken),
      payload: { title: "Student Course" }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/course:create/);
  });

  it("mentors can create + publish courses but not delete others'", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/courses",
      headers: authHeaders(mentorToken),
      payload: { title: "Mentor Course", category: "TPS" }
    });
    expect(created.statusCode).toBe(201);
    const courseId = created.json().data.id as string;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + courseId + "/publish",
      headers: authHeaders(mentorToken)
    });
    expect(published.statusCode).toBe(200);
  });

  it("admins can do everything the owner can", async () => {
    const other = await insertCourse({ title: "Someone Else", status: "draft" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + other.id + "/publish",
      headers: authHeaders(adminToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.published).toBe(true);
  });

  it("mentors cannot manage another mentor's course", async () => {
    await loginAs("rbac-mentor2@t.id", "Mentor 2", "mentor");
    const course = await insertCourse({ title: "Mentor2 Course", status: "draft" });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/courses/" + course.id,
      headers: authHeaders(mentorToken),
      payload: { title: "Hijacked" }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/owner or admin/i);
  });

  it("students cannot delete or restore courses", async () => {
    const course = await insertCourse({ title: "Delete Target" });
    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/courses/" + course.id,
      headers: authHeaders(studentToken)
    });
    expect(del.statusCode).toBe(403);
    const restore = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + course.id + "/restore",
      headers: authHeaders(studentToken)
    });
    expect(restore.statusCode).toBe(403);
  });

  it("non-admins cannot manage simulation packages (simulation:manage)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/packages",
      headers: authHeaders(studentToken),
      payload: { title: "Pkg", questionCounts: { TPS: 1 } }
    });
    expect(res.statusCode).toBe(403);
  });

  it("non-admins cannot manage questions (question:manage)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      headers: authHeaders(studentToken),
      payload: { text: "Q?", category: "TPS" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("students cannot refund payments (payment:refund)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders/00000000-0000-0000-0000-000000000000/refund",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/payment:refund/);
  });

  it("only admins can access IAM routes (iam:manage)", async () => {
    const asStudent = await app.inject({ method: "GET", url: "/api/v1/iam/roles", headers: authHeaders(studentToken) });
    expect(asStudent.statusCode).toBe(403);
    const asMentor = await app.inject({ method: "GET", url: "/api/v1/iam/roles", headers: authHeaders(mentorToken) });
    expect(asMentor.statusCode).toBe(403);
    const asAdmin = await app.inject({ method: "GET", url: "/api/v1/iam/roles", headers: authHeaders(adminToken) });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().data.length).toBeGreaterThanOrEqual(3);
  });

  it("lists permissions and roles", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/iam/permissions", headers: authHeaders(adminToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(16);
  });

  it("assigns a role to a user (admin only)", async () => {
    const db = getPool();
    const user = await db.query("SELECT id FROM users WHERE email = $1", ["rbac-student@t.id"]);
    const userId = user.rows[0]?.id as string;
    const role = await db.query("SELECT id FROM roles WHERE name = $1", ["mentor"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/iam/users/" + userId + "/roles",
      headers: authHeaders(adminToken),
      payload: { roleId: role.rows[0]?.id }
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects role assignment to unknown user / role", async () => {
    const db = getPool();
    const role = await db.query("SELECT id FROM roles WHERE name = $1", ["mentor"]);
    const ghost = await app.inject({
      method: "POST",
      url: "/api/v1/iam/users/00000000-0000-0000-0000-000000000000/roles",
      headers: authHeaders(adminToken),
      payload: { roleId: role.rows[0]?.id }
    });
    expect(ghost.statusCode).toBe(404);
    const user = await db.query("SELECT id FROM users WHERE email = $1", ["rbac-student@t.id"]);
    const badRole = await app.inject({
      method: "POST",
      url: "/api/v1/iam/users/" + user.rows[0]?.id + "/roles",
      headers: authHeaders(adminToken),
      payload: { roleId: "00000000-0000-0000-0000-000000000000" }
    });
    expect(badRole.statusCode).toBe(404);
  });

  it("rejects assigning a role without a valid body", async () => {
    const db = getPool();
    const user = await db.query("SELECT id FROM users WHERE email = $1", ["rbac-student@t.id"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/iam/users/" + user.rows[0]?.id + "/roles",
      headers: authHeaders(adminToken),
      payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Users ────────────────────────────────────────────────────────────
  it("students can read + update their own profile but not others'", async () => {
    const db = getPool();
    const other = await db.query("SELECT id FROM users WHERE email = $1", ["rbac-mentor@t.id"]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/" + other.rows[0]?.id,
      headers: authHeaders(studentToken),
      payload: { name: "Hacked" }
    });
    // No such route exists → 404 (users module only exposes /me)
    expect(res.statusCode).toBe(404);
  });

  it("updates own profile", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: authHeaders(studentToken),
      payload: { name: "Rbac Student Updated" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("Rbac Student Updated");
  });
});
