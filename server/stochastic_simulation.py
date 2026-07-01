"""Monte Carlo stochastic microsimulation of intersection delay.

Sibling to `server.simulation`, not a replacement. The production runtime
keeps using the analytical Webster + HCM 6th Ed. delay engine for
recommendations. This module is thesis-side: it produces confidence
intervals around the analytical point estimates by simulating individual
vehicles with Poisson arrivals and driver-reaction variability across
many independent runs.

The model is intentionally matched to the analytical sim's modelling
depth (one approach, one lane, FIFO discharge at saturation flow during
green). It does *not* model lane-changing, gap-acceptance for permitted
lefts, or any of the things SUMO would. Those are out of scope per
`docs/STOCHASTIC_MICROSIM_PLAN.md` and `docs/SUMO_DEMO_SCOPING.md`.

Validation plan: at zero reaction-time noise and deterministic arrivals,
`monte_carlo_delay` should converge to `server.simulation.compute_uniform_delay`
within ~1 s/veh as `n_runs → ∞`. With realistic Poisson noise at
`n_runs = 100`, the analytical point estimate should fall inside the 95%
CI returned here. Both checks are enforced by
`tests/test_stochastic_simulation.py`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import stats


# ── Constants ──────────────────────────────────────────────────────────────

DEFAULT_SAT_FLOW_PCU_HR        = 1400   # matches server.webster.SATURATION_FLOW
DEFAULT_DURATION_SEC           = 3600   # 1 hour of simulation per run
DEFAULT_N_RUNS                 = 100
DEFAULT_DRIVER_REACTION_SD_SEC = 1.0    # σ of normal reaction delay
HEADWAY_SEC                    = 3600 / DEFAULT_SAT_FLOW_PCU_HR  # ≈2.57s


# ── Dataclasses ────────────────────────────────────────────────────────────

@dataclass
class Vehicle:
    """One simulated vehicle. depart_t is None if it never cleared the stop bar."""
    arrival_t: float
    approach_id: int
    depart_t: float | None = None

    def delay(self) -> float | None:
        if self.depart_t is None:
            return None
        return self.depart_t - self.arrival_t


@dataclass
class SignalProgram:
    """Fixed-time signal program.

    Per-approach phase split is encoded by `green_seconds[approach_id]`
    (green duration) and `phase_offsets[approach_id]` (start-of-green
    within the cycle, in seconds, in [0, cycle_length_s)).

    Inter-green clearance is informational here; the per-approach
    is_green() check uses only the offset and duration. Callers should
    place offsets so that no two approaches overlap their greens by
    more than the design allows (typically the lost time + all-red is
    *between* one approach's green-end and the next approach's
    green-start).
    """
    cycle_length_s: int
    green_seconds: dict[int, float]
    phase_offsets: dict[int, int]
    lost_time_per_phase: float = 4.0
    all_red_clearance: float = 3.0

    def is_green(self, approach_id: int, t_sec: float) -> bool:
        if approach_id not in self.green_seconds:
            return False
        g = self.green_seconds[approach_id]
        if g <= 0:
            return False
        offset = self.phase_offsets.get(approach_id, 0)
        phase = (t_sec - offset) % self.cycle_length_s
        return 0 <= phase < g

    def next_green_start(self, approach_id: int, t_sec: float) -> float:
        """Earliest time >= t_sec at which approach_id has the green.

        Returns t_sec itself if the approach is already green at t_sec.
        """
        if approach_id not in self.green_seconds:
            return math.inf
        g = self.green_seconds[approach_id]
        if g <= 0:
            return math.inf
        offset = self.phase_offsets.get(approach_id, 0)
        phase = (t_sec - offset) % self.cycle_length_s
        if 0 <= phase < g:
            return t_sec
        return t_sec + (self.cycle_length_s - phase)


@dataclass
class RunResult:
    """Per-approach outcome of one Monte Carlo run."""
    vehicles: list[Vehicle]
    mean_delay_s: float
    n_arrivals: int
    max_queue_length: int


@dataclass
class DelayStatistics:
    """Aggregate delay statistics over N independent Monte Carlo runs."""
    mean: float
    std: float
    ci_low_95: float
    ci_high_95: float
    n_runs: int
    per_run_means: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "mean":       round(self.mean, 4),
            "std":        round(self.std,  4),
            "ci_low_95":  round(self.ci_low_95,  4),
            "ci_high_95": round(self.ci_high_95, 4),
            "n_runs":     self.n_runs,
        }


@dataclass
class BeforeAfterStats:
    """Per-approach before/after delay statistics."""
    before: DelayStatistics
    after:  DelayStatistics

    def to_dict(self) -> dict:
        return {"before": self.before.to_dict(), "after": self.after.to_dict()}


@dataclass
class ComparisonResult:
    """Output of monte_carlo_compare across paired before/after runs."""
    per_approach: dict[int, BeforeAfterStats]
    vehicle_hours_saved: DelayStatistics


# ── Arrival processes ──────────────────────────────────────────────────────

class ArrivalProcess:
    """Stateless container for arrival-time generators."""

    @staticmethod
    def poisson_arrivals(
        rate_per_sec: float,
        duration_sec: float,
        rng: np.random.Generator,
    ) -> list[float]:
        """Return arrival times in [0, duration_sec) for a Poisson process.

        Draws inter-arrival times as Exponential(scale=1/rate_per_sec) and
        accumulates; truncates at duration_sec. Empty list if rate is zero
        or non-finite.
        """
        if rate_per_sec <= 0 or not math.isfinite(rate_per_sec):
            return []
        scale = 1.0 / rate_per_sec
        # Over-draw a buffer that almost surely exceeds duration. Mean of N
        # exponentials is N*scale; we want N*scale >> duration so we draw a
        # generous block, then truncate to the window.
        expected_n = rate_per_sec * duration_sec
        buffer_n = int(expected_n + 10 * math.sqrt(expected_n + 1) + 20)
        inter = rng.exponential(scale=scale, size=buffer_n)
        times = np.cumsum(inter)
        return times[times < duration_sec].tolist()

    @staticmethod
    def deterministic_arrivals(
        rate_per_sec: float,
        duration_sec: float,
    ) -> list[float]:
        """Evenly-spaced arrivals at rate_per_sec across [0, duration_sec).

        Used in convergence tests: with deterministic arrivals and zero
        reaction noise, the simulator should match Webster's closed-form
        uniform delay (since Webster's assumes uniform arrival rate).
        """
        if rate_per_sec <= 0 or not math.isfinite(rate_per_sec):
            return []
        step = 1.0 / rate_per_sec
        n = int(duration_sec * rate_per_sec)
        # First arrival at step/2 keeps the sample symmetric inside the
        # window and avoids a free vehicle at t=0 that biases delay low.
        return [(i + 0.5) * step for i in range(n)]


# ── Single run ─────────────────────────────────────────────────────────────

def _simulate_approach(
    approach_id: int,
    arrivals: list[float],
    program: SignalProgram,
    sat_flow_pcu_hr: float,
    driver_reaction_sd_sec: float,
    duration_sec: float,
    rng: np.random.Generator,
) -> RunResult:
    """Event-driven FIFO discharge for one approach.

    For each arrival in order:
      ready_t = max(arrival_t, prev_depart_t + headway)
      if green at ready_t:   depart_t = ready_t (+ reaction if new wave)
      if red at ready_t:     depart_t = next_green_start + reaction

    A "new wave" is when ready_t is constrained by green_start or by
    arrival_t (not by the previous vehicle's headway). That covers both
    the first vehicle after red and the first vehicle into an empty
    queue during green.

    Vehicles whose depart_t exceeds duration_sec are recorded with their
    depart_t but excluded from mean_delay; the queue snapshot at
    duration_sec sets max_queue_length.
    """
    headway = 3600.0 / sat_flow_pcu_hr
    vehicles: list[Vehicle] = [
        Vehicle(arrival_t=t, approach_id=approach_id) for t in arrivals
    ]

    prev_depart = -math.inf
    max_queue = 0
    queue_len = 0
    arrival_idx = 0

    # Track current queue length by interleaving arrival events and the
    # departure being computed for the head vehicle.
    for v in vehicles:
        # Vehicles that arrived before v but haven't departed yet are still
        # in queue. We compute v's depart_t under FIFO so its predecessors'
        # depart times are already final.
        ready_t = max(v.arrival_t, prev_depart + headway if math.isfinite(prev_depart) else v.arrival_t)
        green_at_ready = program.is_green(approach_id, ready_t)

        if green_at_ready:
            new_wave = (not math.isfinite(prev_depart)) or (ready_t > prev_depart + headway + 1e-9)
            depart_t = ready_t
            if new_wave and driver_reaction_sd_sec > 0:
                depart_t += _truncated_normal_reaction(rng, driver_reaction_sd_sec)
        else:
            green_start = program.next_green_start(approach_id, ready_t)
            depart_t = green_start
            if driver_reaction_sd_sec > 0:
                depart_t += _truncated_normal_reaction(rng, driver_reaction_sd_sec)

        v.depart_t = depart_t
        prev_depart = depart_t

    # Mean delay over vehicles that arrived AND departed within the window.
    delays = [
        v.delay() for v in vehicles
        if v.depart_t is not None and v.depart_t <= duration_sec
    ]
    mean_delay = float(np.mean(delays)) if delays else 0.0

    # Max queue length: number of vehicles in queue at any sampled second.
    # Sample at 1 Hz (matches the analytical sim's per-second discretisation).
    if vehicles:
        arr_times = np.array([v.arrival_t for v in vehicles])
        dep_times = np.array([
            v.depart_t if v.depart_t is not None else math.inf
            for v in vehicles
        ])
        sample_ts = np.arange(0.0, duration_sec + 1.0, 1.0)
        # Count vehicles where arrival_t <= t < depart_t. Vectorised pairwise
        # comparison: O(N * T) but T=3600 and N≈few hundred → fine.
        in_queue = (arr_times[None, :] <= sample_ts[:, None]) & (
            sample_ts[:, None] < dep_times[None, :]
        )
        max_queue = int(in_queue.sum(axis=1).max())

    return RunResult(
        vehicles=vehicles,
        mean_delay_s=round(mean_delay, 4),
        n_arrivals=len(arrivals),
        max_queue_length=max_queue,
    )


def _truncated_normal_reaction(rng: np.random.Generator, sd: float) -> float:
    """Draw a non-negative reaction delay ~ HalfNormal(sd).

    Operationally a truncated normal with mean 0, sd `sd`, truncated at 0.
    We sample |Normal(0, sd)| which is exactly the half-normal and avoids
    rejection-sampling loops.
    """
    return float(abs(rng.normal(loc=0.0, scale=sd)))


def simulate_one_run(
    arrivals_per_approach: dict[int, list[float]],
    signal_program: SignalProgram,
    sat_flow_pcu_hr: float = DEFAULT_SAT_FLOW_PCU_HR,
    driver_reaction_sd_sec: float = DEFAULT_DRIVER_REACTION_SD_SEC,
    duration_sec: float = DEFAULT_DURATION_SEC,
    rng: np.random.Generator | None = None,
) -> dict[int, RunResult]:
    """Simulate one Monte Carlo iteration across all approaches.

    Each approach is simulated independently. The signal program governs
    when each approach's queue may discharge; approaches do not interact
    other than through the shared cycle. This matches the analytical sim,
    which also treats approaches as decoupled queues sharing a cycle.
    """
    if rng is None:
        rng = np.random.default_rng()
    out: dict[int, RunResult] = {}
    for approach_id, arrivals in arrivals_per_approach.items():
        out[approach_id] = _simulate_approach(
            approach_id=approach_id,
            arrivals=list(arrivals),
            program=signal_program,
            sat_flow_pcu_hr=sat_flow_pcu_hr,
            driver_reaction_sd_sec=driver_reaction_sd_sec,
            duration_sec=duration_sec,
            rng=rng,
        )
    return out


# ── Monte Carlo aggregation ────────────────────────────────────────────────

def _per_run_rng(base_seed: int, run_index: int, stream: int = 0) -> np.random.Generator:
    """Reproducible per-run RNG derived from a SeedSequence.

    Each (base_seed, run_index, stream) triple produces an independent
    generator. The `stream` channel lets `monte_carlo_compare` reuse the
    same arrival seeds for before/after pairs while keeping reaction-time
    draws on a separate stream.
    """
    ss = np.random.SeedSequence([base_seed, run_index, stream])
    return np.random.default_rng(ss)


def _aggregate(per_run_means: list[float]) -> DelayStatistics:
    """Aggregate per-run means into mean ± 95% t-interval."""
    arr = np.asarray(per_run_means, dtype=float)
    n = len(arr)
    if n == 0:
        return DelayStatistics(
            mean=0.0, std=0.0, ci_low_95=0.0, ci_high_95=0.0,
            n_runs=0, per_run_means=[],
        )
    mean = float(np.mean(arr))
    if n < 2:
        return DelayStatistics(
            mean=mean, std=0.0, ci_low_95=mean, ci_high_95=mean,
            n_runs=n, per_run_means=arr.tolist(),
        )
    std = float(np.std(arr, ddof=1))
    sem = std / math.sqrt(n)
    if sem == 0:
        return DelayStatistics(
            mean=mean, std=0.0, ci_low_95=mean, ci_high_95=mean,
            n_runs=n, per_run_means=arr.tolist(),
        )
    lo, hi = stats.t.interval(0.95, df=n - 1, loc=mean, scale=sem)
    return DelayStatistics(
        mean=mean, std=std,
        ci_low_95=float(lo), ci_high_95=float(hi),
        n_runs=n, per_run_means=arr.tolist(),
    )


def _draw_arrivals(
    q_pcu_hr_per_approach: dict[int, float],
    duration_sec: float,
    rng: np.random.Generator,
    deterministic: bool = False,
) -> dict[int, list[float]]:
    """Per-approach arrival times for one run."""
    arrivals: dict[int, list[float]] = {}
    for approach_id, q in q_pcu_hr_per_approach.items():
        rate = q / 3600.0
        if deterministic:
            arrivals[approach_id] = ArrivalProcess.deterministic_arrivals(
                rate, duration_sec
            )
        else:
            arrivals[approach_id] = ArrivalProcess.poisson_arrivals(
                rate, duration_sec, rng
            )
    return arrivals


def monte_carlo_delay(
    q_pcu_hr_per_approach: dict[int, float],
    signal_program: SignalProgram,
    n_runs: int = DEFAULT_N_RUNS,
    duration_sec: int = DEFAULT_DURATION_SEC,
    sat_flow_pcu_hr: float = DEFAULT_SAT_FLOW_PCU_HR,
    driver_reaction_sd_sec: float = DEFAULT_DRIVER_REACTION_SD_SEC,
    base_seed: int = 42,
    deterministic_arrivals: bool = False,
) -> dict[int, DelayStatistics]:
    """Per-approach mean delay with 95% CI across `n_runs` independent runs.

    Each run uses a deterministically-derived RNG so the experiment is
    reproducible. The default Poisson arrivals match real traffic
    variability; pass `deterministic_arrivals=True` for the Webster's
    convergence check (uniform arrivals + zero reaction noise → exact
    Webster's mean as n_runs → ∞).
    """
    if n_runs < 1:
        raise ValueError("n_runs must be >= 1")

    per_run_means: dict[int, list[float]] = {a: [] for a in q_pcu_hr_per_approach}

    for run_index in range(n_runs):
        arrival_rng  = _per_run_rng(base_seed, run_index, stream=0)
        reaction_rng = _per_run_rng(base_seed, run_index, stream=1)
        arrivals = _draw_arrivals(
            q_pcu_hr_per_approach, duration_sec, arrival_rng,
            deterministic=deterministic_arrivals,
        )
        results = simulate_one_run(
            arrivals_per_approach=arrivals,
            signal_program=signal_program,
            sat_flow_pcu_hr=sat_flow_pcu_hr,
            driver_reaction_sd_sec=driver_reaction_sd_sec,
            duration_sec=duration_sec,
            rng=reaction_rng,
        )
        for approach_id, run_result in results.items():
            per_run_means[approach_id].append(run_result.mean_delay_s)

    return {a: _aggregate(means) for a, means in per_run_means.items()}


def monte_carlo_compare(
    q_pcu_hr_per_approach: dict[int, float],
    before_program: SignalProgram,
    after_program:  SignalProgram,
    n_runs: int = DEFAULT_N_RUNS,
    duration_sec: int = DEFAULT_DURATION_SEC,
    sat_flow_pcu_hr: float = DEFAULT_SAT_FLOW_PCU_HR,
    driver_reaction_sd_sec: float = DEFAULT_DRIVER_REACTION_SD_SEC,
    base_seed: int = 42,
    deterministic_arrivals: bool = False,
) -> ComparisonResult:
    """Paired before/after Monte Carlo. Same arrival draws across pairs.

    Pairing reduces variance on the saved-vehicle-hours estimate because
    each (before, after) run sees identical traffic. Reaction-time draws
    are independent across before/after to avoid spuriously correlating
    queue-clear behaviour.
    """
    if n_runs < 1:
        raise ValueError("n_runs must be >= 1")

    approaches = list(q_pcu_hr_per_approach.keys())
    before_means: dict[int, list[float]] = {a: [] for a in approaches}
    after_means:  dict[int, list[float]] = {a: [] for a in approaches}
    vh_saved_per_run: list[float] = []

    for run_index in range(n_runs):
        arrival_rng       = _per_run_rng(base_seed, run_index, stream=0)
        reaction_before   = _per_run_rng(base_seed, run_index, stream=1)
        reaction_after    = _per_run_rng(base_seed, run_index, stream=2)

        arrivals = _draw_arrivals(
            q_pcu_hr_per_approach, duration_sec, arrival_rng,
            deterministic=deterministic_arrivals,
        )

        before = simulate_one_run(
            arrivals_per_approach=arrivals,
            signal_program=before_program,
            sat_flow_pcu_hr=sat_flow_pcu_hr,
            driver_reaction_sd_sec=driver_reaction_sd_sec,
            duration_sec=duration_sec,
            rng=reaction_before,
        )
        after = simulate_one_run(
            arrivals_per_approach=arrivals,
            signal_program=after_program,
            sat_flow_pcu_hr=sat_flow_pcu_hr,
            driver_reaction_sd_sec=driver_reaction_sd_sec,
            duration_sec=duration_sec,
            rng=reaction_after,
        )

        run_before_vh = 0.0
        run_after_vh  = 0.0
        for a in approaches:
            br = before[a]
            ar = after[a]
            before_means[a].append(br.mean_delay_s)
            after_means[a].append(ar.mean_delay_s)
            run_before_vh += (br.mean_delay_s * br.n_arrivals) / 3600.0
            run_after_vh  += (ar.mean_delay_s * ar.n_arrivals) / 3600.0
        vh_saved_per_run.append(run_before_vh - run_after_vh)

    per_approach = {
        a: BeforeAfterStats(
            before=_aggregate(before_means[a]),
            after=_aggregate(after_means[a]),
        )
        for a in approaches
    }
    return ComparisonResult(
        per_approach=per_approach,
        vehicle_hours_saved=_aggregate(vh_saved_per_run),
    )
