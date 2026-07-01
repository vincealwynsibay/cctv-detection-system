# Real-Data CNN Retrain Sprint — 1-Week Plan

> Internal-only thesis sprint plan, **2026-06-30 → 2026-07-07**. Drives the
> change from synthetic-only training of the warrant CNN to a real-data
> retraining backed by a bias ablation, in direct response to the panel's
> objection that "the training data is fragile and has a lot of bias."

## Goal

Replace the synthetic-only training of the warrant CNN with a real-data
retraining, and ship a **quantitative bias ablation** comparing the two on a
held-out **real** test set. The output the panel sees is one results table
and a one-paragraph narrative.

Honors thesis Objective 5 (*"Implement a deep learning-based recommendation
module … to predict and recommend whether specific intersections require
traffic light installation"*) with real-world data instead of synthetic data.

## Decisions (signed off, do not relitigate)

| # | Decision | Reason |
|---|---|---|
| 1 | Scope = **(C) only**: retrain warrant CNN on real-derived data. Drop **(A) forecasting model** to Future Work. | (A) does not satisfy any thesis objective; one polished change ships, two half-finished do not. |
| 2 | Comparison framing = **(β) bias ablation**: synthetic-trained vs real-trained, evaluated on same real test set. | Directly answers "biased data" complaint with a numerical measurement. |
| 3 | Primary dataset = **Toronto Open Data Multimodal TMC** (City of Toronto Open Data Portal). | Real peds + real per-approach + direct CSV. No signup, no synthesis needed. See §Dataset below. |
| 4 | **Drop `w_local_2`** from CNN heads. | Existing `WARRANT_MODEL_METRICS.md` shows zero test positives → head was a dead parameter sink. |
| 5 | **Drop `w_local_3`** from real-data CNN heads. | Toronto TMC covers ~14h (no overnight). W_local_3 needs full-day low-PCU detection. Stays in rule pipeline. |
| 6 | CNN goes from **6 warrant heads → 4** (w1, w2, w3, w4) + intervention head. | Heads dropped above. Cleaner architecture, smaller param count, defensible. |
| 7 | Pedestrian channel = **real** (from Toronto TMC). No synthesis. | Toronto data has real per-approach pedestrian counts at 15-min. |
| 8 | Single seed for both halves of ablation (not 5). | 1-week budget. Multi-seed run is named Future Work. |
| 9 | Intersection-stratified split = **21 train / 4 val / 5 test**, same as synthetic. | Fair comparison baseline. |

## Dataset

### Chosen: Toronto Open Data – Multimodal TMC

- **URL:** https://ckan0.cf.opendata.inter.prod-toronto.ca/en/dataset/traffic-volumes-at-intersections-for-all-modes
- **Resource:** `tmc_raw_data_2020_2029.csv` (84 MB)
- **Granularity:** 15-minute intervals (start_time, end_time columns)
- **Per-approach:** N / S / E / W with movement breakdown (right / through / left) per approach for cars / trucks / buses
- **Pedestrians:** per-approach (`n_appr_peds`, `s_appr_peds`, `e_appr_peds`, `w_appr_peds`)
- **Bikes:** per-approach (bonus, not used)
- **Time range:** 2020–2026 actuals (file named 2020-2029)
- **Study duration:** 32-slot (8h) or 56-slot (14h) per study
- **Total studies in file:** ~617 unique intersections, ~348K 15-min rows
- **License:** Open Government Licence – Toronto (free for academic + commercial)

### Why Toronto beat the alternatives

| Dataset | 15-min | Per-approach | Real peds | Direct DL | Verdict |
|---|---|---|---|---|---|
| Boston TMC | ❌ (2-12h periods) | partial | separate dump | PDF portal | Eliminated |
| UTD19 | ⚠️ 3-5min | manual mapping needed | ❌ | email signup | Fallback only |
| DVRPC | ✅ | via TMC subset | separate dump, hourly | manual click-through | Fallback only |
| **Toronto Open Data TMC** | ✅ | ✅ | ✅ | ✅ direct CSV | **Primary** |

### Trade we accept

- **14-hour coverage, not 24h.** TMC studies run during operational hours, no overnight. We zero-pad to 96 slots for tensor shape; rule application masks the uncovered hours. This is why W_local_3 (which needs night data to detect signal-off) gets dropped from CNN heads.

## Architecture changes

| Component | Synthetic baseline | Real-data variant |
|---|---|---|
| Input shape | (5, 96) | (5, 96), zero-padded outside study window |
| Vehicle channels (0–3) | synthetic regimes | real Toronto per-approach (cars+trucks+buses summed → PCU) |
| Pedestrian channel (4) | synthesized | **real** Toronto per-approach peds |
| Warrant heads | 6 (w1, w2, w3, w4, w_local_2, w_local_3) | **4 (w1, w2, w3, w4)** |
| Intervention head | 3-class softmax | 3-class softmax (unchanged) |
| Metadata input | 5-feature dense | 5-feature dense (sampled from Tagum priors, since Toronto meta differs) |

The dropped local-warrant heads remain callable in `server.local_warrants` for the production rule pipeline. The CNN simply does not predict them.

## 7-Day timeline

| Day | Date | Work | Deliverable | Status |
|---|---|---|---|---|
| 1 | 06-30 | Dataset verification | Toronto TMC selected, data downloaded | ✅ done |
| 2 | 07-01 | Loader + label pipeline | `scripts/load_real_traffic.py` runs, produces `runs/real_data/{train,val,test}.npz` | in progress |
| 3 | 07-02 | Baseline eval (synthetic-trained CNN on real test set) | `runs/real_eval/baseline_synthetic_on_real.json` | pending |
| 4 | 07-03 | Retrain CNN on real-derived data, 4-head variant | `runs/real_cnn/real_cnn_seed0.pt` | pending |
| 5 | 07-04 | Real-trained eval + ablation table | `runs/real_eval/ablation_synthetic_vs_real.json` + CSV | pending |
| 6 | 07-05 | Draft methodology + results subsections | Two prose blocks for the chapter | pending |
| 7 | 07-06 | Polish + Q&A rehearsal | Defense-ready answers | pending |

## What the panel sees at defense

### One table (4 MUTCD warrants + intervention head)

| Warrant | Synthetic-trained AUC (real test) | Real-trained AUC (real test) | Δ |
|---|---|---|---|
| w1 (8-hour volume, MUTCD §4C.02) | _Day 3_ | _Day 5_ | _Day 5_ |
| w2 (4-hour volume, MUTCD §4C.03) | | | |
| w3 (peak-hour volume, MUTCD §4C.04) | | | |
| w4 (pedestrian volume, MUTCD §4C.05) | | | |
| intervention (3-class) | | | |

### One paragraph

> "The warrant CNN was originally trained on parameter-realistic synthetic
> data calibrated to Tagum priors. Evaluating that model on real flow data
> from the City of Toronto Open Data Multimodal Turning Movement Counts
> dataset revealed a distribution bias of Δ = [X] AUC averaged across the
> four MUTCD warrants. We retrained the CNN on rule-labelled real flows from
> N=30 intersection-day samples, closing the gap by [Y] points. The
> Tagum-local warrants (w_local_2, w_local_3) were excluded from the
> real-data CNN: w_local_2 was already non-functional in the synthetic
> baseline (zero test positives, per the existing metrics documentation),
> and w_local_3 requires full-day low-flow detection that Toronto's
> operational-hours coverage cannot supply. Both local warrants remain in
> the production rule pipeline."

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Real-trained AUC ends up *worse* than synthetic-trained | medium | Honest finding: "synthetic was overfitting clean rule outputs; real data shows actual difficulty." Still a valid contribution. |
| Toronto data covers too few unique intersections for 21/4/5 split | low | 617 intersections in file, >>30 needed. Filter to 4-leg intersections with all 4 approaches non-empty. |
| 56-slot studies are 2020-2026 only | low | Plenty of recent data. Use 2022-2024 to avoid COVID artefacts. |
| Per-approach metadata (lanes, speed) not in Toronto data | high | Sample from Tagum priors. Document as limitation. Real-data context: meta is approximate, but vehicle flows are real. |
| Day-2 loader bug eats Day-3 budget | medium | Loader scaffold already written, smoke-tested on imports. Day-2 work is filling in column names + running. |

## Out of scope (named in Future Work)

- (A) Forecasting model. Mention as "ST-GNN forecasting on the same data is a natural extension; Wang et al. 2025, Li et al. 2022."
- Multi-seed (5 seeds) run on real data. Mention as "single-seed result; multi-seed validation is named future work."
- Real Tagum CCTV data validation. Mention as "real-Tagum deployment validation is named future work; production CCTV pipeline is in place."
- W_local_2 head redesign. Mention as "the locale-specific peak concentration warrant requires reformulation before it can become a useful learning target."

## Shipped after the primary sprint

- **Monte Carlo stochastic microsim** (`server/stochastic_simulation.py`,
  `tests/test_stochastic_simulation.py`, `scripts/run_stochastic_microsim.py`).
  Poisson arrivals + FIFO discharge + 95% t-intervals on every analytical
  delay number. Cross-validates `server/simulation.py:compute_uniform_delay`:
  matches Webster's in the no-noise limit, exceeds it at high saturation
  by the HCM 6th Ed. d2 amount. See
  `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5 "Stochastic confirmation of
  analytical delay estimates" and `docs/STOCHASTIC_MICROSIM_PLAN.md`.

## Reference: cited related work

- **Wang et al. (2025)**, *Machine learning-based prediction of traffic signal timing for optimized intersection management*, Springer Innovative Infrastructure Solutions. XGBoost + ST-GNN + PSO.
- **Springer (2022)**, *A Data-Driven Network Model for Traffic Volume Prediction at Signalized Intersections*, GCN-LSTM.
- **Mai et al. (2025)**, *Urban intersection traffic flow prediction: a physics-guided spatio-temporal GNN framework*, ScienceDirect.
- **Kendall et al. (2018)**, *Multi-task learning using uncertainty to weigh losses*, CVPR (already cited in thesis).
- **Toronto Open Data**, *Multimodal Intersection Turning Movement Counts*, license: Open Government Licence – Toronto.
- **Loder et al. (2019)**, *Understanding traffic capacity of urban networks*, Scientific Reports — UTD19 (fallback dataset; not used in primary run).
