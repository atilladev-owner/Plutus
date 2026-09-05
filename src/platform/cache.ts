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

export class UpstashCache implements Cache {
  private readonly redis: Redis;
  constructor(url: string, token: string) { this.redis = new Redis({ url, token }); }
  async get(key: string): Promise<string | null> { return (await this.redis.get<string>(key)) ?? null; }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> { await this.redis.set(key, value, { ex: ttlSeconds }); }
}
