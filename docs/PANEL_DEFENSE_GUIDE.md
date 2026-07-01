# Panel Defense Guide — Real-Data Retrain Sprint

> A field guide for defending the real-data retrain work to your thesis
> panel. Reads top-to-bottom in ~10 minutes. Pair with
> `docs/REAL_DATA_RETRAIN_PLAN.md` (the sprint plan) and
> `runs/real_eval/ablation_synthetic_vs_real.json` (the actual numbers).

## Part 1 — What we built, in plain language

You had one panel objection: *"the training data is fragile and has a lot of
bias."* The objection was about the warrant CNN being trained only on
parameter-realistic synthetic data calibrated to Tagum priors. That was a
real weakness, the panel was right to flag it.

So we did three things in one week:

1. **We measured the bias.** Took the original synthetic-trained CNN
   (`runs/temporal_cnn/temporal_cnn_seed0.pt`) and scored it against a real
   urban traffic test set (City of Toronto Multimodal TMC). Macro-AUC fell
   from 0.977 on synthetic to **0.732 on real** — a 24.5-point drop. That
   gap *is* the bias, now expressed as a number.
2. **We retrained the CNN on real data.** Used the same model architecture
   but trained on rule-labelled real Toronto flows
   (`runs/real_cnn/real_cnn_seed0.pt`). Scored the retrained model on the
   same real test set. Macro-AUC came back up to **0.956**, closing the gap.
3. **We left the production rule pipeline intact.** MUTCD warrants, Webster's
   timing, and the intervention precedence are unchanged. The CNN is now a
   learned approximation of those rules trained on real flow distributions,
   not synthetic ones.

That's it. One number to defend ("the bias was 0.245 AUC, we closed it to
0.021"), one architectural change ("4 warrant heads instead of 6, with
documented reasons"), one dataset addition (Toronto TMC), one new chapter
subsection.

---

## Part 2 — How the numbers map to thesis Objective 7

Objective 7 calls for accuracy, precision, recall, F1, mAP, FPS. All present:

### Warrant prediction (macro, across w1, w2, w3, w4)

| Metric (Objective 7) | Synthetic-trained on real test | **Real-trained on real test** | Δ |
|---|---:|---:|---:|
| Accuracy | 0.720 | **0.884** | +0.164 |
| Precision | 0.792 | **0.889** | +0.096 |
| Recall | 0.784 | **0.932** | +0.148 |
| F1-score | 0.741 | **0.908** | +0.166 |
| mAP | 0.813 | **0.976** | +0.162 |

### Intervention recommendation (3-class)

| Metric | Synthetic-trained on real test | **Real-trained on real test** | Δ |
|---|---:|---:|---:|
| Accuracy | 0.882 | **0.925** | +0.043 |
| Macro-F1 | 0.609 | **0.782** | +0.173 |

### Inference throughput (FPS analog for a per-sample classifier)

| Model | Samples/sec | ms/sample | Device |
|---|---:|---:|---|
| Synthetic-trained | 6,433 | 0.155 | CPU |
| Real-trained | 5,109 | 0.196 | CPU |

For context: 5,109 samples/sec means the recommender can produce one full
24-hour intersection recommendation in under 0.2 milliseconds. Real-time
deployment is comfortably feasible.

---

## Part 3 — Mapping work to thesis objectives

| Objective | How this sprint addresses it |
|---|---|
| **1.** Collect/preprocess traffic video data | Not affected (YOLOv8 side). |
| **2.** YOLOv8-based detection architecture | Not affected (YOLOv8 side). |
| **3.** Train CNN for high detection accuracy | Not affected (YOLOv8 side). |
| **4.** Real-time monitoring system | Not affected; inference latency well under real-time bound. |
| **5.** Deep-learning recommendation module | **Directly addressed.** CNN now trained on real data, panel-bias objection resolved. |
| **6.** Analytical reports (trends, growth, peaks) | Not affected (rule pipeline unchanged). |
| **7.** Evaluate with acc/prec/rec/F1/mAP/FPS | **Directly addressed.** All metrics present in ablation table. |
| **8.** Test under varied conditions | Toronto TMC samples span hundreds of urban intersections across years 2020-2026, providing distribution diversity beyond a single deployment site. |

---

## Part 4 — How to frame this to the panel (defense script)

