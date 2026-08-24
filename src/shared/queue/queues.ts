import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import { getBullConnections } from "../redis/client.js";
import { getLogger } from "../logger.js";

export enum QueueName {
  Email = "email",
  Notification = "notification",
  Grading = "grading",
  Leaderboard = "leaderboard",
  Transcode = "transcode",
  Payment = "payment"
}

const connections = { connection: undefined as ConnectionOptions | undefined, subscriber: undefined as ConnectionOptions | undefined };
function getConns() {
  if (!connections.connection) {
    const { connection, subscriber } = getBullConnections();
    connections.connection = connection;
    connections.subscriber = subscriber;
  }
  return connections as { connection: ConnectionOptions; subscriber: ConnectionOptions };
}

const log = getLogger();

export function getQueue(name: QueueName): Queue {
  return new Queue(name, {
    connection: getConns().connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 3600 * 24 },
      removeOnFail: { age: 3600 * 24 * 7 }
    }
  });
}

export function createWorker(name: QueueName, processor: (job: any) => Promise<void>): Worker {
  return new Worker(name, processor, {
    connection: getConns().connection,
    concurrency: 5
  });
}

/** Queue a job. Returns false if the job couldn't be enqueued (degradation). */
export async function enqueue(name: QueueName, payload: unknown, opts?: JobsOptions): Promise<string | null> {
  try {
    const queue = getQueue(name);
    const job = await queue.add(name, payload, opts);
    return job.id ?? null;
  } catch (err) {
    log.error({ err, queue: name }, "failed to enqueue bullmq job");
    return null;
  }
}