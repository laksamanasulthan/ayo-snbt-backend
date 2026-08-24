import { MongoClient, type Db } from "mongodb";
import { getEnv } from "../../config/index.js";

let client: MongoClient | undefined;
let db: Db | undefined;

export function getMongoClient(): MongoClient {
  if (!client) {
    client = new MongoClient(getEnv().MONGO_URL);
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
