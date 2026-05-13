const HOSTED_CHECKOUT_BASE = "https://pay.xenarch.com/l/";
// Permissive link-id allowlist: alphanumeric + dash/underscore, 6-64 chars.
// Tight enough to refuse anything that looks like an injection attempt
// (whitespace, slashes, quotes, control chars), loose enough to survive
// any future ID-format rev without a snippet republish.
const LINK_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const ATTACHED_FLAG = "xenarchAttached";

function buildUrl(linkId: string, returnUrl: string): string {
  return `${HOSTED_CHECKOUT_BASE}${linkId}?return_url=${encodeURIComponent(returnUrl)}`;
}

function attach(el: Element): void {
  const node = el as HTMLElement;
  if (node.dataset[ATTACHED_FLAG]) return;
  const linkId = node.getAttribute("data-xenarch-link");
  if (!linkId || !LINK_ID_RE.test(linkId)) return;
  node.dataset[ATTACHED_FLAG] = "1";
  node.addEventListener("click", (e) => {
    e.preventDefault();
    const returnUrl = node.getAttribute("data-xenarch-return-url") || window.location.href;
    window.location.assign(buildUrl(linkId, returnUrl));
  });
}

function scan(root: ParentNode): void {
  const nodes = root.querySelectorAll("[data-xenarch-link]");
  for (let i = 0; i < nodes.length; i++) attach(nodes[i]);
}

function ready(fn: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

ready(() => {
  scan(document);
  // Re-scan when nodes are inserted later (SPA routing, late-rendered
  // checkout buttons, frameworks that hydrate after first paint).
  const target = document.body || document.documentElement;
  new MutationObserver(() => scan(document)).observe(target, {
    childList: true,
    subtree: true,
  });
});

// Test-only exports. esbuild build (IIFE, no exports) ignores these; the
// vitest happy-dom run imports them directly from this module.
export { buildUrl, attach, scan, LINK_ID_RE, HOSTED_CHECKOUT_BASE };
