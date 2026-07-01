"""Reference implementations + validation utilities for the delay simulation.

The production analytical delay simulation in `server.simulation` uses
Webster's 1958 uniform-delay term as its core. That single-term form is
exact under-saturated steady-state and is what every textbook treatment
of signal timing starts from.

This module adds two things the production formula does not:

  * **Full HCM 6th Edition control delay** — the published d = d1 + d2 + d3
    formula, with d1 = uniform (matches Webster's), d2 = incremental (random
    + oversaturation), d3 = initial queue. We use this as an *independent*
    reference implementation to cross-validate the production simulation:
    at low v/c Webster's ≈ HCM 6th Ed within ~5%; at high v/c (> 0.9)
    Webster's underestimates and the system hands off to the intervention
    precedence rule (road_widening). That handoff is the cascading defense
    we cite in the panel guide.

  * **Dose-response sweep utility** — runs Webster's uniform delay across a
    flow range at fixed timing and returns the curve. Used by
    `tests/test_simulation_validation.py` to assert the simulation produces
    the convex curve shape transportation engineers expect.

This module is *thesis-side*. Nothing in production calls it; it exists to
make the simulation engine's behaviour auditable against the engineering
literature in tests and in `docs/PANEL_DEFENSE_GUIDE.md`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


# Defaults mirror server.simulation.SATURATION_FLOW so cross-checks compare
# apples to apples. If saturation_flow gets recalibrated in production, this
# module should re-import that constant rather than re-define it.
SATURATION_FLOW = 1400          # PCU/hr per approach
MAX_DEGREE_OF_SATURATION = 0.98 # matches the cap in compute_uniform_delay


# ── HCM 6th Edition control delay (reference implementation) ────────────────

def hcm_uniform_delay(
    C: float,
    g: float,
    q_pcu_hr: float,
    sat_flow: float = SATURATION_FLOW,
) -> float:
    """HCM 6th Ed. d1 — uniform delay term (identical to Webster's 1958).

    d1 = 0.5 · C · (1 - g/C)² / (1 - min(1, X) · g/C)

    where X = q / (s · g/C) is the degree of saturation. Returned in
    seconds per vehicle.
    """
    if q_pcu_hr <= 0 or g <= 0 or C <= 0:
        return 0.0
    lam = g / C
    capacity = sat_flow * lam
    X = min(1.0, q_pcu_hr / capacity) if capacity > 0 else 1.0
    denom = 1 - X * lam
    if denom <= 0:
        return float("inf")
    return 0.5 * C * (1 - lam) ** 2 / denom


def hcm_incremental_delay(
    q_pcu_hr: float,
    capacity_pcu_hr: float,
    analysis_period_hr: float = 0.25,
    k: float = 0.5,      # control delay adjustment, pretimed signal
    I: float = 1.0,      # upstream filtering, isolated intersection
) -> float:
    """HCM 6th Ed. d2 — incremental delay term (random + oversaturation).

    d2 = 900 · T · [(X-1) + sqrt((X-1)² + 8·k·I·X / (c·T))]

    Returned in seconds per vehicle. For X ≤ 1 this term is small; it grows
    quickly when X > 1 (oversaturated). Defaults k=0.5 (pretimed signal),
    I=1.0 (isolated, no upstream filtering) follow HCM 6th Ed Exhibit 19-15.
    """
    if q_pcu_hr <= 0 or capacity_pcu_hr <= 0:
        return 0.0
    X = q_pcu_hr / capacity_pcu_hr
    T = analysis_period_hr
    inner = (X - 1) ** 2 + (8 * k * I * X) / (capacity_pcu_hr * T)
    return 900 * T * ((X - 1) + math.sqrt(max(0.0, inner)))


def hcm_full_delay(
    C: float,
    g: float,
    q_pcu_hr: float,
    sat_flow: float = SATURATION_FLOW,
    analysis_period_hr: float = 0.25,
) -> float:
    """HCM 6th Ed. d = d1 + d2 (d3 = 0 assuming no initial queue).

    The reference implementation we cross-validate Webster's against.
    Returned in seconds per vehicle.
    """
    if q_pcu_hr <= 0 or g <= 0 or C <= 0:
        return 0.0
    lam = g / C
    capacity = sat_flow * lam
    d1 = hcm_uniform_delay(C, g, q_pcu_hr, sat_flow)
    d2 = hcm_incremental_delay(q_pcu_hr, capacity, analysis_period_hr)
    return d1 + d2


# ── Dose-response sweep ────────────────────────────────────────────────────

@dataclass(frozen=True)
class DelayPoint:
    """One point on a dose-response curve."""
    flow_pcu_hr: float
    degree_of_saturation: float
    webster_uniform_delay_s: float
    hcm_full_delay_s: float


def sweep_dose_response(
    C: float,
    g: float,
    flow_min: float = 100.0,
    flow_max: float = 1300.0,
    n_steps: int = 13,
    sat_flow: float = SATURATION_FLOW,
) -> list[DelayPoint]:
    """Sweep flow from `flow_min` to `flow_max` at fixed (C, g).

    Returns the (Webster, HCM) delay curve. Used by tests to verify the
    simulation produces the convex shape transportation engineers expect:
    near-linear under low saturation, sharply rising toward saturation.
    """
    from server.simulation import compute_uniform_delay

    if n_steps < 2:
        raise ValueError("n_steps must be ≥ 2 to produce a curve")
    step = (flow_max - flow_min) / (n_steps - 1)
    out: list[DelayPoint] = []
    lam = g / C
    capacity = sat_flow * lam
    for i in range(n_steps):
        q = flow_min + i * step
        x = min(MAX_DEGREE_OF_SATURATION, q / capacity) if capacity > 0 else 0.0
        out.append(DelayPoint(
            flow_pcu_hr=q,
            degree_of_saturation=x,
            webster_uniform_delay_s=compute_uniform_delay(int(C), g, q, int(sat_flow)),
            hcm_full_delay_s=hcm_full_delay(C, g, q, sat_flow),
        ))
    return out
