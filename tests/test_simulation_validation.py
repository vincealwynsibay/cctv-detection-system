"""Validation tests for the analytical delay simulation.

These tests go beyond the unit tests in `test_simulation.py` (which check
formula behaviour at edge cases). They cross-validate the production
simulation against:

  1. **Closed-form expected values** computed by hand from Webster's 1958.
     If `compute_uniform_delay` produces the wrong number on these inputs,
     the implementation is wrong, not the formula.
  2. **HCM 6th Edition full delay** (uniform + incremental) for the same
     inputs. Webster's uniform-only should match HCM 6th Ed full delay
     within ~5% under low saturation, and progressively underestimate as
     saturation grows.
  3. **Dose-response curve shape** across the flow range. Delay must rise
     monotonically and convexly, with v/c → 1 producing the asymptotic
     blow-up. If the shape is wrong, the model is wrong even if individual
     point values look fine.

Documented as `docs/PANEL_DEFENSE_GUIDE.md` §"What the simulation does, what
it does not do, and why you can trust it."
"""
from __future__ import annotations

import pytest

from server.simulation import compute_uniform_delay
from server.simulation_validation import (
    DelayPoint,
    hcm_full_delay,
    hcm_uniform_delay,
    sweep_dose_response,
)


# ── 1. Closed-form Webster's values (computed by hand) ──────────────────────

# Webster's 1958: d = 0.5 · C · (1 − g/C)² / (1 − x · g/C)
# All test cases use SATURATION_FLOW = 1400 PCU/hr.

@pytest.mark.parametrize("C, g, q, expected", [
    # ── moderate saturation (textbook-style examples) ──
    # C=90, g=36 (g/C=0.4), q=400, s=1400 → cap=560, x=0.714
    #   d = 0.5 × 90 × 0.36 / (1 - 0.714 × 0.4) = 16.2 / 0.714 ≈ 22.69
    (90, 36, 400, 22.69),
    # C=120, g=48 (g/C=0.4), q=600, s=1400 → cap=560, x=0.98 (capped)
    #   d = 0.5 × 120 × 0.36 / (1 - 0.98 × 0.4) = 21.6 / 0.608 ≈ 35.53
    (120, 48, 600, 35.53),
    # ── low saturation, light traffic ──
    # C=60, g=24 (g/C=0.4), q=200, s=1400 → cap=560, x=0.357
    #   d = 0.5 × 60 × 0.36 / (1 - 0.357 × 0.4) = 10.8 / 0.857 ≈ 12.60
    (60, 24, 200, 12.60),
    # ── longer cycle, more green ──
    # C=120, g=60 (g/C=0.5), q=400, s=1400 → cap=700, x=0.571
    #   d = 0.5 × 120 × 0.25 / (1 - 0.571 × 0.5) = 15.0 / 0.714 ≈ 21.01
    (120, 60, 400, 21.01),
    # ── short cycle, peaked low ──
    # C=60, g=30 (g/C=0.5), q=300, s=1400 → cap=700, x=0.429
    #   d = 0.5 × 60 × 0.25 / (1 - 0.429 × 0.5) = 7.5 / 0.786 ≈ 9.54
    (60, 30, 300, 9.54),
])
def test_webster_matches_closed_form_value(C, g, q, expected):
    """Webster's uniform delay matches a hand-computed value to within 0.5 s.

    Production formula in `server.simulation.compute_uniform_delay`. If this
    test fails, the implementation has drifted from Webster's 1958 — not
    necessarily a bug, but a deviation that must be re-documented in the
    methods chapter and re-validated against the HCM 6th Ed reference.
    """
    actual = compute_uniform_delay(C=C, g=g, q_pcu_hr=q)
    assert actual == pytest.approx(expected, abs=0.5), (
        f"Webster's drifted: C={C} g={g} q={q} expected≈{expected} got {actual}"
    )


# ── 2. HCM 6th Ed cross-validation ──────────────────────────────────────────

@pytest.mark.parametrize("C, g, q", [
    (90, 36, 200),      # low saturation
    (90, 36, 400),      # moderate saturation
    (120, 60, 400),     # longer cycle, light traffic
    (60, 30, 300),      # short cycle, moderate
])
def test_webster_under_hcm_full_at_low_saturation(C, g, q):
    """At low-to-moderate saturation (x ≤ 0.7), Webster's d1 ≤ HCM full delay,
    and the absolute gap ≤ 5 s/veh.

    HCM full = d1 + d2. The incremental delay term d2 is small (~1-3 s/veh)
    at low saturation but never zero, so Webster's uniform-only is
    consistently a slight under-estimate. This test pins both the
    direction (d1 ≤ d_full) and the magnitude of the under-estimate (≤ 5
    s/veh) under operational conditions.
    """
    sat = 1400
    cap = sat * (g / C)
    x = min(1.0, q / cap)
    if x > 0.7:
        pytest.skip(f"x={x:.2f} > 0.7; tested separately as over-saturation case")
    webster = compute_uniform_delay(C=C, g=g, q_pcu_hr=q)
    hcm     = hcm_full_delay(C=C, g=g, q_pcu_hr=q)
    assert webster <= hcm + 0.05, (
        f"Webster's exceeds HCM full at x={x:.2f}: "
        f"webster={webster:.2f}, hcm_full={hcm:.2f}"
    )
    absolute_gap = abs(hcm - webster)
    assert absolute_gap <= 5.0, (
        f"Webster-vs-HCM gap > 5 s/veh at x={x:.2f}: "
        f"webster={webster:.2f}, hcm={hcm:.2f}, gap={absolute_gap:.2f}s"
    )


