# Ayo-SNBT Feature Specifications (API + Frontend + Constraints)

> **Purpose:** every feature in the product, its endpoints, the end-to-end
> flow, how it should look in the frontend, and the constraints that govern
> it. Written for frontend developers and as onboarding material for new
> backend developers.
>
> **Legend:** ✅ built · ⚠️ planned (see `docs/product/PRODUCT-ROADMAP.md`).
> Cross-cutting contracts (envelope, error codes, pagination, CSRF,
> idempotency, rate limits) live in `docs/architecture/API-CONVENTIONS.md` — read that
> first.

---

# Part A — Built features

## A1. Auth

### A1.1 Register

- **Endpoint:** `POST /api/v1/auth/register`
- **Auth:** none · **CSRF:** no (public)
- **Body:** `{ "email": string, "password": string, "name": string }`
- **Response:** `201` → `{ "userId": uuid }`
- **Constraints:**
  - Email must match `format: email`; password ≥ 8 chars; name ≥ 1 char.
  - `409 EMAIL_TAKEN` when the email already exists.
  - `400 VALIDATION_ERROR` with `details.issues` for schema violations.
  - Success queues a **verify-email email** (token valid 24 h).
- **Flow:** form → API → success screen "Cek email kamu" → user clicks email
  link → verify.
- **Frontend:** page `/auth/register`; loading state on submit; inline
  field errors from `details.issues`; success screen with a "resend" hint
  (resend = repeat register → `409 EMAIL_TAKEN` — handle by showing
  "already registered, log in instead").

### A1.2 Verify email

- **Endpoint:** `GET /api/v1/auth/verify-email?token=<token>`
- **Auth:** none · **CSRF:** no
- **Response:** `200` → `{ "verified": true }`
- **Constraints:** `400` for invalid/already-used token; `400` for
  expired token (24 h). Single use.
- **Flow:** email link → page reads `token` from query → calls API →
  success/failure screen.
- **Frontend:** page `/auth/verify-email?token=…`; success → countdown →
  redirect to login; failure → "token invalid/expired, register again".

### A1.3 Login

- **Endpoint:** `POST /api/v1/auth/login`
- **Auth:** none · **CSRF:** no · **Rate limit:** 5/min per IP
- **Body:** `{ "email": string, "password": string }`
- **Response:** `200` → `{ "user": { id, email, name, roles, permissions } }`
  - **Set-Cookie:** `access_token` (JWT, 15 min, httpOnly, SameSite=Lax),
    `refresh_token` (opaque, httpOnly), `csrf_token` (readable by JS).
- **Constraints:**
  - `401 AUTH_INVALID_CREDENTIALS` for unknown email OR wrong password
    (same code — no enumeration).
  - `401 ACCOUNT_LOCKED` after 5/10/15 failures (5/15/60 min windows,
    per email+IP).
  - `403 EMAIL_NOT_VERIFIED` before verification.
  - `429 TOO_MANY_REQUESTS` with `Retry-After` header.
- **Flow:** form → API sets cookies → redirect to home.
- **Frontend:** page `/auth/login`; remember redirect target; show
  lockout countdown from `Retry-After`; "forgot password" link.

### A1.4 Refresh

- **Endpoint:** `POST /api/v1/auth/refresh`
- **Auth:** refresh cookie · **CSRF:** no · **Rate limit:** 20/min
- **Body:** none (cookie only)
- **Response:** `200` → same as login + fresh cookies (rotation: old
  refresh token revoked, new one issued in the same family).
- **Constraints:**
  - `401 TOKEN_EXPIRED` for expired refresh tokens (30 days).
  - `401 TOKEN_REUSE_DETECTED` when a revoked token is presented — the
    **whole family is revoked** (security containment).
  - `401 UNAUTHORIZED` for garbage/missing token.
  - **Never call this endpoint in parallel with the same token** — exactly
    one concurrent refresh wins; the loser revokes the family.
- **Frontend:** invisible interceptor in the API client — on `401` from any
  endpoint (except refresh), call refresh ONCE (serialize concurrent 401s
  behind a single promise), retry the original request; on refresh failure →
  logout → redirect to login.

### A1.5 Logout

- **Endpoint:** `POST /api/v1/auth/logout`
- **Auth:** refresh cookie · **CSRF:** no
- **Response:** `200`
- **Constraints:** idempotent (double logout is a no-op); revokes the
  presented refresh token server-side.
- **Frontend:** clear local auth state, clear `csrf_token` cookie handling,
  redirect to login. (Cookies are httpOnly except csrf — clearing them is
  server-side; client just forgets state.)

### A1.6 Forgot password

- **Endpoint:** `POST /api/v1/auth/forgot-password`
- **Auth:** none · **CSRF:** no · **Rate limit:** 5/min per IP
- **Body:** `{ "email": string }`
- **Response:** `200` → `{ "sent": true }` (always — no enumeration)
- **Constraints:** reset token valid 15 min, single use; email queued only
  when the account exists.
- **Frontend:** page `/auth/forgot-password`; ALWAYS show "if an account
  exists, we emailed a reset link".

### A1.7 Reset password

- **Endpoint:** `POST /api/v1/auth/reset-password`
- **Auth:** none · **CSRF:** no
- **Body:** `{ "token": string, "password": string }` — NOTE the field is
  `password`, not `newPassword`.
- **Response:** `200` → `{ "reset": true }`
- **Constraints:** `400` invalid/used token; `400` expired token (15 min);
  success revokes ALL sessions for the account.
- **Frontend:** page `/auth/reset-password?token=…`; password + confirm
  fields; success → redirect to login.

