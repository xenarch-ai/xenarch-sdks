"""Contract addresses and ABIs for Xenarch payment infrastructure."""

# --- Contract Addresses (Base Mainnet, chain 8453) ---

USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
SPLITTER_ADDRESS_MAINNET = "0xC6D3a6B6fcCD6319432CDB72819cf317E88662ae"

# --- Contract Addresses (Base Sepolia, chain 84532) ---

SPLITTER_ADDRESS_SEPOLIA = "0x7ecfe8f83eab6ba170063d1f1fe7c33695a9ce1d"
MOCK_USDC_SEPOLIA = "0xc5aDdd66Da733101A5468857Aa3C6689Af9d1DDc"

# --- ABIs (minimal, just what we need) ---

SPLITTER_ABI = [
    {
        "inputs": [
            {"name": "collector", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "split",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]

ERC20_ABI = [
    {
        "inputs": [{"name": "owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "name": "allowance",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "approve",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]

# Max uint256 for unlimited approval
MAX_UINT256 = 2**256 - 1

# USDC has 6 decimals
USDC_DECIMALS = 6
