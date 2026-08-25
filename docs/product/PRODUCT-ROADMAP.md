# Ayo-SNBT Backend Feature Roadmap (SNBT-Simulation Focused)

> **Scope change:** frontend development is **excluded from the current scope**
> (the frontend plan at `docs/product/FRONTEND-PLAN.md` is marked DEFERRED and stays
> as the spec for when UI work begins). This roadmap is **backend-first**:
> we expand platform capabilities through the API, inspired by how Udemy
> (courses), LeetCode (practice), Brainly (community Q&A), and classic LMS
> platforms structure learning products — adapted to our objective:
> **SNBT simulation-based exam prep**.

---

## 1. The product loop (every feature strengthens one step)

**Learn** (courses/videos) → **Practice** (untimed drills) → **Simulate**
(timed tryouts) → **Review** (pembahasan of mistakes) → **Improve**
(analytics/weak areas). Features are tiered by how much they close this loop.

---

## 2. Inspiration map (what we borrow and where it lands)

| Pattern from  | What it gives us                                                                                                  | Our feature                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Udemy         | sections/lectures, course progress, completion, coupons, wishlist                                                 | M8, A5, A8, N7, N8             |
| LeetCode      | topic tags, instant judge feedback, daily challenge, contests, editorials, study plans, streaks                   | M2, M3, M6, A1, A6, N1, N2, A5 |
| Brainly       | per-question Q&A, expert answers, moderation                                                                      | A3, M9                         |
| LMS           | attempt policies, scheduled assessments, gradebook/history, announcements                                         | M4, M5, A1, M5                 |
| SNBT-specific | exam-authentic behavior (flag for review, question map, time discipline, subtest weights, national-style scoring) | M3, A2, A4, N4, N5             |

---

## 3. TIER 1 — MUST ADD (core loop + exam-authentic experience)

These complete the product loop and make simulations feel like the real exam.
Ship them in this order (dependency-aware).

### M0. Database schema decomposition (models per slice)

- **Why:** all 19 tables live in one 304-line file
  (`src/shared/db/schema/index.ts`); every slice touches it and review
  conflicts grow with the team. Split it into per-slice model files before
  adding the tables/columns M2–M9 introduce.
- **Backend:** split into `users.ts`, `auth.ts`, `outbox.ts`,
  `courses.ts`, `videos.ts`, `questions.ts`, `simulations.ts`,
  `payments.ts`, `audit.ts` + a re-export barrel `index.ts` (keeps all
  18 importers and `drizzle.config.ts` untouched). Pure reorganization —
  no column changes, no `relations()`; cross-file FKs via imports.
  Future tables (notifications, tags, coupons, tryout_schedules) go into
  their slice's file.
- **Acceptance:** `npm run db:generate` produces **no new migration**;
  all gates green; `GETTING-STARTED.md` "Add a table?" guidance updated.
- **Effort:** S (1–2 pd).

### M1. Review & Pembahasan (was F2)

- **Why:** after grading, students only see a score — they cannot learn from
  mistakes. `questions.explanation` and per-answer `is_correct` are
  already stored but never surfaced. **This is the single biggest product gap.**
- **Backend:** `GET /api/v1/simulations/sessions/:id/review` (owner-only,
  404 cross-user, `400 NOT_GRADED` before grading) returning per question:
  question + options (with correct flags), selectedOptionId, isCorrect,
  explanation. No answer leak before grading (tests assert it).
- **Effort:** S (1–2 pd). **Tests:** ownership, NOT_GRADED, no-leak, flags match grade.

### M2. Practice mode with instant feedback (was F3)

- **Why:** students need untimed drilling by category/difficulty before
  committing to a timed tryout (LeetCode-style instant judge feedback).
- **Backend:** `POST /api/v1/practice/start {category?, difficulty?, count?,
questionIds?}` → `{practiceId, questions}` (no correct flags);
  `POST /api/v1/practice/:id/answer {questionId, selectedOptionId}` →
  `{isCorrect, correctOptionIds, explanation}`;
  `GET /api/v1/practice/:id` (progress). Persist via
  `simulation_sessions.type = 'practice'` (column added in M0) so analytics
  cover both modes.