### A1.8 OAuth2 Google (social login)

- **Endpoint:** `GET /auth/oauth2/google/callback` (backend-side; enabled
  when `OAUTH_ENABLED` + credentials set)
- **Auth:** none (OAuth2 code flow)
- **Response:** sets cookies, then **redirects** to
  `OAUTH_FRONTEND_REDIRECT_URL?oauth=success`.
- **Constraints:** link by `provider_user_id` OR by matching email;
  new users created verified with the student role; `400 OAUTH_NO_EMAIL`
  when the provider returns no email.
- **Flow:** "Masuk dengan Google" → provider consent → callback sets
  cookies → redirect with `?oauth=success`.
- **Frontend:** page at the configured redirect URL; on `?oauth=success`
  → call `GET /users/me` to hydrate → redirect to home.

---

## A2. Users

### A2.1 Get my profile

- **Endpoint:** `GET /api/v1/users/me`
- **Auth:** access cookie
- **Response:** `200` → `{ id, email, name, roles: string[],
permissions: string[], avatarUrl, createdAt }`
- **Constraints:** `401 UNAUTHORIZED` without a valid token. This is the
  single source of truth for roles/permissions on the frontend (JWT is
  httpOnly — never decoded client-side).
- **Frontend:** called on app boot (auth hydration) and after login/OAuth.

### A2.2 Update profile

- **Endpoint:** `PATCH /api/v1/users/me`
- **Auth:** access cookie · **CSRF:** yes
- **Body:** `{ "name"?: string }` — `additionalProperties: false` (any
  other field → `400 VALIDATION_ERROR`).
- **Response:** `200` → updated user object.
- **Frontend:** profile edit form; optimistic update with rollback.

### A2.3 Avatar upload (presigned)

- **Endpoints:**
  1. `POST /api/v1/users/me/avatar/presign` — body `{ "contentType": string }`
     → `200` `{ "uploadUrl": string, "key": string }`
  2. Client `PUT`s the file directly to `uploadUrl` (S3/MinIO).
  3. `POST /api/v1/users/me/avatar/confirm` — body `{ "key": string }`
     → `200` `{ "updated": true }`
- **Auth:** access cookie + CSRF on both POSTs.
- **Constraints:** presigned URL valid `S3_PRESIGN_TTL_SECONDS` (120 s) —
  upload must complete within the window; image content-type enforced by
  the service; avatar URL derived from the key.
- **Frontend:** avatar picker → (1) presign → (2) direct PUT (progress bar)
  → (3) confirm → refresh profile. Handle 120 s expiry (re-presign on
  failure).

---

## A3. Courses

### A3.1 Catalog (public, cursor-paginated)

- **Endpoint:** `GET /api/v1/courses?cursor=&limit=`
- **Auth:** optional (access cookie if present)
- **Response:** `200` → `{ "data": Course[], "meta": { "pagination":
{ "nextCursor": string|null, "limit": number } } }`
  - Course row: `{ id, title, slug, description, category, level,
priceCents, imageKey, createdAt, mentorName }` (+ `enrolled` — planned
    in M8).
- **Constraints:** limit 1–100 (default 20); `400 INVALID_LIMIT`;
  `400 INVALID_CURSOR` for tampered cursors; published courses only;
  soft-deleted courses never appear.
- **Frontend:** infinite scroll via `nextCursor`; course cards; show
  "Gratis"/price; logged-in users get enrollment state (planned M8).

### A3.2 Course detail

- **Endpoint:** `GET /api/v1/courses/:id`
- **Auth:** optional
- **Response:** `200` → course + `lessons: [{ id, title, sortOrder,
durationSeconds, isFree, videoStatus }]`
- **Constraints:** `404` unknown/deleted; draft courses visible only to
  owner/mentor/admin (`403 "Course not published"` otherwise); non-UUID id
  → `400 INVALID_ID`.
- **Frontend:** course page: hero (title, mentor, price, enroll button),
  lesson list (free/paid badges, video status), progress bar (planned M8).

### A3.3 Create / update / publish course (mentor)

- **Endpoints:**
  - `POST /api/v1/courses` — body `{ title, description?, category?,
level?, priceCents? }` → `201` course (status defaults to **draft**)
  - `PATCH /api/v1/courses/:id` — partial update → `200` course
  - `POST /api/v1/courses/:id/publish` → `200` `{ "published": true }`
- **Auth:** access cookie + CSRF + permissions (`course:create` /
  `course:update` / `course:publish` — mentors have them, students do
  not).
- **Constraints:** ownership — non-owner mentor → `403` (admin bypasses);
  `404` unknown; publish is a status flip only (no content validation).
- **Frontend (mentor):** course editor form; draft → publish button;
  "published" badge. Slug is auto-generated (title + timestamp suffix).

### A3.4 Enroll

- **Endpoint:** `POST /api/v1/courses/:id/enroll`
- **Auth:** access cookie + CSRF
- **Response:** `200` → `{ "enrolled": true, "alreadyEnrolled"?: boolean }`
- **Constraints:**
  - Free courses: enrolls immediately (idempotent — parallel requests
    converge to one row).
  - Paid courses: `403 PAYMENT_REQUIRED` → the client must go through
    **Payments** (A8) instead.
  - `404` unknown/deleted course.
- **Frontend:** "Daftar" button → success state ("Lanjutkan"); paid → route
  to order creation with the courseId.

### A3.5 Soft-delete / restore

