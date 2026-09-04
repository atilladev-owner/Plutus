import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  CRON_SECRET: z.string().min(16).optional(),
  SENTRY_DSN: z.string().optional(),
  PLUTUS_VERSION: z.string().default("dev"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof Env>;

/** Parses process.env once. Empty strings count as unset, which is how Vercel and .env files behave. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.trim() !== "") cleaned[k] = v;
  }
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Configuration is invalid or incomplete: ${missing}`);
  }
  return parsed.data;
}
