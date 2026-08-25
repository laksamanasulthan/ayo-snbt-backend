# Video Pipeline (HLS)

Zero-copy upload + server-side transcode to HLS, streamed via 307 redirects
to presigned S3 URLs. Slice: `src/modules/video/`.

## Upload flow

```
POST /videos                     → creates record (status: uploaded)
POST /videos/:id/upload-url      → presigned PUT for the raw file (contentType validated)
   (client PUTs the file straight to S3 — zero API bandwidth)
POST /videos/:id/confirm         → status: processing + enqueue transcode job
[worker] ffprobe → ffmpeg HLS renditions → S3 → status: ready
```

- Allowed content types: `video/mp4`, `video/quicktime`, `video/webm`,
  `video/x-matroska`. Anything else → `400 BAD_CONTENT_TYPE`.
- Extension derived from content type (`.mov`, `.mkv`, `.mp4`, `.webm`);
  raw file stored at `videos/<id>/raw/input.<ext>`.
- `confirm` without a prior presign → `400` ("No raw file uploaded yet").
- `confirm` twice → `202` with `alreadyQueued: true` (jobId dedupe).
- Upload/transcode require `video:upload` / `video:transcode`
  permissions (mentor, admin; students can upload per seed).

## Transcode pipeline (`transcode.ts`)

1. `ffprobe` the raw file (source height).
2. `planRenditions(sourceHeight)` picks up to 3 renditions (e.g. 1080p,
   720p, 480p; never upscales).
3. `ffmpeg` produces per-rendition HLS (m3u8 + ts segments) — runs in the
   **ffmpeg worker image** (`docker/Dockerfile.worker-ffmpeg`).
4. Uploads the playlist/segments to S3 (`S3_BUCKET_VIDEOS`), records
   `hlsPrefix` + `masterPlaylistKey`, sets `status: ready`.
5. Failures: job retries (BullMQ backoff); the video stays `processing`
   with `error` recorded.

## Streaming (auth-checked redirects)

```
GET /videos/:id/master.m3u8      → gate → 307 → presigned GET (master playlist)
GET /videos/:id/segments/*       → gate → 307 → presigned GET (segment)
```

`assertCanStream(userId, videoId, roles)`:

| Case                                      | Result                      |
| ----------------------------------------- | --------------------------- |
| video missing / deleted                   | 404                         |
| video not `ready` (or no master playlist) | 400 `VIDEO_NOT_READY`       |
| attached only to free lessons             | allow (everyone)            |
| attached to paid lessons, user enrolled   | allow                       |
| course owner / admin                      | allow                       |
| unenrolled student                        | 403 `ENROLLMENT_REQUIRED`   |
| not attached to any lesson (orphan)       | mentor/admin only, else 403 |

Segment security: the path must match
`^[a-zA-Z0-9_/-]+\.(ts|m3u8|m4s|mp4)$` — anything else → `400 BAD_SEGMENT_PATH`.
Dot-segment traversal is additionally neutralized by URL normalization before
routing (never a 200, never a 500, redirect targets stay under the video's
`hlsPrefix`).

Rate limits: master 120/min, segments 300/min per route bucket.

## Presigning

`presignPut` / `presignGet` (`shared/s3/client.ts`), TTL
`S3_PRESIGN_TTL_SECONDS` (120 s default). Buckets: `S3_BUCKET_VIDEOS`,
`S3_BUCKET_IMAGES` (avatars via `users/me/avatar-upload-url`).

## Testing

Edge coverage in `tests/integration/video-edge.test.ts`:
content-type guard, idempotent confirm, not-ready/deleted/enrollment gates,
traversal attempts, safe segment streaming. Transcode integration (real
ffmpeg) lives in `tests/integration/phase3.test.ts`.