- **Endpoints:**
  - `DELETE /api/v1/courses/:id` → `200` `{ "deleted": true, "soft": true }`
  - `POST /api/v1/courses/:id/restore` → `200` `{ "restored": true,
"alreadyActive"?: boolean }`
- **Auth:** access cookie + CSRF + `course:delete` (route gate = **admin
  only** in practice).
- **Constraints:** deleted → invisible everywhere (catalog, detail,
  enroll); restore is admin-only; ownership checks are a second layer.
- **Frontend (admin):** delete with confirm; restore from a "deleted" list
  (planned M9 admin views).

### A3.6 Lessons

- **Endpoints:**
  - `POST /api/v1/courses/:id/lessons` — body `{ title, description?,
videoId?, isFree? }` → `201` lesson (sortOrder auto = max+1)
  - `PATCH /api/v1/lessons/:id` — partial update → `200`
- **Auth:** access cookie + CSRF + `course:update` (owner or admin).
- **Constraints:** ownership enforced against the parent course; `404`
  unknown course/lesson; soft-deleted lessons hidden.
- **Frontend (mentor):** lesson editor with video picker (from the video
  pipeline), free/paid toggle, reorder (planned: reorder endpoint).

### A3.7 Progress

- **Endpoints:**
  - `POST /api/v1/lessons/:id/progress` — body `{ status?: "in_progress" |
"completed", progressPercent?: int, lastPositionSeconds?: int }` →
    `200` `{ "recorded": true }` (rate limit 60/min)
  - `GET /api/v1/courses/:id/progress` → `200` rows `{ lessonId, status,
progressPercent, lastPositionSeconds, updatedAt }`
- **Auth:** access cookie + CSRF (POST) / access cookie (GET).
- **Constraints:** `404` unknown lesson; non-integer fields →
  `400 VALIDATION_ERROR`; progress is per-user, never leaked to others.
- **Frontend:** video player sends progress periodically (debounced) +
  on pause/unmount; lesson checkmarks; course progress bar; "completed"
  badge at 100% (summary rollup planned in M8).

---

## A4. Questions (question bank — mentor/admin)

### A4.1 List

- **Endpoint:** `GET /api/v1/questions?cursor=&limit=&category=`
- **Auth:** `question:manage` (mentor/admin)
- **Response:** `200` → `{ data: Question[], meta.pagination }`
  - Question row includes `options: [{ id, text, isCorrect, sortOrder }]`
- **Constraints:** soft-deleted questions never appear; category filter
  exact-match; cursor pagination as usual.
- **Frontend (mentor):** table with category filter, pagination, edit/delete
  actions.

### A4.2 Create / update / delete / restore

- **Endpoints:**
  - `POST /api/v1/questions` — body `{ text, type?, category?,
difficulty?, explanation?, options?: [{ text, isCorrect }] }` → `201`
  - `PATCH /api/v1/questions/:id` — partial update; **options replace
    atomically** (send the full new list) → `200`
  - `DELETE /api/v1/questions/:id` → `200` (soft)
  - `POST /api/v1/questions/:id/restore` → `200`
- **Auth:** access cookie + CSRF + `question:manage`; ownership (creator
  or admin) enforced server-side.
- **Constraints:** missing `text` → `400 VALIDATION_ERROR`; options
  replace is transactional (all-or-nothing); deleted questions are excluded
  from simulation question picking.
- **Frontend (mentor):** question editor with dynamic option list,
  correct-answer toggles, explanation field; delete = soft (restorable).

---

## A5. Video pipeline (mentor)

### A5.1 Create / presign / confirm

- **Endpoints:**
  1. `POST /api/v1/videos` — body `{ title, originalName? }` → `201`
     (status `uploaded`)
  2. `POST /api/v1/videos/:id/upload-url` — body `{ contentType }` →
     `200` `{ uploadUrl, key }` (client PUTs raw file directly to S3)
  3. `POST /api/v1/videos/:id/confirm` → `202` `{ status:
"processing", alreadyQueued?: boolean }` (enqueues transcode job)
- **Auth:** access cookie + CSRF + `video:upload` (1,2) /
  `video:transcode` (3).
- **Constraints:**
  - Allowed content types: mp4 / quicktime / webm / x-matroska —
    else `400 BAD_CONTENT_TYPE`.
  - `400` confirming before a raw upload exists.
  - Confirm is idempotent (`alreadyQueued: true` on repeat).
  - Presigned URL valid 120 s.
- **Flow:** upload widget: (1) create → (2) presign + direct PUT → (3)
  confirm → poll `GET /videos/:id` until `status: "ready"`.
- **Frontend (mentor):** upload page with progress; status chip
  (uploaded → processing → ready/failed).

### A5.2 Streaming (student)

- **Endpoints:**
  - `GET /api/v1/videos/:id/master.m3u8` → `307` → `Location` =
    presigned S3 master playlist (rate limit 120/min)
  - `GET /api/v1/videos/:id/segments/*` → `307` → presigned segment
    (rate limit 300/min)
- **Auth:** access cookie (both).
- **Constraints:**
  - `400 VIDEO_NOT_READY` when not transcoded; `404` deleted video.
  - Enrollment gate: free lessons open; paid lessons require enrollment
    (`403 ENROLLMENT_REQUIRED`); owner/admin bypass; videos not attached
    to a lesson are mentor/admin-only.
  - Segment paths must match `^[a-zA-Z0-9_/-]+\.(ts|m3u8|m4s|mp4)$` —
    traversal → `400 BAD_SEGMENT_PATH`.
  - Presigned URLs expire (120 s) — hls.js must fetch segments promptly;
    re-request the master playlist after long pauses.
