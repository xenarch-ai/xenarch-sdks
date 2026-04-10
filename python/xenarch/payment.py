"""On-chain USDC payment execution via the Xenarch splitter contract.

Port of xenarch-sdks/cli/src/lib/payment.ts to Python using web3.py.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from decimal import Decimal

from eth_account import Account
from web3 import Web3

from .constants import (
    ERC20_ABI,
    MAX_UINT256,
    MOCK_USDC_SEPOLIA,
    SPLITTER_ABI,
    SPLITTER_ADDRESS_MAINNET,
    SPLITTER_ADDRESS_SEPOLIA,
    USDC_BASE,
    USDC_DECIMALS,
)
from .wallet import WalletConfig


@dataclass
class PaymentResult:
    """Result of an on-chain payment."""

    tx_hash: str
    block_number: int


def _get_usdc_address(network: str) -> str:
    if network == "base-sepolia":
        return MOCK_USDC_SEPOLIA
    return USDC_BASE


def execute_payment(
    wallet: WalletConfig,
    splitter_address: str,
    collector_address: str,
    price_usd: str | Decimal,
) -> PaymentResult:
    """Execute a USDC payment through the Xenarch splitter contract.

    Flow: check balance -> check gas -> approve USDC -> call split()
    """
    # Validate splitter is a known Xenarch contract
    trusted = [SPLITTER_ADDRESS_MAINNET.lower(), SPLITTER_ADDRESS_SEPOLIA.lower()]
    if splitter_address.lower() not in trusted:
        raise ValueError(f"Untrusted splitter contract: {splitter_address}")

    # Enforce micropayment cap ($1 max)
    if Decimal(str(price_usd)) > 1:
        raise ValueError(f"Price exceeds $1 micropayment cap: {price_usd}")

    w3 = Web3(Web3.HTTPProvider(wallet.rpc_url))
    account = Account.from_key(wallet.private_key)
    address = account.address

    usdc_address = _get_usdc_address(wallet.network)
    usdc = w3.eth.contract(
        address=Web3.to_checksum_address(usdc_address), abi=ERC20_ABI
    )
    splitter = w3.eth.contract(
        address=Web3.to_checksum_address(splitter_address), abi=SPLITTER_ABI
    )

    # USDC has 6 decimals
    amount = int(Decimal(str(price_usd)) * 10**USDC_DECIMALS)

    # 1. Check balance
    balance = usdc.functions.balanceOf(address).call()
    if balance < amount:
        have = Decimal(balance) / 10**USDC_DECIMALS
        raise ValueError(
            f"Insufficient USDC. Have {have}, need {price_usd}"
        )

    # 2. Check ETH for gas
    eth_balance = w3.eth.get_balance(address)
    if eth_balance == 0:
        raise ValueError(
            "No ETH for gas. Send some ETH (Base) to your wallet to cover transaction fees."
        )

    # 3. Check and set allowance — approve max to avoid repeated approvals
    allowance = usdc.functions.allowance(
        address, Web3.to_checksum_address(splitter_address)
    ).call()
    if allowance < amount:
        approve_tx = usdc.functions.approve(
            Web3.to_checksum_address(splitter_address), MAX_UINT256
        ).build_transaction(
            {
                "from": address,
                "nonce": w3.eth.get_transaction_count(address),
                "gas": 60_000,
            }
        )
        signed = account.sign_transaction(approve_tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

        # Poll allowance to ensure state is propagated (equivalent to ethers wait(2))
        for _ in range(10):
            updated = usdc.functions.allowance(
                address, Web3.to_checksum_address(splitter_address)
            ).call()
            if updated >= amount:
                break
            time.sleep(1)

    # 4. Call split
    split_tx = splitter.functions.split(
        Web3.to_checksum_address(collector_address), amount
    ).build_transaction(
        {
            "from": address,
            "nonce": w3.eth.get_transaction_count(address),
            "gas": 150_000,
        }
    )
    signed = account.sign_transaction(split_tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

    return PaymentResult(
        tx_hash=receipt["transactionHash"].hex(),
        block_number=receipt["blockNumber"],
    )
