import { Redis } from "@upstash/redis";

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class MemoryCache implements Cache {
  private readonly items = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const hit = this.items.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) { this.items.delete(key); return null; }
    return hit.value;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.items.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

/**
 * Values go in as strings and must come back as the same strings. The Upstash client
 * deserialises by default: a stored JSON document comes back as an object and a stored
 * "12345" as a number, and every caller here parses the string itself (the verify routes
 * answered 500 on a cache hit in production for exactly that reason, and the market data
 * cache logged a parse failure and missed on every read). Deserialisation is off, so get
 * returns the bytes set wrote.
 */
export class UpstashCache implements Cache {
  private readonly redis: Redis;
  constructor(url: string, token: string) { this.redis = new Redis({ url, token, automaticDeserialization: false }); }
  async get(key: string): Promise<string | null> { return (await this.redis.get<string>(key)) ?? null; }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> { await this.redis.set(key, value, { ex: ttlSeconds }); }
}
