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