def test_webster_uniform_matches_hcm_d1_under_uncapped_saturation():
    """Webster's uniform delay == HCM 6th Ed d1 (identical formula).

    Confirms the reference HCM implementation we cross-validate against
    has not drifted from the production formula. Both should match to
    within rounding precision at any x ≤ 0.95 (well below the 0.98 cap
    used by the production formula).

    Cases above x = 0.95 hit the production formula's cap and stop tracking
    HCM d1 by design; those are exercised in the over-saturation test.
    """
    test_cases = [(90, 36, 400), (120, 60, 600), (60, 24, 200)]
    for C, g, q in test_cases:
        webster = compute_uniform_delay(C=C, g=g, q_pcu_hr=q)
        d1      = hcm_uniform_delay(C, g, q)
        assert d1 == pytest.approx(webster, abs=0.05), (
            f"d1 ≠ Webster at C={C} g={g} q={q}: webster={webster}, d1={d1}"
        )


def test_webster_underestimates_hcm_when_oversaturated():
    """At v/c > 0.9, Webster's uniform-only underestimates HCM 6th Ed full delay.

    This is the documented limit of using uniform-only. It is also the
    point where the intervention precedence rule (`road_widening` when
    critical_vc > 0.90) takes over from "tweak the timing." So the
    underestimate does not produce wrong recommendations — the system has
    a cascading defense documented in `docs/PANEL_DEFENSE_GUIDE.md`.
    """
    # cap = 1400 * 0.4 = 560; q = 540 → x ≈ 0.964
    C, g, q = 90, 36, 540
    webster = compute_uniform_delay(C=C, g=g, q_pcu_hr=q)
    hcm     = hcm_full_delay(C=C, g=g, q_pcu_hr=q)
    assert webster < hcm, (
        f"Expected Webster's < HCM at v/c>0.9; "
        f"webster={webster:.2f}, hcm={hcm:.2f}"
    )


# ── 3. Dose-response curve shape ────────────────────────────────────────────

def test_dose_response_is_monotonically_increasing():
    """Delay must rise monotonically with flow at fixed (C, g).

    If the curve dips anywhere, the simulation has a bug. Standard
    transportation engineering: under fixed signal control, adding cars
    cannot reduce delay.
    """
    curve = sweep_dose_response(C=90, g=36, flow_min=100, flow_max=550, n_steps=10)
    for i in range(1, len(curve)):
        assert curve[i].webster_uniform_delay_s >= curve[i - 1].webster_uniform_delay_s, (
            f"Webster's delay decreased between {curve[i-1].flow_pcu_hr} and "
            f"{curve[i].flow_pcu_hr} PCU/hr"
        )


def test_dose_response_is_convex():
    """Delay must accelerate as flow approaches capacity (second derivative > 0).

    Verifies the classic v/c-vs-delay curve shape transportation engineers
    expect: near-linear at low saturation, sharply rising as x → 1. A
    linear or concave curve would be evidence of a fundamentally wrong
    model.
    """
    curve = sweep_dose_response(C=90, g=36, flow_min=100, flow_max=550, n_steps=10)
    # Compute first differences (per-step delay growth); they should be non-decreasing.
    diffs = [
        curve[i].webster_uniform_delay_s - curve[i - 1].webster_uniform_delay_s
        for i in range(1, len(curve))
    ]
    # Allow a small numerical tolerance at the low-saturation flat part.
    for j in range(1, len(diffs)):
        assert diffs[j] >= diffs[j - 1] - 0.5, (
            f"Curve not convex at step {j}: prev growth={diffs[j-1]:.2f}, "
            f"this growth={diffs[j]:.2f}"
        )


def test_dose_response_zero_flow_zero_delay():
    """Zero flow → zero delay, in both Webster and HCM."""
    curve = sweep_dose_response(C=90, g=36, flow_min=0, flow_max=400, n_steps=5)
    assert curve[0].webster_uniform_delay_s == 0.0
    assert curve[0].hcm_full_delay_s == 0.0


def test_dose_response_hcm_diverges_from_webster_at_high_saturation():
    """HCM 6th Ed full delay grows faster than Webster's at v/c > 0.7.

    This is the same finding as `test_webster_underestimates_hcm_when_oversaturated`,
    but expressed as a curve-shape property. The HCM curve must pull
    visibly ahead of Webster's in the high-x range; if it does not, the
    incremental term is implemented wrong.
    """
    curve = sweep_dose_response(C=90, g=36, flow_min=200, flow_max=540, n_steps=10)
    high_x_points = [p for p in curve if p.degree_of_saturation > 0.7]
    assert high_x_points, "Sweep did not reach x > 0.7; widen flow range"
    for p in high_x_points:
        assert p.hcm_full_delay_s >= p.webster_uniform_delay_s, (
            f"At x={p.degree_of_saturation:.2f}: hcm={p.hcm_full_delay_s:.2f} "
            f"< webster={p.webster_uniform_delay_s:.2f}"
        )


# ── 4. Smoke check on the sweep utility itself ──────────────────────────────

def test_sweep_returns_requested_number_of_points():
    """`sweep_dose_response` honours n_steps."""
    curve = sweep_dose_response(C=90, g=36, flow_min=0, flow_max=500, n_steps=11)
    assert len(curve) == 11
    assert isinstance(curve[0], DelayPoint)
    assert curve[0].flow_pcu_hr == 0.0
    assert curve[-1].flow_pcu_hr == 500.0
