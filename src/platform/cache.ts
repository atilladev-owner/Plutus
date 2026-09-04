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