- **Frontend:** use `fetch(url, { redirect: "manual" })` to capture the
  `Location` header → feed the presigned URL to **hls.js**. Never follow
  the redirect yourself for the playlist.

---

## A6. Simulations (SNBT tryouts)

### A6.1 Packages

- **Endpoints:**
  - `GET /api/v1/simulations/packages?cursor=&limit=` — public; published
    only → `{ data, meta.pagination }`
  - `GET /api/v1/simulations/packages/:id` — public
  - `POST /api/v1/simulations/packages` — body `{ title,
description?, durationMinutes?, questionCounts?, scoring?, status? }`
    → `201` (mentor; default status `draft`)
  - `PATCH /api/v1/simulations/packages/:id` → `200`
  - `POST /api/v1/simulations/packages/:id/publish` → `200`
  - `DELETE /api/v1/simulations/packages/:id` → `200` (soft, mentor)
  - `POST /api/v1/simulations/packages/:id/restore` → `200` (admin)
- **Auth:** manage = access cookie + CSRF + `simulation:manage`
  (mentor/admin).
- **Constraints:** `questionCounts` = `{ "<category>": n }`;
  `scoring` = `{ correct, blank, wrong }` (SNBT 2023+: no penalty —
  wrong: 0); soft-deleted packages vanish from public lists; restore
  admin-only.
- **Frontend (mentor):** package editor (title, duration, per-category
  question counts, scoring weights), publish toggle, delete/restore.

### A6.2 Start a session (student)

- **Endpoint:** `POST /api/v1/simulations/:packageId/start`
- **Auth:** access cookie
- **Response:** `201` → `{ sessionId, deadlineAt, durationMinutes }`
- **Constraints:**
  - Package must be published — `403` otherwise.
  - `400 PACKAGE_EMPTY` (no counts configured) / `400 BANK_EMPTY` (no
    matching questions).
  - Questions picked server-side (random, anti-cheat); deleted questions
    excluded; answer rows pre-created = the session's question set.
  - A delayed auto-submit job is scheduled server-side (duration + 5 s) —
    grading happens even if the student never submits.
  - Attempt limits (planned M4).
- **Frontend:** confirm dialog → POST → navigate to the session page with
  the returned `deadlineAt` (survives refresh — re-read on mount).

### A6.3 Session detail

- **Endpoint:** `GET /api/v1/simulations/sessions/:id`
- **Auth:** access cookie (owner only — `404` for other users)
- **Response:** `200` → session + `questions: [{ id, text, category,
difficulty, options: [{ id, text }], selectedOptionId }]`
- **Constraints:** **correct answers are never included** (anti-cheat);
  options are seeded-shuffled per session (deterministic for the same
  session); `400 INVALID_ID` for non-UUID.
- **Frontend:** exam screen — question map (grid), one question at a time
  or scroll, selected answers highlighted, flag state (planned M3).

### A6.4 Save answer

- **Endpoint:** `POST /api/v1/simulations/sessions/:id/answers`
- **Auth:** access cookie + CSRF
- **Body:** `{ questionId, selectedOptionId }`
- **Response:** `200` → `{ "saved": true }`
- **Constraints:**
  - `400` question not part of this session.
  - `400 SESSION_CLOSED` after submission.
  - `400 SESSION_EXPIRED` when the deadline passed — the server
    auto-submits AND grades inline, then rejects the answer.
  - Overwriting an answer is allowed (idempotent).
- **Frontend:** autosave on selection (debounced); treat
  `SESSION_EXPIRED` as "time's up → go to results".

### A6.5 Submit

- **Endpoint:** `POST /api/v1/simulations/sessions/:id/submit`
- **Auth:** access cookie + CSRF
- **Response:** `202` → `{ "submitted": true,
"alreadySubmitted"?: boolean }` — **202**, not 200.
- **Constraints:** double submit → `alreadySubmitted: true` (idempotent);
  grading is async (BullMQ) — the result is NOT in this response.
- **Frontend:** confirm dialog → submit → "Sedang dinilai…" → poll the
  result endpoint until graded.

### A6.6 Result

- **Endpoint:** `GET /api/v1/simulations/sessions/:id/result`
- **Auth:** access cookie (owner only)
- **Response:** `200` → `{ sessionId, packageId, packageTitle, status:
"graded", score, maxScore, correctCount, wrongCount, blankCount,
percentile, rank, submittedAt }`
- **Constraints:** `400 NOT_GRADED` before grading finishes — poll every
  2 s (up to ~60 s); percentile 100 when no peers yet; rank = ties share
  the rank.
- **Frontend:** results page: big score, counts (benar/salah/kosong),
  percentile + rank, "Lihat Pembahasan" → review (M1), leaderboard link.

### A6.7 My sessions

- **Endpoint:** `GET /api/v1/simulations/sessions?cursor=&limit=`
- **Auth:** access cookie
- **Response:** `200` → `{ data: [{ id, packageTitle, status, score,
percentile, startedAt, submittedAt }], meta.pagination }`
- **Frontend:** "Riwayat Tryout" page with status badges
  (in_progress / submitted / graded), resume in-progress sessions (deadline
  re-read), view results for graded ones.

### A6.8 Leaderboard

- **Endpoint:** `GET /api/v1/simulations/leaderboard?packageId=<uuid>`
- **Auth:** optional
- **Response:** `200` → rows `{ userId, name, score, percentile,
submittedAt }` sorted by score desc (top 20 default)
- **Constraints:** graded sessions only; query param `packageId`
  (not a path segment); period filters planned (A7).
- **Frontend:** leaderboard table with highlight for "me" (match
  `userId` from /users/me).

