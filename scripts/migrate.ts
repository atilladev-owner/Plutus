import { existsSync } from "node:fs";
import { runMigrations } from "../src/db/migrate.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL_UNPOOLED or DATABASE_URL is required\n");
  process.exit(1);
}
const applied = await runMigrations(url);
process.stdout.write(applied.length ? `applied: ${applied.join(", ")}\n` : "nothing to apply\n");
