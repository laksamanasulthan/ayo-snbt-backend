const base = "http://localhost:3000";
const db = await import("pg").then(p => new p.default.Pool({ connectionString: "postgres://ayosnbt:ayosnbt@localhost:5433/ayosnbt" }));
const { issueAccessToken } = await import("../dist/modules/auth/index.js");
async function mkUser(email: string, role: string): Promise<string> {
  const u = await db.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (email) DO NOTHING RETURNING id", [email, "x", email.split("@")[0], "active"]);
  if (!u.rows[0]) { const ex = await db.query("SELECT id FROM users WHERE email = $1", [email]); u.rows[0] = ex.rows[0]; }
  const uid = u.rows[0].id;
  const r = await db.query("SELECT id FROM roles WHERE name = $1", [role]);
  if (r.rows[0]) await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [uid, r.rows[0].id]);
  return issueAccessToken(uid, email);
}
const h = (t: string) => ({ cookie: "access_token=" + t + "; csrf_token=c", "x-csrf-token": "c" });
const g = (t: string) => ({ cookie: "access_token=" + t });

const mentor = await mkUser("pay-mentor@t.id", "mentor");
const student = await mkUser("pay-student-live@t.id", "student");

// 1. Create a PAID course (Rp 150.000) + publish
let res = await fetch(base + "/api/v1/courses", { method: "POST", headers: { ...h(mentor), "content-type": "application/json" }, body: JSON.stringify({ title: "Bimbel SNBT Intensif", description: "Paket lengkap", category: "TPS", priceCents: 150000 }) });
const courseId = (await res.json()).data.id;
await fetch(base + "/api/v1/courses/" + courseId + "/publish", { method: "POST", headers: h(mentor) });
console.log("COURSE: created + published (Rp 150.000)");

// 2. Student creates an order
res = await fetch(base + "/api/v1/payments/orders", { method: "POST", headers: { ...h(student), "content-type": "application/json" }, body: JSON.stringify({ courseId }) });
const orderBody = await res.json();
const order = orderBody.data.order;
console.log("ORDER:", res.status, "status:", order.status, "| amount:", order.amountCents, "| url:", order.paymentUrl.slice(0, 60) + "...");

// 3. Student cannot access course content yet (no enrollment)
res = await fetch(base + "/api/v1/courses/" + courseId + "/enroll", { method: "POST", headers: h(student) });
console.log("ENROLL BEFORE PAYMENT:", res.status, (await res.json()).error?.code ?? "");

// 4. Simulate payment via the mock provider URL
res = await fetch(order.paymentUrl, { method: "POST" });
console.log("MOCK PAY:", res.status, JSON.stringify((await res.json()).data ?? {}));

// 5. Worker fulfills: enrollment + receipt email (async via BullMQ)
let orderStatus = "";
for (let i = 0; i < 10 && orderStatus !== "fulfilled"; i++) {
  await new Promise(r => setTimeout(r, 1000));
  res = await fetch(base + "/api/v1/payments/orders/" + order.id, { headers: g(student) });
  orderStatus = (await res.json()).data.status;
}
console.log("ORDER STATUS:", orderStatus);

// 6. Check enrollment + course access
res = await fetch(base + "/api/v1/courses/" + courseId + "/enroll", { method: "POST", headers: h(student) });
console.log("ENROLL AFTER PAYMENT:", res.status, JSON.stringify((await res.json()).data ?? {}));

// 7. Check receipt email in Mailpit
await new Promise(r => setTimeout(r, 1500));
const mres = await fetch("http://localhost:8025/api/v1/messages?limit=5");
const msgs = (await mres.json()).messages as { ID: string; To: { Address: string }[]; Subject: string }[];
const receipt = msgs.find(m => m.To[0]?.Address === "pay-student-live@t.id");
console.log("RECEIPT EMAIL:", receipt ? "✓ " + receipt.Subject : "NOT FOUND");

// 8. Duplicate webhook (idempotency)
res = await fetch(order.paymentUrl, { method: "POST" });
const dup = await res.json();
console.log("DUPLICATE WEBHOOK:", "processed=" + dup.data.processed, "(should be false)");

await db.end();
console.log("LIVE PAYMENT FLOW DONE");
process.exit(0);