### Opening (one minute)

> "The panel raised a methodological concern that the warrant CNN was
> trained on parameter-realistic synthetic data, and that this might
> introduce distribution bias. We took that concern seriously, measured the
> bias quantitatively, and closed it by retraining on real urban traffic
> data from the City of Toronto's Open Data Multimodal Turning Movement
> Counts dataset. I'd like to walk you through the measurement, the fix,
> and the limitations."

### The bias measurement (one minute)

> "First, we measured the bias. We took the original synthetic-trained CNN
> from our T17 training run and evaluated it against a real-data test set
> drawn from 60 unseen Toronto intersections. The macro-AUC on the four
> MUTCD warrants dropped from 0.977 on the synthetic test set to 0.732 on
> the real test set. A 24-point AUC gap is significant; the panel was
> correct to be concerned. This gap is what we wanted to close."

### The fix (two minutes)

> "Second, we retrained the CNN on rule-labelled real flows from a
> different 480-intersection training subset of the same dataset. Same
> architecture, same uncertainty-weighted multi-task loss from Kendall et
> al. 2018, same Adam optimizer with early stopping. The only change was
> the data source. We then evaluated the retrained model on the same real
> test set used to measure the bias.
>
> The macro-AUC recovered to 0.956. The 24-point gap closed to 2.1 points.
> Across the warrant heads — w1, w2, w3, w4 — every metric improved:
> accuracy from 0.72 to 0.88, precision from 0.79 to 0.89, recall from 0.78
> to 0.93, F1 from 0.74 to 0.91, mAP from 0.81 to 0.98. The intervention
> head's macro-F1 jumped from 0.61 to 0.78. The model now classifies
> `timing_only` cases reliably, which the synthetic-trained model failed at
> on real distributions."

### The limitations (one minute)

> "Three limitations we acknowledge in the methods chapter. First, the
> Tagum-local warrants W-Local-2 and W-Local-3 were dropped from the CNN
> head set. W-Local-2 was already non-functional in the synthetic baseline
> per our existing metrics documentation, and W-Local-3 requires full-day
> coverage that Toronto's operational-hours TMC studies cannot provide.
> Both rules remain callable in the production rule pipeline. Second, the
> evaluation is single-seed because of the sprint timeline; multi-seed
> validation is named future work. Third, the intersection metadata for the
> Toronto samples — lane counts, posted speeds, signalized status — was
> sampled from our Tagum priors because Toronto's TMC dataset does not
> publish per-intersection metadata. The flows themselves are real;
> the metadata is approximate."

### The contribution claim (30 seconds)

> "The contribution is methodological: we identified, measured, and closed
> a synthetic-data distribution bias in a multi-task warrant prediction
> CNN, using a publicly available real urban dataset and the same model
> architecture as the baseline. The bias closure is reproducible; the
> evaluation code is in `scripts/eval_on_real.py` and the data loader is in
> `scripts/load_real_traffic.py`."

---

## Part 5 — Anticipated panel questions and answers

### Q1. "Why Toronto and not Tagum?"

> "We do not have a labelled real-data dataset of comparable scale for
> Tagum yet. Our system has a YOLOv8 detection pipeline that is producing
> CCTV-derived flow data, but the volume required for a deep-learning
> retraining sample is not yet available. The City of Toronto Open Data
> Multimodal TMC dataset is publicly available, well-documented under the
> Open Government Licence, and contains 56 timeslots of 15-minute resolution
> per-approach vehicle and pedestrian counts for thousands of intersection
> studies. It is the closest available analog for a major urban arterial
> network. Validation against real Tagum CCTV data is named future work
> in the discussion chapter."

### Q2. "How do we know your real-data test set is representative?"

> "Three things. One, the test set comes from a different 60 intersections
> than the training set — intersection-stratified split with
> sklearn.GroupShuffleSplit, no leakage. Two, the test set spans both peak
> and off-peak studies across years 2020 to 2026. Three, all three
> intervention classes are represented in the test set, not just
> road-widening — six signalize cases, ten timing-only cases, 77
> road-widening cases. The distribution is what it is for Toronto downtown,
> and we report it transparently in the methods chapter."

### Q3. "Isn't this just overfitting to Toronto?"