---

## A7. Chat

### A7.1 Rooms (HTTP)

- **Endpoints:**
  - `GET /api/v1/chat/rooms` → `200` my rooms `{ id, type, name,
unreadCount, lastMessageAt }`
  - `POST /api/v1/chat/rooms` — body `{ type: "course" | "mentor" |
"group", name?, courseId?, mentorId?, memberIds? }` → `201`
  - `POST /api/v1/chat/rooms/:id/join` → `200` `{ joined: true }`
  - `GET /api/v1/chat/rooms/:id/messages?before=<seq>&limit=` →
    `200` messages ascending, cap 100
  - `POST /api/v1/chat/rooms/:id/read` → `200` `{ read: true }`
- **Auth:** access cookie + CSRF on POSTs.
- **Constraints:**
  - Course rooms: mentor/admin only to create; duplicate create returns the
    SAME room (dedupe by courseId); students join by being enrolled.
  - Mentor rooms: deterministic id `1:1:<sorted user ids>`.
  - Membership: outsiders → `403 NOT_ROOM_MEMBER`; unknown room → `404`.
  - Messages: body ≤ 2000 chars (truncated server-side, rejected > 2000 via
    WS); `before` = exclusive seq cursor.
- **Frontend:** rooms list (unread badges), room page (message thread,
  input ≤ 2000, load-older on scroll up, mark-read on open).

### A7.2 WebSocket gateway

- **Endpoint:** `GET /api/v1/chat/ws?ticket=<ticket>` or cookie auth
- **Protocol:** see `docs/services/CHAT-WEBSOCKET.md` — client→server
  `join/leave/message/typing/ping`; server→client
  `welcome/joined/left/ack/message/typing/pong/error`.
- **Ticket:** `POST /api/v1/chat/ticket` → `{ ticket,
expiresInSeconds: 120 }` (auth required).
- **Constraints:** send rate limit 30/min/user; messages > 2000 →
  `MESSAGE_TOO_LONG`; empty → `EMPTY_MESSAGE`; unknown type →
  `UNKNOWN_EVENT`; reconnection needs a fresh ticket.
- **Frontend:** chat client with reconnection (fresh ticket on reconnect),
  typing indicators (debounced), optimistic send with ack reconciliation,
  offline banner.

---

## A8. Payments

### A8.1 Create order

- **Endpoint:** `POST /api/v1/payments/orders`
- **Auth:** access cookie + CSRF + `payment:read`
- **Body:** `{ courseId }` (+ `couponCode?` planned F12/A8)
- **Response:** `201` →
  - free course: `{ free: true, enrolled: true }`
  - paid course: `{ free: false, order: { id, orderNumber, amountCents,
currency, status: "pending", paymentUrl, provider, createdAt } }`
- **Constraints:**
  - `404` unknown course; `400` unpublished course.
  - **Idempotency-Key** header supported (24 h replay; `409
IDEMPOTENCY_KEY_REUSED` on mismatch; 5xx never cached) — the client
    MUST send one for retry safety.
  - `paymentUrl` for the mock provider points back at the backend
    (`/api/v1/payments/mock/pay/<orderNumber>`); for real providers it is
    external (Midtrans/Xendit redirect).
- **Flow:** "Beli" → order → redirect to `paymentUrl` → provider →
  webhook marks paid → async fulfillment (enroll + receipt email) → user
  returns → poll order status until `fulfilled`.
- **Frontend:** order page (summary + pay button); after redirect return,
  poll `GET /orders/:id` (2 s interval, max ~2 min); show success when
  fulfilled.

### A8.2 My orders

- **Endpoints:**
  - `GET /api/v1/payments/orders?cursor=&limit=` → `200` cursor list
  - `GET /api/v1/payments/orders/:id` → `200` (owner only — others
    `404`)
- **Constraints:** lazy expiry — a pending order older than 24 h flips to
  `expired` on read; statuses: created → pending → paid → fulfilled →
  refunded (→ expired).
- **Frontend:** orders page with status badges; "bayar lagi" for pending
  (re-open paymentUrl); success CTA → go to course.

### A8.3 Refund (admin)

- **Endpoint:** `POST /api/v1/payments/orders/:id/refund`
- **Auth:** access cookie + CSRF + `payment:refund` (admin)
- **Response:** `200`
- **Constraints:** `400` unless status is `paid`/`fulfilled`;
  double refund → `400`; unknown → `404`.
- **Frontend (admin):** refund button on fulfilled orders with confirm.

### A8.4 Webhooks (backend-only)

- `POST /api/v1/payments/webhook/midtrans` /
  `POST /api/v1/payments/webhook/xendit` /
  `POST /api/v1/payments/mock/pay/:orderNumber`
- **Auth:** provider signature (SHA512 / x-callback-token) — NOT cookies.
- **Constraints:** `400 WEBHOOK_SIGNATURE_INVALID`; idempotent by
  `event_id` (replay → no-op); state machine guards double fulfillment.

---

## A9. IAM (admin)

- **Endpoints:**
  - `GET /api/v1/iam/roles` → `200` roles list
  - `GET /api/v1/iam/permissions` → `200` permissions list
  - `POST /api/v1/iam/users/:userId/roles` — body `{ roleId }` → `201`
    `{ assigned: true }`
- **Auth:** access cookie + CSRF + `iam:manage` (admin).
- **Constraints:** `404` unknown user OR role (never 500); duplicate
  assignment → idempotent no-op.
- **Frontend (admin):** user search → role select → assign; roles list.

---

## A10. System

- `GET /health` → `200` `{ status: "ok" }` — liveness (never fails on
  dependency issues).