- **Effort:** M (3–4 pd).

### M3. Exam-authentic session mechanics (flag, question map, time discipline)

- **Why:** the real SNBT UI lets you flag questions, jump around a question
  map, and see time pressure; our session model only stores final answers.
- **Backend:** add to `simulation_answers`: `isFlagged boolean`,
  `timeSpentMs integer`; extend the session payload
  (`GET /sessions/:id`) with per-question `{answered, flagged,
timeSpentMs}`; `PATCH /sessions/:id/answers/:qid/flag {isFlagged}`;
  server-side warning threshold in session (`warnAtRemainingMs`, configurable
  on the package).
- **Effort:** M (3 pd). **Tests:** flag persistence, time accumulation,
  warning threshold in session response.

### M4. Attempt policy per package (LMS-grade) ✅ (done)

- **Why:** unlimited retakes make tryouts meaningless; schools/mentors need
  control (e.g. 1 official attempt, practice unlimited).
- **Backend:** `simulation_packages.maxAttempts int null` (null =
  unlimited), `retakeCooldownMinutes int null`; enforced in
  `startSession` (`403 ATTEMPT_LIMIT_REACHED` with
  `{attemptsUsed, maxAttempts, retryAfter}`); per-package attempt count in
  `GET /sessions` (mine) response.
- **Effort:** S–M (2–3 pd).

### M5. Notifications module (was F5) ✅ (done)

- **Why:** users don't know results are ready or courses are published —
  the README-planned `notifications` module was never built.
- **Backend:** `notifications` table + slice:
  `GET /notifications` (cursor), `GET /notifications/unread-count`,
  `POST /notifications/:id/read`, `POST /notifications/read-all`;
  event-bus subscribers create rows for `simulation.graded` (new event
  emitted by gradeSession), `course.published`, `order.fulfilled`;
  email subset via the reserved `notification` BullMQ queue.
- **Effort:** M (3–4 pd).

### M6. Question tags + topic drilling (LeetCode-grade) ✅ (done)

- **Why:** category alone is too coarse (e.g. "TPS_PK"); students want
  "perbandingan", "aljabar", "geometri". Tags power M2 and analytics.
- **Backend:** `question_tags` + `tags` tables (many-to-many);
  filter `GET /questions?tag=`; tags in question payloads; package
  `questionCounts` can target a tag (`{tag: "aljabar": 5}`).
- **Effort:** M (3–4 pd).

### M7. Bulk question import (CSV) with validation report ✅ (done)

- **Why:** content velocity is the moat; manual creation can't scale.
- **Backend:** `POST /api/v1/admin/questions/import` (multipart CSV:
  text, category, difficulty, tags, options + correct, explanation) →
  `{imported, failed: [{row, errors}]}`; dry-run mode; idempotent via a
  content hash; audit + events per created question.
- **Effort:** M (3–4 pd).

### M8. Course completion, progress summary & enrollment visibility ✅ (done)

- **Why:** students can't see course progress, completion is a retention
  hook, AND the frontend has no way to identify which courses a user is
  enrolled in (the table `course_enrollments` covers it, the API does not —
  `coursesService.isEnrolled` exists but is only used internally by chat).
- **Backend:**
  - `GET /courses/:id/progress` gains
    `{completedLessons, totalLessons, percentComplete, completedAt}`
    (`completedAt` derived from lesson progress rows).
  - **New** `GET /api/v1/courses/mine?cursor=&limit=` (authGuard) —
    cursor-paginated enrolled courses with course fields + progress rollup
    - `enrolledAt`/`expiresAt`. Route must be declared BEFORE
      `/courses/:id` so it isn't shadowed.
  - **New** `enrolled: boolean` on catalog rows (`GET /courses`) and on
    detail (`GET /courses/:id`) when authenticated (route already uses
    optionalAuth) — batch with ONE `IN` query on `course_enrollments`
    per page (no N+1).
- **Effort:** S (1–2 pd).

### M9. Admin content moderation (scoped admin slice) ✅ (done)

- **Why:** operations needs user + content management; README's `admin`
  module was never built.
