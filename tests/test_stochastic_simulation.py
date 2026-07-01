"""Tests for the Monte Carlo stochastic microsimulator.

Two layers of evidence:

  1. **Behavioural sanity** — zero flow → zero delay, monotonicity,
     reproducibility, reaction-time effect. These catch implementation
     bugs (wrong queue handling, swapped indices, RNG misuse).

  2. **Convergence to the analytical reference** — at low-to-moderate
     saturation with deterministic arrivals and zero reaction noise, the
     Monte Carlo mean delay should approach Webster's. With Poisson
     arrivals, the MC mean is allowed to *exceed* Webster's at high x,
     because Poisson variance produces the same stochastic overshoot
     HCM 6th Ed. models via d2. The defensible operational claim is
     therefore: at low x, MC and Webster's agree; at high x, MC reveals
     the variance Webster's misses.

Documented in `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5 "Stochastic
confirmation of analytical delay estimates" and
`docs/STOCHASTIC_MICROSIM_PLAN.md`.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from server.simulation import compute_uniform_delay
from server.stochastic_simulation import (
    ArrivalProcess,
    SignalProgram,
    monte_carlo_compare,
    monte_carlo_delay,
    simulate_one_run,
    _per_run_rng,
)


# ── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture
def single_approach_program() -> SignalProgram:
    """C=90, g=36 for one approach. Webster's @ q=400 → 22.68 s/veh."""
    return SignalProgram(
        cycle_length_s=90,
        green_seconds={1: 36.0},
        phase_offsets={1: 0},
    )


@pytest.fixture
def two_approach_program() -> SignalProgram:
    """Two approaches sharing one 90-second cycle: each gets 36 s green.

    Approach 1: green at [0, 36). Approach 2: green at [43, 79). Seven-second
    inter-green clearance between phases matches lost_time + all_red defaults.
    """
    return SignalProgram(
        cycle_length_s=90,
        green_seconds={1: 36.0, 2: 36.0},
        phase_offsets={1: 0, 2: 43},
    )


# ── Layer 1: Behavioural sanity ────────────────────────────────────────────

def test_poisson_arrivals_match_expected_count():
    """At q=400 PCU/hr over 3600s the count is Poisson(400)."""
    rng = np.random.default_rng(seed=42)
    arrivals = ArrivalProcess.poisson_arrivals(
        rate_per_sec=400 / 3600, duration_sec=3600, rng=rng,
    )
    # Poisson(400) has σ = 20; six-sigma window keeps the test stable.
    assert 400 - 6 * 20 < len(arrivals) < 400 + 6 * 20
    assert all(0 <= t < 3600 for t in arrivals)
    # Sorted ascending.
    assert arrivals == sorted(arrivals)


def test_signal_program_is_green():
    program = SignalProgram(
        cycle_length_s=90,
        green_seconds={1: 36.0},
        phase_offsets={1: 0},
    )
    assert program.is_green(1, 0.0)
    assert program.is_green(1, 35.999)
    assert not program.is_green(1, 36.0)
    assert not program.is_green(1, 89.999)
    # Periodicity.
    assert program.is_green(1, 90.0)
    assert program.is_green(1, 125.999)


def test_zero_flow_produces_zero_delay(single_approach_program):
    """No vehicles, no delay, every run."""
    stats = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 0.0},
        signal_program=single_approach_program,
        n_runs=10,
        duration_sec=600,
    )
    assert stats[1].mean == 0.0
    assert stats[1].std == 0.0
    assert stats[1].n_runs == 10


def test_positive_flow_produces_positive_delay(single_approach_program):
    """Real flow + a red phase must yield positive mean delay."""
    stats = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 400.0},
        signal_program=single_approach_program,
        n_runs=20,
        duration_sec=3600,
    )
    assert stats[1].mean > 0.0
    assert stats[1].ci_low_95 < stats[1].mean < stats[1].ci_high_95


def test_doubling_flow_increases_mean_delay(single_approach_program):
    """Higher q at fixed timing → higher mean delay (below saturation)."""
    low = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 200.0},
        signal_program=single_approach_program,
        n_runs=30, duration_sec=3600,
    )
    high = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 400.0},
        signal_program=single_approach_program,
        n_runs=30, duration_sec=3600,
    )
    assert high[1].mean > low[1].mean


