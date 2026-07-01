# Stochastic Microsim Sprint Plan — for the next session

> **Status: shipped.** Implementation landed in `server/stochastic_simulation.py`,
> tests in `tests/test_stochastic_simulation.py` (15 passing), CLI at
> `scripts/run_stochastic_microsim.py`. Example output:
> `runs/stochastic/example_offline.json`. Methods-chapter narrative + Q&A
> are in `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5 under
> "Stochastic confirmation of analytical delay estimates". Convergence
> claim was tightened during implementation: at low x, MC tracks Webster's;
> at high x, MC exceeds Webster's by the HCM d2 amount (the documented
> deviation is the contribution, not a calibration miss).
>
> Pickup brief for the next Claude (or human) session. Self-contained:
> read this and `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5, then execute.
> Decision context behind this work is in `docs/REAL_DATA_RETRAIN_PLAN.md`
> and conversation history with the operator (synthetic-data bias work
> already shipped Days 1-7).

## TL;DR

Build a Monte Carlo stochastic microsimulation of the intersection-delay
problem that **(1) models individual vehicles instead of aggregate queues,
(2) uses Poisson arrivals and driver-reaction variability, (3) produces
confidence intervals on every delay and vehicle-hours-saved estimate**,
and (4) validates against the existing analytical Webster's + HCM 6th Ed.
simulation engine (`server/simulation.py`).

This is **not** a SUMO replacement and **not** a runtime component. It is a
thesis methodology artifact: a stochastic reference the analytical sim is
cross-validated against, producing CI-bounded numbers for the methods
chapter.

## Why this work

Where we are right now (Day 7, sprint already shipped):

- CNN retrained on Toronto Open Data Multimodal TMC; macro-AUC closed
  from 0.732 to 0.956 on the same real test set.
- Analytical delay simulation validated against closed-form Webster's
  and HCM 6th Ed. d1 + d2 (a real bug was caught and fixed during this).
- All Objective 7 metrics above 85% on the real-trained model.
- 15-test validation suite at `tests/test_simulation_validation.py` passes.

What the operator asked for:

> *"Can we simulate this? Random with the synthetic data, or like how Google
> Maps does it from GPS?"*

After laying out three options — SUMO, lightweight stochastic microsim,
Google Maps API — the operator chose **the lightweight stochastic microsim
(Option A)** for the in-budget upgrade. SUMO is named future work in
`docs/SUMO_DEMO_SCOPING.md`; Google Maps is mentioned in the methods
chapter as alternative validation path.

This sprint delivers the stochastic microsim and its validation against
the analytical sim.

## Goals (in priority order)

1. **Per-intersection delay with 95% confidence intervals.** Today the
   simulation produces a point estimate. After this work, every delay
   number comes with a CI. The thesis claim upgrades from *"the
   recommendation will save 80 vehicle-hours"* to *"the recommendation
   will save 80 vehicle-hours [62, 98] at 95% confidence."*
2. **Cross-validation of the analytical sim.** The Monte Carlo mean
   should converge to Webster's analytical value as `n_runs → ∞`. If it
   does, that's evidence the analytical sim is correctly implementing
   the published formulas. If it doesn't, we have a discrepancy to
   investigate.
3. **Methodology contribution paragraph for the methods chapter.** One
   subsection: *"Stochastic confirmation of analytical delay estimates."*
4. **No production breakage.** Production recommendations continue to
   come from the existing analytical sim. The Monte Carlo simulator is
   an offline thesis tool, not a runtime component.

## What's in scope

- Poisson arrival process per approach.
- Per-vehicle FIFO queue simulation at each approach.
- Signalised control (green / red phases). Unsignalised case is out of
  scope for V1; revisit in V2 if time allows.
- Driver-reaction variability at green onset (small normally-distributed
  delay added when a vehicle reaches the stop bar during green).
- Monte Carlo over N independent runs with deterministic per-run RNG
  seeding so the experiment is fully reproducible.
- Per-approach mean-delay statistics (mean, std, 95% CI).
- Vehicle-hours-saved statistics under a before-vs-after signal program
  comparison.
- A test suite that validates the simulator's behaviour against the
  existing analytical sim under matched conditions.
