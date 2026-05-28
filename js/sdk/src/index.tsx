// @xenarch/sdk — React component for Xenarch pay links.
//
// Three modes:
//   redirect  — button navigates to pay.xenarch.com/l/<id>?return_url=<here>
//   modal     — button opens a <dialog> with an <iframe> of the checkout
//   inline    — <iframe> mounted directly in place
//
// All three use the same hosted-checkout subdomain — there is no second
// checkout implementation. The SDK is purely a parent-side wrapper that
// picks the surface and (in modal/inline) listens for the
// `window.parent.postMessage({type:'xenarch:paid', ...})` event the
// hosted-checkout side emits on terminal state changes.
//
// `?embed=modal|inline` on the iframe URL tells the hosted checkout to
// suppress the auto-redirect overlay — the parent SDK is the one that
// decides what happens after pay (close modal + fire onPaid).
//
// Origin-locked: we only act on postMessages whose event.origin matches
// HOSTED_ORIGIN. The hosted side sends `*` so any embed setup works,
// but the parent has to validate — that's us.

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export const HOSTED_ORIGIN = "https://pay.xenarch.com";
const HOSTED_BASE = `${HOSTED_ORIGIN}/l/`;

// Same regex the @xenarch/embed snippet uses — alphanumeric + dash/
// underscore, 6-64 chars. Refuses anything injection-shaped without
// over-constraining the ID space for future link-id revs.
const LINK_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export type CheckoutMode = "redirect" | "modal" | "inline";

/** Terminal-state event types the hosted checkout posts up to the parent. */
export type XenarchEventType =
  | "xenarch:paid"
  | "xenarch:underpaid"
  | "xenarch:overpaid"
  | "xenarch:expired"
  | "xenarch:revoked"
  | "xenarch:close";

export type XenarchEvent = {
  type: XenarchEventType;
  linkId: string;
  txHash?: string;
};

export type XenarchCheckoutProps = {
  /** Pay-link ID (the part after `pay.xenarch.com/l/`). */
  linkId: string;
  /** Default 'redirect'. */
  mode?: CheckoutMode;
  /**
   * After-pay return URL (redirect mode) — defaults to the current page.
   * Modal/inline ignore this; they fire `onPaid` directly.
   */
  returnUrl?: string;
  /** Fires on PAID / CONFIRMED. Modal closes automatically afterwards. */
  onPaid?: (event: XenarchEvent) => void;
  /** Fires on terminal non-success states (underpaid, overpaid, etc.). */
  onTerminal?: (event: XenarchEvent) => void;
  /** Modal only — fires when the user closes the modal without paying. */
  onClose?: () => void;
  /**
   * Inline mode only — initial iframe height in CSS units. Defaults to
   * `min(900px, 80vh)`. Inline does NOT auto-resize in v1; the parent
   * sizes it. (Resize protocol is deferred to v1.1.)
   */
  inlineHeight?: string | number;
  /** Pass-through to the rendered button (redirect/modal) or iframe (inline). */
  className?: string;
  style?: CSSProperties;
  /** Button label (redirect/modal). Ignored in inline mode. */
  children?: ReactNode;
};

function isValidLinkId(id: string): boolean {
  return LINK_ID_RE.test(id);
}

function buildHostedUrl(
  linkId: string,
  opts: { returnUrl?: string; embed?: "modal" | "inline" },
): string {
  const params = new URLSearchParams();
  if (opts.returnUrl) params.set("return_url", opts.returnUrl);
  if (opts.embed) params.set("embed", opts.embed);
  const qs = params.toString();
  return `${HOSTED_BASE}${linkId}${qs ? `?${qs}` : ""}`;
}

const KNOWN_EVENT_TYPES: ReadonlySet<XenarchEventType> = new Set([
  "xenarch:paid",
  "xenarch:underpaid",
  "xenarch:overpaid",
  "xenarch:expired",
  "xenarch:revoked",
  "xenarch:close",
]);

/**
 * Parent-side postMessage listener. Validates origin + payload shape
 * before dispatching to the user's callbacks. Returns the deregister fn.
 *
 * We can't trust event.data — anyone can send a message. Validate
 * everything:
 *   1. event.origin must be HOSTED_ORIGIN exactly
 *   2. data.type must be in KNOWN_EVENT_TYPES
 *   3. data.linkId must match the linkId we're rendering (defends
 *      against a different iframe on the page firing a message
 *      that races us)
 */
function attachXenarchListener(
  linkId: string,
  handlers: {
    onPaid?: (e: XenarchEvent) => void;
    onTerminal?: (e: XenarchEvent) => void;
    onClose?: () => void;
  },
): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== HOSTED_ORIGIN) return;
    const data = event.data as unknown;
    if (!data || typeof data !== "object") return;
    const obj = data as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== "string" || !KNOWN_EVENT_TYPES.has(type as XenarchEventType)) {
      return;
    }
    const evLinkId = obj.linkId;
    if (typeof evLinkId !== "string" || evLinkId !== linkId) return;
    const txHash =
      typeof obj.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(obj.txHash)
        ? obj.txHash
        : undefined;
    const ev: XenarchEvent = {
      type: type as XenarchEventType,
      linkId: evLinkId,
      txHash,
    };
    if (ev.type === "xenarch:paid") {
      handlers.onPaid?.(ev);
    } else if (ev.type === "xenarch:close") {
      handlers.onClose?.();
    } else {
      handlers.onTerminal?.(ev);
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

// --- styling ---------------------------------------------------------------
// Inline CSS-in-JS so the SDK has zero stylesheet/build-step requirements
// on the merchant side. Anyone who wants restyling passes `className` and
// targets these elements — but the unstyled-defaults look fine on dark/
// light backgrounds.

const buttonDefaultStyle: CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 6,
  border: "1px solid currentColor",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2147483647, // top of the int32 stacking range — beats any merchant z-index
};