def test_reaction_time_variability_increases_delay(single_approach_program):
    """σ_react: 0 → 2 should not decrease mean delay."""
    quiet = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 400.0},
        signal_program=single_approach_program,
        n_runs=40, duration_sec=3600,
        driver_reaction_sd_sec=0.0,
    )
    noisy = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 400.0},
        signal_program=single_approach_program,
        n_runs=40, duration_sec=3600,
        driver_reaction_sd_sec=2.0,
    )
    assert noisy[1].mean > quiet[1].mean


def test_reproducibility_same_seeds_same_results(single_approach_program):
    """Identical inputs → identical per-run means, bit-for-bit."""
    a = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 400.0},
        signal_program=single_approach_program,
        n_runs=15, duration_sec=3600, base_seed=12345,
    )
    b = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 400.0},
        signal_program=single_approach_program,
        n_runs=15, duration_sec=3600, base_seed=12345,
    )
    assert a[1].per_run_means == b[1].per_run_means
    assert a[1].mean == b[1].mean
    assert a[1].ci_low_95 == b[1].ci_low_95


# ── Layer 2: Convergence to Webster's ───────────────────────────────────────

def test_convergence_to_websters_at_low_saturation(single_approach_program):
    """Poisson MC mean is within 2 s/veh of Webster's at x ≤ 0.5.

    At low-to-moderate saturation, Webster's uniform delay is the dominant
    term; HCM d2 (incremental) is small. The MC simulator should agree.
    The 2 s/veh threshold absorbs (a) per-second discretisation of saturation
    discharge and (b) finite-sample Monte Carlo noise at n_runs=200.
    """
    # x = 200 * 90 / (1400 * 36) = 0.357 → low saturation.
    q = 200.0
    analytical = compute_uniform_delay(C=90, g=36, q_pcu_hr=int(q))
    stats = monte_carlo_delay(
        q_pcu_hr_per_approach={1: q},
        signal_program=single_approach_program,
        n_runs=200, duration_sec=3600,
        driver_reaction_sd_sec=0.0,
    )
    assert abs(stats[1].mean - analytical) < 2.0, (
        f"MC mean {stats[1].mean:.2f} vs Webster {analytical:.2f}"
    )


def test_high_saturation_mc_exceeds_websters(single_approach_program):
    """At x ≈ 0.9, Poisson MC must exceed Webster's d1.

    This is the HCM 6th Ed. d2 (incremental) effect: random arrival
    variance produces overflow even when the deterministic-average flow
    fits within capacity. The MC simulator reproduces this naturally;
    Webster's uniform delay alone does not. The methods-chapter framing
    is: at high x, the analytical estimate is an under-bound and the MC
    sim reveals the true expected delay.
    """
    # x = 500 * 90 / (1400 * 36) = 0.893 → near-saturated.
    q = 500.0
    analytical = compute_uniform_delay(C=90, g=36, q_pcu_hr=int(q))
    stats = monte_carlo_delay(
        q_pcu_hr_per_approach={1: q},
        signal_program=single_approach_program,
        n_runs=100, duration_sec=3600,
    )
    # MC strictly exceeds Webster's at high x with normal margin.
    assert stats[1].mean > analytical + 2.0


def test_no_noise_limit_matches_webster(single_approach_program):
    """Deterministic arrivals + σ_react=0 → MC mean ≈ Webster's d1 (±2 s/veh).

    This is the "no-noise limit" convergence claim. Webster's assumes a
    continuous uniform arrival rate and continuous saturation discharge;
    our simulator discretises both (vehicles arrive at fixed intervals,
    discharge at headway = 3600/sat_flow seconds). The 2 s/veh slack
    absorbs (a) the discrete-headway artifact and (b) the alignment
    artifact between deterministic arrivals and signal phase. Using
    q=400 ensures many arrivals per cycle (≈10), which smooths the
    alignment artifact below the threshold.
    """
    q = 400.0  # 10 vehicles per 90-second cycle → alignment smoothed
    analytical = compute_uniform_delay(C=90, g=36, q_pcu_hr=int(q))
    stats = monte_carlo_delay(
        q_pcu_hr_per_approach={1: q},
        signal_program=single_approach_program,
        n_runs=5, duration_sec=7200,
        driver_reaction_sd_sec=0.0,
        deterministic_arrivals=True,
    )
    assert abs(stats[1].mean - analytical) < 2.0, (
        f"No-noise MC {stats[1].mean:.2f} vs Webster {analytical:.2f}"
    )


