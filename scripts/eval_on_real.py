"""Evaluate a TemporalWarrantCNN checkpoint on the Toronto-real test split.

Day 3 of the real-data retrain sprint (see `docs/REAL_DATA_RETRAIN_PLAN.md`).

Loads any checkpoint produced by `scripts.train_multitask_cnn` and runs it
against an `.npz` test split produced by `scripts.load_real_traffic`. The
checkpoint can have N warrant heads; the npz can have K warrant labels with
K ≤ N. We score only the warrants present in both (matched by name).

Two intended uses:

  * **Day 3 baseline:** evaluate the synthetic-trained 6-head model
    (`runs/temporal_cnn/temporal_cnn_seed0.pt`) on the real 4-label test set.
    The 2 dropped local-warrant heads in the synthetic model are silently
    ignored. Produces `baseline_synthetic_on_real.json`.

  * **Day 5 comparison:** evaluate the real-trained 4-head model
    (`runs/real_cnn/real_cnn_seed0.pt`) on the same real test set. Produces
    `real_trained_on_real.json`. The two JSONs together form the ablation.

Metrics:
  per-warrant AUC, F1@0.5, positive-rate (label prevalence on this test set)
  intervention accuracy, macro-F1, per-class precision/recall/F1, confusion matrix
  overall sample count

Usage:
    python -m scripts.eval_on_real \\
        --checkpoint runs/temporal_cnn/temporal_cnn_seed0.pt \\
        --test-npz runs/real_data/test.npz \\
        --output runs/real_eval/baseline_synthetic_on_real.json
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Sequence

import numpy as np
import torch
import time

from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
    roc_auc_score,
)

from server.intervention_rules import INTERVENTION_CLASSES
from server.ml.temporal_inference import load_recommender


logger = logging.getLogger("eval_on_real")


def _safe_auc(labels: np.ndarray, scores: np.ndarray) -> float | None:
    """ROC-AUC, with `None` when the split has no positive or no negative samples."""
    pos = int(labels.sum())
    if pos == 0 or pos == len(labels):
        return None
    return float(roc_auc_score(labels, scores))


def run_inference(
    checkpoint_path: Path,
    test_npz: Path,
    batch_size: int = 64,
) -> dict:
    """Score one checkpoint against one real-data .npz test split.

    Returns a JSON-ready dict with per-warrant + intervention metrics.
    """
    logger.info("Loading checkpoint: %s", checkpoint_path)
    artifacts = load_recommender(checkpoint_path)
    model = artifacts.model
    model_warrant_names = artifacts.warrant_names

    logger.info("Loading test set: %s", test_npz)
    data = np.load(test_npz, allow_pickle=False)
    flow = data["flow"]                   # (N, C, 96) — typically C=5
    metadata = data["metadata"]           # (N, M)
    warrants_y = data["warrants"]         # (N, K) — K may be smaller than model heads
    intervention_y = data["intervention"] # (N,)
    label_warrant_names = list(data["warrant_names"])

    n_samples = flow.shape[0]
    logger.info("Test samples: %d", n_samples)
    logger.info("Model warrants (%d): %s", len(model_warrant_names), model_warrant_names)
    logger.info("Label warrants (%d): %s", len(label_warrant_names), label_warrant_names)

    # Map label index → model output index. Warrants in labels but not in the
    # model are skipped (we can't score them); warrants in the model but not
    # in labels are silently ignored for the comparison (this is how the
    # synthetic model's dropped local heads get ignored when scored on real data).
    name_to_model_col = {name: i for i, name in enumerate(model_warrant_names)}
    scoreable: list[tuple[str, int, int]] = []   # (warrant_name, label_col, model_col)
    for label_col, name in enumerate(label_warrant_names):
        if name in name_to_model_col:
            scoreable.append((name, label_col, name_to_model_col[name]))
        else:
            logger.warning("warrant=%s in labels but not in model heads — skipping", name)
    logger.info("Scoreable warrants: %d", len(scoreable))

    warrant_probs = np.zeros((n_samples, len(model_warrant_names)), dtype=np.float32)
    intervention_probs = np.zeros((n_samples, model.n_intervention_classes), dtype=np.float32)

    model.eval()
    with torch.no_grad():
        for i in range(0, n_samples, batch_size):
            f_batch = torch.from_numpy(flow[i : i + batch_size]).float()
            m_batch = torch.from_numpy(metadata[i : i + batch_size]).float()
            w_logits, iv_logits = model(f_batch, m_batch)
            warrant_probs[i : i + batch_size] = torch.sigmoid(w_logits).numpy()
            intervention_probs[i : i + batch_size] = torch.softmax(iv_logits, dim=1).numpy()

    # ── Per-warrant metrics (Objective 7: accuracy/precision/recall/F1/mAP) ──
    per_warrant: dict[str, dict] = {}
    for name, label_col, model_col in scoreable:
        y = warrants_y[:, label_col].astype(np.int32)
        p = warrant_probs[:, model_col]
        y_hat = (p >= 0.5).astype(np.int32)
        prec_w, rec_w, f1_w, _ = precision_recall_fscore_support(
            y, y_hat, average="binary", zero_division=0.0,
        )
        per_warrant[name] = {
            "accuracy":  float((y_hat == y).mean()),
            "precision": float(prec_w),
            "recall":    float(rec_w),
            "f1_at_0_5": float(f1_w),
            "auc":             _safe_auc(y, p),
            "average_precision": float(average_precision_score(y, p)) if 0 < y.sum() < len(y) else None,
            "positive_rate":         float(y.mean()),
            "n_positives":           int(y.sum()),
            "predicted_positive_rate": float(y_hat.mean()),
            "mean_prob":             float(p.mean()),
        }

    # Aggregates across warrants (skip warrants where the metric is undefined).
    defined_aucs = [m["auc"] for m in per_warrant.values() if m["auc"] is not None]
    defined_aps  = [m["average_precision"] for m in per_warrant.values() if m["average_precision"] is not None]
    macro_auc = float(np.mean(defined_aucs)) if defined_aucs else None
    macro_f1  = float(np.mean([m["f1_at_0_5"] for m in per_warrant.values()]))
    macro_precision = float(np.mean([m["precision"] for m in per_warrant.values()]))
    macro_recall    = float(np.mean([m["recall"] for m in per_warrant.values()]))
    macro_accuracy  = float(np.mean([m["accuracy"] for m in per_warrant.values()]))
    mean_average_precision = float(np.mean(defined_aps)) if defined_aps else None

    # ── Intervention head metrics ────────────────────────────────────────────
    intervention_pred = intervention_probs.argmax(axis=1)
    labels_present = sorted(set(intervention_y.tolist()) | set(intervention_pred.tolist()))
    iv_accuracy = float((intervention_pred == intervention_y).mean())
    iv_macro_f1 = float(f1_score(
        intervention_y, intervention_pred, average="macro", zero_division=0.0,
    ))

    precision, recall, f1, support = precision_recall_fscore_support(
        intervention_y, intervention_pred,
        labels=list(range(len(INTERVENTION_CLASSES))), zero_division=0.0,
    )
    per_class = {
        INTERVENTION_CLASSES[i]: {
            "precision": float(precision[i]),
            "recall":    float(recall[i]),
            "f1":        float(f1[i]),
            "support":   int(support[i]),
            "predicted_count": int((intervention_pred == i).sum()),
        }
        for i in range(len(INTERVENTION_CLASSES))
    }

    cm = confusion_matrix(
        intervention_y, intervention_pred,
        labels=list(range(len(INTERVENTION_CLASSES))),
    )
    confusion = {
        f"true_{INTERVENTION_CLASSES[true_i]}": {
            f"pred_{INTERVENTION_CLASSES[pred_i]}": int(cm[true_i, pred_i])
            for pred_i in range(len(INTERVENTION_CLASSES))
        }
        for true_i in range(len(INTERVENTION_CLASSES))
    }

    # ── Inference throughput (Objective 7: FPS) ──────────────────────────────
    # Wall-clock samples-per-second for the recommendation forward pass. We
    # time a fixed-batch loop after a warm-up, like a typical ML benchmark.
    # Reported as samples/sec (analog of FPS for a per-sample classifier).
    warmup_batches = 2
    timing_batches = 10
    bench_batch = min(batch_size, n_samples) or 1
    with torch.no_grad():
        f_warm = torch.from_numpy(flow[:bench_batch]).float()
        m_warm = torch.from_numpy(metadata[:bench_batch]).float()
        for _ in range(warmup_batches):
            model(f_warm, m_warm)
        t0 = time.perf_counter()
        total = 0
        for _ in range(timing_batches):
            model(f_warm, m_warm)
            total += bench_batch
        elapsed = time.perf_counter() - t0
    samples_per_sec = float(total / elapsed) if elapsed > 0 else None
    ms_per_sample = float(1000.0 * elapsed / total) if total > 0 else None

    return {
        "checkpoint": str(checkpoint_path),
        "test_npz": str(test_npz),
        "n_samples": int(n_samples),
        "model_warrant_names": list(model_warrant_names),
        "label_warrant_names": list(label_warrant_names),
        "scoreable_warrant_names": [s[0] for s in scoreable],
        "per_warrant": per_warrant,
        "macro_auc": macro_auc,
        "macro_f1": macro_f1,
        "macro_precision": macro_precision,
        "macro_recall": macro_recall,
        "macro_accuracy": macro_accuracy,
        "mean_average_precision": mean_average_precision,
        # Back-compat aliases (Day 3/5 already wrote these names into ablation JSON):
        "macro_auc_over_scoreable": macro_auc,
        "macro_f1_over_scoreable": macro_f1,
        "intervention": {
            "accuracy": iv_accuracy,
            "macro_f1": iv_macro_f1,
            "per_class": per_class,
            "confusion_matrix": confusion,
        },
        "throughput": {
            "samples_per_sec": samples_per_sec,
            "ms_per_sample":   ms_per_sample,
            "batch_size":      bench_batch,
            "device":          str(next(model.parameters()).device),
        },
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint", type=Path, required=True)
    p.add_argument("--test-npz", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--batch-size", type=int, default=64)
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)
    result = run_inference(args.checkpoint, args.test_npz, args.batch_size)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2))
    logger.info("Wrote: %s", args.output)


if __name__ == "__main__":
    main()
