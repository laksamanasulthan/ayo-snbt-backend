import { getEnv } from "../../config/index.js";
import { getLogger } from "../../shared/logger.js";
import { retryWithBackoff } from "../../shared/backoff/retry.js";
import { createHash } from "node:crypto";

const log = getLogger();

export interface CreatePaymentResult {
  providerReference: string;
  paymentUrl: string;
  status: "pending";
}

export interface PaymentProvider {
  name: string;
  createPayment(input: { orderNumber: string; amountCents: number; email: string; courseTitle: string }): Promise<CreatePaymentResult>;
  /** Verify webhook authenticity. Returns the order number if valid. */
  verifyWebhook(parsed: Record<string, unknown>, headers: Record<string, string | string[] | undefined>): { orderNumber: string; paid: boolean; eventId: string } | null;
}

/**
 * Mock provider: no external calls. The payment URL points at our own
 * dev-only webhook endpoint so local flows work without sandbox keys.
 */
const mockProvider: PaymentProvider = {
  name: "mock",
  async createPayment(input) {
    return {
      providerReference: "MOCK-" + input.orderNumber,
      paymentUrl: getEnv().PAYMENT_BASE_URL + "/api/v1/payments/mock/pay/" + input.orderNumber,
      status: "pending"
    };
  },
  verifyWebhook(parsed, _headers) {
    const orderNumber = parsed.order_number;
    const paid = parsed.status === "paid";
    const eventId = (parsed.event_id ?? "mock-" + orderNumber + "-" + Date.now()) as string;
    if (typeof orderNumber !== "string") return null;
    return { orderNumber, paid, eventId };
  }
};

/** Midtrans Snap: SHA512(order_id + status_code + gross_amount + serverKey). */
const midtransProvider: PaymentProvider = {
  name: "midtrans",
  async createPayment(input) {
    const env = getEnv();
    const auth = Buffer.from(env.MIDTRANS_SERVER_KEY + ":").toString("base64");
    // Retry with exponential backoff + full jitter (provider flakiness)
    return retryWithBackoff(async () => {
      const res = await fetch(env.MIDTRANS_BASE_URL + "/snap/v1/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Basic " + auth },
        body: JSON.stringify({
          transaction_details: { order_id: input.orderNumber, gross_amount: input.amountCents / 100 },
          customer_details: { email: input.email },
          item_details: [{ id: "course", price: input.amountCents / 100, quantity: 1, name: input.courseTitle }]
        })
      });
      if (!res.ok) throw new Error("Midtrans create transaction failed: " + res.status);
      const data = (await res.json()) as { token: string; redirect_url: string };
      return { providerReference: input.orderNumber, paymentUrl: data.redirect_url, status: "pending" };
    }, { attempts: 3, baseDelayMs: 1000, maxDelayMs: 10000, onRetry: ({ attempt, delayMs, error }) => log.warn({ attempt, delayMs, error: String(error) }, "midtrans retry") });
  },
  verifyWebhook(parsed, _headers) {
    const env = getEnv();
    const orderId = parsed.order_id;
    const statusCode = parsed.status_code;
    const grossAmount = parsed.gross_amount;
    const signatureKey = parsed.signature_key;
    if (typeof orderId !== "string" || typeof statusCode !== "string" || typeof grossAmount !== "string" || typeof signatureKey !== "string") return null;
    const expected = createHash("sha512").update(orderId + statusCode + grossAmount + env.MIDTRANS_SERVER_KEY).digest("hex");
    if (expected !== signatureKey) {
      log.warn({ orderId }, "midtrans signature mismatch");
      return null;
    }
    const paid = statusCode === "200" || statusCode === "201";
    return { orderNumber: orderId, paid, eventId: orderId + ":" + statusCode + ":" + (parsed.transaction_id ?? "") };
  }
};

/** Xendit: x-callback-token header auth. */
const xenditProvider: PaymentProvider = {
  name: "xendit",
  async createPayment(input) {
    const env = getEnv();
    return retryWithBackoff(async () => {
      const xres = await fetch(env.XENDIT_BASE_URL + "/v2/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Basic " + Buffer.from(env.XENDIT_SECRET_KEY + ":").toString("base64") },
        body: JSON.stringify({ external_id: input.orderNumber, amount: input.amountCents, payer_email: input.email, description: input.courseTitle })
      });
      if (!xres.ok) throw new Error("Xendit create invoice failed: " + xres.status);
      const xdata = (await xres.json()) as { id: string; invoice_url: string };
      return { providerReference: xdata.id, paymentUrl: xdata.invoice_url, status: "pending" };
    }, { attempts: 3, baseDelayMs: 1000, maxDelayMs: 10000, onRetry: ({ attempt, delayMs, error }) => log.warn({ attempt, delayMs, error: String(error) }, "xendit retry") });
  },
  verifyWebhook(parsed, headers) {
    const env = getEnv();
    const token = headers["x-callback-token"];
    if (!env.XENDIT_CALLBACK_TOKEN || token !== env.XENDIT_CALLBACK_TOKEN) {
      log.warn("xendit callback token mismatch");
      return null;
    }
    const externalId = parsed.external_id;
    const status = parsed.status;
    const eventId = (parsed.id ?? "") as string;
    if (typeof externalId !== "string" || typeof status !== "string" || !eventId) return null;
    return { orderNumber: externalId, paid: status === "PAID", eventId };
  }
};

export function getPaymentProvider(): PaymentProvider {
  const env = getEnv();
  switch (env.PAYMENT_PROVIDER) {
    case "midtrans":
      return midtransProvider;
    case "xendit":
      return xenditProvider;
    default:
      return mockProvider;
  }
}