- A CLI runner that produces a JSON report for one intersection, suitable
  for paste into the methods chapter.

## What's out of scope (do NOT do)

- Multiple lanes per approach. Each approach is single-lane in V1.
- Lane-changing behaviour, gap acceptance for permitted lefts, slip
  lanes. The existing analytical sim doesn't model these either; SUMO
  would. This work is matched to the analytical sim's modelling depth,
  not above it.
- Unsignalised (TWSC) gap-acceptance microsim. The HCM 6th Ed.
  gap-acceptance formula already covers this analytically; adding a
  microsim version is V2 work.
- Integration into the production runtime. The Monte Carlo simulator
  lives in `server/stochastic_simulation.py` but no router calls it.
- Frontend changes. The dashboard continues to show the analytical
  point estimate; the Monte Carlo CI lives in JSON output files used in
  the methods chapter.
- Calibration against actual CCTV-observed delay. We do not have
  ground-truth observed delay data, only counts. The Monte Carlo
  matches the analytical sim's assumptions about saturation flow, lost
  time, etc. (see Constants below).
- SUMO comparison. Out of scope. Future work per
  `docs/SUMO_DEMO_SCOPING.md`.

## Architecture

### Module layout

```
server/stochastic_simulation.py        # new
├── ArrivalProcess
│   ├── poisson_arrivals(rate_per_sec, duration_sec, rng) → list[float]
│   └── deterministic_arrivals(rate_per_sec, duration_sec) → list[float]
├── SignalProgram (dataclass)
│   ├── cycle_length_s: int
│   ├── green_seconds: dict[int, float]   # approach_id → green time in cycle
│   ├── phase_offsets:  dict[int, int]    # approach_id → start-of-green within cycle
│   ├── lost_time_per_phase: float = 4
│   ├── all_red_clearance:   float = 3
│   └── is_green(approach_id, t_sec) → bool
├── Vehicle (dataclass)
│   ├── arrival_t: float
│   ├── depart_t:  float | None
│   ├── approach_id: int
│   └── delay() → float   # depart_t - arrival_t
├── simulate_one_run(
│       arrivals_per_approach,    # dict[int, list[float]]
│       signal_program,
│       sat_flow_pcu_hr,
│       driver_reaction_sd_sec,
│       duration_sec,
│       rng,
│   ) → dict[int, RunResult]      # per-approach
├── RunResult (dataclass)
│   ├── vehicles: list[Vehicle]
│   ├── mean_delay_s: float
│   ├── n_arrivals: int
│   └── max_queue_length: int
├── DelayStatistics (dataclass)
│   ├── mean: float
│   ├── std:  float
│   ├── ci_low_95:  float
│   ├── ci_high_95: float
│   ├── n_runs: int
│   └── per_run_means: list[float]
├── monte_carlo_delay(
│       q_pcu_hr_per_approach,   # dict[int, float]
│       signal_program,
│       n_runs: int = 100,
│       duration_sec: int = 3600,
│       sat_flow_pcu_hr: float = 1400,
│       driver_reaction_sd_sec: float = 1.0,
│       base_seed: int = 42,
│   ) → dict[int, DelayStatistics]
└── monte_carlo_compare(
        q_pcu_hr_per_approach,
        before_program: SignalProgram,
        after_program:  SignalProgram,
        n_runs: int = 100,
        ...,
    ) → ComparisonResult
        per_approach: dict[int, BeforeAfterStats]
        vehicle_hours_saved: DelayStatistics
```

### Math (lock these definitions; do not improvise)

**Poisson arrivals.** For each approach, given flow `q` PCU/hr:

```
rate_per_sec = q / 3600
inter_arrival_t ~ Exponential(rate_per_sec)
arrivals = cumulative sum of inter-arrival times, capped at duration_sec
```

Use `numpy.random.Generator.exponential(scale=1/rate_per_sec)` to draw
inter-arrival times. Capping at duration ensures arrival times stay in
the simulation window.

**Service.** During green at approach `a`, the first vehicle at the head
of the FIFO queue departs at:

```
depart_t = max(t_green_start, vehicle.arrival_t) + reaction_delay
where reaction_delay ~ TruncatedNormal(mean=0, sd=driver_reaction_sd_sec, lo=0)
```

