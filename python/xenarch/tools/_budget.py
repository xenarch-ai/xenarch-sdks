"""Xenarch alias for the neutral ``x402_agent.BudgetPolicy``.

Historical name: this module originally hosted ``XenarchBudgetPolicy``. The
implementation has since been promoted to the framework-agnostic
``x402_agent`` subpackage so it can be shared across LangChain, CrewAI,
AutoGen, and LangGraph adapters. The alias is kept for callers that still
``from xenarch.tools import XenarchBudgetPolicy``.
"""

from __future__ import annotations

from x402_agent import BudgetPolicy as XenarchBudgetPolicy

__all__ = ["XenarchBudgetPolicy"]
