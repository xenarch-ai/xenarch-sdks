import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fetchGate, verifyPayment, getGateStatus, registerAgent, fetchPayJson } from "../../src/lib/api.js";
import { TestServer } from "./test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = new TestServer();
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe("fetchGate (real HTTP)", () => {
  it("parses a real 402 Xenarch gate response", async () => {
    const result = await fetchGate(`${server.baseUrl}/gated`);

    expect(result.gated).toBe(true);
    expect(result.gate).not.toBeNull();
    expect(result.gate!.gate_id).toBe("gate_test_001");
    expect(result.gate!.price_usd).toBe("0.0030");
    expect(result.gate!.xenarch).toBe(true);
    expect(result.gate!.network).toBe("base");
    expect(result.gate!.asset).toBe("USDC");
    expect(result.gate!.protocol).toBe("x402");
    expect(result.gate!.splitter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.gate!.verify_url).toBe(`${server.baseUrl}/v1/gates/gate_test_001/verify`);
  });

  it("returns not gated for a 200 response", async () => {
    const result = await fetchGate(`${server.baseUrl}/free`);

    expect(result.gated).toBe(false);
    expect(result.gate).toBeNull();
  });

  it("returns not gated for a non-Xenarch 402", async () => {
    const result = await fetchGate(`${server.baseUrl}/non-xenarch-402`);

    expect(result.gated).toBe(false);
    expect(result.gate).toBeNull();
  });

  it("sends correct User-Agent header", async () => {
    server.clearRequests();
    await fetchGate(`${server.baseUrl}/gated`);

    const req = server.requests.find((r) => r.url === "/gated");
    expect(req).toBeDefined();
    expect(req!.headers["user-agent"]).toBe("xenarch-cli/0.1.0");
  });

  it("returns not gated on server error (500)", async () => {
    const result = await fetchGate(`${server.baseUrl}/error`);
    expect(result.gated).toBe(false);
  });
});

