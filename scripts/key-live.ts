import { existsSync } from "node:fs";
import pg from "pg";
import { generateSecret } from "../src/platform/auth.js";
import { newId } from "../src/domain/ids.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) { process.stderr.write("DATABASE_URL_UNPOOLED is required\n"); process.exit(1); }
const client = new pg.Client({ connectionString: url });
await client.connect();
const s = generateSecret("live");
const id = newId("key");
await client.query("insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, $3, $4, 'live', '{ledger:read,ledger:write,webhooks:manage,exchange:trade}')", [id, s.hash, s.prefix, s.last4]);
await client.end();
process.stdout.write(`id: ${id}\nsecret (shown once, store it now): ${s.secret}\n`);
