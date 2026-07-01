# Warrant Model Metrics - `runs/temporal_cnn`

Evaluation results for the multi-task `TemporalWarrantCNN` (`server/ml/temporal_warrant.py`)
checkpoint stored at `runs/temporal_cnn/temporal_cnn_seed0.pt`.

## How to reproduce

```bash
python3 -m scripts.evaluate_multitask_cnn \
    --model-dir runs/temporal_cnn \
    --output-dir runs/temporal_cnn/eval
```

The harness reconstructs the held-out test split deterministically from
`runs/temporal_cnn/training_summary.json` (intersection-stratified, `data_seed=42`,
`split_seed=42`) and writes:

| File | Contents |
| --- | --- |
| `runs/temporal_cnn/eval/metrics_main.json` | per-seed + aggregated metrics |
| `runs/temporal_cnn/eval/evaluation_summary.json` | top-level rollup |
| `runs/temporal_cnn/eval/saliency/gradcam_seed0.npz` | 1-D Grad-CAM maps for plotting |

## Dataset

| Setting | Value |
| --- | --- |
| Intersections | 30 (21 train / 4 val / 5 test) |
| Days per intersection | 90 |
| Day types | 2 (weekday / weekend) |
| Test samples | **900** |
| Seeds trained | 1 (`seed=0`) |

Single-seed run → standard deviations are 0.0 across the board. Train more seeds
via `scripts/train_multitask_cnn.py --seeds 0 1 2 3 4` to get mean ± std.

---

## Warrant head - per-warrant AUC / F1

Six binary heads, sigmoid output, threshold = 0.5 for F1.

| Warrant | What it measures | AUC | F1 | Positive rate |
| --- | --- | ---: | ---: | ---: |
| `w1` | MUTCD §4C.02 - 8-hour vehicular volume | **0.984** | 0.809 | 16.1 % |
| `w2` | MUTCD §4C.03 - 4-hour vehicular volume | **0.977** | 0.826 | 20.3 % |
| `w3` | MUTCD §4C.04 - peak-hour volume | **0.989** | 0.797 | 6.6 % |
| `w4` | MUTCD §4C.05 - pedestrian volume | 0.956 | **0.044** | 4.9 % |
| `w_local_2` | Local - top-2 chunk concentration | - | 0.000 | 0.0 % |
| `w_local_3` | Local - signal-off (low PCU/approach) | **0.999** | 0.936 | 9.4 % |

### Reading the table

- **AUC is strong across the board** (≥ 0.96 for every warrant with a defined
  AUC). The classifier ranks positives above negatives reliably even for the
  rare warrants.
- **`w4` F1 collapses to 0.044** despite AUC 0.956. The 0.5 threshold is too
  high for a 4.9 %-positive class; predictions are well-calibrated for ranking
  but conservative at the default cutoff. A per-warrant threshold sweep (e.g.
  pick the threshold that maximises F1 on the validation split) will recover
  most of the signal - see "Suggested follow-ups".
- **`w_local_2` AUC is undefined** (`auc_n_seeds=0`). The test split has zero
  positives for this warrant, so neither AUC nor F1 is meaningful. The harness
  records `None` to flag incomplete coverage rather than biasing the mean with
  a 0.0. Expand the test split or rebalance the synthetic generator to surface
  positives.

---

## Intervention head - 3-class classifier

Softmax over `{signalize, road_widening, timing_only}` (defined in
`server/intervention_rules.py`). Argmax → predicted class.

**Overall accuracy: 90.2 %**
**Macro-F1: 0.838**

### Confusion matrix

Rows = true class, columns = predicted class.

| | pred: signalize | pred: road_widening | pred: timing_only | row total |
| --- | ---: | ---: | ---: | ---: |
| **true: signalize** | **152** | 12 | 14 | 178 |
| **true: road_widening** | 0 | **37** | 0 | 37 |
| **true: timing_only** | 53 | 9 | **623** | 685 |
| col total | 205 | 58 | 637 | 900 |

### Per-class precision / recall / F1

| Class | Precision | Recall | F1 |
| --- | ---: | ---: | ---: |
| `signalize` | 0.741 | 0.854 | 0.794 |
| `road_widening` | 0.638 | **1.000** | 0.779 |
| `timing_only` | **0.978** | 0.909 | **0.943** |

### Reading the matrix

- **`timing_only` dominates** the test set (685 / 900 = 76 %). The model handles
  this majority class well (precision 0.978, recall 0.909).
- **Largest off-diagonal: 53 `timing_only` → `signalize`** false positives.
  The model is over-eager to signalize intersections that just need timing
  tweaks. This drags `signalize` precision down to 0.741.
- **`road_widening` recall is perfect** but precision is the weakest at 0.638
  (12 + 9 = 21 false positives against 37 true positives). Worth watching once
  more seeds are trained - perfect recall on a 37-sample class is fragile.
- No `road_widening` rows are misclassified - the head never confuses widening
  with the other two when widening is the true label.

---

## Suggested follow-ups

1. **Train more seeds.** All `_std` fields are 0.0 because only `seed=0` exists.
   The PRD calls for multi-seed mean ± std.
   ```bash
   python3 -m scripts.train_multitask_cnn --output-dir runs/temporal_cnn \
       --seeds 0 1 2 3 4
   ```
2. **Per-warrant threshold tuning** to lift `w4` F1 - pick the threshold that
   maximises F1 on the validation split, then re-run the evaluator.
3. **Fix `w_local_2` test coverage.** Either widen the test intersection pool
   or adjust the synthetic generator so the top-2 chunk concentration warrant
   fires on at least a handful of test samples.
4. **Investigate `timing_only → signalize` confusion.** 53 / 685 ≈ 7.7 % of
   true `timing_only` samples are mis-routed to `signalize`. Inspect the
   Grad-CAM maps in `runs/temporal_cnn/eval/saliency/gradcam_seed0.npz` for
   patterns.
5. **Add an uncertainty-weighted vs equal-weighted ablation.** Re-train with
   `--loss-type equal` and pass `--ablation-dir` to `evaluate_multitask_cnn`
   to populate the paired-t-test comparison required by the PRD.