describe("verifyPayment (real HTTP)", () => {
  it("returns access token from real verify endpoint", async () => {
    const txHash = "0x" + "ab".repeat(32);
    const result = await verifyPayment(
      `${server.baseUrl}/v1/gates/gate_test_001/verify`,
      txHash,
    );

    expect(result.access_token).toBe("eyJhbGciOiJIUzI1NiJ9.integration-test-token");
    expect(result.expires_at).toBeDefined();
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("sends correct Content-Type and body", async () => {
    server.clearRequests();
    const txHash = "0x" + "cd".repeat(32);
    await verifyPayment(
      `${server.baseUrl}/v1/gates/gate_test_001/verify`,
      txHash,
    );

    const req = server.requests.find((r) => r.url === "/v1/gates/gate_test_001/verify");
    expect(req).toBeDefined();
    expect(req!.method).toBe("POST");
    expect(req!.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req!.body);
    expect(body.tx_hash).toBe(txHash);
  });

  it("throws on verification failure", async () => {
    const failServer = new TestServer({ verifySucceeds: false });
    await failServer.start();
    try {
      await expect(
        verifyPayment(
          `${failServer.baseUrl}/v1/gates/gate_test_001/verify`,
          "0x" + "00".repeat(32),
        ),
      ).rejects.toThrow("Payment verification failed");
    } finally {
      await failServer.stop();
    }
  });
});

describe("getGateStatus (real HTTP)", () => {
  it("returns gate status from real endpoint", async () => {
    const result = await getGateStatus(server.baseUrl, "gate_test_001");

    expect(result.gate_id).toBe("gate_test_001");
    expect(result.status).toBe("pending");
    expect(result.price_usd).toBe("0.0030");
    expect(result.created_at).toBeDefined();
    expect(result.paid_at).toBeNull();
  });

  it("constructs URL correctly with base + gate ID", async () => {
    server.clearRequests();
    await getGateStatus(server.baseUrl, "gate_abc_123");

    const req = server.requests.find((r) => r.url === "/v1/gates/gate_abc_123");
    expect(req).toBeDefined();
    expect(req!.method).toBe("GET");
  });

  it("throws on gate not found", async () => {
    await expect(
      getGateStatus(server.baseUrl, "not_found"),
    ).rejects.toThrow("Failed to get gate status");
  });
});

describe("registerAgent (real HTTP)", () => {
  it("registers an agent and returns response", async () => {
    const walletAddress = "0x" + "aa".repeat(20);
    const result = await registerAgent(server.baseUrl, walletAddress, "test-agent");

    expect(result.id).toBe("agent_test_001");
    expect(result.wallet_address).toBe(walletAddress);
    expect(result.created_at).toBeDefined();
  });

  it("sends correct POST body with wallet_address and name", async () => {
    server.clearRequests();
    const walletAddress = "0x" + "bb".repeat(20);
    await registerAgent(server.baseUrl, walletAddress, "my-agent");

    const req = server.requests.find((r) => r.url === "/v1/agents");
    expect(req).toBeDefined();
    expect(req!.method).toBe("POST");
    expect(req!.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req!.body);
    expect(body.wallet_address).toBe(walletAddress);
    expect(body.name).toBe("my-agent");
  });

  it("sends body without name when name is omitted", async () => {
    server.clearRequests();
    const walletAddress = "0x" + "cc".repeat(20);
    await registerAgent(server.baseUrl, walletAddress);

    const req = server.requests.find((r) => r.url === "/v1/agents");
    const body = JSON.parse(req!.body);
    expect(body.wallet_address).toBe(walletAddress);
    expect(body.name).toBeUndefined();
  });
});

describe("fetchPayJson (real HTTP)", () => {
  it("returns pay.json pricing from real endpoint", async () => {
    const result = await fetchPayJson(`${server.baseUrl}/gated`);

    expect(result).not.toBeNull();
    expect(result!.default_price_usd).toBe(0.003);
    expect(result!.rules).toHaveLength(1);
    expect(result!.rules![0].path).toBe("/premium/*");
    expect(result!.rules![0].price_usd).toBe(0.01);
  });

  it("derives origin correctly from full URL", async () => {
    server.clearRequests();
    await fetchPayJson(`${server.baseUrl}/some/deep/path?query=1`);

    const req = server.requests.find((r) => r.url === "/.well-known/pay.json");
    expect(req).toBeDefined();
  });

  it("returns null when pay.json not found", async () => {
    const noPayJsonServer = new TestServer({ payJson: null });
    await noPayJsonServer.start();
    try {
      const result = await fetchPayJson(`${noPayJsonServer.baseUrl}/page`);
      expect(result).toBeNull();
    } finally {
      await noPayJsonServer.stop();
    }
  });

  it("sends correct User-Agent header", async () => {
    server.clearRequests();
    await fetchPayJson(`${server.baseUrl}/page`);

    const req = server.requests.find((r) => r.url === "/.well-known/pay.json");
    expect(req).toBeDefined();
    expect(req!.headers["user-agent"]).toBe("xenarch-cli/0.1.0");
  });
});

describe("JSON round-trip fidelity", () => {
  it("preserves number precision in price_usd string", async () => {
    const customServer = new TestServer({ gatePrice: "0.0001" });
    await customServer.start();
    try {
      const result = await fetchGate(`${customServer.baseUrl}/gated`);
      expect(result.gate!.price_usd).toBe("0.0001");
    } finally {
      await customServer.stop();
    }
  });

  it("preserves ISO date strings through JSON round-trip", async () => {
    const expires = "2099-12-31T23:59:59.999Z";
    const customServer = new TestServer({ gateExpires: expires });
    await customServer.start();
    try {
      const result = await fetchGate(`${customServer.baseUrl}/gated`);
      expect(result.gate!.expires).toBe(expires);
    } finally {
      await customServer.stop();
    }
  });
});
