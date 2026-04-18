"""Tests for the reusable XenarchBudgetPolicy primitive (XEN-148 PR 5a)."""

from __future__ import annotations

import threading
from decimal import Decimal

from xenarch.tools import XenarchBudgetPolicy


class TestDefaults:
    def test_defaults_match_paytool(self):
        policy = XenarchBudgetPolicy()
        assert policy.max_per_call == Decimal("0.10")
        assert policy.max_per_session == Decimal("5.00")
        assert policy.human_approval_above is None
        assert policy.approval_callback is None
        assert policy.session_spent == Decimal("0")


class TestCheck:
    def test_under_cap_returns_none(self):
        policy = XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        assert policy.check(Decimal("0.05")) is None

    def test_exactly_at_per_call_cap_allowed(self):
        policy = XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        assert policy.check(Decimal("0.10")) is None

    def test_above_per_call_cap_rejected(self):
        policy = XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        err = policy.check(Decimal("0.20"))
        assert err is not None
        assert err["error"] == "budget_exceeded"
        assert err["reason"] == "max_per_call"
        assert err["price_usd"] == "0.20"
        assert err["limit_usd"] == "0.10"

    def test_cumulative_per_session_rejected(self):
        policy = XenarchBudgetPolicy(
            max_per_call=Decimal("1.00"),
            max_per_session=Decimal("0.50"),
        )
        policy._session_spent = Decimal("0.40")
        err = policy.check(Decimal("0.20"))
        assert err is not None
        assert err["reason"] == "max_per_session"
        assert err["session_spent_usd"] == "0.40"
        assert err["limit_usd"] == "0.50"

    def test_exactly_at_session_cap_allowed(self):
        policy = XenarchBudgetPolicy(
            max_per_call=Decimal("1.00"),
            max_per_session=Decimal("1.00"),
        )
        policy._session_spent = Decimal("0.70")
        assert policy.check(Decimal("0.30")) is None


class TestPriceValidation:
    """Adversarial inputs to `check()` — gate is server-controlled, so we
    must not trust the price it hands us.
    """

    def test_negative_price_rejected(self):
        policy = XenarchBudgetPolicy(max_per_call=Decimal("100"))
        err = policy.check(Decimal("-1"))
        assert err is not None
        assert err["reason"] == "invalid_price"

    def test_zero_price_rejected(self):
        policy = XenarchBudgetPolicy(max_per_call=Decimal("100"))
        err = policy.check(Decimal("0"))
        assert err is not None
        assert err["reason"] == "invalid_price"

    def test_nan_price_rejected(self):
        policy = XenarchBudgetPolicy(max_per_call=Decimal("100"))
        err = policy.check(Decimal("NaN"))
        assert err is not None
        assert err["reason"] == "invalid_price"

    def test_infinity_price_rejected(self):
        policy = XenarchBudgetPolicy(max_per_call=Decimal("100"))
        err = policy.check(Decimal("Infinity"))
        assert err is not None
        assert err["reason"] == "invalid_price"


class TestRequiresApproval:
    def test_no_threshold_never_requires(self):
        policy = XenarchBudgetPolicy(human_approval_above=None)
        assert policy.requires_approval(Decimal("999")) is False

    def test_at_threshold_does_not_require(self):
        policy = XenarchBudgetPolicy(human_approval_above=Decimal("0.10"))
        assert policy.requires_approval(Decimal("0.10")) is False

    def test_above_threshold_requires(self):
        policy = XenarchBudgetPolicy(human_approval_above=Decimal("0.10"))
        assert policy.requires_approval(Decimal("0.11")) is True


class TestRequestApproval:
    def test_no_approval_needed_returns_none(self):
        policy = XenarchBudgetPolicy()
        assert policy.request_approval({"price_usd": "0.05"}) is None

    def test_approval_required_no_callback(self):
        policy = XenarchBudgetPolicy(human_approval_above=Decimal("0.01"))
        err = policy.request_approval({"price_usd": "0.05"})
        assert err is not None
        assert err["error"] == "approval_required"
        assert err["reason"] == "no_callback_configured"
        assert err["threshold_usd"] == "0.01"

    def test_callback_approves(self):
        policy = XenarchBudgetPolicy(
            human_approval_above=Decimal("0.01"),
            approval_callback=lambda plan: True,
        )
        assert policy.request_approval({"price_usd": "0.05"}) is None

    def test_callback_declines(self):
        policy = XenarchBudgetPolicy(
            human_approval_above=Decimal("0.01"),
            approval_callback=lambda plan: False,
        )
        err = policy.request_approval({"price_usd": "0.05"})
        assert err is not None
        assert err["status"] == "declined"
        assert err["reason"] == "approval_callback_rejected"

    def test_callback_receives_full_plan(self):
        captured = {}

        def callback(plan):
            captured.update(plan)
            return True

        policy = XenarchBudgetPolicy(
            human_approval_above=Decimal("0.01"),
            approval_callback=callback,
        )
        plan = {
            "url": "https://example.com/article",
            "price_usd": "0.05",
            "collector": "0xABC",
            "splitter": "0xDEF",
        }
        policy.request_approval(plan)
        assert captured == plan


class TestCommit:
    def test_commit_increments_session_spent(self):
        policy = XenarchBudgetPolicy()
        policy.commit(Decimal("0.03"))
        policy.commit(Decimal("0.07"))
        assert policy.session_spent == Decimal("0.10")


class TestConcurrency:
    def test_external_lock_pattern_respects_cap(self):
        """Callers that follow the documented check→commit pattern under the
        RLock get exact session-cap enforcement. This is the contract PayTool
        relies on in `_run`.
        """
        policy = XenarchBudgetPolicy(
            max_per_call=Decimal("1.00"),
            max_per_session=Decimal("1.00"),
        )
        price = Decimal("0.40")
        outcomes: list[str] = []

        def attempt() -> None:
            with policy.lock():
                err = policy.check(price)
                if err is not None:
                    outcomes.append("rejected")
                    return
                policy.commit(price)
                outcomes.append("committed")

        threads = [threading.Thread(target=attempt) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        committed = outcomes.count("committed")
        rejected = outcomes.count("rejected")
        assert committed + rejected == 5
        # 0.40 * 2 = 0.80 fits; 0.40 * 3 = 1.20 doesn't → exactly 2 commits.
        assert committed == 2
        assert rejected == 3
        assert policy.session_spent == Decimal("0.80")

    def test_commit_is_self_locking(self):
        """`commit()` takes the RLock internally, so racy callers that skip
        the external lock can still rely on the total being correct (they
        just lose TOCTOU protection against the cap). No torn writes.
        """
        policy = XenarchBudgetPolicy(
            max_per_call=Decimal("100"),
            max_per_session=Decimal("1000"),
        )
        price = Decimal("0.01")
        N = 500

        def racer() -> None:
            policy.commit(price)

        threads = [threading.Thread(target=racer) for _ in range(N)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert policy.session_spent == price * N
