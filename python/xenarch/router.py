"""Facilitator Router — selects an x402 facilitator per payment.

Implements `Information/design/facilitator-router.md`. The Router picks a
ranked fallback list of facilitators for each payment based on a weighted
score (fee, gas sponsorship, spec compliance, observed uptime, observed
latency, publisher preference). Failed settlements are recorded as
passive health signals; a facilitator that exceeds the failure threshold
within the rolling window is circuit-broken for the cooldown period.

The Router only selects from facilitators it was constructed with (its
"registered stack"). A publisher's pay.json may rank a SUBSET of the
registered stack; URLs not in the stack are ignored. This keeps the
Router from making outbound calls to arbitrary URLs sourced from
publisher metadata.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Callable, Sequence


# §9 — default facilitator stack. Coinbase is configurable, never default.
DEFAULT_FACILITATOR_STACK: tuple["FacilitatorConfig", ...]
# (Defined after FacilitatorConfig.)

# §6.1 circuit breaker defaults.
DEFAULT_FAILURE_THRESHOLD = 5
DEFAULT_FAILURE_WINDOW_S = 60.0
DEFAULT_COOLDOWN_S = 300.0

# §5.2 weights — sum to 1.0.
DEFAULT_WEIGHTS: dict[str, float] = {
    "fee": 0.30,
    "gas": 0.25,
    "spec": 0.10,
    "uptime": 0.15,
    "latency": 0.10,
    "preference": 0.10,
}


class HealthState(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


@dataclass(frozen=True)
class FacilitatorConfig:
    """Static facilitator metadata. Mutable runtime state lives in `_FacilitatorState`."""

    name: str
    url: str
    spec_version: str = "v2"
    fee_bps: int = 0
    gas_sponsored: bool = True
    supported_chains: frozenset[str] = frozenset({"base"})
    supported_assets: frozenset[str] = frozenset({"USDC"})


DEFAULT_FACILITATOR_STACK = (
    FacilitatorConfig(
        name="PayAI",
        url="https://facilitator.payai.network",
    ),
    FacilitatorConfig(
        name="xpay",
        url="https://facilitator.xpay.dev",
    ),
    FacilitatorConfig(
        name="Ultravioleta DAO",
        url="https://x402.ultravioletadao.xyz",
    ),
    FacilitatorConfig(
        name="x402.rs",
        url="https://x402.rs",
    ),
)


@dataclass
class PaymentContext:
    chain: str = "base"
    asset: str = "USDC"
    amount_usd: Decimal | None = None
    publisher_max_fee_bps: int | None = None


@dataclass
class _FacilitatorState:
    config: FacilitatorConfig
    failures: deque[float] = field(default_factory=lambda: deque(maxlen=200))
    successes: deque[float] = field(default_factory=lambda: deque(maxlen=200))
    latency_samples_ms: deque[float] = field(default_factory=lambda: deque(maxlen=50))
    cooldown_until: float = 0.0

    def health(self, now: float, threshold: int, window_s: float) -> HealthState:
        if now < self.cooldown_until:
            return HealthState.UNHEALTHY
        recent = sum(1 for t in self.failures if now - t < window_s)
        if recent >= threshold:
            return HealthState.UNHEALTHY
        if recent > 0:
            return HealthState.DEGRADED
        return HealthState.HEALTHY


class Router:
    """Selects facilitators per payment, tracks passive health, falls back on failure."""

    def __init__(
        self,
        facilitators: Sequence[FacilitatorConfig] | None = None,
        weights: dict[str, float] | None = None,
        failure_threshold: int = DEFAULT_FAILURE_THRESHOLD,
        failure_window_s: float = DEFAULT_FAILURE_WINDOW_S,
        cooldown_s: float = DEFAULT_COOLDOWN_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        configs = (
            list(facilitators) if facilitators is not None else list(DEFAULT_FACILITATOR_STACK)
        )
        if not configs:
            raise ValueError("Router requires at least one facilitator")
        # Preserve insertion order; dict is ordered in Py3.7+.
        self._states: dict[str, _FacilitatorState] = {
            c.url: _FacilitatorState(config=c) for c in configs
        }
        self._weights = dict(weights) if weights is not None else dict(DEFAULT_WEIGHTS)
        self._failure_threshold = failure_threshold
        self._failure_window_s = failure_window_s
        self._cooldown_s = cooldown_s
        self._clock = clock
        self._last_used_url: str | None = None

    @property
    def registered(self) -> list[FacilitatorConfig]:
        return [s.config for s in self._states.values()]

    def select(
        self,
        ctx: PaymentContext | None = None,
        publisher_facilitators: Sequence[str] | None = None,
        max_results: int = 3,
    ) -> list[FacilitatorConfig]:
        """Return a ranked fallback list. Empty list if nothing eligible."""
        ctx = ctx or PaymentContext()
        now = self._clock()

        candidates: list[_FacilitatorState] = []
        for state in self._states.values():
            cfg = state.config
            if ctx.chain not in cfg.supported_chains:
                continue
            if ctx.asset not in cfg.supported_assets:
                continue
            if (
                ctx.publisher_max_fee_bps is not None
                and cfg.fee_bps > ctx.publisher_max_fee_bps
            ):
                continue
            if state.health(now, self._failure_threshold, self._failure_window_s) == HealthState.UNHEALTHY:
                continue
            candidates.append(state)

        if not candidates:
            return []

        publisher_rank: dict[str, int] = {}
        if publisher_facilitators:
            i = 0
            for url in publisher_facilitators:
                if url in self._states and url not in publisher_rank:
                    publisher_rank[url] = i
                    i += 1

        scored = [(self._score(s, now, publisher_rank), s) for s in candidates]
        scored.sort(key=lambda pair: pair[0], reverse=True)

        # §5.4 tie-break: within 1%, prefer different from last used.
        if len(scored) >= 2 and self._last_used_url:
            top_score, top_state = scored[0]
            next_score, next_state = scored[1]
            denom = max(abs(top_score), 1e-9)
            if abs(top_score - next_score) / denom < 0.01:
                if top_state.config.url == self._last_used_url:
                    scored[0], scored[1] = scored[1], scored[0]

        return [s.config for _, s in scored[:max_results]]

    def record_success(self, url: str, latency_ms: float | None = None) -> None:
        state = self._states.get(url)
        if state is None:
            return
        now = self._clock()
        state.successes.append(now)
        if latency_ms is not None:
            state.latency_samples_ms.append(latency_ms)
        self._last_used_url = url

    def record_failure(self, url: str) -> None:
        state = self._states.get(url)
        if state is None:
            return
        now = self._clock()
        state.failures.append(now)
        recent = sum(1 for t in state.failures if now - t < self._failure_window_s)
        if recent >= self._failure_threshold:
            state.cooldown_until = now + self._cooldown_s

    def health(self, url: str) -> HealthState | None:
        state = self._states.get(url)
        if state is None:
            return None
        return state.health(
            self._clock(), self._failure_threshold, self._failure_window_s
        )

    def _score(
        self,
        state: _FacilitatorState,
        now: float,
        publisher_rank: dict[str, int],
    ) -> float:
        cfg = state.config
        w = self._weights
        # Fee: 0bps → 1.0, 100bps+ → 0.0. Linear in between.
        fee_component = 1.0 - min(cfg.fee_bps / 100.0, 1.0)
        gas_component = 1.0 if cfg.gas_sponsored else 0.0
        spec_component = 1.0 if cfg.spec_version == "v2" else 0.5
        uptime_component = self._uptime_component(state, now)
        latency_component = self._latency_component(state)
        if cfg.url in publisher_rank and publisher_rank:
            n = max(len(publisher_rank), 1)
            # Rank 0 (top) → 1.0; last rank → ~0.0.
            preference_component = 1.0 - (publisher_rank[cfg.url] / n)
        else:
            preference_component = 0.0
        return (
            w["fee"] * fee_component
            + w["gas"] * gas_component
            + w["spec"] * spec_component
            + w["uptime"] * uptime_component
            + w["latency"] * latency_component
            + w["preference"] * preference_component
        )

    @staticmethod
    def _uptime_component(state: _FacilitatorState, now: float) -> float:
        # Spec calls for 7-day rolling; deques are bounded at 200 events,
        # which is approximate but cheap. Untested = optimistic.
        window_s = 7 * 24 * 3600.0
        s = sum(1 for t in state.successes if now - t < window_s)
        f = sum(1 for t in state.failures if now - t < window_s)
        total = s + f
        if total == 0:
            return 1.0
        return s / total

    @staticmethod
    def _latency_component(state: _FacilitatorState) -> float:
        if not state.latency_samples_ms:
            return 1.0
        # p95 inverted, clamped to [500ms, 5000ms].
        sorted_samples = sorted(state.latency_samples_ms)
        p95_idx = max(0, int(len(sorted_samples) * 0.95) - 1)
        p95 = sorted_samples[p95_idx]
        if p95 <= 500:
            return 1.0
        if p95 >= 5000:
            return 0.0
        return 1.0 - (p95 - 500) / 4500
