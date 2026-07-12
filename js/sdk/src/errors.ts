import type { PayLinkFieldIssue } from "@xenarch/core";

/** Re-exported from @xenarch/core: thrown on a 401 (session missing/expired). */
export { SessionExpiredError } from "@xenarch/core";

/**
 * Thrown when a money/irreversible merchant op (create/revoke) is called
 * without confirmation and the client was built with `requireConfirm: true`
 * (the default). Pass `{ confirm: true }` to the call, or build the client
 * with `requireConfirm: false` for trusted scripts.
 */
export class ConfirmationRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationRequired";
  }
}

/**
 * Thrown by `merchant.links.create` when the params tree is missing or
 * invalid. `missing` and `errors` carry the platform's field-level issues so
 * a caller (human or agent) can ask for exactly the fields it still needs.
 */
export class PayLinkValidationError extends Error {
  readonly missing: PayLinkFieldIssue[];
  readonly errors: PayLinkFieldIssue[];

  constructor(missing: PayLinkFieldIssue[], errors: PayLinkFieldIssue[]) {
    const problems = [...missing, ...errors]
      .map((i) => i.message ?? i.field)
      .join("; ");
    super(`pay-link params invalid: ${problems}`);
    this.name = "PayLinkValidationError";
    this.missing = missing;
    this.errors = errors;
  }
}

/** Thrown by `x402.pay` when the URL has no active 402 gate. */
export class NotGatedError extends Error {
  constructor(url: string) {
    super(`no active x402 gate at ${url}`);
    this.name = "NotGatedError";
  }
}

/** Thrown when a signing op is attempted without a configured private key. */
export class MissingSigningKeyError extends Error {
  constructor() {
    super(
      "no signing key — pass `privateKey` to create pay-links or pay x402 " +
        "URLs (the wallet must sign locally)",
    );
    this.name = "MissingSigningKeyError";
  }
}

/**
 * Thrown when a `services.*` write (create/update/delete) is attempted without
 * a configured publisher API key. Build the client with `{ publisherApiKey }`.
 */
export class MissingPublisherKeyError extends Error {
  constructor() {
    super(
      "no publisher API key — pass `publisherApiKey` to manage services " +
        "(create/update/delete authenticate as a publisher, not the merchant session)",
    );
    this.name = "MissingPublisherKeyError";
  }
}

/** Thrown by `webhooks.verify(..., { throwOnFailure: true })` on a bad signature. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
