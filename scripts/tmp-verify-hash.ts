import { getPool } from "../src/shared/db/client.js";
try {
  const r = await getPool().query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'questions' AND column_name = 'content_hash'"
  );
  console.log("COLS:", JSON.stringify(r.rows));
  const idx = await getPool().query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'questions' AND indexname = 'question_content_hash_uq'"
  );
  console.log("IDX:", JSON.stringify(idx.rows));
} catch (err) {
  console.error("ERR:", (err as Error).message);
}
process.exit(0);
