import { ethers } from "ethers";
import type { GateResponse, PaymentResult } from "../types.js";
import { USDC_BASE, USDC_ABI, SPLITTER_ABI } from "../types.js";

export async function executePayment(
  gate: GateResponse,
  wallet: ethers.Wallet,
  rpcUrl: string,
): Promise<PaymentResult> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);

  const usdc = new ethers.Contract(USDC_BASE, USDC_ABI, signer);
  const splitter = new ethers.Contract(gate.splitter, SPLITTER_ABI, signer);

  // USDC has 6 decimals
  const amount = ethers.parseUnits(gate.price_usd, 6);

  // 1. Check balance
  const balance = (await usdc.balanceOf(wallet.address)) as bigint;
  if (balance < amount) {
    throw new Error(
      `Insufficient USDC. Have ${ethers.formatUnits(balance, 6)}, need ${gate.price_usd}`,
    );
  }

  // 2. Check ETH for gas
  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance === 0n) {
    throw new Error(
      "No ETH for gas. Send some ETH (Base) to your wallet to cover transaction fees.",
    );
  }

  // 3. Check and set allowance — approve max to avoid repeated approvals
  const allowance = (await usdc.allowance(
    wallet.address,
    gate.splitter,
  )) as bigint;
  if (allowance < amount) {
    const approveTx = await usdc.approve(gate.splitter, ethers.MaxUint256);
    await approveTx.wait(2); // wait 2 blocks to ensure RPC state is updated
  }

  // 4. Call split
  const splitTx = await splitter.split(gate.collector, amount);
  const receipt = await splitTx.wait(1);

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}