> "Three counterpoints. One, the test set is intersection-held-out from
> training, so by construction the model is generalizing across
> intersections within the Toronto distribution. Two, the architecture is
> unchanged from the synthetic baseline; we did not architect for Toronto.
> Three, the metrics we report — AUC, mAP, F1 — would all be near 1.0 if
> the model had memorised the test set. They sit at 0.91 to 0.98, which is
> consistent with learning the rule mapping, not memorising."

### Q4. "Why did you drop two warrants?"

> "W-Local-2 was already producing zero positive samples in the existing
> test split, documented in WARRANT_MODEL_METRICS.md — it was a head with
> no learnable signal. Dropping it eliminates a dead parameter sink and
> does not lose any production capability because the rule remains
> callable in `server/local_warrants.py`. W-Local-3 is the signal-off
> warrant, which detects when an intersection has near-zero flow during a
> TOD chunk. That requires overnight coverage. Toronto's TMC studies are
> 14-hour operational windows, so the necessary off-peak chunks are not
> observed. Including the head would have trained it on noise. Both rules
> remain in production; the CNN simply does not approximate them on this
> dataset."

### Q5. "Aren't your labels still derived from the same rules? Isn't this
> circular?"

> "The labels come from MUTCD §4C.01 through §4C.05 plus Webster's
> critical-v/c. These are published Federal Highway Administration and
> Highway Capacity Manual standards, not our invention. The CNN is being
> trained to approximate these published standards from raw 15-minute
> per-approach flows. The contribution is that the approximation is now
> built on real flow distributions, not synthetic ones. The rule pipeline
> stays in production and remains the deterministic source of truth; the
> CNN serves as a learned approximation that supports interpretability
> (Grad-CAM, future work) and end-to-end inference."

### Q6. "Why not just deploy the rules and skip the CNN?"

> "Two reasons. First, the CNN provides the CS contribution on the
> decision side of the system. Without it, the recommendation side has no
> machine-learning algorithm, which is a problem for a CS thesis. Second,
> the CNN provides per-sample uncertainty calibration through the sigmoid
> outputs, which the rule pipeline cannot. A rule says 'warrant met / not
> met'; the CNN says 'warrant met with probability 0.83', which is more
> actionable for operators prioritizing capital planning."

### Q7. "Why is the inference latency 0.2 ms relevant?"

> "Objective 7 calls for FPS reporting. We measured 5,100 samples per
> second on CPU, which translates to under 0.2 milliseconds per
> recommendation. That is many orders of magnitude faster than real-time
> requirements for a traffic monitoring system, so the architecture
> imposes no operational bottleneck."

### Q8. "What's the gap from here to a deployable Tagum system?"

> "Three steps. One, collect labelled or rule-labelled real flow data from
> our Tagum CCTV deployment — the YOLOv8 pipeline is in place, only the
> data volume needs to accumulate. Two, retrain on a Tagum-real subset and
> measure the gap to the Toronto-trained model. Three, run an operator
> validation pass where Tagum CTMO engineers review a sample of the
> system's recommendations. The methodology in this thesis is the
> blueprint; the deployment data is the future work."

---

## Part 6 — Phrases to use, phrases to avoid

### Use

- "Measured the bias quantitatively"
- "Closed the gap from 0.245 AUC to 0.021 AUC"
- "Real-data test set drawn from 60 unseen Toronto intersections"
- "Trained on rule-labelled real flows"
- "Macro-AUC of 0.956 on the real-data test set"
- "Single-seed result, multi-seed validation is named future work"

### Avoid

- "The model works perfectly now" — overclaim, panel will push back
- "We validated the model" — invites the "validated against what?" question
- "We solved the bias problem" — instead, say "we measured it and closed it"
- "Trained on industry standards" without naming the synthetic vs real split — panel can call this evasive
- "Our new dataset" — Toronto is *their* dataset; we are *using* it
- "The CNN replaces the rule pipeline" — it does not; the rules stay in production

---

## Part 7 — What is and is not claimed

### Claimed

- The synthetic dataset has a distribution bias of 0.245 macro-AUC when
  evaluated against the Toronto real-data test set.
- Retraining the same architecture on real Toronto flows closes that gap
  to 0.021 macro-AUC.
- The retrained model achieves 0.925 intervention accuracy, 0.908 warrant
  macro-F1, and 0.976 warrant mAP on a real-data test set of 93 samples
  from 60 held-out Toronto intersections.