- **Backend:** `GET /admin/users?cursor=&q=`, `GET /admin/users/:id`
  (summary), `PATCH /admin/users/:id/status` (suspend/activate — enforce in
  auth guard), content list views (reuse soft-delete endpoints), question
  quality view (missing explanations).
- **Effort:** M (3–4 pd).

### M10. Enabling work (do with M1–M9, not standalone)

- `FRONTEND_URL` env for email templates (currently hardcoded
  `localhost:3000`).
- `simulation.graded` event emission in `gradeSession`.
- `simulation_sessions.type` column ('simulation' | 'practice').
- Notification queue consumer in `worker.ts`.
- **Effort:** S (1 pd) total.

---

## 4. TIER 2 — ADDITIONAL (high value, larger effort)

| #   | Feature                                       | Why / inspiration                                                           | Backend scope                                                                                                                                                                                                                             | Effort     |
| --- | --------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1  | **Scheduled official tryouts** ✅             | LeetCode contests / real SNBT: everyone starts together; countdown to start | `tryout_schedules` table (`{packageId, startsAt, endsAt, title}`); `POST /tryouts/:id/register`, `GET /tryouts/upcoming`; startSession validates window (`403 TRYOUT_NOT_STARTED` / `EXPIRED`); auto-submit at endsAt (reuse delayed job) | M (4 pd)   |
| A2  | **Per-category scoring weights** ✅           | SNBT subtests score differently; scoring is currently package-level         | extend `scoring` JSONB: `{correct:4, wrong:0, blank:0, perCategory:{TPS_PK:{correct:5,…}}}`; gradeSession resolves per question; document the formula in result payload                                                                   | S–M (2 pd) |
| A3  | **Question Q&A (Brainly-lite)** ✅            | Community explanations; mentor-verified answers                             | `question_threads` + `thread_replies` (polymorphic or per-question); reply upvotes; mentor "verified" flag; moderation (report/flag + hide)                                                                                               | L (6 pd)   |
| A4  | **Question search** ✅                        | Find questions by text/tags                                                 | `GET /questions?q=` with ILIKE on text + tag filter; later pg_trgm index; paginate with cursors                                                                                                                                           | S (1–2 pd) |
| A5  | **Learning paths / study plans** ✅           | Udemy curricula + LeetCode study plans; time-to-exam generator              | `paths` + `path_items` (ordered references to packages/courses); `GET /paths`, `POST /paths/:id/enroll` (reuses enrollments), `GET /paths/:id` with progress rollup                                                                       | M (4 pd)   |
| A6  | **Mistakes bank + retry** (was F8) ✅         | LeetCode submissions; reuse F2 review data                                  | `GET /results/mistakes` (distinct wrong questions, cursor); retry via M2 practice with `questionIds`                                                                                                                                      | M (2–3 pd) |
| A7  | **Leaderboard periods + friends** (was F9) ✅ | engagement; ranking feels stale weekly                                      | `GET /leaderboard?period=week                                                                                                                                                                                                             | month      | all`; `follows` table + friends-only filter; personal rank in result payload                                                                                     | S–M (2–3 pd) |
| A8  | **Coupons & bundles** (was F12/F13) ✅        | monetization                                                                | `coupons` (`{code, percentOff, maxUses, expiresAt, courseId?}`) applied at order creation; `bundles` (multiple courseIds, price) + fulfillment enrolls all                                                                                | M (4 pd)   |
| A9  | **Product analytics events** (was F11) ✅     | measure activation/retention funnels                                        | `analytics_events` table written by event-bus subscribers (register, verify, first-session, results-viewed, order-paid); admin summary endpoints for cohort/D7                                                                            | M (3 pd)   |
| A10 | **Content quality workflow** ✅               | scale content responsibly                                                   | question `source` (`{origin: "utbk-2023"                                                                                                                                                                                                  | "tryout-1" | "custom", year?}`), `reviewStatus` (draft/in_review/published), duplicate detection (text hash), difficulty calibration (per-tag accuracy stats from M2/M1 data) | M (4 pd)     |

---

