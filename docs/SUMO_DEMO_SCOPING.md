# SUMO Demonstration Intersection — Scoping Document

> **Scope of this document:** a methodology-proof SUMO microsimulation of
> one Tagum intersection, framed as future work demonstrated. *Not* a
> system-wide replacement of the analytical delay simulation in
> `server/simulation.py`. Read this before committing time; the honest
> effort estimate is at the bottom.

## Why one intersection, not all

A SUMO microsimulation models individual vehicles with car-following, lane-
changing, and gap-acceptance behaviour. For one intersection, building the
model takes a few days. For thirty intersections, it takes months. The
existing analytical sim (Webster's 1958 + HCM 6th Ed., validated in
`tests/test_simulation_validation.py`) is what produces all production
delay numbers. SUMO does not replace that; it demonstrates that the
analytical numbers can be cross-checked against an individual-vehicle
simulator on a single representative site.

The deliverable becomes: *"For intersection X, we validated the analytical
delay estimate against a full SUMO microsimulation and found them to agree
within Y%. This evidences that the analytical methodology is operationally
trustworthy for the broader system."*

That sentence is the contribution. One intersection is sufficient because
SUMO is *the* established microsimulation reference; agreement on one
calibrated site supports the analytical method's validity in general.

## Why now (or maybe later)

This work is **out of scope for the 1-week sprint**. It belongs to
post-defense work or a follow-up paper. The 1-week sprint already shipped:

- Real-data CNN retraining + bias ablation
- Analytical delay simulation validation suite (15 tests pass)
- Panel defense guide

SUMO adds a fourth piece. Realistic effort is 3-5 focused days. If you
have that budget *after* defense and want to extend into a journal paper
or a thesis revision, this scoping document is the plan.

## Site selection — pick one Tagum intersection

Criteria, in priority order:

1. **You have actual CCTV data for it.** Need real per-second arrival
   timestamps to drive the SUMO demand model. Without real data the
   comparison reduces to "two synthetic models agree," which is not
   useful.
2. **It is 4-leg, signalised, with all four approaches active.** Matches
   the synthetic dataset assumptions and the recommendation pipeline.
   Avoids edge cases (T-intersections, slip lanes, dedicated turn pockets)
   that complicate the SUMO geometry.
3. **It produces a `timing_only` recommendation in the current system.**
   Means Webster's is what your system would actually propose. SUMO can
   then evaluate "current timing vs Webster's timing" and report whether
   the analytical delay reduction matches the microsim delay reduction.
4. **You have geometry information** (street widths, lane counts, turn
   pockets). Even rough numbers are enough for SUMO; precision is not
   required for a methodology demo.

If you have multiple candidate intersections meeting all four, pick the
one with the most operational hours of clean CCTV data.

## Required SUMO artifacts

For one intersection:

| Artifact | Format | Effort |
|---|---|---|
| Road network | SUMO `.net.xml` (built in `netedit`) | 0.5–1 day |
| Traffic light program | `.add.xml` containing TLS phases + offsets | 0.5 day |
| Vehicle demand routes | `.rou.xml` derived from CCTV counts | 0.5 day |
| Vehicle type definitions | inline in `.rou.xml` (cars, trucks, buses, motorcycles, tricycles, pedicabs) | 0.25 day |
| Simulation config | `.sumocfg` wiring everything together | 0.25 day |
| Detector outputs | E1/E2 detectors at each approach for delay measurement | 0.25 day |
| Headless runner | Python script using TraCI or `sumo` CLI | 0.5 day |

Total: ~3 days for the engineering, before any analysis.

## Workflow (sequential)

### Day 1 — Build the network

- Install SUMO (`brew install sumo`, or apt on Linux).
- Open `netedit`. Roughly draw the intersection — four legs at correct
  bearings, lane counts per approach, signal at the centre.
- Save as `tagum_intersection_X.net.xml`.

Deliverable: a SUMO road network that loads and displays correctly. No
demand yet.

### Day 2 — Build the demand

- Extract per-approach 15-minute counts for one representative weekday
  from your CCTV `Detection` table.
- Generate `.rou.xml` flows: one `<flow>` element per (approach, vehicle
  type, departure period). Use SUMO's `xml-tools` or write a small
  Python script.
- Add `vType` definitions for the Tagum mix (cars, trucks, buses,
  motorcycles, tricycles, pedicabs) with PCU-consistent acceleration and
  size parameters.

Deliverable: a `.rou.xml` that, when run with the network, produces the
right number of vehicles in roughly the right time pattern.

### Day 3 — Configure signals and instrumentation

- Build two signal programs:
  - `current` — the intersection's actual existing cycle + green splits
    (from `Intersection.existing_cycle_length`,
    `Intersection.existing_green_splits`).
  - `proposed` — Webster's-recommended cycle + splits (from the latest
    `TimingRecommendation` row for this intersection).
- Add E1 detectors immediately upstream of the stop bar on each approach
  for delay measurement.
- Write a SUMO config + runner that executes both scenarios over the same
  demand and records mean control delay per approach.

Deliverable: two runs producing per-approach delay numbers.

