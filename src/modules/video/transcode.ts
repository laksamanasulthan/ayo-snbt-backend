import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import ffmpegPath from "ffmpeg-static";

import ffprobeStatic from "ffprobe-static";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { videos } from "../../shared/db/schema/index.js";
import { getS3Client } from "../../shared/s3/client.js";
import { getEnv } from "../../config/index.js";
import { getLogger } from "../../shared/logger.js";

const execFileAsync = promisify(execFile);
const log = getLogger();

interface ProbeResult {
  durationSeconds: number;
  height: number;
}

function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH ?? (ffmpegPath as unknown as string | null) ?? "ffmpeg";
}

function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH ?? ffprobeStatic.path ?? "ffprobe";
}

const MIME: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".jpg": "image/jpeg",
  ".png": "image/png"
};

async function probe(inputPath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(ffprobeBinary(), [
    "-v", "error",
    "-show_entries", "format=duration:stream=height",
    "-of", "json",
    inputPath
  ]);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { height?: number }[] };
  const durationSeconds = Math.round(Number(parsed.format?.duration ?? 0));
  const height = parsed.streams?.find((s) => s.height)?.height ?? 720;
  return { durationSeconds, height };
}

interface Rendition {
  label: string;
  width: number;
  bitrate: string;
}

function planRenditions(sourceHeight: number): Rendition[] {
  // Always produce at least 360p; add higher renditions only when the
  // source is tall enough (no silly upscaling).
  const plans: Rendition[] = [{ label: "360p", width: 640, bitrate: "800k" }];
  if (sourceHeight >= 480) plans.push({ label: "480p", width: 854, bitrate: "1400k" });
  if (sourceHeight >= 720) plans.push({ label: "720p", width: 1280, bitrate: "2800k" });
  if (sourceHeight >= 1080) plans.push({ label: "1080p", width: 1920, bitrate: "5000k" });
  return plans;
}

async function transcodeOne(inputPath: string, outDir: string, rendition: Rendition): Promise<void> {
  const renditionDir = join(outDir, rendition.label);
  await import("node:fs/promises").then((fs) => fs.mkdir(renditionDir, { recursive: true }));
  await execFileAsync(ffmpegBinary(), [
    "-y",
    "-i", inputPath,
    "-vf", "scale=" + rendition.width + ":-2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "96k",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", join(renditionDir, "seg_%03d.ts"),
    join(renditionDir, "index.m3u8")
  ]);
}

function buildMasterPlaylist(renditions: string[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const label of renditions) {
    lines.push("#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720");
    lines.push(label + "/index.m3u8");
  }
  return lines.join("\n") + "\n";
}

async function uploadDirToS3(dir: string, prefix: string, bucket: string): Promise<number> {
  const s3 = getS3Client();
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(dir);
  // Upload with modest concurrency
  const concurrency = 4;
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (file) => {
        const rel = file.slice(dir.length + 1).replace(/\\/g, "/");
        const ext = "." + basename(file).split(".").pop();
        const contentType = MIME[ext] ?? "application/octet-stream";
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: prefix + "/" + rel,
            Body: createReadStream(file),
            ContentType: contentType
          })
        );
      })
    );
  }
  return files.length;
}

async function downloadFromS3(bucket: string, key: string, dest: string): Promise<void> {
  const s3 = getS3Client();
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error("Empty S3 body");
  const body = res.Body as import("node:stream").Readable;
  const out = createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    body.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    body.on("error", reject);
  });
}

export interface TranscodeJobData {
  videoId: string;
  rawKey: string;
}

/**
 * BullMQ transcode processor: download raw → probe → HLS renditions →
 * upload to S3 → update DB status. BullMQ retries with exponential backoff.
 */
export async function processTranscodeJob(data: TranscodeJobData): Promise<void> {
  const env = getEnv();
  const db = getDb();
  const workDir = await mkdtemp(join(tmpdir(), "asbt-transcode-"));
  const inputPath = join(workDir, "input.mp4");
  try {
    log.info({ videoId: data.videoId, rawKey: data.rawKey }, "transcode: downloading raw");
    await downloadFromS3(env.S3_BUCKET_VIDEOS, data.rawKey, inputPath);

    const info = await probe(inputPath);
    log.info({ videoId: data.videoId, ...info }, "transcode: probed");

    const renditions = planRenditions(info.height);
    for (const r of renditions) {
      await transcodeOne(inputPath, workDir, r);
      log.info({ videoId: data.videoId, rendition: r.label }, "transcode: rendition done");
    }

    // Master playlist
    const master = buildMasterPlaylist(renditions.map((r) => r.label));
    await import("node:fs/promises").then((fs) => fs.writeFile(join(workDir, "master.m3u8"), master));

    // Poster frame at 1s
    await execFileAsync(ffmpegBinary(), ["-y", "-i", inputPath, "-ss", "1", "-vframes", "1", join(workDir, "poster.jpg")]);

    const hlsPrefix = "videos/" + data.videoId + "/hls";
    await uploadDirToS3(workDir, hlsPrefix, env.S3_BUCKET_VIDEOS);
    const masterKey = hlsPrefix + "/master.m3u8";
    const posterKey = hlsPrefix + "/poster.jpg";

    await db
      .update(videos)
      .set({
        status: "ready",
        hlsPrefix,
        masterPlaylistKey: masterKey,
        posterKey,
        durationSeconds: info.durationSeconds,
        error: null,
        updatedAt: new Date()
      })
      .where(eq(videos.id, data.videoId));
    log.info({ videoId: data.videoId, renditions: renditions.length }, "transcode: ready");
  } catch (err) {
    await db
      .update(videos)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err), updatedAt: new Date() })
      .where(eq(videos.id, data.videoId));
    log.error({ videoId: data.videoId, err }, "transcode failed");
    throw err; // rethrow → BullMQ exponential backoff retry
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}