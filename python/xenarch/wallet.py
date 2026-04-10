"""Wallet management for Xenarch agent payments."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from eth_account import Account


@dataclass
class WalletConfig:
    """Agent wallet configuration."""

    private_key: str
    rpc_url: str
    api_base: str
    network: str

    @property
    def address(self) -> str:
        return Account.from_key(self.private_key).address


_CONFIG_DIR = Path.home() / ".xenarch"
_CONFIG_FILE = _CONFIG_DIR / "config.json"
_WALLET_FILE = _CONFIG_DIR / "wallet.json"


def load_wallet() -> WalletConfig:
    """Load wallet config from ~/.xenarch/ or environment variables.

    Priority: env vars > config.json > wallet.json
    """
    private_key: str | None = None
    rpc_url = "https://mainnet.base.org"
    api_base = "https://api.xenarch.dev"
    network = "base"

    # Read config.json
    if _CONFIG_FILE.exists():
        with open(_CONFIG_FILE) as f:
            data = json.load(f)
            private_key = data.get("privateKey") or data.get("private_key")
            rpc_url = data.get("rpcUrl", data.get("rpc_url", rpc_url))
            api_base = data.get("apiBase", data.get("api_base", api_base))
            network = data.get("network", network)

    # Read wallet.json as fallback for private key
    if not private_key and _WALLET_FILE.exists():
        with open(_WALLET_FILE) as f:
            data = json.load(f)
            private_key = data.get("privateKey") or data.get("private_key")

    # Environment overrides
    private_key = os.environ.get("XENARCH_PRIVATE_KEY", private_key)
    rpc_url = os.environ.get("XENARCH_RPC_URL", rpc_url)
    api_base = os.environ.get("XENARCH_API_BASE", api_base)
    network = os.environ.get("XENARCH_NETWORK", network)

    if not private_key:
        raise ValueError(
            "No wallet configured. Set XENARCH_PRIVATE_KEY env var, "
            'or create ~/.xenarch/wallet.json with { "privateKey": "0x..." }'
        )

    return WalletConfig(
        private_key=private_key,
        rpc_url=rpc_url,
        api_base=api_base,
        network=network,
    )


def generate_wallet() -> WalletConfig:
    """Generate a new wallet and save to ~/.xenarch/wallet.json."""
    account = Account.create()
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    private_key = "0x" + account.key.hex()
    _WALLET_FILE.write_text(
        json.dumps(
            {"privateKey": private_key, "address": account.address},
            indent=2,
        )
    )
    _WALLET_FILE.chmod(0o600)
    return WalletConfig(
        private_key=private_key,
        rpc_url="https://mainnet.base.org",
        api_base="https://api.xenarch.dev",
        network="base",
    )