### Day 4 — Compare against the analytical simulation

- Run `server.simulation.compute_simulation_for_window` over the same
  intersection / same time window. Record per-approach delay.
- Build a comparison table:

  | Approach | Current SUMO | Current Analytical | Proposed SUMO | Proposed Analytical |
  |---|---:|---:|---:|---:|
  | NB | … | … | … | … |
  | SB | … | … | … | … |
  | EB | … | … | … | … |
  | WB | … | … | … | … |

- Compute SUMO-vs-analytical agreement per approach (% gap).
- Compute SUMO vehicle-hours-saved vs analytical vehicle-hours-saved.
- Document any systematic divergence.

Deliverable: a results table + a one-paragraph narrative for the methods
chapter.

### Day 5 — Write the methodology subsection + ship

- Add a subsection to the methods chapter: *"Microsimulation
  cross-validation of analytical delay estimates."*
- Cover: site selection, SUMO model construction, demand calibration,
  signal program comparison, agreement metrics, limitations.
- Commit all SUMO artifacts (`.net.xml`, `.rou.xml`, `.add.xml`,
  `.sumocfg`, runner script, comparison output) to `sumo/intersection_X/`.

Deliverable: a paste-ready subsection plus reproducible SUMO artifacts.

## Success criteria

The cross-validation succeeds if:

- **Per-approach mean delay agrees within 25%** between SUMO and the
  analytical simulation under the same demand and signal program. (HCM
  6th Ed. 25-percentile error band for analytical methods vs microsim is
  the published norm.)
- **Sign of the proposed-vs-current delay change is the same** in both
  simulators. If both say "delay goes down by X%," the analytical method
  is operationally correct even if the magnitudes differ.
- **Vehicle-hours-saved estimates are within 30%** of each other.

If any of these fail, the methods chapter says so honestly and the
recommendation engine becomes "produces directional guidance, not
precise delay estimates" — still useful, more bounded claim.

## Connection to the existing system

SUMO does *not* get wired into the production server. It is a *thesis
artifact* demonstrating methodology, not a runtime component. Production
recommendations continue to come from:

- The CNN (warrant + intervention prediction)
- The analytical simulation (delay + vehicle-hours-saved estimate)
- The rule pipeline (recommendation precedence)

The SUMO artifacts live under `sumo/` and are run manually for the
thesis comparison. No backend or frontend changes required.

## What this WILL produce

- Evidence that the analytical sim is calibrated against the
  individual-vehicle reference.
- A second-opinion delay number for one intersection.
- A methods-chapter subsection that adds engineering credibility.
- A paragraph for the future-work / discussion chapter explicitly framing
  full-system microsimulation as a follow-up.

## What this will NOT produce

- A SUMO-driven runtime recommendation engine. That would be months of
  work.
- Validation across all thirty test intersections. One intersection is
  the scope.
- A perfect replication of CCTV-observed dynamics. SUMO's car-following
  defaults will be close to reality but not identical.
- A peer-reviewed paper by itself. This is a thesis methodology
  artifact; turning it into a paper requires more sites and more
  statistical analysis.

## Honest effort estimate

3-5 focused days, assuming:

- You have CCTV-derived per-approach 15-minute counts ready for the demo
  intersection.
- You can install SUMO without IT-administration friction.
- The intersection geometry is straightforward (no unprotected lefts,
  no slip lanes, no skewed legs).
- The signal program is fixed-time (not actuated).

If any of those is not true, add 1-2 days each. An actuated signal with
ped pushbuttons doubles Day 3.

## Recommendation on timing

**Do this after defense, not before.** The 1-week sprint already has
enough deliverables to defend. SUMO is a strength in a follow-up revision
or a journal paper, not a sprint-week add-on. If you blow this onto the
sprint timeline, you risk shipping a half-finished SUMO model that does
not pass cross-validation, which becomes a *new* attack surface for the
panel rather than a strength.

If after defense you want to extend into a publishable paper, this
scoping document is the plan. Execute it then.

## Files this work would create

```
sumo/
└── intersection_X/                        # X = your chosen Tagum site
    ├── tagum_intersection_X.net.xml       # SUMO road network
    ├── tagum_intersection_X.rou.xml       # vehicle flows + vTypes
    ├── tagum_intersection_X.add.xml       # signal programs + detectors
    ├── tagum_intersection_X.sumocfg       # simulation configuration
    ├── runner.py                          # batch run + delay extraction
    ├── cross_validation_results.csv       # SUMO vs analytical comparison
    └── README.md                          # how to reproduce
```

## What to tell the panel if you have NOT done this yet

> "Full microsimulation cross-validation using SUMO is named future work
> in the discussion chapter. The analytical delay simulation we ship has
> been validated against closed-form Webster's 1958 expected values and
> the full HCM 6th Edition control delay formula. SUMO would add an
> individual-vehicle reference; the analytical methods are themselves what
> SUMO would be calibrated against, so the validation we already have is
> sufficient for the thesis-stage claim."

That sentence holds the line. SUMO is the path to a stronger paper, not a
prerequisite for defense.
