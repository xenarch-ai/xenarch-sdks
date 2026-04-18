"""Tests for LangChain tool budget guardrails (XEN-148 PR 2)."""

import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest

pytest.importorskip("langchain_core")

from xenarch.tools.langchain import PayTool  # noqa: E402


def _mock_gate(price_usd: str = "0.05") -> SimpleNamespace:
    return SimpleNamespace(
        gate_id="gate-abc",
        price_usd=price_usd,
        splitter="0xSPLITTER",
        collector="0xCOLLECTOR",
        network="base",
        asset="USDC",
        protocol="x402",
        verify_url="https://xenarch.dev/v1/gates/gate-abc/verify",
    )


def _mock_wallet() -> SimpleNamespace:
    return SimpleNamespace(
        address="0xAGENT",
        private_key="0x" + "0" * 64,
        rpc_url="https://mainnet.base.org",
        network="base",
        api_base="https://xenarch.dev",
    )


class TestBudgetChecks:
    def test_check_budget_under_cap_returns_none(self):
        tool = PayTool(max_per_call=Decimal("0.10"))
        assert tool._check_budget(Decimal("0.05")) is None

    def test_check_budget_max_per_call_exceeded(self):
        tool = PayTool(max_per_call=Decimal("0.10"))
        err = tool._check_budget(Decimal("0.20"))
        assert err is not None
        assert err["error"] == "budget_exceeded"
        assert err["reason"] == "max_per_call"
        assert err["limit_usd"] == "0.10"

    def test_check_budget_max_per_session_exceeded(self):
        tool = PayTool(
            max_per_call=Decimal("1.00"),
            max_per_session=Decimal("0.50"),
        )
        tool._session_spent = Decimal("0.40")
        err = tool._check_budget(Decimal("0.20"))
        assert err is not None
        assert err["reason"] == "max_per_session"
        assert err["session_spent_usd"] == "0.40"

    def test_requires_approval_no_threshold(self):
        tool = PayTool()
        assert tool._requires_approval(Decimal("999")) is False

    def test_requires_approval_above_threshold(self):
        tool = PayTool(human_approval_above=Decimal("0.10"))
        assert tool._requires_approval(Decimal("0.20")) is True
        assert tool._requires_approval(Decimal("0.05")) is False

    def test_defaults(self):
        tool = PayTool()
        assert tool.max_per_call == Decimal("0.10")
        assert tool.max_per_session == Decimal("5.00")
        assert tool.human_approval_above is None
        assert tool.approval_callback is None
        assert tool.session_spent == Decimal("0")


