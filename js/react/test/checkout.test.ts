// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { XenarchCheckout, HOSTED_ORIGIN } from "../src/index";

// XEN-690: browsers block navigator.clipboard.writeText inside a cross-origin
// iframe unless the embedder grants clipboard-write. Both embed modes must
// carry the grant, scoped to the hosted origin, or "Copy" on the pay page
// silently copies nothing.
const EXPECTED_ALLOW = `clipboard-write ${HOSTED_ORIGIN}`;
const LINK_ID = "testLink123456";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(props: Parameters<typeof XenarchCheckout>[0]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(XenarchCheckout, props));
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("XenarchCheckout iframe permissions", () => {
  it("inline mode grants clipboard-write to the hosted origin", () => {
    const el = render({ linkId: LINK_ID, mode: "inline" });
    const frame = el.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("allow")).toBe(EXPECTED_ALLOW);
    expect(frame!.getAttribute("src")).toContain(`${HOSTED_ORIGIN}/l/${LINK_ID}`);
  });

  it("modal mode grants clipboard-write to the hosted origin once opened", () => {
    const el = render({ linkId: LINK_ID, mode: "modal" });
    expect(document.querySelector("iframe")).toBeNull();
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });
    const frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("allow")).toBe(EXPECTED_ALLOW);
    expect(frame!.getAttribute("src")).toContain(`${HOSTED_ORIGIN}/l/${LINK_ID}`);
  });
});

// XEN-717: the multi-network pay box tells the embedding page which coin and
// network paid. Tron hashes carry no 0x.
describe("XenarchCheckout events", () => {
  const EVM_TX = "0x" + "ab".repeat(32);
  const TRON_TX = "cd".repeat(32);

  function post(data: unknown, origin = HOSTED_ORIGIN) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin }));
    });
  }

  it("onPaid gets the network and token of a Tron USDT payment", () => {
    const got: unknown[] = [];
    render({ linkId: LINK_ID, mode: "inline", onPaid: (e) => got.push(e) });
    post({ type: "xenarch:paid", linkId: LINK_ID, txHash: TRON_TX, network: "tron", token: "USDT" });
    expect(got).toEqual([
      { type: "xenarch:paid", linkId: LINK_ID, txHash: TRON_TX, network: "tron", token: "USDT" },
    ]);
  });

  it("onTerminal gets an underpaid payment with its network and token", () => {
    const got: unknown[] = [];
    render({ linkId: LINK_ID, mode: "inline", onTerminal: (e) => got.push(e) });
    post({ type: "xenarch:underpaid", linkId: LINK_ID, txHash: EVM_TX, network: "bnb", token: "USDC" });
    expect(got).toEqual([
      { type: "xenarch:underpaid", linkId: LINK_ID, txHash: EVM_TX, network: "bnb", token: "USDC" },
    ]);
  });

  it("still accepts an older page's event without network or token", () => {
    const got: unknown[] = [];
    render({ linkId: LINK_ID, mode: "inline", onPaid: (e) => got.push(e) });
    post({ type: "xenarch:paid", linkId: LINK_ID, txHash: EVM_TX });
    expect(got).toEqual([{ type: "xenarch:paid", linkId: LINK_ID, txHash: EVM_TX }]);
  });

  it("drops malformed network, token and hash values", () => {
    const got: Array<Record<string, unknown>> = [];
    render({ linkId: LINK_ID, mode: "inline", onPaid: (e) => got.push(e as Record<string, unknown>) });
    post({ type: "xenarch:paid", linkId: LINK_ID, txHash: "0x1234", network: "<img onerror=x>", token: { s: "USDT" } });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ type: "xenarch:paid", linkId: LINK_ID, txHash: undefined });
  });

  it("ignores another origin and another link", () => {
    const got: unknown[] = [];
    render({ linkId: LINK_ID, mode: "inline", onPaid: (e) => got.push(e) });
    post({ type: "xenarch:paid", linkId: LINK_ID, network: "base", token: "USDC" }, "https://evil.example");
    post({ type: "xenarch:paid", linkId: "otherLink99999", network: "base", token: "USDC" });
    expect(got).toEqual([]);
  });
});