## 5. TIER 3 — NICE-TO-HAVE (differentiators; opportunistic)

| #   | Feature                                                 | Backend scope                                                                                                                                              | Effort |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| N1  | **Daily challenge (soal harian) + streaks** (was F7) ✅ | `daily_challenges` (question per day, rotation); `GET /challenges/today`, submit via M2; streak = consecutive days with ≥1 practice answer (existing data) | S–M    |
| N2  | **Personal notes per question** ✅                      | `question_notes` (`{userId, questionId, body}`) + CRUD                                                                                                     | S      |
| N3  | **Explanation videos per question** ✅                  | `questions.videoKey` + presigned link in review payload (reuse video slice)                                                                                | S      |
| N4  | **Predicted score banding** ✅                          | estimate percentile band from graded sessions (`results/banding`); simple: reuse percentile distribution + difficulty weights                              | S      |
| N5  | **Time-usage analytics** ✅                             | avg time/question, flagged rate, per-category timing (uses M3 data) — `results/time-analysis`                                                              | M      |
| N6  | **On-screen tools** (calculator, notepad)               | mostly frontend; backend only stores per-session scratchpad if wanted                                                                                      | S      |
| N7  | **Certificates of completion** ✅                       | `certificates` (`{userId, courseId, issuedAt, number}`) generated on 100% completion (M8), PDF via worker                                                  | M      |
| N8  | **Course wishlist** ✅                                  | `wishlist` table + toggle endpoints                                                                                                                        | S      |
| N9  | **Gamification points/badges** ✅                       | points rules table + badge definitions; award via event bus                                                                                                | M      |
| N10 | **i18n**                                                | content stays Indonesian; API error messages keyed by code (frontend concern — defer)                                                                      | —      |

---

## 6. Investigation queue (non-feature engineering)

Engineering investigations that must happen but are not user features. They
can run in parallel with Tier 1 — the chat slice is independent of M0–M10.

### I1. MongoDB high-CPU investigation

- **Symptom:** MongoDB CPU consistently reaches >90% under real usage.
- **Why now:** chat is the only Mongo consumer; production traffic makes it
  the next bottleneck. Investigate before it becomes an outage.
- **Current usage (verified in code):** one shared client
  (`getChatDb`, `serverSelectionTimeoutMS: 2000`, `discardMongoClient()`
  on error); two collections (`chat_rooms`, `chat_messages`); indexes
  ensured at boot (messages `{roomId, seq}` both directions incl. unique,
  rooms `{courseId}` partial unique, `{memberIds}`, `{lastMessageAt}`);
  per-message pattern = `nextRoomSeq` (`findOneAndUpdate $inc lastSeq` on
  the room doc) + message insert + room update (`$set lastMessageAt` +
  `$inc unreadCounts.<member>` for EVERY member except sender).
- **Ranked hypotheses (to validate, not assume):**
  - **H1 — Unbounded growth / working set:** no TTL index on
    `chat_messages.createdAt`, no archival job; once messages exceed RAM,
    WiredTiger pages to disk → CPU spikes.
  - **H2 — Unread-count write amplification:** one message in a large room
    rewrites the room document with one `$inc` per member; large rooms →
    document bloat + heavy writes per message.
  - **H3 — Per-message seq contention:** every message serializes on the
    room document's `$inc lastSeq`; hot rooms become a single-document
    write bottleneck.
  - **H4 — Missing/hot index:** verify with `explain()` on the real query
    shapes (history `{roomId, seq < N}` desc, my-rooms `{memberIds}`,
    markRead `{_id}` + `unreadCounts.<uid>` set).
  - **H5 — Config/deployment:** standalone (no replica set → no read
    scaling), WiredTiger cache sizing, disk type, connection pool defaults.
  - **H6 — Connection churn:** `discardMongoClient` + dev watcher restarts
    create clients repeatedly; verify `currentOp` connection counts.
