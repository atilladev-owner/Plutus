import type { AppDeps } from "../deps.js";

/** Called after a write commits with the ids of the events it produced. Task 11 makes this deliver webhooks. */
export async function afterCommit(deps: AppDeps, eventIds: string[]): Promise<void> {
  if (eventIds.length > 0) deps.logger.debug({ event_ids: eventIds }, "events committed");
}
