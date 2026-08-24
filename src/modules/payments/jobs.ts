import { paymentsService } from "./service.js";

export interface PaymentJobData {
  type: "fulfill";
  orderId: string;
}

/** BullMQ Payment queue processor. */
export async function processPaymentJob(data: PaymentJobData): Promise<void> {
  if (data.type === "fulfill") {
    await paymentsService.fulfillOrder(data.orderId);
  }
}