The next vehicle at the head of the queue departs at:

```
depart_t = previous_depart_t + headway
where headway = 3600 / sat_flow_pcu_hr  (≈2.57s at sat_flow=1400)
```

When red starts, no vehicles depart until green resumes.

**Queue capacity.** No upper bound; if it grows large, that's evidence of
oversaturation, surfaced via `max_queue_length` in `RunResult`.

**Per-approach mean delay.** Over all vehicles that arrived AND departed
within the simulation window:

```
mean_delay = mean(vehicle.depart_t - vehicle.arrival_t for vehicle in run)
```

Vehicles that did not depart by `duration_sec` are excluded from the
mean (they would be "carryover queue" — note this in the docstring; this
is a known limitation of finite-horizon simulation and matches Webster's
steady-state assumption).

**Monte Carlo aggregation.** After `n_runs` independent runs:

```
per_run_means = [run_result.mean_delay_s for run in runs]
mean = numpy.mean(per_run_means)
std  = numpy.std(per_run_means, ddof=1)
sem  = std / sqrt(n_runs)
ci_low_95, ci_high_95 = t.interval(0.95, df=n_runs-1, loc=mean, scale=sem)
```

Use `scipy.stats.t.interval` for the CI. `n_runs = 100` is the default;
the operator can override.

**Vehicle-hours-saved.** Compute per-run:

```
before_vh = (before_mean_delay_s × n_arrivals) / 3600
after_vh  = (after_mean_delay_s  × n_arrivals) / 3600
saved_vh  = before_vh - after_vh
```

Then aggregate across runs the same way as delays, producing a
`DelayStatistics` over the `saved_vh` distribution.

### Constants and defaults

Lock these in `server/stochastic_simulation.py` so the next session does
not have to make calls:

```python
DEFAULT_SAT_FLOW_PCU_HR        = 1400   # matches server/simulation.py
DEFAULT_DURATION_SEC           = 3600   # 1 hour of simulation per run
DEFAULT_N_RUNS                 = 100
DEFAULT_DRIVER_REACTION_SD_SEC = 1.0    # σ of normal reaction delay
HEADWAY_SEC                    = 3600 / DEFAULT_SAT_FLOW_PCU_HR  # ≈2.57
```

If a future session wants to vary these, they go through the public API,
not by editing the constants.

## Day-by-day breakdown

### Day 1 — Core single-run simulator

**Goal:** `simulate_one_run` works for one approach and returns sensible
per-vehicle records.

Steps:

1. Create `server/stochastic_simulation.py` with the module-docstring,
   constants, and the basic dataclasses (`Vehicle`, `SignalProgram`,
   `RunResult`).
2. Implement `ArrivalProcess.poisson_arrivals`. Smoke-check: 3600 seconds
   at rate 400 PCU/hr should produce ~400 ± sqrt(400) arrivals (Poisson
   variance).
3. Implement `SignalProgram.is_green` with a single approach. Smoke-check:
   at `t=0`, with `green_start=0` and `green_duration=30`, should return
   True for `t ∈ [0, 30)`, False otherwise.
4. Implement `simulate_one_run` for a *single approach*:
   - Poisson arrivals over the duration.
   - FIFO queue.
   - Per second, advance time. If green and queue non-empty, dequeue head
     and assign `depart_t = max(t, head.arrival_t) + reaction_delay`,
     then advance internal clock by `HEADWAY_SEC`.
   - If red, no service. Vehicles accumulate.
5. Extend to multi-approach. Each approach has its own queue. The signal
   program determines which approach is green at each second; only that
   approach's queue is served.
6. Test that mean delay roughly matches Webster's at one or two test
   points. Allow a 30% gap at this stage — convergence will be tightened
   in Day 3 validation.

Deliverable: a working `simulate_one_run` plus 3-5 smoke tests in
`tests/test_stochastic_simulation.py`.

### Day 2 — Monte Carlo wrapper, statistics, comparison

**Goal:** `monte_carlo_delay` and `monte_carlo_compare` return
`DelayStatistics` / `ComparisonResult` with CIs.

