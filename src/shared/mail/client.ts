import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "../../config/index.js";
import { getLogger } from "../logger.js";
import { retryWithBackoff } from "../backoff/retry.js";

let transporter: Transporter | undefined;

export function getMailer(): Transporter {
  if (!transporter) {
    const env = getEnv();
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } } : {})
    });
  }
  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** Send email with exponential backoff + full jitter (SMTP is flaky). */
export async function sendMail(msg: MailMessage): Promise<void> {
  const env = getEnv();
  const log = getLogger();
  await retryWithBackoff(
    async () => {
      await getMailer().sendMail({ from: env.SMTP_FROM, ...msg });
    },
    {
      attempts: 4,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      onRetry: ({ attempt, delayMs, error }) => {
        log.warn({ attempt, delayMs, error: String(error), to: msg.to }, "mail send failed, retrying");
      }
    }
  );
}

export async function closeMailer(): Promise<void> {
  if (transporter) {
    transporter.close();
    transporter = undefined;
  }
}
