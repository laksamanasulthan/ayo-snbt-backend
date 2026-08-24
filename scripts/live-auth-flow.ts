const base = "http://localhost:3000";
const email = "live" + Date.now() + "@test.id";
const pass = "live-pass-123";

function cookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const parts = setCookie.split(",");
  for (const part of parts) {
    const [pair] = part.trim().split(";");
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}

async function show(label: string, res: Response, body?: unknown) {
  console.log(label, "→", res.status, body ? JSON.stringify(body).slice(0, 160) : "");
}

// 1. Register
let res = await fetch(base + "/api/v1/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: pass, name: "Live User" })
});
await show("REGISTER", res, await res.json());

// 2. Wait for the worker to deliver the email to Mailpit, extract the token
let token: string | null = null;
for (let i = 0; i < 10 && !token; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const mres = await fetch("http://localhost:8025/api/v1/messages?limit=10");
  const msgs = (await mres.json()) as { messages: { ID: string; To: { Address: string }[] }[] };
  const mine = msgs.messages.find((m) => m.To[0]?.Address === email);
  if (mine) {
    const detail = (await (await fetch("http://localhost:8025/api/v1/message/" + mine.ID)).json()) as { Text: string };
    const m = /token=([a-f0-9]{64})/.exec(detail.Text);
    token = m?.[1] ?? null;
  }
}
console.log("MAILPIT TOKEN:", token ? "extracted (" + token.slice(0, 8) + "...)" : "NOT FOUND");

// 3. Verify email
if (token) {
  res = await fetch(base + "/api/v1/auth/verify-email?token=" + token);
  await show("VERIFY", res, await res.json());
}

// 4. Login
res = await fetch(base + "/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: pass })
});
const loginBody = await res.json();
await show("LOGIN", res, loginBody);
const access = cookieValue(res.headers.get("set-cookie"), "access_token");
const refresh = cookieValue(res.headers.get("set-cookie"), "refresh_token");
const csrf = cookieValue(res.headers.get("set-cookie"), "csrf_token");
console.log("COOKIES: access=" + (access ? "yes" : "NO") + " refresh=" + (refresh ? "yes" : "NO") + " csrf=" + (csrf ? "yes" : "NO"));
console.log("USER:", JSON.stringify(loginBody.data?.user ?? "none").slice(0, 200));

// 5. Me
const accessCookie = "access_token=" + access;
res = await fetch(base + "/api/v1/users/me", {
  headers: { cookie: accessCookie }
});
await show("ME", res, await res.json());

// 6. Refresh rotation
const refreshCookie = "refresh_token=" + refresh;
res = await fetch(base + "/api/v1/auth/refresh", {
  method: "POST",
  headers: { cookie: refreshCookie }
});
const newRefresh = cookieValue(res.headers.get("set-cookie"), "refresh_token");
await show("REFRESH", res, await res.json());
console.log("ROTATED:", newRefresh && newRefresh !== refresh ? "yes (new token issued)" : "NO");

// 7. Reuse the OLD refresh token → family revocation
res = await fetch(base + "/api/v1/auth/refresh", {
  method: "POST",
  headers: { cookie: refreshCookie }
});
const reuseBody = await res.json();
await show("REUSE", res, reuseBody);

// 8. CSRF protection demo
res = await fetch(base + "/api/v1/users/me", {
  method: "PATCH",
  headers: { cookie: accessCookie, "content-type": "application/json" },
  body: JSON.stringify({ name: "Hacker" })
});
await show("CSRF-BLOCKED", res, await res.json());

// 9. RBAC: student on IAM
res = await fetch(base + "/api/v1/iam/roles", {
  headers: { cookie: accessCookie }
});
await show("IAM-DENIED", res, await res.json());

process.exit(0);