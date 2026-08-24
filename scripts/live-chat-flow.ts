import WebSocket from "ws";
const base = "http://localhost:3000";
const wsBase = "ws://localhost:3000/api/v1/chat/ws";
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

const mentor = await mkUser("live-mentor@t.id", "mentor");
const studentA = await mkUser("live-student-a@t.id", "student");
const studentB = await mkUser("live-student-b@t.id", "student");

// 1. Create group room with both students
const a = await db.query("SELECT id FROM users WHERE email = $1", ["live-student-a@t.id"]);
const b = await db.query("SELECT id FROM users WHERE email = $1", ["live-student-b@t.id"]);
let res = await fetch(base + "/api/v1/chat/rooms", { method: "POST", headers: { ...h(mentor), "content-type": "application/json" }, body: JSON.stringify({ type: "group", name: "Grup Belajar SNBT", memberIds: [a.rows[0].id, b.rows[0].id] }) });
const roomId = (await res.json()).data._id;
console.log("ROOM:", res.status, roomId.slice(0, 8) + "...");

// 2. Get WS ticket for student B
res = await fetch(base + "/api/v1/chat/ticket", { method: "POST", headers: h(studentB) });
const ticket = (await res.json()).data.ticket;
console.log("TICKET:", ticket.slice(0, 20) + "...");

// 3. Connect A (cookie) + B (ticket)
const wsA = new WebSocket(wsBase, { headers: { cookie: "access_token=" + studentA } });
const wsB = new WebSocket(wsBase + "?ticket=" + encodeURIComponent(ticket));

function once(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout " + type)), 5000);
    const handler = (raw: unknown) => {
      const msg = JSON.parse((raw as Buffer).toString());
      if (msg.type === type) { clearTimeout(timer); ws.off("message", handler); resolve(msg); }
    };
    ws.on("message", handler);
  });
}

await Promise.all([once(wsA, "welcome"), once(wsB, "welcome")]);
console.log("WS: both connected (cookie + ticket auth) ✓");

// 4. Join room
wsA.send(JSON.stringify({ type: "join", roomId }));
wsB.send(JSON.stringify({ type: "join", roomId }));
await Promise.all([once(wsA, "joined"), once(wsB, "joined")]);
console.log("WS: both joined ✓");

// 5. A sends a message → B receives, A gets ack
const recvPromise = once(wsB, "message");
wsA.send(JSON.stringify({ type: "message", roomId, body: "Halo! Persiapan SNBT bareng yuk 💪" }));
const ack = await once(wsA, "ack");
const delivered = await recvPromise;
console.log("ACK:", ack.seq, "| DELIVERED:", (delivered.message as Record<string, unknown>).body);

// 6. REST history + unread
res = await fetch(base + "/api/v1/chat/rooms/" + roomId + "/messages", { headers: g(studentB) });
const history = await res.json();
console.log("HISTORY:", history.data.length, "messages, seq:", history.data[0].seq, "sender:", history.data[0].senderName);
res = await fetch(base + "/api/v1/chat/rooms", { headers: g(studentB) });
const rooms = await res.json();
const myRoom = rooms.data.find((r: { id: string }) => r.id === roomId);
console.log("UNREAD for B:", myRoom.unreadCount, "| room name:", myRoom.name);

// 7. Mark read
await fetch(base + "/api/v1/chat/rooms/" + roomId + "/read", { method: "POST", headers: h(studentB) });
res = await fetch(base + "/api/v1/chat/rooms", { headers: g(studentB) });
const rooms2 = await res.json();
console.log("UNREAD after read:", rooms2.data.find((r: { id: string }) => r.id === roomId).unreadCount);

wsA.close();
wsB.close();
await db.end();
console.log("LIVE CHAT FLOW DONE");
process.exit(0);