import { MongoClient, type Db } from "mongodb";
import { getEnv } from "../../config/index.js";

let client: MongoClient | undefined;
let db: Db | undefined;

export function getMongoClient(): MongoClient {
  if (!client) {
    client = new MongoClient(getEnv().MONGO_URL, {
      // Fail fast when MongoDB is unreachable (degraded chat) instead of
      // hanging for the driver default (30s) on every operation.
      serverSelectionTimeoutMS: 2_000
    });
    // Suppress unhandled error events from the client (e.g. when MongoDB
    // is unreachable — the topology emits 'error' which Node turns into
    // an unhandled rejection if no listener exists).
    client.on("error", () => {});
  }
  return client;
}

export function getChatDb(): Db {
  if (!db) {
    db = getMongoClient().db();
  }
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}

/**
 * Discard a broken Mongo client (e.g. after a failed connect the topology
 * is permanently closed) so the next getChatDb() creates a fresh one.
 */
export function discardMongoClient(): void {
  if (client) {
    void client.close().catch(() => {});
    client = undefined;
    db = undefined;
  }
}