Steps:

1. Implement `DelayStatistics` dataclass with `mean`, `std`,
   `ci_low_95`, `ci_high_95`, `n_runs`, `per_run_means`.
2. Implement `monte_carlo_delay`:
   - Loop `n_runs` times.
   - Each iteration uses `numpy.random.default_rng(np.random.SeedSequence(
     [base_seed, run_index, 0xC0]).generate_state(2))` for reproducibility.
   - Collect per-run per-approach `mean_delay_s`.
   - Aggregate with `scipy.stats.t.interval` (this adds scipy to thesis
     deps — pip install if needed).
3. Implement `monte_carlo_compare`:
   - Run Monte Carlo on `before_program` and `after_program` with the
     same arrival seeds (paired comparison reduces variance).
   - For each paired run, compute `saved_vh`.
   - Aggregate `saved_vh` distribution into a `DelayStatistics`.
4. Validate convergence: with `n_runs = 1000`, the Monte Carlo mean
   should agree with Webster's analytical value within 1 s/veh under
   matched single-approach conditions. Document this in a test.

Deliverable: `monte_carlo_delay` + `monte_carlo_compare` work, with at
least 3 statistical tests verifying convergence and CI coverage.

### Day 3 — Validation, CLI, docs

**Goal:** Test suite is complete, CLI script produces a methods-chapter
JSON report, panel guide is updated.

Steps:

1. Test suite (target: 8-10 tests in `tests/test_stochastic_simulation.py`):
   - Sanity: zero flow → zero delay (every run, every approach).
   - Sanity: delay > 0 under realistic flow + red phase.
   - Monotonicity: doubling flow at fixed timing produces higher mean
     delay (at sub-saturation).
   - Convergence: MC mean ≈ Webster's analytical mean (within 1 s/veh
     at `n_runs = 1000`, single approach, x ≤ 0.7).
   - CI coverage: at fixed inputs, the 95% CI from `n_runs = 100`
     contains Webster's analytical value with the expected coverage
     (test by repeating the experiment 50 times and counting hits;
     should hit ≥ 47).
   - Reproducibility: same seeds → same per-run means, bit-for-bit.
   - Reaction-time effect: increasing `driver_reaction_sd_sec` from 0 to
     2 increases mean delay.
   - `monte_carlo_compare` sanity: under identical before/after
     programs, `vehicle_hours_saved` mean ≈ 0 and CI straddles 0.
2. CLI script `scripts/run_stochastic_microsim.py`:
   - Takes an intersection ID, time window, and signal-program selector
     (`current` or `proposed`).
   - Pulls real per-15-min flows from the DB or from a `--counts-json` file.
   - Runs `monte_carlo_compare` between `current` and `proposed` signal
     programs.
   - Writes a JSON report to `runs/stochastic/{intersection_id}_{window}.json`
     with per-approach `DelayStatistics`, comparison results, and
     reproducibility metadata (seeds, n_runs, sat_flow used).
3. Documentation:
   - Add a "Stochastic confirmation" subsection to
     `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5 explaining what the MC sim
     does, what convergence we observe vs. Webster's, and what the CIs
     mean operationally.
   - Update `docs/REAL_DATA_RETRAIN_PLAN.md` "out of scope" → "shipped"
     for stochastic microsim.
   - Cross-link `server/simulation.py:compute_uniform_delay`'s docstring
     to point at the Monte Carlo reference.

Deliverable: test suite passes, CLI produces a JSON report on a real
intersection from the DB, panel guide has the new subsection.

## Validation strategy

Two layers of evidence the Monte Carlo simulator is correct.

### Layer 1 — Behaviour matches engineering expectations

The simulator should:

- Produce zero delay when there is zero flow.
- Produce more delay when flow goes up.
- Produce more delay when green time goes down.
- Produce more delay when driver reaction-time variability goes up.
- Reproduce identical numbers under identical seeds.

These are the same sanity checks the existing analytical sim has. They
catch implementation bugs (wrong queue handling, swapped indices, etc.).

### Layer 2 — Convergence to the analytical reference

This is the load-bearing claim for the methods chapter. Under the same
inputs (single approach, no driver reaction noise, deterministic
arrivals at the equivalent rate), the Monte Carlo simulator should
converge to Webster's:

```
At C=90, g=36, q=400, sat=1400 (x=0.714):
  Webster's analytical: 22.69 s/veh
  Monte Carlo (n_runs=1000, σ_react=0): should agree within 1 s/veh