- **Measurement plan (first 1–2 days, no code changes):**
  - `mongostat`/`mongotop` during a traffic window; `db.serverStatus()`
    (page faults, globalLock, opcounters); `db.currentOp()` for slow ops.
  - `db.chat_messages.stats()` + `db.chat_rooms.stats()` (sizes,
    avgDocSize, index sizes); room-size distribution query
    (`memberIds` array lengths).
  - `explain("executionStats")` on history / my-rooms / markRead / unread
    queries; enable profiling level 1 (`slowms: 100`) for one hour.
  - Correlate CPU with message rate + room sizes (aggregation on
    `chat_messages` by hour/room).
- **Fix candidates (decide AFTER measurement, cheapest first):**
  1. TTL index on `chat_messages.createdAt` (+ archival policy question:
     keep window vs export-to-object-storage job).
  2. Move unread counts off the room document (separate
     `room_members` collection with `{roomId, userId, lastReadSeq,
unreadCount}` or compute on read from lastReadSeq vs room.lastSeq) —
     removes per-member `$inc` write amplification.
  3. Dedicated counters collection for `nextRoomSeq` (decouples seq from
     the room doc; same per-room atomicity, less write amplification).
  4. Batch/pipeline message persistence (insert + room update in one
     transaction-free bulk op where possible).
  5. Config: WiredTiger cache sizing, replica set for read scaling,
     connection pool tuning, dedicated volume.
  6. Cap room membership / paginate member writes.
- **Deliverable:** investigation report — measured root cause, ranked fixes
  with effort, and a decision record: keep Mongo with fixes, or migrate chat
  to Postgres (ADR if so; chat data model is small — rooms/messages/seq fit
  relational storage). Apply the cheap wins (TTL, unread redesign) in the
  same sprint the report lands.
- **Effort:** investigation S–M (2–3 pd) + fixes M (3–5 pd).

---

## 7. Sequencing plan

```text
Sprint 1  M0 schema decomposition → M1 review → M10 enabling (incl. simulation_sessions.type)
Sprint 2  M2 practice → M3 exam mechanics
Sprint 3  M5 notifications → M4 attempt policy → M6 tags
Sprint 4  M7 import → M8 completion → M9 admin (scoped)
Sprint 5+  Tier 2 in order: A1 tryouts → A2 scoring → A3 Q&A → A5 paths →
           A6 mistakes → A7 leaderboard → A8 coupons/bundles → A9 analytics → A10 content quality
Parallel   Tier 3 opportunistically (N1/N2/N3 are small)
```

I1 (MongoDB CPU investigation) runs in parallel from Sprint 1 — chat is
independent of the M-slice work; cheap wins (TTL index, unread redesign)
land as soon as the report is written.

Every sprint ends with: backend tests green, API contract documented
(`docs/architecture/API-CONVENTIONS.md` + domain docs), metrics defined for the feature.

---

## 8. Definition of done (unchanged from previous roadmap)

1. Migration (if any) + API + integration tests covering normal AND edge cases
   (per `docs/guides/TESTING.md` standard) + error codes added to the catalog.
2. Domain doc updated; `docs:check` green.
3. Gates green: lint, typecheck, build, unit + integration tests.
4. Metrics defined before implementation and reported after release.

---

## 9. Anti-features (explicit non-goals)

- **Frontend development** (deferred — see `docs/product/FRONTEND-PLAN.md` status)
- Flashcard/spaced-repetition engine
- Live proctored exams / remote supervision
- Social network features beyond leaderboard friends
- Mentor marketplace / third-party course sales
- Native mobile apps
- Real-time collaboration (multi-user whiteboard etc.)

---

## 10. Risks & mitigations

| Risk                                       | Mitigation                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Backend-only releases feel invisible       | Ship with curl-able API demos + Postman/bruno collection; metrics prove progress; frontend stays one decision away |
| Answer-leak regressions in review/practice | owner-scoped + graded-only endpoints; integration tests asserting no-leak before grading                           |
| Content volume (thousands of questions)    | M7 import + M10 quality workflow; tags drive drilling value                                                        |
| A1 tryouts add scheduling complexity       | Reuse existing delayed-job pattern (auto-submit) for endsAt; keep v1 simple (single timezone)                      |
| Attempt policy mistakes hurt users         | default null (unlimited); explicit per-package opt-in; clear error codes with retryAfter                           |
