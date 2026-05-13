// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

const HOSTED = "https://pay.xenarch.com/l/";

async function loadEmbed() {
  // Import is cached per module; the side-effect bootstrap (DOMContentLoaded
  // → scan + MutationObserver) only runs once per process. Tests that need
  // a fresh DOM rely on `document.body.innerHTML = ""` between cases — the
  // standing MutationObserver will pick up new nodes via subtree:true.
  return await import("../src/index");
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as { __xen_navigated?: string }).__xen_navigated;
});

describe("link-id regex", () => {
  it("accepts realistic IDs", async () => {
    const { LINK_ID_RE } = await loadEmbed();
    expect(LINK_ID_RE.test("JJjIwDyV4N1CG9g8AHMxfdJ9")).toBe(true);
    expect(LINK_ID_RE.test("rpl_kJ3f")).toBe(true);
    expect(LINK_ID_RE.test("abc-123_DEF")).toBe(true);
  });
  it("rejects injection-ish strings", async () => {
    const { LINK_ID_RE } = await loadEmbed();
    expect(LINK_ID_RE.test("")).toBe(false);
    expect(LINK_ID_RE.test("../evil")).toBe(false);
    expect(LINK_ID_RE.test("a b")).toBe(false);
    expect(LINK_ID_RE.test('rpl_<script>')).toBe(false);
    expect(LINK_ID_RE.test("toolong" + "a".repeat(64))).toBe(false);
    expect(LINK_ID_RE.test("short")).toBe(false);
  });
});

describe("buildUrl", () => {
  it("builds the hosted-checkout URL with return_url query param", async () => {
    const { buildUrl } = await loadEmbed();
    const got = buildUrl("rpl_test", "https://shop.example.com/cart?id=42");
    expect(got).toBe(
      `${HOSTED}rpl_test?return_url=${encodeURIComponent("https://shop.example.com/cart?id=42")}`,
    );
  });
});

describe("attach", () => {
  it("attaches click handler and navigates on click", async () => {
    const { attach } = await loadEmbed();
    const btn = document.createElement("button");
    btn.setAttribute("data-xenarch-link", "rpl_alpha1");
    document.body.appendChild(btn);

    const assign = vi.fn();
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: assign,
    });
    Object.defineProperty(window.location, "href", {
      configurable: true,
      get: () => "https://merchant.test/page",
    });

    attach(btn);
    btn.click();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0][0]).toContain(`${HOSTED}rpl_alpha1`);
    expect(assign.mock.calls[0][0]).toContain(
      encodeURIComponent("https://merchant.test/page"),
    );
  });

  it("is idempotent on the same element (no double-attach)", async () => {
    const { attach } = await loadEmbed();
    const btn = document.createElement("button");
    btn.setAttribute("data-xenarch-link", "rpl_alpha2");
    document.body.appendChild(btn);

    const assign = vi.fn();
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: assign,
    });

    attach(btn);
    attach(btn);
    attach(btn);
    btn.click();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed link IDs (no attach, no navigation)", async () => {
    const { attach } = await loadEmbed();
    const btn = document.createElement("button");
    btn.setAttribute("data-xenarch-link", "../evil");
    document.body.appendChild(btn);

    const assign = vi.fn();
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: assign,
    });

    attach(btn);
    btn.click();
    expect(assign).not.toHaveBeenCalled();
  });

  it("honors data-xenarch-return-url override", async () => {
    const { attach } = await loadEmbed();
    const btn = document.createElement("button");
    btn.setAttribute("data-xenarch-link", "rpl_alpha3");
    btn.setAttribute(
      "data-xenarch-return-url",
      "https://merchant.test/thanks",
    );
    document.body.appendChild(btn);

    const assign = vi.fn();
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: assign,
    });

    attach(btn);
    btn.click();
    expect(assign.mock.calls[0][0]).toContain(
      encodeURIComponent("https://merchant.test/thanks"),
    );
  });
});

describe("scan", () => {
  it("finds multiple buttons in one pass", async () => {
    const { scan } = await loadEmbed();
    document.body.innerHTML = `
      <button data-xenarch-link="rpl_alpha4">Pay A</button>
      <a href="#fallback" data-xenarch-link="rpl_alpha5">Pay B</a>
      <span data-xenarch-link="rpl_alpha6">Pay C (non-button)</span>
    `;
    const assign = vi.fn();
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: assign,
    });

    scan(document);

    (document.querySelectorAll("[data-xenarch-link]") as NodeListOf<HTMLElement>).forEach(
      (el) => el.click(),
    );
    expect(assign).toHaveBeenCalledTimes(3);
  });
});