const modalFrameStyle: CSSProperties = {
  width: "min(440px, 95vw)",
  height: "min(720px, 90vh)",
  border: "none",
  borderRadius: 10,
  background: "#000",
  boxShadow: "0 24px 60px rgba(0, 0, 0, 0.6)",
};

const closeButtonStyle: CSSProperties = {
  position: "absolute",
  top: -36,
  right: 0,
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "none",
  background: "rgba(255, 255, 255, 0.9)",
  color: "#000",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: "28px",
  textAlign: "center",
  padding: 0,
};

// --- component -------------------------------------------------------------

export function XenarchCheckout({
  linkId,
  mode = "redirect",
  returnUrl,
  onPaid,
  onTerminal,
  onClose,
  inlineHeight,
  className,
  style,
  children,
}: XenarchCheckoutProps) {
  if (!isValidLinkId(linkId)) {
    // Surface invalid linkId at render time rather than at click time —
    // the merchant sees the broken integration immediately during dev.
    // Throwing inside a React render keeps the error in the React tree
    // (boundary-catchable) instead of as a silent broken button.
    throw new Error(
      `XenarchCheckout: invalid linkId "${linkId}". ` +
        `Expected alphanumeric + dash/underscore, 6-64 chars.`,
    );
  }

  const [modalOpen, setModalOpen] = useState(false);

  // Resolve returnUrl once at first render (defer to window since we're
  // 'use client'-tagged). Recomputing on every render would force the
  // iframe to re-mount on parent re-renders.
  const resolvedReturnUrl = useMemo(() => {
    if (returnUrl) return returnUrl;
    if (typeof window === "undefined") return undefined;
    return window.location.href;
  }, [returnUrl]);

  const redirectHref = useMemo(
    () => buildHostedUrl(linkId, { returnUrl: resolvedReturnUrl }),
    [linkId, resolvedReturnUrl],
  );

  // Stable message-handler refs so the listener effect doesn't re-bind on
  // every parent re-render (which would race with iframe message delivery).
  const onPaidRef = useRef(onPaid);
  const onTerminalRef = useRef(onTerminal);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);
  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Common postMessage listener for both modal + inline.
  useEffect(() => {
    if (mode === "redirect") return;
    if (mode === "modal" && !modalOpen) return; // no listener until shown
    return attachXenarchListener(linkId, {
      onPaid: (e) => {
        onPaidRef.current?.(e);
        // Auto-close the modal on a successful payment — the merchant's
        // onPaid handler will likely navigate away or show a thank-you,
        // but if not, leaving a paid modal open is just confusing.
        if (mode === "modal") setModalOpen(false);
      },
      onTerminal: (e) => onTerminalRef.current?.(e),
      onClose: () => {
        onCloseRef.current?.();
        if (mode === "modal") setModalOpen(false);
      },
    });
  }, [mode, modalOpen, linkId]);

  // Esc-to-close for modal mode.
  useEffect(() => {
    if (mode !== "modal" || !modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModalOpen(false);
        onCloseRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, modalOpen]);

  // -- redirect mode --------------------------------------------------------
  if (mode === "redirect") {
    return (
      <a
        href={redirectHref}
        className={className}
        style={{ ...buttonDefaultStyle, textDecoration: "none", ...style }}
      >
        {children ?? "Pay"}
      </a>
    );
  }

  // -- inline mode ----------------------------------------------------------
  if (mode === "inline") {
    const inlineSrc = buildHostedUrl(linkId, { embed: "inline" });
    const height =
      inlineHeight ??
      (typeof window !== "undefined" ? "min(900px, 80vh)" : "720px");
    return (
      <iframe
        src={inlineSrc}
        className={className}
        style={{
          width: "100%",
          height: typeof height === "number" ? `${height}px` : height,
          border: "none",
          background: "#000",
          borderRadius: 8,
          ...style,
        }}
        title="Xenarch checkout"
        // No allow attribute — the hosted checkout opens WalletConnect
        // via deep links / QR rather than browser features. Add allow=
        // here if a future payment path needs camera/clipboard/etc.
      />
    );
  }

  // -- modal mode -----------------------------------------------------------
  const modalSrc = buildHostedUrl(linkId, { embed: "modal" });
  const handleBackdropClick = useCallbackBackdrop(setModalOpen, onCloseRef);
  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className={className}
        style={{ ...buttonDefaultStyle, ...style }}
      >
        {children ?? "Pay"}
      </button>
      {modalOpen ? (
        <div
          // Custom backdrop instead of <dialog> because <dialog> styling
          // is patchy across browsers and the polyfill story is messy.
          role="dialog"
          aria-modal="true"
          aria-label="Xenarch checkout"
          style={backdropStyle}
          onClick={handleBackdropClick}
        >
          <div
            style={{ position: "relative" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close checkout"
              onClick={() => {
                setModalOpen(false);
                onCloseRef.current?.();
              }}
              style={closeButtonStyle}
            >
              ×
            </button>
            <iframe
              src={modalSrc}
              style={modalFrameStyle}
              title="Xenarch checkout"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

// Standalone helper kept in module scope so the inline handler doesn't
// re-create on every render of the parent.
function useCallbackBackdrop(
  setOpen: (v: boolean) => void,
  onCloseRef: React.MutableRefObject<(() => void) | undefined>,
) {
  return useCallback(() => {
    setOpen(false);
    onCloseRef.current?.();
  }, [setOpen, onCloseRef]);
}

// Lower-level escape hatches for callers who want to roll their own UI.
export { buildHostedUrl, attachXenarchListener, isValidLinkId, LINK_ID_RE };
