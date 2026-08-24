import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/shared/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // Migrations bypass PgBouncer (direct connection)
    url: process.env.DIRECT_DATABASE_URL ?? ""
  },
  verbose: true,
  strict: true
});
