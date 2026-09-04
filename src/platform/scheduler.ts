export interface DeliveryScheduler { schedule(deliveryId: string, delaySeconds: number): Promise<void> }

export class MemoryScheduler implements DeliveryScheduler {
  readonly scheduled: Array<{ deliveryId: string; delaySeconds: number }> = [];
  constructor(private readonly runNow?: (deliveryId: string) => Promise<void>) {}
  async schedule(deliveryId: string, delaySeconds: number): Promise<void> {
    this.scheduled.push({ deliveryId, delaySeconds });
    if (delaySeconds === 0 && this.runNow) await this.runNow(deliveryId);
  }
}