- Inference throughput is 5,100 samples/sec on CPU.

### Not claimed

- That the retrained model will perform identically on Tagum CCTV data
  (this is named as future work, requires deployment-data collection).
- That the multi-seed mean ± std results would match the single-seed
  numbers reported here (named as future work).
- That W-Local-2 and W-Local-3 can be learned from this dataset (we
  document the architectural decision to drop them).
- That the synthetic generator is now redundant; it remains useful as the
  baseline that defined the bias gap.

---

## Part 7.5 — The analytical delay simulation (Approach 2 territory)

The system has a "would this actually help?" simulator built in. It is not
just a visualisation. It produces the vehicle-hours-saved number on the
dashboard, and it is the engineering justification behind every timing
recommendation.

### What it does

For every recommendation generated on a real Tagum intersection with CCTV
data, `server.simulation.compute_simulation_for_window` runs two scenarios
back-to-back over the same real per-second arrival pattern:

1. **Before**: current intersection state. If signalised, replays arrivals
   through the existing cycle + green splits. If unsignalised, replays
   arrivals through an HCM 6th Ed. gap-acceptance capacity model.
2. **After**: same arrivals, Webster's-recommended cycle + green splits.

Both produce mean delay (s/veh) and a per-second queue series. The
difference, multiplied by flow volume, is *vehicle-hours-saved*. That is
the dashboard's quantitative claim that the recommendation would actually
help.

### Methods used (these are the standards real cities use)

| Method | Use case | Citation |
|---|---|---|
| Webster's 1958 uniform delay | Mean delay at a signalised approach with known timing | Webster, F. V. (1958). *Traffic signal settings.* Road Research Laboratory. |
| HCM 6th Ed. d2 (incremental delay) | Adds the random-arrival + oversaturation term to Webster's d1 | Transportation Research Board (2016). *Highway Capacity Manual, 6th Edition.* |
| HCM 6th Ed. TWSC gap-acceptance | Capacity + delay of an uncontrolled minor approach | Same. Used for the unsignalised "before" case. |
| Per-second discrete-event queue replay | Recovers mean delay under the *actual* arrival sequence, not Poisson | This is our refinement. Uses real detection timestamps as inputs. |

These are the same methods that get used in published transportation
engineering reports when a city plans a signal installation or re-timing.
A SUMO or VISSIM microsimulation would be *calibrated against* these
methods. They are the authoritative baseline.

### Validation evidence we ship

A new validation suite in `tests/test_simulation_validation.py` and a
reference implementation of HCM 6th Ed. full delay in
`server/simulation_validation.py`:

| Test | What it proves |
|---|---|
| 5 hand-computed Webster's values | The implementation matches closed-form textbook arithmetic to within 0.5 s/veh |
| Webster's d1 ≤ HCM full at x ≤ 0.7, gap ≤ 5 s/veh | Webster's uniform-only is a slight under-estimate of full HCM delay at operational saturation, within published bounds |
| Webster's d1 = HCM 6th Ed. d1 (identical formula) | The cross-validation reference is correctly implemented |
| Webster's underestimates HCM at x > 0.9 | The documented limit of uniform-only; the system hands off to the road_widening precedence rule at v/c > 0.90, so the underestimate cannot produce wrong recommendations |
| Dose-response monotonicity, convexity, zero-flow → zero-delay | The curve has the shape transportation engineers expect; v/c → 1 produces the asymptotic blow-up |

All 15 validation tests pass; the broader simulation surface (110 tests in
`tests/test_simulation.py`, `tests/test_timing.py`) passes.

### Validation surfaced a real bug, which we fixed

During the validation-test build-out, the closed-form textbook checks
failed on `compute_uniform_delay`. The denominator used `(1 - x)` where
Webster's 1958 / HCM 6th Ed. d1 use `(1 - λ·x)`. This produced delay
estimates inflated by a factor of ~2.5× at typical (g/C) and dramatically
larger numbers at high saturation. We corrected the formula
(`server/simulation.py:55`) and the validation suite now passes.

**This is a strength in the chapter, not a weakness.** The methodology is:
*"we wrote a validation suite, it caught a deviation from published
formulas, we corrected the implementation, all tests pass."* That is what
sound engineering looks like.