class TestRunBudgetEnforcement:
    def test_rejects_when_price_above_max_per_call(self):
        tool = PayTool(max_per_call=Decimal("0.01"))
        with patch("xenarch.tools.langchain.load_wallet", return_value=_mock_wallet()):
            with patch(
                "xenarch.tools.langchain._resolve_gate",
                return_value=_mock_gate(price_usd="0.05"),
            ):
                result = json.loads(tool._run("example.com"))
        assert result["error"] == "budget_exceeded"
        assert result["reason"] == "max_per_call"
        # Session untouched
        assert tool.session_spent == Decimal("0")

    def test_rejects_when_cumulative_exceeds_session(self):
        tool = PayTool(
            max_per_call=Decimal("1.00"),
            max_per_session=Decimal("0.10"),
        )
        tool._session_spent = Decimal("0.08")
        with patch("xenarch.tools.langchain.load_wallet", return_value=_mock_wallet()):
            with patch(
                "xenarch.tools.langchain._resolve_gate",
                return_value=_mock_gate(price_usd="0.05"),
            ):
                result = json.loads(tool._run("example.com"))
        assert result["error"] == "budget_exceeded"
        assert result["reason"] == "max_per_session"

    def test_approval_required_without_callback(self):
        tool = PayTool(
            max_per_call=Decimal("1.00"),
            human_approval_above=Decimal("0.01"),
        )
        with patch("xenarch.tools.langchain.load_wallet", return_value=_mock_wallet()):
            with patch(
                "xenarch.tools.langchain._resolve_gate",
                return_value=_mock_gate(price_usd="0.05"),
            ):
                result = json.loads(tool._run("example.com"))
        assert result["error"] == "approval_required"
        assert result["reason"] == "no_callback_configured"

    def test_approval_declined(self):
        tool = PayTool(
            max_per_call=Decimal("1.00"),
            human_approval_above=Decimal("0.01"),
            approval_callback=lambda plan: False,
        )
        with patch("xenarch.tools.langchain.load_wallet", return_value=_mock_wallet()):
            with patch(
                "xenarch.tools.langchain._resolve_gate",
                return_value=_mock_gate(price_usd="0.05"),
            ):
                result = json.loads(tool._run("example.com"))
        assert result["status"] == "declined"
        assert result["reason"] == "approval_callback_rejected"

    def test_approval_callback_receives_plan(self):
        captured = {}

        def callback(plan):
            captured.update(plan)
            return False

        tool = PayTool(
            max_per_call=Decimal("1.00"),
            human_approval_above=Decimal("0.01"),
            approval_callback=callback,
        )
        with patch("xenarch.tools.langchain.load_wallet", return_value=_mock_wallet()):
            with patch(
                "xenarch.tools.langchain._resolve_gate",
                return_value=_mock_gate(price_usd="0.05"),
            ):
                tool._run("https://example.com/x")
        assert captured["price_usd"] == "0.05"
        assert captured["collector"] == "0xCOLLECTOR"
        assert captured["splitter"] == "0xSPLITTER"

    def test_concurrent_runs_respect_session_cap(self):
        """TOCTOU guard: parallel _run calls on one tool must not jointly exceed cap."""
        import threading as _t

        gate = _mock_gate(price_usd="0.60")
        tool = PayTool(
            max_per_call=Decimal("1.00"),
            max_per_session=Decimal("1.00"),
        )
        results: list[dict] = []

        def call():
            with patch("xenarch.tools.langchain.load_wallet", return_value=_mock_wallet()):
                with patch(
                    "xenarch.tools.langchain._resolve_gate", return_value=gate
                ):
                    with patch(
                        "xenarch.tools.langchain.execute_payment",
                        return_value=SimpleNamespace(tx_hash="0xabc", block_number=1),
                    ):
                        with patch(
                            "xenarch.tools.langchain.verify_payment",
                            return_value={"access_token": "t", "expires_at": "x"},
                        ):
                            results.append(json.loads(tool._run("example.com")))

        threads = [_t.Thread(target=call) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Two 0.60 charges against a 1.00 session cap: exactly one must pay, one must reject.
        successes = [r for r in results if r.get("success")]
        rejects = [r for r in results if r.get("error") == "budget_exceeded"]
        assert len(successes) == 1
        assert len(rejects) == 1
        assert tool.session_spent == Decimal("0.60")

    def test_session_spent_increments_on_success(self):
        gate = _mock_gate(price_usd="0.03")
        tool = PayTool(
            max_per_call=Decimal("1.00"),
            max_per_session=Decimal("1.00"),
        )
        with patch("xenarch.tools.langchain.load_wallet", return_value=_mock_wallet()):
            with patch(
                "xenarch.tools.langchain._resolve_gate", return_value=gate
            ):
                with patch(
                    "xenarch.tools.langchain.execute_payment",
                    return_value=SimpleNamespace(
                        tx_hash="0xabc", block_number=123
                    ),
                ):
                    with patch(
                        "xenarch.tools.langchain.verify_payment",
                        return_value={
                            "access_token": "tok",
                            "expires_at": "2026-04-18T13:00:00Z",
                        },
                    ):
                        result = json.loads(tool._run("example.com"))
        assert result["success"] is True
        assert tool.session_spent == Decimal("0.03")
        assert result["session_spent_usd"] == "0.03"
