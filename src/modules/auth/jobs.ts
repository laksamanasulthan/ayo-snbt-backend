import { renderTemplate } from "./templates.js";

export interface EmailJobPayload {
  to: string;
  template: string;
  data: Record<string, unknown>;
}

/** Render a template-based email job into a ready-to-send mail message. */
export function renderEmailJob(payload: EmailJobPayload): { to: string; subject: string; html: string } {
  const rendered = renderTemplate(payload.template, payload.data);
  return { to: payload.to, subject: rendered.subject, html: rendered.html };
}
