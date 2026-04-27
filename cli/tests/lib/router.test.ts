/**
 * Tests for the TS Facilitator Router.
 *
 * Mirrors `python/tests/test_router.py`. Spec:
 * `Information/design/facilitator-router.md`.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_COOLDOWN_S,
  DEFAULT_FACILITATOR_STACK,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_FAILURE_WINDOW_S,
  DEFAULT_WEIGHTS,
  Router,
  type FacilitatorConfig,
} from "../../src/lib/router.js";

class FakeClock {
  t = 1000.0;
  bind(): () => number {
    return () => this.t;
  }
  advance(seconds: number): void {
    this.t += seconds;
  }
}

function cfg(overrides: Partial<FacilitatorConfig> & { url: string; name: string }): FacilitatorConfig {
  return overrides;
}

describe("default stack", () => {
  it("has four facilitators", () => {
    expect(DEFAULT_FACILITATOR_STACK).toHaveLength(4);
    const names = new Set(DEFAULT_FACILITATOR_STACK.map((f) => f.name));
    expect(names).toEqual(new Set(["PayAI", "xpay", "Ultravioleta DAO", "x402.rs"]));
  });

  it("excludes Coinbase", () => {
    for (const f of DEFAULT_FACILITATOR_STACK) {
      expect(f.name.toLowerCase()).not.toContain("coinbase");
      expect(f.url.toLowerCase()).not.toContain("coinbase");
    }
  });

  it("weights sum to 1.0", () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
  });

  it("Router uses default stack when none provided", () => {
    const r = new Router();
    expect(r.registered.map((c) => c.url)).toEqual(
      DEFAULT_FACILITATOR_STACK.map((c) => c.url),
    );
  });

  it("Router rejects empty facilitator list", () => {
    expect(() => new Router([])).toThrow();
  });
});

describe("eligibility filters", () => {
  it("filters by chain", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a", supportedChains: new Set(["base"]) }),
      cfg({ name: "B", url: "https://b", supportedChains: new Set(["solana"]) }),
    ]);
    expect(r.select({ chain: "base" }).map((p) => p.url)).toEqual(["https://a"]);
  });

  it("filters by asset", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a", supportedAssets: new Set(["USDC"]) }),
      cfg({ name: "B", url: "https://b", supportedAssets: new Set(["EURC"]) }),
    ]);
    expect(r.select({ asset: "USDC" }).map((p) => p.url)).toEqual(["https://a"]);
  });

  it("filters by publisher max fee", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a", feeBps: 10 }),
      cfg({ name: "B", url: "https://b", feeBps: 50 }),
    ]);
    expect(r.select({ publisherMaxFeeBps: 20 }).map((p) => p.url)).toEqual([
      "https://a",
    ]);
  });

  it("returns empty when nothing eligible", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a", supportedChains: new Set(["solana"]) }),
    ]);
    expect(r.select({ chain: "base" })).toEqual([]);
  });
});

describe("scoring", () => {
  it("lower fee ranks higher", () => {
    const r = new Router([
      cfg({ name: "pricey", url: "https://pricey", feeBps: 80 }),
      cfg({ name: "cheap", url: "https://cheap", feeBps: 0 }),
    ]);
    expect(r.select()[0].url).toBe("https://cheap");
  });

  it("gas-sponsored outranks unsponsored when otherwise equal", () => {
    const r = new Router([
      cfg({ name: "B", url: "https://b", gasSponsored: false }),
      cfg({ name: "A", url: "https://a", gasSponsored: true }),
    ]);
    expect(r.select()[0].url).toBe("https://a");
  });

  it("v2 outranks older spec when otherwise equal", () => {
    const r = new Router([
      cfg({ name: "B", url: "https://b", specVersion: "v1" }),
      cfg({ name: "A", url: "https://a", specVersion: "v2" }),
    ]);
    expect(r.select()[0].url).toBe("https://a");
  });

  it("max_results caps the returned list", () => {
    const configs = Array.from({ length: 5 }, (_, i) =>
      cfg({ name: `f${i}`, url: `https://f${i}` }),
    );
    const r = new Router(configs);
    expect(r.select({}, undefined, 3)).toHaveLength(3);
    expect(r.select({}, undefined, 1)).toHaveLength(1);
  });

  it("custom weights override defaults", () => {
    const r = new Router(
      [
        cfg({ name: "cheap", url: "https://a", feeBps: 80 }),
        cfg({ name: "sponsored", url: "https://b", feeBps: 0, gasSponsored: false }),
      ],
      {
        weights: {
          fee: 0.0,
          gas: 1.0,
          spec: 0.0,
          uptime: 0.0,
          latency: 0.0,
          preference: 0.0,
        },
      },
    );
    // Fee zeroed, gas dominant — sponsored "a" beats unsponsored "b".
    expect(r.select()[0].url).toBe("https://a");
  });
});

describe("publisher pay.json ranking", () => {
  it("publisher preference lifts a listed facilitator", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a" }),
      cfg({ name: "B", url: "https://b" }),
    ]);
    expect(
      r.select({}, ["https://b", "https://a"])[0].url,
    ).toBe("https://b");
  });

  it("publisher URLs outside the registered stack are ignored", () => {
    const r = new Router([cfg({ name: "A", url: "https://a" })]);
    expect(
      r.select({}, ["https://attacker.example", "https://a"]).map((p) => p.url),
    ).toEqual(["https://a"]);
  });

  it("publisher-only-unknown yields no preference boost", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a" }),
      cfg({ name: "B", url: "https://b" }),
    ]);
    const picks = r.select({}, ["https://nope"]).map((p) => p.url);
    expect(new Set(picks)).toEqual(new Set(["https://a", "https://b"]));
  });

  it("attacker URLs in pay.json never appear in picks", () => {
    const r = new Router([cfg({ name: "A", url: "https://known" })]);
    const picks = r.select({}, [
      "http://attacker.invalid/steal",
      "https://known",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]);
    expect(picks.map((p) => p.url)).toEqual(["https://known"]);
  });
});

describe("circuit breaker", () => {
  it("trips after threshold failures in window", () => {
    const clock = new FakeClock();
    const r = new Router(
      [
        cfg({ name: "A", url: "https://a" }),
        cfg({ name: "B", url: "https://b" }),
      ],
      { clock: clock.bind() },
    );
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      r.recordFailure("https://a");
    }
    expect(r.health("https://a")).toBe("unhealthy");
    expect(r.select().map((p) => p.url)).toEqual(["https://b"]);
  });

  it("below threshold is degraded, not excluded", () => {
    const r = new Router([cfg({ name: "A", url: "https://a" })], {
      clock: new FakeClock().bind(),
    });
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i++) {
      r.recordFailure("https://a");
    }
    expect(r.health("https://a")).toBe("degraded");
    expect(r.select().map((p) => p.url)).toEqual(["https://a"]);
  });

  it("re-eligible after cooldown expires", () => {
    const clock = new FakeClock();
    const r = new Router([cfg({ name: "A", url: "https://a" })], {
      clock: clock.bind(),
    });
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      r.recordFailure("https://a");
    }
    expect(r.select()).toEqual([]);
    clock.advance(DEFAULT_COOLDOWN_S + 1);
    expect(r.health("https://a")).toBe("healthy");
    expect(r.select().map((p) => p.url)).toEqual(["https://a"]);
  });

  it("failures outside the window do not trip the breaker", () => {
    const clock = new FakeClock();
    const r = new Router([cfg({ name: "A", url: "https://a" })], {
      clock: clock.bind(),
    });
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i++) {
      r.recordFailure("https://a");
    }
    clock.advance(DEFAULT_FAILURE_WINDOW_S + 1);
    r.recordFailure("https://a");
    expect(r.health("https://a")).not.toBe("unhealthy");
  });

  it("all-broken returns empty", () => {
    const r = new Router(
      [
        cfg({ name: "A", url: "https://a" }),
        cfg({ name: "B", url: "https://b" }),
      ],
      { clock: new FakeClock().bind() },
    );
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      r.recordFailure("https://a");
      r.recordFailure("https://b");
    }
    expect(r.select()).toEqual([]);
  });
});

describe("tie-break", () => {
  it("prefers different facilitator from last used when scores equal", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a" }),
      cfg({ name: "B", url: "https://b" }),
    ]);
    r.recordSuccess("https://a", 100);
    expect(r.select()[0].url).toBe("https://b");
  });

  it("does not tie-break when scores diverge meaningfully", () => {
    const r = new Router([
      cfg({ name: "cheap", url: "https://cheap", feeBps: 0 }),
      cfg({ name: "pricey", url: "https://pricey", feeBps: 80 }),
    ]);
    r.recordSuccess("https://cheap", 100);
    expect(r.select()[0].url).toBe("https://cheap");
  });
});

describe("health monitoring", () => {
  it("fresh router is healthy and selectable", () => {
    const r = new Router([cfg({ name: "A", url: "https://a" })]);
    expect(r.health("https://a")).toBe("healthy");
    expect(r.select().map((p) => p.url)).toEqual(["https://a"]);
  });

  it("record methods ignore unknown URLs", () => {
    const r = new Router([cfg({ name: "A", url: "https://a" })]);
    r.recordSuccess("https://unknown");
    r.recordFailure("https://unknown");
    expect(r.health("https://unknown")).toBeNull();
  });

  it("high latency lowers score", () => {
    const r = new Router([
      cfg({ name: "fast", url: "https://fast" }),
      cfg({ name: "slow", url: "https://slow" }),
    ]);
    for (let i = 0; i < 20; i++) {
      r.recordSuccess("https://fast", 100);
      r.recordSuccess("https://slow", 4500);
    }
    expect(r.select()[0].url).toBe("https://fast");
  });
});

describe("registered property", () => {
  it("returns a fresh list", () => {
    const r = new Router([cfg({ name: "A", url: "https://a" })]);
    const snapshot = r.registered;
    snapshot.length = 0;
    expect(r.registered).toHaveLength(1);
  });
});

describe("combined publisher + health", () => {
  it("falls back to next when publisher's preferred is broken", () => {
    const r = new Router(
      [
        cfg({ name: "A", url: "https://a" }),
        cfg({ name: "B", url: "https://b" }),
      ],
      { clock: new FakeClock().bind() },
    );
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      r.recordFailure("https://a");
    }
    expect(r.select({}, ["https://a", "https://b"]).map((p) => p.url)).toEqual([
      "https://b",
    ]);
  });
});

describe("empty publisher list behaves like undefined", () => {
  it("produces the same picks", () => {
    const r = new Router([
      cfg({ name: "A", url: "https://a" }),
      cfg({ name: "B", url: "https://b" }),
    ]);
    const none = new Set(r.select({}, undefined).map((p) => p.url));
    const empty = new Set(r.select({}, []).map((p) => p.url));
    expect(none).toEqual(empty);
    expect(none).toEqual(new Set(["https://a", "https://b"]));
  });
});