```

If they disagree by more than 1 s/veh at `n_runs = 1000`, something is
wrong — either the MC implementation or our reading of Webster's.
Investigate before proceeding.

Once convergence is established at one or two operating points,
**Poisson arrival noise is added back** (since real traffic is stochastic)
and the MC mean is allowed to differ from Webster's by up to 5-10%. The
*CI* should still contain Webster's value, which is the proof point for
the panel: *"the analytical Webster's estimate falls within the 95% CI
of the stochastic microsim across our test conditions."*

## Integration with the existing analytical sim

The Monte Carlo simulator is a **sibling** to `server/simulation.py`, not
a replacement.

- Production stays on the analytical sim. `compute_simulation_for_window`
  is unchanged.
- The new module `server/stochastic_simulation.py` is offline / thesis-only.
- A future session may add a `compute_simulation_for_window_stochastic`
  helper that returns a Monte Carlo CI alongside the point estimate, and
  optionally surface it via an admin endpoint. **Not required** for V1.

Cross-validation flow:

```
real CCTV flow data
        ↓
        ├──→ server/simulation.py        → point estimate of delay
        └──→ server/stochastic_simulation.py → mean ± CI of delay
                                            ↓
                              the two should agree within 5-10%
                              point estimate falls inside the CI
```

If they do agree, the methods chapter says *"the analytical sim is
cross-validated by a Monte Carlo stochastic microsim; agreement is
within X% across our test conditions."*

If they don't, the methods chapter says *"the analytical sim is a
deterministic mean-value approximation; the stochastic microsim reveals
delay distributions with wide CIs at high saturation, suggesting the
analytical mean is operationally sufficient for low-to-moderate
saturation but should be interpreted with caution above v/c = 0.85."*

Either outcome is honest, defensible, and a contribution.

## CLI output format (for the methods chapter)

`runs/stochastic/{intersection_id}_{window}.json`:

```json
{
  "intersection_id": 42,
  "window": {
    "start_iso": "2026-06-15T07:00:00",
    "end_iso":   "2026-06-15T08:00:00",
    "duration_sec": 3600
  },
  "config": {
    "n_runs": 100,
    "sat_flow_pcu_hr": 1400,
    "driver_reaction_sd_sec": 1.0,
    "base_seed": 42
  },
  "per_approach": {
    "1": {
      "approach_label": "NB",
      "flow_pcu_hr": 412,
      "before": { "mean": 28.4, "std": 4.1, "ci_low_95": 26.7, "ci_high_95": 30.1, "n_runs": 100 },
      "after":  { "mean": 19.6, "std": 2.8, "ci_low_95": 18.5, "ci_high_95": 20.7, "n_runs": 100 }
    },
    "2": { ... },
    "3": { ... },
    "4": { ... }
  },
  "vehicle_hours_saved": {
    "mean": 72.3, "std": 8.4, "ci_low_95": 65.9, "ci_high_95": 78.7, "n_runs": 100
  },
  "analytical_reference": {
    "before_per_approach": { "1": 27.9, "2": ... },
    "after_per_approach":  { "1": 19.2, "2": ... },
    "vehicle_hours_saved": 71.8,
    "note": "From server.simulation.compute_simulation_for_window, the production analytical sim."
  }
}
```

The methods-chapter narrative becomes:

> *"For intersection 42 in the AM peak window, the analytical simulation
> estimates 71.8 vehicle-hours saved by the proposed timing. A Monte Carlo
> stochastic microsim with 100 runs estimates 72.3 [65.9, 78.7]
> vehicle-hours saved at 95% confidence, with the analytical point
> estimate inside the interval. Per-approach delays agree to within X%
> on average."*

That paragraph is the contribution.

## Panel framing

The new subsection in `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5 should
include this Q&A entry:

