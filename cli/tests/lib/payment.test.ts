import { describe, it, expect, vi } from "vitest";
import { executePayment } from "../../src/lib/payment.js";
import { mockGateResponse } from "../fixtures/mock-responses.js";
import { ethers } from "ethers";

// Mock ethers module
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");

  const mockWait = vi.fn().mockResolvedValue({
    hash: "0x" + "cc".repeat(32),
    blockNumber: 12345678,
  });

  const mockGetBalance = vi.fn().mockResolvedValue(1_000_000_000_000_000n); // 0.001 ETH

  const mockContract = vi.fn().mockImplementation(() => ({
    balanceOf: vi.fn().mockResolvedValue(10_000_000n), // 10 USDC
    allowance: vi.fn().mockResolvedValue(0n),
    approve: vi.fn().mockResolvedValue({ wait: mockWait }),
    split: vi.fn().mockResolvedValue({ wait: mockWait }),
  }));

  const mockProvider = {
    getBalance: mockGetBalance,
  };

  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: mockContract,
      parseUnits: actual.ethers.parseUnits,
      formatUnits: actual.ethers.formatUnits,
      Wallet: actual.ethers.Wallet,
    },
  };
});

// Helper: create a signer with a mock provider that has getBalance
function createMockSigner() {
  const wallet = ethers.Wallet.createRandom();
  // Attach a mock provider with getBalance
  const mockProvider = {
    getBalance: vi.fn().mockResolvedValue(1_000_000_000_000_000n),
  };
  return {
    getAddress: () => Promise.resolve(wallet.address),
    provider: mockProvider,
    // The signer is passed to Contract constructors — mocked, so shape doesn't matter
  } as unknown as ethers.Signer;
}

describe("executePayment", () => {
  it("executes full payment flow (approve + split)", async () => {
    const gate = mockGateResponse({ price_usd: "0.0030" });
    const signer = createMockSigner();

    const result = await executePayment(gate, signer);

    expect(result.txHash).toBe("0x" + "cc".repeat(32));
    expect(result.blockNumber).toBe(12345678);
  });

  it("throws on insufficient balance", async () => {
    // Override the mock to return 0 balance
    const { ethers: mockedEthers } = await import("ethers");
    vi.mocked(mockedEthers.Contract).mockImplementationOnce(
      () =>
        ({
          balanceOf: vi.fn().mockResolvedValue(0n),
          allowance: vi.fn().mockResolvedValue(0n),
          approve: vi.fn(),
          split: vi.fn(),
        }) as any,
    );

    const gate = mockGateResponse({ price_usd: "1.0000" });
    const signer = createMockSigner();

    await expect(
      executePayment(gate, signer),
    ).rejects.toThrow("Insufficient USDC");
  });
});