- `GET /ready` → `200` readiness + degradation snapshot
  (cache/rateLimit/queue/presence gate modes).
- **Frontend:** health-check pings in CI/deploy smoke tests; a "system
  degraded" banner could read /ready in admin tools.

---

# Part B — Planned features (see docs/product/PRODUCT-ROADMAP.md)

> ⚠️ Endpoints below are **proposals** — they become normative the moment
> they are implemented. The frontend can design against them now; final
> shapes are confirmed in the implementing PR.

## B1. M1 — Review & Pembahasan ✅ (built)

- **Endpoints:**
  - `GET /api/v1/simulations/sessions/:id/review` — auth (owner only) ✅
- **Response:** `200` → `{ sessionId, packageId, questions: [{ questionId,
text, category, difficulty, explanation, selectedOptionId,
correctOptionIds: string[], isCorrect, options: [{ id, text, isCorrect }] }] }`
- **Constraints:** `400 NOT_GRADED` before grading; `404` other users'
  sessions; answers/correct flags NEVER exposed before grading (tests
  enforce).
- **Flow:** results page → "Lihat Pembahasan" → review page.
- **Frontend:** per-question cards (benar/salah/kosong styling), explanation
  panel, filter tabs (semua / salah / kosong), link to retry wrong answers
  (M2 with questionIds).

## B2. M2 — Practice mode ✅ (built)

- **Endpoints (live):**
  - `POST /api/v1/practice/start` — body `{ packageId?, category?,
difficulty?, count?, questionIds?, tag? }` → `201` `{ practiceId,
deadlineAt, questions: [{ id, text, options }], maxScore }` (no correct
    flags leaked)
  - `POST /api/v1/practice/:id/answer` — body `{ questionId,
selectedOptionId }` → `200` `{ isCorrect, correctOptionIds,
explanation }`
  - `GET /api/v1/practice/:id` → `200` progress (answered, correct,
    remaining)
  - `POST /api/v1/practice/:id/finish` → graded + score (idempotent)
- **Constraints:** instant feedback is the point (LeetCode-style); no
  timer; practice sessions stored with `type = 'practice'` so analytics
  cover both modes; answer rate-limited 60/min; package-driven practice
  honors the package distribution incl. `tag:` keys (M6).
- **Frontend:** "Latihan" page — one question at a time, immediate
  correct/wrong + explanation reveal, progress bar, end summary.

## B3. M3 — Exam-authentic session mechanics ✅ (built)

- **Endpoints (live):**
  - `PATCH /api/v1/simulations/sessions/:id/answers/:questionId/flag` —
    body `{ isFlagged: boolean }` → `200` (only while `in_progress`;
    otherwise `400 SESSION_CLOSED`)
  - `GET /sessions/:id` payload gains per-question `{ answered, flagged,
timeSpentMs }`; session gains `warnAtRemainingMs` (package config,
    simulation type only)
  - `GET /sessions/:id/review` — per-question correct/explanation
    (owner only, `400 NOT_GRADED` before grading) ✅ (M1)
- **Backend data:** `simulation_answers.isFlagged`, `timeSpentMs`
  (server-side accumulation: elapsed since the last `answeredAt` or
  session start is added on every save); `simulation_packages.warnAtRemainingMs`.
- **Constraints:** flag/time only while `in_progress`; time accumulated
  server-side on answer events (no client trust).
- **Frontend:** question map grid (answered/flagged/current states), flag
  toggle, "sisa waktu" countdown with warning state at the threshold,
  confirm dialog on time-up.

## B4. M4 — Attempt policy ✅ (built)

- **Backend data:** `simulation_packages.maxAttempts int|null` (null =
  unlimited), `retakeCooldownMinutes int|null` (null = no cooldown).