> **Q.** *Your analytical simulation produces point estimates. How do we
> know those numbers are stable, given stochastic arrival patterns?*
>
> **A.** "We additionally implemented a Monte Carlo stochastic microsim
> that models Poisson arrivals at each approach with driver-reaction
> variability. Running 100 independent simulations of the same hour
> produces a confidence interval on every delay and vehicle-hours-saved
> estimate. At 1000 runs in the no-noise limit, the stochastic mean
> converges to the analytical Webster's value within 1 second per
> vehicle. With realistic Poisson noise at 100 runs, the analytical point
> estimate falls inside the 95% confidence interval of the stochastic
> simulation, supporting the analytical mean as operationally sufficient
> for the recommendation pipeline."

Replace placeholders with actual measured numbers from the validation
tests.

## What ships at the end of Day 3

```
server/stochastic_simulation.py                  # the simulator
tests/test_stochastic_simulation.py              # 8-10 tests
scripts/run_stochastic_microsim.py               # CLI
runs/stochastic/{example_intersection}.json      # one example output
docs/PANEL_DEFENSE_GUIDE.md (updated Part 7.5)   # narrative + Q&A entry
docs/STOCHASTIC_MICROSIM_PLAN.md (this file, mark as completed)
```

No production routes changed. No frontend changes. Tests pass.

## Risks and how to handle them

| Risk | Likelihood | Mitigation |
|---|---|---|
| Monte Carlo does not converge to Webster's | Low | Check the headway and queue handling. The simulator's deterministic-arrivals limit must match Webster's; if it doesn't, the loop logic is wrong. |
| Tests are flaky due to randomness | Medium | Fix seeds in every test. Use large `n_runs` (≥ 1000) when checking convergence. Reproducibility test catches drift. |
| `scipy` not in `server/requirements.txt` | Low | Add it to `requirements-test.txt` (or `requirements-thesis.txt` if you create one). Production does not need it. |
| Simulation is too slow for n_runs=100 on the CLI | Low | A single 1-hour run for 4 approaches at 1400 sat_flow is ≤ 100ms in pure Python. 100 runs ≈ 10s. Should be fine; vectorise only if measured slow. |
| Convergence requires more than 1000 runs to get under 1 s/veh | Medium | This is OK; loosen the threshold to 2 s/veh and document in the methods chapter. The CI-contains-Webster's check is the more important one. |
| Driver-reaction-time σ is poorly calibrated | Low | The default 1s σ comes from HCM 6th Ed. typical values. The test for the reaction-time effect uses 0 vs. 2; both are well-defined regardless of the σ choice. |

## What this is NOT (read before you start)

- Not a SUMO replacement. SUMO has lane-changing, gap-acceptance for
  permitted lefts, vehicle interactions across signals. We have one
  approach, one lane, one signal head. That's intentional — we match
  the analytical sim's modelling depth.
- Not a calibration against observed CCTV delay. We don't have ground
  truth delay observations, only counts.
- Not a replacement for the existing analytical sim. They coexist.
- Not a runtime upgrade. The new module lives in `server/` only for code
  organisation; no router imports it.

## Estimated effort

3 days, assuming:

- The operator has Python development environment ready (numpy, scipy).
- No major distractions from sprint work.
- Operator is available for spot questions on Day 1 and 3.

Pad to 4 days if scipy needs to be installed for the first time or if
the operator needs to step away mid-sprint.

## Final note for the next session

**Do not start coding before reading:**

1. This document (you're here).
2. `docs/REAL_DATA_RETRAIN_PLAN.md` — the broader sprint context.
3. `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5 — what the analytical sim does
   now and what we already validate.
4. `server/simulation.py:compute_uniform_delay` — the formula you are
   stochastically converging to.
5. `server/simulation_validation.py:hcm_full_delay` — the HCM 6th Ed.
   reference, in case you want to cross-validate against d1+d2 as well.

Then start with Day 1 step 1. Verify each step's smoke check before
moving on. Don't try to write the whole simulator in one pass; it's
easier to debug incrementally.

The operator has been transparent that this is a thesis-side artifact,
not a production change. Maintain that scope. If you find yourself
tempted to integrate the Monte Carlo into the routers or change the
frontend, stop and re-read the "What's out of scope" section.

Good luck.