def test_mc_bias_relative_to_webster_grows_with_saturation(single_approach_program):
    """MC bias above Webster's is monotone non-decreasing across saturation
    levels — the HCM d2 (incremental delay) signature.

    Why this matters: the methods chapter's defensible claim is that
    Webster's is operationally adequate where the system *recommends*
    timings (target x ≤ 0.85) and is a lower bound elsewhere. This test
    pins down the bias direction, which is the load-bearing claim. A
    regression that broke d2-like overflow capture would flip this
    ordering or collapse the bias to zero across saturations.
    """
    biases: list[float] = []
    for q in (100.0, 300.0, 500.0):
        analytical = compute_uniform_delay(C=90, g=36, q_pcu_hr=int(q))
        stats = monte_carlo_delay(
            q_pcu_hr_per_approach={1: q},
            signal_program=single_approach_program,
            n_runs=80, duration_sec=3600,
        )
        biases.append(stats[1].mean - analytical)
    # Monotone non-decreasing across the three saturation points.
    assert biases[0] <= biases[1] <= biases[2], biases
    # And the high-saturation bias is materially positive (the d2 effect).
    assert biases[2] > 3.0, biases


# ── Multi-approach + comparison sanity ──────────────────────────────────────

def test_multi_approach_independent_queues(two_approach_program):
    """Two approaches with identical flows should produce similar delays.

    Both have 36 s green per 90 s cycle, only the phase offset differs;
    by symmetry, per-approach mean delays should match within MC noise.
    """
    stats = monte_carlo_delay(
        q_pcu_hr_per_approach={1: 300.0, 2: 300.0},
        signal_program=two_approach_program,
        n_runs=40, duration_sec=3600,
    )
    assert abs(stats[1].mean - stats[2].mean) < 1.5


def test_compare_identical_programs_saves_zero(single_approach_program):
    """If before == after, vehicle_hours_saved mean ≈ 0 and CI straddles 0."""
    result = monte_carlo_compare(
        q_pcu_hr_per_approach={1: 400.0},
        before_program=single_approach_program,
        after_program=single_approach_program,
        n_runs=50, duration_sec=3600,
    )
    vh = result.vehicle_hours_saved
    assert abs(vh.mean) < 1.0
    assert vh.ci_low_95 <= 0.0 <= vh.ci_high_95


def test_compare_better_timing_saves_positive_vh(single_approach_program):
    """Doubling green time on a congested approach should save vehicle-hours."""
    bad = SignalProgram(
        cycle_length_s=90, green_seconds={1: 20.0}, phase_offsets={1: 0},
    )
    good = SignalProgram(
        cycle_length_s=90, green_seconds={1: 50.0}, phase_offsets={1: 0},
    )
    result = monte_carlo_compare(
        q_pcu_hr_per_approach={1: 300.0},
        before_program=bad,
        after_program=good,
        n_runs=40, duration_sec=3600,
    )
    vh = result.vehicle_hours_saved
    # More green → less delay → positive saved vehicle-hours, well clear of 0.
    assert vh.mean > 0.0
    assert vh.ci_low_95 > 0.0


def test_per_run_rng_streams_are_independent():
    """Different streams from the same (base_seed, run_index) yield
    different draws, while the same (seed, index, stream) is reproducible."""
    a0 = _per_run_rng(42, 0, stream=0).standard_normal(10)
    a1 = _per_run_rng(42, 0, stream=1).standard_normal(10)
    a0_again = _per_run_rng(42, 0, stream=0).standard_normal(10)
    assert not np.array_equal(a0, a1)
    assert np.array_equal(a0, a0_again)
