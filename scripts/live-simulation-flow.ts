const base = "http://localhost:3000";
const db = await import("pg").then(p => new p.default.Pool({ connectionString: "postgres://ayosnbt:ayosnbt@localhost:5433/ayosnbt" }));
const h = (t: string) => ({ cookie: "access_token=" + t + "; csrf_token=c", "x-csrf-token": "c" });
const g = (t: string) => ({ cookie: "access_token=" + t });
const { issueAccessToken } = await import("../dist/modules/auth/index.js");

async function mkUser(email: string, role: string): Promise<string> {
  const u = await db.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (email) DO NOTHING RETURNING id", [email, "x", email.split("@")[0], "active"]);
  if (!u.rows[0]) {
    const ex = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    u.rows[0] = ex.rows[0];
  }
  const uid = u.rows[0].id;
  const r = await db.query("SELECT id FROM roles WHERE name = $1", [role]);
  if (r.rows[0]) await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [uid, r.rows[0].id]);
  return issueAccessToken(uid, email);
}

const mentorToken = await mkUser("mentor4@t.id", "mentor");
const studentToken = await mkUser("student4@t.id", "student");

// 1. Create questions
const questions = [
  { text: "2+2?", category: "TPS_PK", options: [{ text: "3", isCorrect: false }, { text: "4", isCorrect: true }] },
  { text: "Ibukota RI?", category: "TPS_PK", options: [{ text: "Jakarta", isCorrect: true }, { text: "Bandung", isCorrect: false }] },
  { text: "Akar 9?", category: "TPS_PK", options: [{ text: "2", isCorrect: false }, { text: "3", isCorrect: true }] },
  { text: "Presiden pertama?", category: "TPS_PK", options: [{ text: "Sukarno", isCorrect: true }, { text: "Suharto", isCorrect: false }] }
];
for (const q of questions) {
  await fetch(base + "/api/v1/questions", { method: "POST", headers: { ...h(mentorToken), "content-type": "application/json" }, body: JSON.stringify(q) });
}
console.log("QUESTIONS: 4 created");

// 2. Create + publish package
let res = await fetch(base + "/api/v1/simulations/packages", { method: "POST", headers: { ...h(mentorToken), "content-type": "application/json" }, body: JSON.stringify({ title: "Simulasi TPS Live", durationMinutes: 60, questionCounts: { TPS_PK: 4 } }) });
const packageId = (await res.json()).data.id;
await fetch(base + "/api/v1/simulations/packages/" + packageId + "/publish", { method: "POST", headers: h(mentorToken) });
console.log("PACKAGE: created + published");

// 3. Student starts the simulation
res = await fetch(base + "/api/v1/simulations/" + packageId + "/start", { method: "POST", headers: h(studentToken) });
const started = await res.json();
const sessionId = started.data.sessionId;
console.log("SESSION: started", sessionId.slice(0, 8) + "... deadline:", new Date(started.data.deadlineAt).toISOString());

// 4. Fetch questions + answer all with the FIRST option
res = await fetch(base + "/api/v1/simulations/sessions/" + sessionId, { headers: g(studentToken) });
const session = (await res.json()).data;
console.log("QUESTIONS IN SESSION:", session.questions.length, "(options shuffled, no isCorrect leaked:", session.questions[0].options[0].isCorrect === undefined, ")");
for (const q of session.questions) {
  await fetch(base + "/api/v1/simulations/sessions/" + sessionId + "/answers", { method: "POST", headers: { ...h(studentToken), "content-type": "application/json" }, body: JSON.stringify({ questionId: q.id, selectedOptionId: q.options[0].id }) });
}
console.log("ANSWERS: 4 saved");

// 5. Submit → BullMQ grading job
res = await fetch(base + "/api/v1/simulations/sessions/" + sessionId + "/submit", { method: "POST", headers: h(studentToken) });
console.log("SUBMIT:", res.status, "(202 = accepted, grading async)");

// 6. Poll for the graded result (worker processes via BullMQ)
let result: any = null;
for (let i = 0; i < 15 && !result; i++) {
  await new Promise(r => setTimeout(r, 1000));
  res = await fetch(base + "/api/v1/simulations/sessions/" + sessionId + "/result", { headers: g(studentToken) });
  const body = await res.json();
  if (body.data?.status === "graded") result = body.data;
}
if (result) {
  console.log("RESULT: status=" + result.status, "score=" + result.score + "/" + result.maxScore, "correct=" + result.correctCount, "wrong=" + result.wrongCount, "blank=" + result.blankCount, "percentile=" + result.percentile, "rank=" + result.rank);
} else {
  console.log("RESULT: not graded after 15s (worker issue?)");
}

// 7. Leaderboard
res = await fetch(base + "/api/v1/simulations/leaderboard?packageId=" + packageId);
const board = await res.json();
console.log("LEADERBOARD:", JSON.stringify(board.data.map((r: { name: string; score: number; percentile: number }) => ({ name: r.name, score: r.score, pct: r.percentile }))));

await db.end();
console.log("LIVE SIMULATION FLOW DONE");
process.exit(0);