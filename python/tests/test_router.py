"""Tests for the Facilitator Router (XEN-182 / Phase D1).

Spec: Information/design/facilitator-router.md
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from xenarch.router import (
    DEFAULT_COOLDOWN_S,
    DEFAULT_FACILITATOR_STACK,
    DEFAULT_FAILURE_THRESHOLD,
    DEFAULT_FAILURE_WINDOW_S,
    DEFAULT_WEIGHTS,
    FacilitatorConfig,
    HealthState,
    PaymentContext,
    Router,
)


class FakeClock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


# --- Construction & defaults ---------------------------------------------------


def test_default_stack_has_four_facilitators():
    assert len(DEFAULT_FACILITATOR_STACK) == 4
    names = {f.name for f in DEFAULT_FACILITATOR_STACK}
    assert names == {"PayAI", "xpay", "Ultravioleta DAO", "x402.rs"}


def test_default_stack_excludes_coinbase():
    for f in DEFAULT_FACILITATOR_STACK:
        assert "coinbase" not in f.name.lower()
        assert "coinbase" not in f.url.lower()


def test_default_weights_sum_to_one():
    assert abs(sum(DEFAULT_WEIGHTS.values()) - 1.0) < 1e-9


def test_router_uses_default_stack_when_none_provided():
    r = Router()
    urls = [c.url for c in r.registered]
    assert urls == [c.url for c in DEFAULT_FACILITATOR_STACK]


def test_router_rejects_empty_facilitator_list():
    with pytest.raises(ValueError):
        Router(facilitators=[])


# --- Eligibility filters -------------------------------------------------------


def _make_router(*configs: FacilitatorConfig, clock: FakeClock | None = None) -> Router:
    return Router(facilitators=list(configs), clock=clock or FakeClock())


def test_filters_by_chain():
    base_only = FacilitatorConfig(name="A", url="https://a", supported_chains=frozenset({"base"}))
    sol_only = FacilitatorConfig(name="B", url="https://b", supported_chains=frozenset({"solana"}))
    r = _make_router(base_only, sol_only)
    picks = r.select(PaymentContext(chain="base"))
    assert [p.url for p in picks] == ["https://a"]


def test_filters_by_asset():
    usdc = FacilitatorConfig(name="A", url="https://a", supported_assets=frozenset({"USDC"}))
    eurc = FacilitatorConfig(name="B", url="https://b", supported_assets=frozenset({"EURC"}))
    r = _make_router(usdc, eurc)
    picks = r.select(PaymentContext(asset="USDC"))
    assert [p.url for p in picks] == ["https://a"]


def test_filters_by_publisher_max_fee():
    cheap = FacilitatorConfig(name="A", url="https://a", fee_bps=10)
    expensive = FacilitatorConfig(name="B", url="https://b", fee_bps=50)
    r = _make_router(cheap, expensive)
    picks = r.select(PaymentContext(publisher_max_fee_bps=20))
    assert [p.url for p in picks] == ["https://a"]


def test_returns_empty_when_nothing_eligible():
    sol = FacilitatorConfig(name="A", url="https://a", supported_chains=frozenset({"solana"}))
    r = _make_router(sol)
    assert r.select(PaymentContext(chain="base")) == []


# --- Scoring & ordering --------------------------------------------------------


def test_lower_fee_ranks_higher():
    cheap = FacilitatorConfig(name="cheap", url="https://cheap", fee_bps=0)
    pricey = FacilitatorConfig(name="pricey", url="https://pricey", fee_bps=80)
    r = _make_router(pricey, cheap)
    picks = r.select()
    assert picks[0].url == "https://cheap"


def test_gas_sponsored_outranks_unsponsored_when_otherwise_equal():
    sponsored = FacilitatorConfig(name="A", url="https://a", gas_sponsored=True)
    unsponsored = FacilitatorConfig(name="B", url="https://b", gas_sponsored=False)
    r = _make_router(unsponsored, sponsored)
    assert r.select()[0].url == "https://a"


def test_v2_outranks_older_spec_when_otherwise_equal():
    v2 = FacilitatorConfig(name="A", url="https://a", spec_version="v2")
    v1 = FacilitatorConfig(name="B", url="https://b", spec_version="v1")
    r = _make_router(v1, v2)
    assert r.select()[0].url == "https://a"


def test_max_results_caps_returned_list():
    configs = [FacilitatorConfig(name=f"f{i}", url=f"https://f{i}") for i in range(5)]
    r = _make_router(*configs)
    assert len(r.select(max_results=3)) == 3
    assert len(r.select(max_results=1)) == 1


# --- Publisher pay.json ranking ------------------------------------------------


def test_publisher_preference_lifts_listed_facilitator():
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = _make_router(a, b)
    # A and B are equal on all other axes; publisher prefers B.
    picks = r.select(publisher_facilitators=["https://b", "https://a"])
    assert picks[0].url == "https://b"


def test_publisher_urls_outside_registered_stack_are_ignored():
    a = FacilitatorConfig(name="A", url="https://a")
    r = _make_router(a)
    # Unknown URLs must NOT cause outbound calls or appear in result.
    picks = r.select(publisher_facilitators=["https://attacker.example", "https://a"])
    assert [p.url for p in picks] == ["https://a"]


def test_publisher_only_unknown_urls_yields_no_preference_boost():
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = _make_router(a, b)
    # All publisher URLs are unknown — both facilitators score equally on preference.
    picks = r.select(publisher_facilitators=["https://nope"])
    assert {p.url for p in picks} == {"https://a", "https://b"}


# --- Circuit breaker -----------------------------------------------------------


def test_circuit_breaker_trips_after_threshold_failures():
    clock = FakeClock()
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = Router(facilitators=[a, b], clock=clock)

    for _ in range(DEFAULT_FAILURE_THRESHOLD):
        r.record_failure("https://a")

    assert r.health("https://a") == HealthState.UNHEALTHY
    picks = r.select()
    assert [p.url for p in picks] == ["https://b"]


def test_below_threshold_failures_are_degraded_not_excluded():
    clock = FakeClock()
    a = FacilitatorConfig(name="A", url="https://a")
    r = Router(facilitators=[a], clock=clock)

    for _ in range(DEFAULT_FAILURE_THRESHOLD - 1):
        r.record_failure("https://a")

    assert r.health("https://a") == HealthState.DEGRADED
    assert [p.url for p in r.select()] == ["https://a"]


def test_facilitator_re_eligible_after_cooldown_expires():
    clock = FakeClock()
    a = FacilitatorConfig(name="A", url="https://a")
    r = Router(facilitators=[a], clock=clock)

    for _ in range(DEFAULT_FAILURE_THRESHOLD):
        r.record_failure("https://a")
    assert r.select() == []

    clock.advance(DEFAULT_COOLDOWN_S + 1)
    # Failures fell out of the window too, so back to healthy.
    assert r.health("https://a") == HealthState.HEALTHY
    assert [p.url for p in r.select()] == ["https://a"]


def test_failures_outside_window_dont_trip_breaker():
    clock = FakeClock()
    a = FacilitatorConfig(name="A", url="https://a")
    r = Router(facilitators=[a], clock=clock)

    # Record threshold failures, then advance past the window before adding more.
    for _ in range(DEFAULT_FAILURE_THRESHOLD - 1):
        r.record_failure("https://a")
    clock.advance(DEFAULT_FAILURE_WINDOW_S + 1)
    r.record_failure("https://a")

    # Only one failure inside the rolling window now.
    assert r.health("https://a") != HealthState.UNHEALTHY


# --- Tie-break by traffic diversification --------------------------------------


def test_tiebreak_prefers_different_facilitator_from_last_used():
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = _make_router(a, b)

    # Both have identical scores. Mark A as last used; B should win the tie.
    r.record_success("https://a", latency_ms=100.0)
    picks = r.select()
    assert picks[0].url == "https://b"


def test_no_tiebreak_when_scores_diverge():
    cheap = FacilitatorConfig(name="cheap", url="https://cheap", fee_bps=0)
    pricey = FacilitatorConfig(name="pricey", url="https://pricey", fee_bps=80)
    r = _make_router(cheap, pricey)

    # cheap is materially better; even if it was just used it should still rank first.
    r.record_success("https://cheap", latency_ms=100.0)
    assert r.select()[0].url == "https://cheap"


# --- Health monitoring ---------------------------------------------------------


def test_fresh_router_is_optimistic_about_uptime():
    a = FacilitatorConfig(name="A", url="https://a")
    r = _make_router(a)
    assert r.health("https://a") == HealthState.HEALTHY
    # No success/failure history yet — should still be selectable.
    assert [p.url for p in r.select()] == ["https://a"]


def test_record_success_tracks_latency():
    a = FacilitatorConfig(name="A", url="https://a")
    r = _make_router(a)
    r.record_success("https://a", latency_ms=250.0)
    state = r._states["https://a"]
    assert list(state.latency_samples_ms) == [250.0]


def test_record_methods_ignore_unknown_url():
    a = FacilitatorConfig(name="A", url="https://a")
    r = _make_router(a)
    # Should silently no-op, not raise.
    r.record_success("https://unknown")
    r.record_failure("https://unknown")
    assert r.health("https://unknown") is None


def test_high_latency_lowers_score():
    fast = FacilitatorConfig(name="fast", url="https://fast")
    slow = FacilitatorConfig(name="slow", url="https://slow")
    r = _make_router(fast, slow)

    # Seed many slow latency samples for "slow", fast samples for "fast".
    for _ in range(20):
        r.record_success("https://fast", latency_ms=100.0)
        r.record_success("https://slow", latency_ms=4500.0)

    # Reset _last_used_url effect by recording one final success on slow,
    # then on fast so fast is the most recent — but tie-break only matters
    # within 1%. Here scores diverge meaningfully.
    picks = r.select()
    assert picks[0].url == "https://fast"


# --- Combined publisher + health scenario --------------------------------------


def test_unhealthy_publisher_preferred_facilitator_falls_back_to_next():
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = _make_router(a, b)

    # Publisher prefers A; trip A's circuit breaker.
    for _ in range(DEFAULT_FAILURE_THRESHOLD):
        r.record_failure("https://a")

    picks = r.select(publisher_facilitators=["https://a", "https://b"])
    assert [p.url for p in picks] == ["https://b"]


def test_payment_context_amount_does_not_filter_by_default():
    a = FacilitatorConfig(name="A", url="https://a")
    r = _make_router(a)
    # amount_usd is informational; routing still works.
    picks = r.select(PaymentContext(amount_usd=Decimal("0.05")))
    assert [p.url for p in picks] == ["https://a"]


# --- Additional hardening cases -----------------------------------------------


def test_custom_weights_override_defaults():
    """Caller-supplied weights replace the defaults wholesale."""
    a = FacilitatorConfig(name="cheap", url="https://a", fee_bps=80)
    b = FacilitatorConfig(name="sponsored", url="https://b", fee_bps=0, gas_sponsored=False)
    # If we crank gas to 1.0 and zero out fee, the unsponsored "b" should
    # lose despite having the better fee. Verifies the weights actually
    # propagate into _score().
    weights = {"fee": 0.0, "gas": 1.0, "spec": 0.0, "uptime": 0.0, "latency": 0.0, "preference": 0.0}
    r = Router(facilitators=[a, b], weights=weights, clock=FakeClock())
    assert r.select()[0].url == "https://a"


def test_empty_publisher_list_behaves_like_none():
    """Both `[]` and `None` mean no publisher signal; results equal."""
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = _make_router(a, b)
    none_picks = {p.url for p in r.select(publisher_facilitators=None)}
    empty_picks = {p.url for p in r.select(publisher_facilitators=[])}
    assert none_picks == empty_picks == {"https://a", "https://b"}


def test_all_facilitators_broken_returns_empty():
    """When every registered facilitator is in cooldown, select returns []."""
    clock = FakeClock()
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = Router(facilitators=[a, b], clock=clock)
    for _ in range(DEFAULT_FAILURE_THRESHOLD):
        r.record_failure("https://a")
        r.record_failure("https://b")
    assert r.select() == []


def test_publisher_duplicate_urls_collapse_to_first_rank():
    """A publisher that lists the same URL twice gets the better rank, not double weight."""
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = _make_router(a, b)
    # Listing https://b twice should not drown out https://a.
    picks = r.select(publisher_facilitators=["https://b", "https://b", "https://a"])
    # Both ranked: b at rank 0, a at rank 1. b should still win on preference.
    assert picks[0].url == "https://b"


def test_unknown_url_record_calls_dont_pollute_known_state():
    """record_success/record_failure on unknown URLs are no-ops."""
    a = FacilitatorConfig(name="A", url="https://a")
    r = _make_router(a)
    r.record_success("https://does-not-exist", latency_ms=999.0)
    r.record_failure("https://does-not-exist")
    state = r._states["https://a"]
    assert len(state.successes) == 0
    assert len(state.failures) == 0
    assert len(state.latency_samples_ms) == 0


def test_cooldown_expiry_with_failures_still_in_window_stays_unhealthy():
    """If cooldown elapses but failures still cluster inside the window, stay UNHEALTHY."""
    clock = FakeClock()
    # Use a long failure window, short cooldown for this test.
    a = FacilitatorConfig(name="A", url="https://a")
    r = Router(
        facilitators=[a],
        failure_window_s=600.0,
        cooldown_s=60.0,
        clock=clock,
    )
    for _ in range(DEFAULT_FAILURE_THRESHOLD):
        r.record_failure("https://a")
    # Cooldown is 60s; advance just past it, but failures (within last 600s) remain.
    clock.advance(61.0)
    assert r.health("https://a") == HealthState.UNHEALTHY


def test_p95_latency_with_many_samples_orders_correctly():
    """With enough samples, the p95 calculation should distinguish fast vs slow tails."""
    fast = FacilitatorConfig(name="fast", url="https://fast")
    bursty = FacilitatorConfig(name="bursty", url="https://bursty")
    r = _make_router(fast, bursty)
    # fast: tight cluster around 200ms.
    for _ in range(50):
        r.record_success("https://fast", latency_ms=200.0)
    # bursty: mostly fast, but a long tail past 4500ms — p95 lands in the tail.
    for _ in range(45):
        r.record_success("https://bursty", latency_ms=200.0)
    for _ in range(5):
        r.record_success("https://bursty", latency_ms=4800.0)
    picks = r.select()
    assert picks[0].url == "https://fast"


def test_select_with_no_arguments_uses_default_context():
    """`select()` with no args should not raise and should return all eligible facilitators."""
    a = FacilitatorConfig(name="A", url="https://a")
    b = FacilitatorConfig(name="B", url="https://b")
    r = _make_router(a, b)
    picks = r.select()
    assert {p.url for p in picks} == {"https://a", "https://b"}


def test_registered_property_returns_fresh_list():
    """`registered` should not expose internal state; mutating the result is harmless."""
    a = FacilitatorConfig(name="A", url="https://a")
    r = _make_router(a)
    snapshot = r.registered
    snapshot.clear()
    # Internal state untouched.
    assert len(r.registered) == 1


def test_publisher_url_unknown_to_router_logs_no_outbound_intent():
    """Defense-in-depth: an attacker-controlled pay.json URL must never appear in the picks."""
    a = FacilitatorConfig(name="A", url="https://known")
    r = _make_router(a)
    picks = r.select(
        publisher_facilitators=[
            "http://attacker.invalid/steal",
            "https://known",
            "javascript:alert(1)",
            "file:///etc/passwd",
        ]
    )
    # Only the registered URL surfaces; attacker URLs silently dropped.
    assert [p.url for p in picks] == ["https://known"]
