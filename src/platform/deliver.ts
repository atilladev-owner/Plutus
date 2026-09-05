import { withTx } from "../db/pool.js";
import { getDelivery, recordAttempt, bumpFailures } from "../db/webhooks.js";
import { getEventsByIds } from "../db/events.js";
import { signPayload } from "./webhook-sign.js";
import type { AppDeps } from "../deps.js";

export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 10800, 21600, 43200];
export const MAX_ATTEMPTS = 8;

/** One attempt. Records the outcome, then schedules the next attempt or marks the delivery dead. */
export async function deliverOnce(deps: AppDeps, deliveryId: string): Promise<void> {
  const d = await withTx(deps.pool, (c) => getDelivery(c, deliveryId));
  if (!d || d.status === "succeeded" || d.status === "dead") return;
  const [event] = await withTx(deps.pool, (c) => getEventsByIds(c, [d.event_id]));
  if (!event) return;
  const body = JSON.stringify({ id: event.id, type: event.type, ledger_id: event.ledger_id, entity_id: event.entity_id, data: event.payload, created_at: event.created_at.toISOString() });
  const t = Math.trunc(Date.now() / 1000);
  const attempt = d.attempt + 1;
  let status: number | null = null;
  let excerpt: string | null = null;
  if (d.endpoint.status === "disabled") {
    excerpt = "endpoint disabled";
  } else {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      const res = await fetch(d.endpoint.url, {
        method: "POST", signal: ac.signal, redirect: "manual",
        headers: { "content-type": "application/json", "user-agent": "plutus-webhooks/1", "plutus-event-id": event.id, "plutus-signature": `t=${t},v1=${signPayload(d.endpoint.secret, t, body)}` },
        body,
      });
      status = res.status;
      excerpt = (await res.text()).slice(0, 1024);
    } catch (err) {
      excerpt = `request failed: ${(err as Error).name}`;
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = status !== null && status >= 200 && status < 300;
  const nextDelay = RETRY_DELAYS_SECONDS[attempt - 1];
  const dead = !ok && (attempt >= MAX_ATTEMPTS || nextDelay === undefined);
  await withTx(deps.pool, async (c) => {
    await recordAttempt(c, d.id, {
      attempt, status: ok ? "succeeded" : dead ? "dead" : "pending", responseStatus: status, excerpt,
      nextAttemptAt: ok || dead ? null : new Date(Date.now() + (nextDelay ?? 0) * 1000),
    });
    await bumpFailures(c, d.endpoint_id, ok);
  });
  if (!ok && !dead && nextDelay !== undefined) await deps.scheduler.schedule(d.id, nextDelay);
}