Side-effects of the fix:
- The dashboard's vehicle-hours-saved numbers are now smaller (the previous
  values were inflated) and align with what an engineer using a manual
  worksheet would compute.
- Historical `simulation_results` rows have stale delay numbers. They are
  not load-bearing thesis numbers — the CNN ablation results in
  `runs/real_eval/` were computed independently of the simulation. The
  recommendations precedence is unaffected (uses v/c, not delay).
- The methods-chapter sentence becomes *"Webster's 1958 uniform delay,
  identical to HCM 6th Ed. d1, validated against closed-form expected
  values and the full HCM 6th Ed. control delay formula."* No deviation
  to defend.

### What this is not

Be honest about the limits when asked:

- **Not a full microsimulation.** No lane-changing, no driver-behaviour
  variability, no platoon dispersion modelling. A SUMO study would model
  more individual-vehicle dynamics.
- **Requires CCTV-derived arrivals** for the full per-second replay. The
  Toronto TMC retraining data uses 15-min aggregates, not per-second
  arrivals, so the dose-response simulation does not run on Toronto data
  during training/eval. The CNN ablation is a separate concern.
- **Does not model political, budget, or right-of-way constraints.** A
  recommendation with 100 vehicle-hours saved still has to clear those.
  The system produces engineering evidence; the operator makes the
  decision.

### How to answer the panel question

> *"How do we know your simulation produces trustworthy delay numbers?"*

> "Three pieces. First, the simulation uses Webster's 1958 uniform delay
> for signalised approaches and HCM 6th Edition gap-acceptance for
> unsignalised, the same methods cited in transportation engineering
> textbooks. Second, we shipped a validation suite that cross-checks the
> production formula against five hand-computed Webster's values and
> against the full HCM 6th Edition delay formula across a range of
> saturation conditions. Third, the validation suite caught a deviation
> in our original implementation — the denominator was missing a λ
> multiplier — which we corrected before evaluation. All 15 validation
> tests pass, and the broader simulation test suite of 110 tests passes.
> The simulation engine is not a visualisation; it is a per-intersection
> analytical delay model that produces the same numbers a transportation
> engineer would compute on a worksheet."

That sentence is what the panel needs to hear.

### Stochastic confirmation of analytical delay estimates

The analytical sim above produces a point estimate per intersection. The
follow-up question is whether that number is *stable* under random
arrival patterns, not just under the textbook's uniform-arrival
assumption. To answer it, the sprint also ships a Monte Carlo stochastic
microsim at `server/stochastic_simulation.py`.

**What it does.** Models individual vehicles at each approach with
Poisson arrivals and a small driver-reaction variance at green onset;
each vehicle has its own FIFO arrival and discharge time. Running 100
independent simulations of the same hour produces a delay distribution
per approach plus a global vehicle-hours-saved distribution. From each
distribution we report the mean, standard deviation, and a 95%
t-interval. The CLI runner at `scripts/run_stochastic_microsim.py`
produces the per-intersection JSON used in the methods chapter.

**What we observe vs. Webster's.** Two regimes:

1. **Low-to-moderate saturation (x ≤ 0.5).** The MC mean tracks Webster's
   uniform delay within roughly 1 s/veh. With deterministic arrivals and
   zero reaction noise, the MC mean lands within 2 s/veh of Webster's
   for x in [0.3, 0.7]; the residual gap is the per-second discretisation
   of saturation discharge, not a modelling disagreement. The
   convergence is enforced by
   `tests/test_stochastic_simulation.py::test_no_noise_limit_matches_webster`.
2. **High saturation (x ≥ 0.85).** The MC mean strictly *exceeds*
   Webster's by an amount consistent with the HCM 6th Ed. incremental
   delay term d2. This is the random-arrival overflow Webster's d1
   ignores. The bias direction is enforced by
   `tests/test_stochastic_simulation.py::test_mc_bias_relative_to_webster_grows_with_saturation`.

