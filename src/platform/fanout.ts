import { withTx } from "../db/pool.js";
import { getEventsByIds } from "../db/events.js";
import { subscribedEndpoints, insertDelivery } from "../db/webhooks.js";
import { newId } from "../domain/ids.js";
import type { AppDeps } from "../deps.js";

export async function afterCommit(deps: AppDeps, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const deliveries = await withTx(deps.pool, async (c) => {
    const out: string[] = [];
    for (const event of await getEventsByIds(c, eventIds)) {
      for (const ep of await subscribedEndpoints(c, event.key_id, event.type)) {
        out.push((await insertDelivery(c, newId("whd"), ep.id, event.id)).id);
      }
    }
    return out;
  });
  for (const id of deliveries) {
    try { await deps.scheduler.schedule(id, 0); }
    catch (err) { deps.logger.error({ delivery_id: id, err: (err as Error).message }, "schedule failed; the sweep will republish"); }
  }
}
