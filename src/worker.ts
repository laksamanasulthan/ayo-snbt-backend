import { loadEnv } from "./config/index.js";
import { QueueName, createWorker } from "./shared/queue/queues.js";
import { sendMail } from "./shared/mail/client.js";
import { renderEmailJob, type EmailJobPayload } from "./modules/auth/index.js";
import { processTranscodeJob } from "./modules/video/index.js";
import { processGradingJob } from "./modules/simulations/index.js";
import { processPaymentJob } from "./modules/payments/index.js";
import { getLogger } from "./shared/logger.js";

const env = loadEnv();
const log = getLogger();

/** Email queue consumer (template-based jobs from the auth slice). */
const emailWorker = createWorker(QueueName.Email, async (job) => {
  const payload = job.data as EmailJobPayload;
  const mail = renderEmailJob(payload);
  log.info({ jobId: job.id, to: mail.to, template: payload.template }, "sending email");
  await sendMail(mail);
});

/** Transcode consumer (HLS pipeline) — runs in the ffmpeg worker image in prod. */
const transcodeWorker = createWorker(QueueName.Transcode, async (job) => {
  log.info({ jobId: job.id, videoId: job.data.videoId }, "transcoding video");
  await processTranscodeJob(job.data);
});

/** Grading consumer (SNBT simulation scoring + percentile). */
const gradingWorker = createWorker(QueueName.Grading, async (job) => {
  log.info({ jobId: job.id, type: job.data.type, sessionId: job.data.sessionId }, "grading");
  await processGradingJob(job.data);
});

/** Payment fulfillment consumer (enroll + receipt email). */
const paymentWorker = createWorker(QueueName.Payment, async (job) => {
  log.info({ jobId: job.id, type: job.data.type, orderId: job.data.orderId }, "payment");
  await processPaymentJob(job.data);
});

const workers = [emailWorker, transcodeWorker, gradingWorker, paymentWorker];
for (const w of workers) {
  w.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "job failed"));
  w.on("completed", (job) => log.info({ jobId: job.id }, "job completed"));
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "worker shutting down");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info("Ayo-SNBT worker started");
void env;