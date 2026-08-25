# Queueing (BullMQ)

Background work runs on Redis-backed BullMQ queues consumed by the worker
process (`src/worker.ts`, image `docker/Dockerfile.worker-ffmpeg` for
transcode). Queue infrastructure lives in `src/shared/queue/queues.ts`.

## Queues

| Queue (`QueueName`) | Producer       | Consumer / processor                        | Payload examples                              |
| ------------------- | -------------- | ------------------------------------------- | --------------------------------------------- |
| `email`             | auth, payments | `worker.ts` → `sendMail` + `renderEmailJob` | verify-email, reset-password, payment-receipt |
| `notification`      | (reserved)     | —                                           | —                                             |
| `grading`           | simulations    | `processGradingJob`                         | grade, auto-submit                            |
| `leaderboard`       | (reserved)     | —                                           | —                                             |
| `transcode`         | video          | `processTranscodeJob` (ffmpeg)              | HLS renditions                                |
| `payment`           | payments       | `processPaymentJob`                         | fulfill                                       |

Only queues with consumers are worked in `src/worker.ts`; `notification`
and `leaderboard` are reserved for future work.

## Default job options

```ts
{
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 3600 * 24 },   // 1 day
  removeOnFail: { age: 3600 * 24 * 7 }    // 1 week (debugging window)
}
```

Failed jobs retry with exponential backoff (BullMQ built-in); after 5
attempts the job fails and `worker.ts` logs `job failed` with the job id.

## How to enqueue

```ts
import { QueueName, enqueue } from "../../shared/queue/queues.js";

const jobId = await enqueue(
  QueueName.Grading,
  { type: "grade", sessionId },
  {
    delay: 5_000, // optional
    jobId: "auto-submit-" + sessionId // optional — dedupes identical jobs
  }
);
// jobId is null when enqueue failed (Redis down) — caller must handle it
```

- **`jobId` dedupe**: two enqueues with the same `jobId` while the first is
  pending/active are collapsed into one (used by auto-submit and transcode
  confirm).
- **Degradation**: `enqueue` catches Redis errors and returns `null`; callers
  fall back (e.g. simulations reject the request when grading cannot be
  scheduled, payments rely on the webhook idempotency replay).

## Job flows

### Simulation auto-submit (delayed)

1. `startSession` enqueues `{ type: "auto-submit", sessionId }` with
   `delay: durationMinutes * 60_000 + 5_000` and
   `jobId: "auto-submit-" + sessionId`.
2. The worker's `processGradingJob` submits + grades the session when the
   deadline passes — grading is guaranteed even if the student never submits.
3. Lazy path: if the student saves an answer AFTER the deadline, the service
   grades inline and returns `SESSION_EXPIRED`.

### Video transcode

1. `confirmUpload` marks the video `processing` and enqueues
   `{ videoId, rawKey }` with `jobId: "transcode-" + videoId` (idempotent
   confirm).
2. `processTranscodeJob` → ffprobe → ffmpeg HLS renditions → upload to S3 →
   `status: ready` + `masterPlaylistKey`/`hlsPrefix`.
3. On failure the job retries (backoff); the video stays `processing` with
   the error recorded, and streaming returns `VIDEO_NOT_READY` until fixed.

### Payment fulfillment

1. Webhook marks the order `paid` and enqueues `{ type: "fulfill", orderId }`
   with `jobId: "pay-fulfill-" + orderId`.
2. `processPaymentJob` enrolls the user (`onConflictDoNothing`), sends the
   receipt email, marks the order `fulfilled`.
3. The processor is defensive: an order that is not `paid` is skipped (no
   double enrollment, no duplicate emails).

## Worker operation

```bash
npm run dev:worker          # local (tsx watch)
docker compose up -d --scale worker=2   # prod: more consumers
```

- Each worker registers the four consumers with `concurrency: 5` per queue.
- Graceful shutdown on SIGTERM/SIGINT (`worker.close()` waits for running
  jobs).
- Transcode jobs should run on the ffmpeg image (ffmpeg/ffprobe binaries);
  the API image does not bundle them for production.

## Testing note

Integration tests capture enqueues via `vi.mock` of
`shared/queue/queues.js` (auth suites) or let jobs sit in Redis unprocessed
(no worker started in tests) — grading is invoked directly through
`simulationsService.gradeSession`. See [TESTING.md](../guides/TESTING.md).
