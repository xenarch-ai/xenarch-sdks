/**
 * `@xenarch/sdk` — isomorphic TypeScript SDK for the agentic internet.
 *
 * Two sides of the market, one client, for human devs and AI agents:
 *   - `sdk.x402`     — pay any HTTP 402-gated resource on the open web.
 *   - `sdk.merchant` — get paid: pay-links, payments, subscribers, profile.
 *   - `sdk.webhooks` — verify incoming webhook signatures.
 *
 * Gasless USDC on Base. 0% Xenarch fee. Runs on Node, Bun, Deno, and edge.
 *
 *     import { createXenarch } from "@xenarch/sdk";
 *     const sdk = createXenarch({ sessionToken, privateKey });
 *     const link = await sdk.merchant.links.create(params, { confirm: true });
 *     const res  = await sdk.x402.pay("https://example.com/paywalled");
 */
export {
  Xenarch,
  createXenarch,
  type XenarchOptions,
  type ListOptions,
  type SubscriberListOptions,
  type ConfirmOption,
  type PayResult,
} from "./client.js";

export { webhooks, verify, computeSignature, type VerifyOptions } from "./webhooks.js";

export {
  SessionExpiredError,
  ConfirmationRequired,
  PayLinkValidationError,
  NotGatedError,
  MissingSigningKeyError,
  WebhookVerificationError,
} from "./errors.js";

// Re-export the data-layer types so consumers get them from one place.
export type {
  GateResponse,
  PayLinkSchemaResponse,
  PayLinkSchemaField,
  PayLinkFieldIssue,
  PayLinkValidateResponse,
  PayLinkCreateResponse,
  PayLinkListItem,
  PayLinkListResponse,
  PayLinkDetail,
  PayLinkRevokeResponse,
  MerchantPaymentItem,
  MerchantPaymentListResponse,
  SubscriberListItem,
  SubscriberListResponse,
  MerchantProfileBody,
  MerchantProfileResponse,
} from "@xenarch/core";