- **Endpoints (live):**
  - `POST /api/v1/simulations/packages` / `PATCH .../:id` accept
    `maxAttempts` (int ≥ 1) and `retakeCooldownMinutes` (int ≥ 0);
    invalid values → `400 VALIDATION_ERROR`.
  - `POST /api/v1/simulations/:packageId/start` enforces the policy
    before creating a session:
    - limit hit → `403 ATTEMPT_LIMIT_REACHED` with
      `details: { attemptsUsed, maxAttempts, retryAfter: null }`;
    - cooldown active → same code with
      `details: { attemptsUsed, maxAttempts, retryAfter: <ISO timestamp> }`
      (earliest allowed start = last attempt's `startedAt` + cooldown).
  - `GET /api/v1/simulations/sessions` rows gain `attemptsUsed` (all
    simulation-type sessions for that user+package, not just the page).
- **Semantics:** only `type='simulation'` sessions count — practice
  drills never consume attempts; cooldown is per user+package, based on
  the most recent attempt's `startedAt`.
- **Frontend:** package card shows "sisa 1 percobaan"; blocked start shows
  the reason + cooldown countdown.

## B5. M5 — Notifications ✅ (built)

- **Endpoints (live):**
  - `GET /api/v1/notifications?cursor=&limit=&unread=true` → `200` list
    (cursor-paginated, newest first; `unread=true` filters)
  - `GET /api/v1/notifications/unread-count` → `200` `{ count }`
  - `POST /api/v1/notifications/:id/read` → `200` `{ read: true }`
    (idempotent; foreign/unknown id → `404`)
  - `POST /api/v1/notifications/read-all` → `200` `{ updated }`
- **Auth:** access cookie on all routes + CSRF on POSTs.
- **Trigger events (subscriptions in `shared/events/subscriptions.ts`):**
  - `simulation.graded` → row for the session owner ("Hasil tryout siap")
  - `course.published` → fan-out row to every active user
  - `order.fulfilled` → row for the buyer + email job on the reserved
    `notification` BullMQ queue
- **Schema:** `notifications` (`user_id`, `type`, `title`, `body`,
  `payload` jsonb deep-link context, `read_at`, `created_at`; index
  `(user_id, read_at, created_at)`); rows are only ever written by
  subscribers, never by slices directly.
- **Frontend:** bell + unread badge (poll unread-count every 60 s), dropdown
  with recent items, notifications page, deep links (result/course).

## B6. M6 — Question tags ✅ (built)

- **Backend data (live):** `tags` (unique, normalized lowercase) +
  `question_tags` (M:N, cascade on physical delete).
- **Endpoints (live):**
  - `POST /api/v1/questions` / `PATCH .../:id` accept `tags: string[]`
    (normalized + deduped); replace semantics on update.
  - `GET /api/v1/questions/:id` and the bank list now return
    `tags: string[]` per question.
  - `GET /api/v1/questions?tag=aljabar` filters (combinable with
    `category`).
  - Package `questionCounts` accepts `"tag:<name>": N` keys — a package
    can draw N random questions from a topic tag (also honored by
    `POST /api/v1/practice/start` with a package).
  - `POST /api/v1/practice/start` accepts `tag` for pure tag drills.
  - Soft-deleting a question drops its tag links (tags survive for reuse).
- **Frontend (mentor):** tag input (chips) in the question editor; tag
  filter in the bank; package editor can target tags.

## B7. M7 — Bulk question import ✅ (built)

- **Endpoint (live):** `POST /api/v1/questions/import` — JSON body
  `{ dryRun?, questions: [...] }` OR raw CSV (content-type `text/plain`,
  no new deps; a native `text/csv` parser can be registered later).
- **CSV columns (header optional, order-flexible):** `text, category,
difficulty, tags (; separated), option1..option4, correct (1-based,
comma-separated e.g. `1,3`), explanation`. Quoted fields (commas,
  quotes) are RFC-4180 parsed. Header-less CSV uses the canonical order.
- **Response:** `200` →
  `{ dryRun, imported, skipped: [{row, reason}], failed: [{row, errors}] }`.
  `dryRun: true` validates without writing (`wouldImport` reports).
- **Validation per row:** text required; ≥ 2 options; ≥ 1 correct option;
  difficulty ∈ easy|medium|hard. Bad rows are reported, good rows import.
- **Idempotency:** `questions.content_hash` = sha256(trimmed text),
  partial unique index `WHERE deleted_at IS NULL` — replays skip as
  `duplicate (already imported)`, and re-import works after a soft
  delete. Cap: 2000 rows/request (`400 IMPORT_TOO_LARGE`).
- **Audit + events:** one audit entry per run; `question.created` event
  per imported question; cache version bumped.
- **Auth:** admin/mentor with `question:manage`.
- **Frontend (mentor):** upload page with CSV template download, preview
  table, per-row error report.

## B8. M8 — My courses + enrollment visibility ✅ (built)

- **Endpoints (live):**
  - `GET /api/v1/courses/mine?cursor=&limit=` (auth, registered before `/:id`) — enrolled courses
    with progress rollup `{ completedLessons, totalLessons,
percentComplete, enrolledAt, expiresAt, mentorName }`; cursor pagination
    (enrolledAt DESC, courseId DESC).
  - `GET /api/v1/courses` rows gain `enrolled: boolean` (when authed,
    post-cache enrichment — never cached).
  - `GET /api/v1/courses/:id` gains `enrolled: boolean` when authed.
  - `GET /courses/:id` gains `enrolled` + progress rollup
- **Frontend:** "Kursus Saya" page (resume where left off), catalog cards
  show Daftar vs Lanjutkan, detail shows progress bar.

## B9. M9 — Admin user management + dashboard ✅ (built)

- **Endpoints (live):**
  - `GET /api/v1/admin/stats` → `{ users, courses, questions,
simulationSessions, orders, revenueCents }`
  - `GET /api/v1/admin/users?cursor=&limit=&q=` → users with `roles`
    (email/name ILIKE search)
  - `GET /api/v1/admin/users/:id` → summary (roles, orders +
    paidCents, sim sessions + bestScore)
  - `PATCH /api/v1/admin/users/:id/status` — `{ status: "active" |
"suspended" }` (idempotent; self-suspension → 400; audit trailed)
- **Auth:** access cookie + CSRF + `roles.includes("admin")`.
- **Constraints:** suspended users → `403 ACCOUNT_SUSPENDED` on login
  AND refresh (checked after credential verification); content
  moderation reuses existing soft-delete/restore endpoints.
- **Frontend (admin):** users table with search + status badges, detail
  drawer, suspend/activate actions, content list views.

## B10. Tier 2 & 3 (summary of planned endpoints)

| Feature                    | Planned endpoints                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Scheduled tryouts ✅    | `GET /api/v1/simulations/tryouts` (published + `scheduled_at` set, cursor-paginated by window); `POST /packages`/`PATCH` accept `scheduledAt`/`closesAt` (ISO or null); `startSession` windowed: `403 TRYOUT_NOT_STARTED` (`details.startsAt`) / `403 TRYOUT_EXPIRED` (`details.closesAt`)                                       |
| A2 Per-category scoring ✅ | `scoring.perCategory: { [category]: {correct, blank, wrong} }` on packages; `gradeSession` computes score + maxScore per question category (base fallback)                                                                                                                                                                       |
| A3 Question Q&A ✅         | `GET /api/v1/questions/:id/thread` (question + visible replies w/ author + upvotes); `POST /questions/:id/replies` (≤4000 chars); `POST /replies/:id/upvote` (idempotent); `POST /admin/replies/:id/hide` (moderation); tables `question_replies`, `reply_upvotes`                                                               |
| A4 Question search ✅      | `GET /api/v1/questions?q=` — case-insensitive ILIKE over text + explanation, combinable with `category`/`tag`                                                                                                                                                                                                                    |
| A5 Learning paths ✅       | `GET /api/v1/paths` (published + courseCount); `GET /paths/:id` (ordered courses + `enrolled` + `progress`); `POST /paths/:id/enroll` (idempotent); mentor `POST /paths` / `PATCH /paths/:id`; tables `learning_paths`, `path_courses`, `path_enrollments`                                                                       |
| A6 Mistakes bank ✅        | `GET /api/v1/results/mistakes` (auth) — distinct wrong questions across graded sessions with `wrongCount` + `lastWrongAt` + tags, cursor-paginated; retry via practice `questionIds`                                                                                                                                             |
| A7 Leaderboard periods ✅  | `GET /api/v1/simulations/leaderboard?packageId=&period=week                                                                                                                                                                                                                                                                      | month                                                                                                                                                                                                                                                            | all&friends=true`(friends via`follows`); personal rank in `meta.leaderboard.personalRank`; `POST /api/v1/users/:id/follow`, `DELETE /users/:id/follow`, `GET /users/me/following` |
| A8 Coupons/bundles ✅      | `POST /api/v1/payments/coupons` + `GET /payments/coupons` (mentor/admin; normalized uppercase code, percentOff 1–100, maxUses/courseId/expiresAt); `POST /payments/orders` accepts `{ courseId                                                                                                                                   | bundleId, couponCode? }`; `GET /payments/bundles`(published) +`GET /bundles/:id`; `POST /payments/bundles`/`PATCH /bundles/:id`(course replacement); fulfillment enrolls every bundle course; coupon errors:`COUPON_INVALID`/`COUPON_EXPIRED`/`COUPON_EXHAUSTED` |
| A9 Analytics events ✅     | `analytics_events` table written by event-bus subscribers (register, verify, session-start, results-viewed, order-paid); admin `GET /admin/analytics/summary` (per-event totals) + `GET /admin/analytics/cohort?days=14` (D7 retention per day)                                                                                  |
| A10 Content quality ✅     | `questions.source` (jsonb `{origin, year?}`) + `reviewStatus` (draft/in_review/published) on create/update/import (JSON + CSV `source_origin`/`source_year`/`review_status`); admin `GET /admin/questions/stats/tag-accuracy` (per-tag attempts/correct/accuracy from graded answers); duplicate detection via content hash (M7) |
| N1 Daily challenge ✅      | `GET /api/v1/challenges/today` (pinned or random question, no correct flags), `GET /api/v1/challenges/streak` (consecutive days with practice answer), `POST /api/v1/admin/challenges/today` (pin question); streak computed from practice answer dates                                                                          |
| N2 Notes ✅                | `GET /api/v1/questions/:id/note`, `PUT /questions/:id/note` (upsert, ≤4000), `DELETE /questions/:id/note`; `GET /api/v1/users/me/notes` (cursor-paginated with question text); table `question_notes` with unique(userId, questionId)                                                                                            |
| N3 Explain videos ✅       | `questions.video_key` column; `GET /sessions/:id/review` returns per-question `videoUrl` (presigned GET from S3); `POST`/`PATCH /questions` accept `videoKey`                                                                                                                                                                    |
| N4 Banding ✅              | `GET /api/v1/results/banding` (auth) — `{sessions, averageScore, bestScore, averagePercentile, percentileRange, band}` from graded simulation sessions (404 when none)                                                                                                                                                           |
| N5 Time analytics ✅       | `GET /api/v1/results/time-analysis` (auth) — `{totalAnswers, answered, avgTimePerQuestionMs, flaggedRate, perCategory[]}` from M3 `timeSpentMs`/`isFlagged` data                                                                                                                                                                 |
| N7 Certificates ✅         | `certificates` table; `GET /api/v1/certificates/mine` (lazy issue on 100% completion; unique number AYO-…); PDF worker deferred                                                                                                                                                                                                  |
| N8 Wishlist ✅             | `POST /api/v1/courses/:id/wishlist`, `DELETE /courses/:id/wishlist` (idempotent), `GET /api/v1/courses/wishlist` (with course details)                                                                                                                                                                                           |
| N9 Gamification ✅         | `points_events` + `badges` + `user_badges`; automatic points on 6 events (10/20/5/50/2/30); `POST /api/v1/admin/badges`; `GET /users/me/points`, `GET /users/me/badges`                                                                                                                                                          |

---

## C. How to use this document

1. **Frontend developers:** implement Part A strictly (they are the shipped
   contract). For Part B, design UI against the proposed endpoints and
   flag any mismatch during the implementing PR review.
2. **Backend developers:** when implementing a planned feature, update its
   spec here in the SAME PR (flow + constraints + response shapes) — the
   spec becomes normative at merge.
3. **Onboarding:** read `docs/architecture/API-CONVENTIONS.md` (contract) →
   this document (features) → `docs/architecture/ARCHITECTURE.md` (how it's built).
4. Keep cross-cutting rules (CSRF on mutations, idempotency on creates,
   cursor pagination on lists, `Retry-After` on 429s) consistent with the
   conventions doc — never duplicate them here.