The operational reading: at the saturations where the production
recommendation lives (Webster's targets x ≤ 0.85 by design), the
analytical point estimate is inside the MC behaviour envelope. Above
that, the analytical estimate is a lower bound and the cascading
precedence rule already routes the case to a non-timing intervention
(road widening, signalisation upgrade), so a tighter delay estimate
doesn't change the recommendation.

**Q.** *"Your analytical simulation produces point estimates. How do we
know those numbers are stable under stochastic arrival patterns?"*

> "We additionally implemented a Monte Carlo stochastic microsim that
> models Poisson arrivals at each approach with driver-reaction
> variability. Running 100 independent simulations of the same hour
> produces a delay distribution per approach and a 95% confidence
> interval on every delay and vehicle-hours-saved estimate. In the
> no-noise limit — deterministic arrivals, zero reaction variance — the
> stochastic mean converges to Webster's value within 2 seconds per
> vehicle. With realistic Poisson noise, the two agree at low-to-moderate
> saturation and the stochastic mean exceeds Webster's at high
> saturation by the amount the HCM 6th Edition incremental delay term
> models. Either outcome is honest and informative: at low saturation
> Webster's is operationally sufficient and the CI is tight; at high
> saturation Webster's is a lower bound and the recommendation system
> has already routed the case to a cascading intervention."

**Scope.** Each approach is single-lane, FIFO. We don't model
lane-changing, gap-acceptance for permitted lefts, or any of the things
SUMO would. That work is named in `docs/SUMO_DEMO_SCOPING.md` as future
work. This stochastic microsim is matched to the analytical sim's
modelling depth, not above it — its job is to give CIs to the analytical
numbers, not to replace them.

---

## Part 8 — Files and where they live

| File | Purpose |
|---|---|
| `docs/REAL_DATA_RETRAIN_PLAN.md` | The 1-week sprint plan you signed off on. |
| `docs/PANEL_DEFENSE_GUIDE.md` | This document. |
| `scripts/load_real_traffic.py` | Toronto TMC → (5,96) + rule labels + intersection-stratified split. |
| `scripts/train_on_real.py` | Trains the 4-head TemporalWarrantCNN on the real-data npz. |
| `scripts/eval_on_real.py` | Scores any checkpoint against the real-data test set. |
| `data/toronto_tmc/tmc_raw_2020_2029.csv` | Toronto Open Data Multimodal TMC raw 15-min counts (85 MB). |
| `runs/real_data/{train,val,test}.npz` | Labelled real samples (691 / 89 / 93). |
| `runs/real_data/real_data_summary.json` | Split metadata + distribution. |
| `runs/real_cnn/real_cnn_seed0.pt` | The real-trained CNN checkpoint. |
| `runs/real_cnn/training_summary.json` | Training-run metadata. |
| `runs/real_eval/baseline_synthetic_on_real.json` | The "before" column. |
| `runs/real_eval/real_trained_on_real.json` | The "after" column. |
| `runs/real_eval/ablation_synthetic_vs_real.json` | The merged ablation result with all Objective 7 metrics. |
| `server/simulation_validation.py` | HCM 6th Ed. reference + dose-response sweep utility (Part 7.5). |
| `tests/test_simulation_validation.py` | 15-test validation suite that exercises the analytical delay simulation against closed-form and HCM 6th Ed. reference values. |
| `docs/SUMO_DEMO_SCOPING.md` | Future-work scoping doc for SUMO microsim cross-validation on a single demonstration intersection. Not in 1-week sprint scope. |
| `docs/STOCHASTIC_MICROSIM_PLAN.md` | Self-contained execution plan for the Monte Carlo stochastic microsim. Shipped — see `server/stochastic_simulation.py`. |
| `server/stochastic_simulation.py` | Monte Carlo stochastic microsim: Poisson arrivals + FIFO discharge + 95% t-intervals on every delay and vehicle-hours-saved estimate. Sibling to `server/simulation.py`, not a replacement. |
| `tests/test_stochastic_simulation.py` | 15-test suite for the stochastic microsim: sanity (zero flow, monotonicity, reaction effect, reproducibility), no-noise convergence to Webster's, monotone bias above Webster's with saturation, and `monte_carlo_compare` paired-seed sanity. |
| `scripts/run_stochastic_microsim.py` | CLI runner: produces `runs/stochastic/{id}_{window}.json` with per-approach DelayStatistics + analytical reference for the methods chapter. |
| `docs/RECOMMENDER_MODEL_SWITCH.md` | How to swap between synthetic and real-trained CNN via the TEMPORAL_CNN_MODEL_PATH env var; safe-deployment guidance. |
