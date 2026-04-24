"""Property-based tests for pay-json (XEN-148 PR 5c).

We generate syntactically valid (and deliberately invalid) pay.json documents
with hypothesis and assert parse-layer invariants:

- Parsing valid input never crashes and returns a ``PayJson`` doc.
- ``match_rule`` is deterministic for a given (doc, path) pair.
- Every parsed ``Rule.price_usd`` is ``>= 0`` (no negative prices leak through).
- Inputs that violate the schema (bad addresses, missing fields, bad price
  strings) always raise ``PayJsonInvalid`` — never pass silently.

The goal is to catch regressions in the reader's input validation without
having to enumerate every edge case by hand. Kept cheap: small example
counts, no network.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pay_json import PayJson, PayJsonInvalid


pytestmark = pytest.mark.property


# A realistic-but-cheap example budget so tests finish quickly.
_PROFILE = settings(
    max_examples=50,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------


_addresses = st.from_regex(r"^0x[0-9a-fA-F]{40}$", fullmatch=True)
_versions = st.sampled_from(["1.2"])

# Non-negative decimal strings matching _PRICE_RE: `\d+(\.\d+)?`.
_price_strings = st.decimals(
    min_value=Decimal("0"),
    max_value=Decimal("10000"),
    allow_nan=False,
    allow_infinity=False,
    places=4,
).map(lambda d: format(d, "f"))

# Glob-ish paths — the reader doesn't validate path syntax, so any string
# containing a leading slash is fine. Keep them short.
_paths = st.from_regex(r"^/[a-z0-9/\*]{1,20}$", fullmatch=True)


@st.composite
def _rule_strategy(draw: st.DrawFn) -> dict[str, Any]:
    rule: dict[str, Any] = {
        "path": draw(_paths),
        "price_usd": draw(_price_strings),
    }
    if draw(st.booleans()):
        rule["budget_hints"] = {
            "recommended_max_per_call": draw(_price_strings),
        }
    return rule


@st.composite
def _valid_doc(draw: st.DrawFn) -> dict[str, Any]:
    rules = draw(st.lists(_rule_strategy(), min_size=1, max_size=5))
    return {
        "version": draw(_versions),
        "protocol": "x402",
        "network": "base",
        "asset": draw(_addresses),
        "receiver": draw(_addresses),
        "seller_wallet": draw(_addresses),
        "rules": rules,
    }


# ---------------------------------------------------------------------------
# Invariants on valid input
# ---------------------------------------------------------------------------


class TestValidDocsParse:
    @_PROFILE
    @given(doc=_valid_doc())
    def test_parse_never_crashes(self, doc: dict[str, Any]) -> None:
        parsed = PayJson.parse(doc)
        assert parsed.version == "1.2"
        assert parsed.rules  # non-empty

    @_PROFILE
    @given(doc=_valid_doc())
    def test_prices_non_negative(self, doc: dict[str, Any]) -> None:
        parsed = PayJson.parse(doc)
        for rule in parsed.rules:
            assert rule.price_usd >= Decimal("0")

    @_PROFILE
    @given(doc=_valid_doc(), path=_paths)
    def test_match_rule_is_deterministic(
        self, doc: dict[str, Any], path: str
    ) -> None:
        # Parsing twice and matching the same path must return equal rules.
        # We compare the underlying `raw` dict rather than Rule identity
        # because parse() reconstructs objects on every call.
        a = PayJson.parse(doc).match_rule(path)
        b = PayJson.parse(doc).match_rule(path)
        assert (a is None) == (b is None)
        if a is not None and b is not None:
            assert a.raw == b.raw


# ---------------------------------------------------------------------------
# Invariants on invalid input — must raise, never pass silently
# ---------------------------------------------------------------------------


class TestInvalidDocsRaise:
    @_PROFILE
    @given(doc=_valid_doc(), bad_addr=st.text(min_size=1, max_size=20))
    def test_bad_receiver_raises(
        self, doc: dict[str, Any], bad_addr: str
    ) -> None:
        # Anything that doesn't match ^0x[0-9a-fA-F]{40}$.
        if bad_addr.startswith("0x") and len(bad_addr) == 42:
            return  # may accidentally be valid; skip
        doc["receiver"] = bad_addr
        with pytest.raises(PayJsonInvalid):
            PayJson.parse(doc)

    @_PROFILE
    @given(
        doc=_valid_doc(),
        missing=st.sampled_from(
            ["version", "protocol", "network", "asset", "receiver"]
        ),
    )
    def test_missing_required_field_raises(
        self, doc: dict[str, Any], missing: str
    ) -> None:
        del doc[missing]
        with pytest.raises(PayJsonInvalid):
            PayJson.parse(doc)

    @_PROFILE
    @given(doc=_valid_doc(), bad_price=st.text(min_size=1, max_size=10))
    def test_bad_price_string_raises(
        self, doc: dict[str, Any], bad_price: str
    ) -> None:
        # Skip anything that accidentally matches \d+(\.\d+)?.
        import re

        if re.fullmatch(r"\d+(\.\d+)?", bad_price):
            return
        doc["rules"][0]["price_usd"] = bad_price
        with pytest.raises(PayJsonInvalid):
            PayJson.parse(doc)

    @_PROFILE
    @given(doc=_valid_doc())
    def test_empty_rules_raises(self, doc: dict[str, Any]) -> None:
        doc["rules"] = []
        with pytest.raises(PayJsonInvalid):
            PayJson.parse(doc)
