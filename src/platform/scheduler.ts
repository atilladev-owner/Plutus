import { Client } from "@upstash/qstash";

export interface DeliveryScheduler { schedule(deliveryId: string, delaySeconds: number): Promise<void> }

export class MemoryScheduler implements DeliveryScheduler {
  readonly scheduled: Array<{ deliveryId: string; delaySeconds: number }> = [];
  constructor(private readonly runNow?: (deliveryId: string) => Promise<void>) {}
  async schedule(deliveryId: string, delaySeconds: number): Promise<void> {
    this.scheduled.push({ deliveryId, delaySeconds });
    if (delaySeconds === 0 && this.runNow) await this.runNow(deliveryId);
  }
}

/** Hands the clock to QStash: it calls back the internal deliver route after the delay,
 * with retries turned off here because deliverOnce owns the retry ladder itself. */
export class QStashScheduler implements DeliveryScheduler {
  private readonly client: Client;
  constructor(token: string, private readonly callbackUrl: string) { this.client = new Client({ token }); }
  async schedule(deliveryId: string, delaySeconds: number): Promise<void> {
    await this.client.publishJSON({ url: this.callbackUrl, body: { delivery_id: deliveryId }, delay: delaySeconds, retries: 0 });
  }
}
