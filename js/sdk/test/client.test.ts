import { describe, it, expect } from "vitest";
import {
  createXenarch,
  Xenarch,
  ConfirmationRequired,
  SessionExpiredError,
  MissingSigningKeyError,
} from "../src/index.js";

describe("createXenarch", () => {
  it("builds a client with the bilingual namespaces", () => {
    const sdk = createXenarch({ sessionToken: "t", privateKey: "0x1" });
    expect(sdk).toBeInstanceOf(Xenarch);
    expect(sdk.merchant.links).toBeDefined();
    expect(sdk.merchant.payments).toBeDefined();
    expect(sdk.merchant.subscribers).toBeDefined();
    expect(sdk.merchant.profile).toBeDefined();
    expect(sdk.x402).toBeDefined();
    expect(sdk.webhooks.verify).toBeInstanceOf(Function);
  });

  it("defaults the api base and strips trailing slashes", () => {
    expect(createXenarch().apiBase).toBe("https://api.xenarch.dev");
    expect(createXenarch({ apiBase: "https://x.dev/" }).apiBase).toBe("https://x.dev");
  });
});

describe("confirm gate", () => {
  it("blocks create without confirm by default (before any network call)", async () => {
    const sdk = createXenarch({ sessionToken: "t", privateKey: "0x1" });
    await expect(sdk.merchant.links.create({})).rejects.toBeInstanceOf(
      ConfirmationRequired,
    );
  });

  it("blocks revoke without confirm by default", async () => {
    const sdk = createXenarch({ sessionToken: "t" });
    await expect(sdk.merchant.links.revoke("abc")).rejects.toBeInstanceOf(
      ConfirmationRequired,
    );
  });

  it("requireConfirm:false bypasses the gate (falls through to the real op)", async () => {
    // No session → the next thing revoke hits is the session check, proving
    // the confirm gate was skipped.
    const sdk = createXenarch({ requireConfirm: false });
    await expect(sdk.merchant.links.revoke("abc")).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});

describe("auth + signing guards", () => {
  it("merchant ops without a session throw SessionExpiredError", async () => {
    const sdk = createXenarch({});
    await expect(sdk.merchant.payments.list()).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("x402.pay without a signing key throws MissingSigningKeyError", async () => {
    const sdk = createXenarch({ sessionToken: "t" });
    await expect(sdk.x402.pay("https://example.com")).rejects.toBeInstanceOf(
      MissingSigningKeyError,
    );
  });
});
