import { simulationsService } from "./service.js";

export interface GradingJobData {
  type: "grade" | "auto-submit";
  sessionId: string;
}

/** BullMQ Grading queue processor. */
export async function processGradingJob(data: GradingJobData): Promise<void> {
  if (data.type === "auto-submit") {
    await simulationsService.autoSubmit(data.sessionId);
  } else {
    await simulationsService.gradeSession(data.sessionId);
  }
}
