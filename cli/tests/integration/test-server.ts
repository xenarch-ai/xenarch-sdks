/**
 * Reusable local HTTP server for integration tests.
 * Binds to port 0 (OS-assigned) to avoid conflicts.
 * Tracks all received requests for assertions.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { GateResponse, GateVerifyResponse, GateStatusResponse, AgentRegisterResponse, PayJsonPricing } from "../../src/types.js";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface TestServerOptions {
  gatePrice?: string;
  gateExpires?: string;
  gateId?: string;
  splitter?: string;
  collector?: string;
  payJson?: PayJsonPricing | null;
  /** When false, POST /v1/gates/:id/verify returns 402 failure */
  verifySucceeds?: boolean;
}

export class TestServer {
  private server: Server | null = null;
  private _port = 0;
  private _requests: RecordedRequest[] = [];
  private options: Required<TestServerOptions>;

  constructor(opts: TestServerOptions = {}) {
    this.options = {
      gatePrice: opts.gatePrice ?? "0.0030",
      gateExpires: opts.gateExpires ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      gateId: opts.gateId ?? "gate_test_001",
      splitter: opts.splitter ?? "0x1111111111111111111111111111111111111111",
      collector: opts.collector ?? "0x2222222222222222222222222222222222222222",
      payJson: opts.payJson === undefined ? { default_price_usd: 0.003, rules: [{ path: "/premium/*", price_usd: 0.01 }] } : opts.payJson,
      verifySucceeds: opts.verifySucceeds ?? true,
    };
  }

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get requests(): RecordedRequest[] {
    return this._requests;
  }

  clearRequests(): void {
    this._requests = [];
  }

  private gateResponse(): GateResponse {
    return {
      xenarch: true,
      gate_id: this.options.gateId,
      price_usd: this.options.gatePrice,
      splitter: this.options.splitter,
      collector: this.options.collector,
      network: "base",
      asset: "USDC",
      protocol: "x402",
      verify_url: `${this.baseUrl}/v1/gates/${this.options.gateId}/verify`,
      expires: this.options.gateExpires,
    };
  }

  private verifyResponse(): GateVerifyResponse {
    return {
      access_token: "eyJhbGciOiJIUzI1NiJ9.integration-test-token",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  private gateStatusResponse(): GateStatusResponse {
    return {
      gate_id: this.options.gateId,
      status: "pending",
      price_usd: this.options.gatePrice,
      created_at: new Date().toISOString(),
      paid_at: null,
    };
  }

  private agentRegisterResponse(walletAddress: string): AgentRegisterResponse {
    return {
      id: "agent_test_001",
      wallet_address: walletAddress,
      created_at: new Date().toISOString(),
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(0, "127.0.0.1", () => {
        this._port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      this._requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });

      this.route(req.method ?? "GET", req.url ?? "/", body, res);
    });
  }

  private route(method: string, url: string, body: string, res: ServerResponse): void {
    // GET /gated → 402 with Xenarch gate body
    if (method === "GET" && url === "/gated") {
      this.json(res, 402, this.gateResponse());
      return;
    }

    // GET /non-xenarch-402 → 402 without xenarch marker
    if (method === "GET" && url === "/non-xenarch-402") {
      this.json(res, 402, { error: "payment_required", xenarch: false });
      return;
    }

    // GET /free → 200 with free content
    if (method === "GET" && url === "/free") {
      this.json(res, 200, { content: "free content" });
      return;
    }

    // GET /error → 500
    if (method === "GET" && url === "/error") {
      this.json(res, 500, { error: "internal_error", message: "Something went wrong", code: 500 });
      return;
    }

    // GET /.well-known/pay.json → pricing rules
    if (method === "GET" && url === "/.well-known/pay.json") {
      if (this.options.payJson === null) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      this.json(res, 200, this.options.payJson);
      return;
    }

    // POST /v1/gates/:id/verify → configurable success/failure
    const verifyMatch = url.match(/^\/v1\/gates\/([^/]+)\/verify$/);
    if (method === "POST" && verifyMatch) {
      if (this.options.verifySucceeds) {
        this.json(res, 200, this.verifyResponse());
      } else {
        this.json(res, 402, { error: "insufficient_payment", message: "Transaction amount below gate price", code: 402 });
      }
      return;
    }

    // GET /v1/gates/not_found → gate status 404
    if (method === "GET" && url === "/v1/gates/not_found") {
      this.json(res, 404, { error: "not_found", message: "Gate not found", code: 404 });
      return;
    }

    // GET /v1/gates/:id → gate status
    const gateStatusMatch = url.match(/^\/v1\/gates\/([^/]+)$/);
    if (method === "GET" && gateStatusMatch) {
      this.json(res, 200, this.gateStatusResponse());
      return;
    }

    // POST /v1/agents → agent registration
    if (method === "POST" && url === "/v1/agents") {
      const parsed = body ? JSON.parse(body) : {};
      this.json(res, 200, this.agentRegisterResponse(parsed.wallet_address ?? "0x0000000000000000000000000000000000000000"));
      return;
    }

    // Fallback 404
    res.writeHead(404);
    res.end("Not Found");
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
