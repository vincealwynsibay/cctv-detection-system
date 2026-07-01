# Switching Between the Synthetic and Real-Trained Recommender

> Day 7 deployment notes for the real-data retrain sprint
> (`docs/REAL_DATA_RETRAIN_PLAN.md`).
> Use this when you need to swap the warrant CNN checkpoint without
> touching code, or to demo the swap to the thesis panel.

## What changed

Two warrant CNN checkpoints now exist:

| Variant | Path | Heads | Trained on |
|---|---|---:|---|
| Synthetic baseline | `runs/temporal_cnn/temporal_cnn_seed0.pt` | 6 | Tagum-realistic synthetic generator |
| Real-trained Toronto | `runs/real_cnn/real_cnn_seed0.pt` | 4 | Toronto Open Data Multimodal TMC (rule-labelled real flows) |

Both load through the same `server.ml.temporal_inference.load_recommender`
code path. The server side accepts either via the `TEMPORAL_CNN_MODEL_PATH`
environment variable; no router or model code needed to change.

## How to switch (production)

Set the env var before starting the server:

```bash
# Use the synthetic baseline (default behaviour — recommended for production
# until the real-trained model is validated against real Tagum CCTV data).
export TEMPORAL_CNN_MODEL_PATH=runs/temporal_cnn/temporal_cnn_seed0.pt

# Use the real-trained Toronto model (demo or evaluation only).
export TEMPORAL_CNN_MODEL_PATH=runs/real_cnn/real_cnn_seed0.pt

# Then start the server normally:
uvicorn server.main:app --reload
```

The lifespan handler at `server/main.py:108-118` reads the env var on
startup. On a successful load, `app.state.recommender_artifacts` exposes
the new model to the recommendations router; on a failure, the system
falls back to the scalar `WarrantMLP` baseline automatically.

## How to confirm which model is live

### From the dashboard

A pill in the top-right header shows the loaded variant:

- **Synthetic CNN** (amber): the synthetic-trained 6-head baseline
- **Real-trained CNN** (emerald): the Toronto-trained 4-head retrained model
- **Scalar baseline** (muted): fallback when the CNN failed to load

Hover the pill for the checkpoint path, head names, and training metadata.

### From the API

```bash
curl http://localhost:8000/recommendations/model-info
```

Returns:

```json
{
  "mode":                 "temporal_cnn",
  "loaded":               true,
  "variant":              "real_trained_toronto",
  "training_data_source": "Toronto Open Data Multimodal TMC (rule-labelled real flows)",
  "checkpoint_path":      "runs/real_cnn/real_cnn_seed0.pt",
  "warrant_names":        ["w1", "w2", "w3", "w4"],
  "intervention_classes": ["signalize", "road_widening", "timing_only"],
  "n_warrants":           4,
  "training_metadata":    { "seed": 0, "best_epoch": 47, ... }
}
```

## What does NOT need to change

Confirmed compatible with both checkpoints:

- **`server/routers/recommendations.py`** — the CNN path at line 411-412 reads
  `wp.get("w1", 0.0)`, `wp.get("w2", 0.0)`, `wp.get("w4", 0.0)` with safe defaults.
  Both checkpoints emit those names. The 6-head model's `w_local_2` and
  `w_local_3` outputs were never consumed here (rule pipeline owns those).
- **`server/local_warrants.py`** — produces `w_local_1`, `w_local_2`,
  `w_local_3` fields independently of the CNN. These continue to appear in
  every recommendation regardless of which CNN is loaded.
- **Frontend types and components** — `Recommendation.w_local_*` fields are
  already `boolean | null`, and existing tests
  (`eyegila/src/tests/warrantBars.test.ts`) verify nullable handling.

## Production safety guidance

> **The default remains the synthetic-baseline checkpoint until the
> real-trained model is validated against real Tagum CCTV data.**

The bias was measured in one direction: synthetic-trained → Toronto-eval
(0.245 AUC gap, closed by retraining). The reverse direction is unmeasured:
**Toronto-trained → Tagum-eval is an unknown bias.** The Toronto training
distribution is `road_widening`-dominated (76%) because of Toronto urban
downtown volumes. Tagum's distribution skews `timing_only`. Deploying the
Toronto-trained model directly to Tagum production may over-recommend
`road_widening` on calm Tagum intersections.

Until Tagum-real data is collected and a Tagum-evaluation ablation is run,
the synthetic baseline remains the production default.

## For the panel demo

If you want to show the model swap live during defense:

1. Start the server with the synthetic checkpoint (default).
2. Open the dashboard. Point at the header pill: *"Synthetic CNN (amber)"*.
3. Stop the server.
4. `export TEMPORAL_CNN_MODEL_PATH=runs/real_cnn/real_cnn_seed0.pt`.
5. Restart the server.
6. Reload the dashboard. Pill now reads: *"Real-trained CNN (emerald)"*.
7. Hover the pill, narrate the metadata.

That takes 30 seconds and visibly shows the system supports both models.

## Rollback

```bash
unset TEMPORAL_CNN_MODEL_PATH
# Restart server — falls back to default path at `<ml_dir>/temporal_cnn_model.pt`.
```

If even that fails to load, the recommendations router routes to the scalar
`WarrantMLP` baseline (`server/ml/inference.py:predict_warrants`).
Production stays up.
