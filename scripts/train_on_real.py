"""Train a TemporalWarrantCNN on the real-data .npz produced by load_real_traffic.

Day 4 of the real-data retrain sprint (see `docs/REAL_DATA_RETRAIN_PLAN.md`).

Thin wrapper that reuses `scripts.train_multitask_cnn.train_one_seed` so the
optimizer + loss + early-stopping logic stays identical between the synthetic
baseline and the real-data variant. Only the data source changes (npz on
disk vs in-process synthetic generation) and the head set shrinks from 6 →
the K warrant heads named in the npz (4 for Toronto: w1, w2, w3, w4).

Usage:
    python -m scripts.train_on_real \\
        --real-data-dir runs/real_data/ \\
        --output-dir runs/real_cnn/ \\
        --seeds 0
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Sequence

import numpy as np
import torch

from server.intervention_rules import INTERVENTION_CLASSES
from server.ml.temporal_warrant import DEFAULT_METADATA_FEATURES
from scripts.train_multitask_cnn import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_DROPOUT,
    DEFAULT_EPOCHS,
    DEFAULT_LR,
    DEFAULT_PATIENCE,
    DEFAULT_WEIGHT_DECAY,
    LOSS_TYPE_CHOICES,
    LOSS_TYPE_UNCERTAINTY,
    SyntheticTensors,
    save_checkpoint,
    train_one_seed,
)


logger = logging.getLogger("train_on_real")


def _npz_to_tensors(npz_path: Path) -> tuple[SyntheticTensors, list[str]]:
    """Read one split's npz into a SyntheticTensors bundle.

    Returns the bundle alongside the warrant_names recorded on the npz so
    the caller can pass them into TemporalWarrantCNN's name list.
    """
    data = np.load(npz_path, allow_pickle=False)
    return SyntheticTensors(
        flow=torch.from_numpy(data["flow"]).float(),
        metadata=torch.from_numpy(data["metadata"]).float(),
        warrants=torch.from_numpy(data["warrants"]).float(),
        intervention=torch.from_numpy(data["intervention"]).long(),
        intersection_id=data["intersection_id"].astype(np.int64),
    ), [str(n) for n in data["warrant_names"]]


def merge_train_val(
    train: SyntheticTensors, val: SyntheticTensors,
) -> tuple[SyntheticTensors, np.ndarray, np.ndarray]:
    """Concatenate train + val and produce row-index splits for train_one_seed."""
    n_train = train.flow.shape[0]
    n_val = val.flow.shape[0]
    bundle = SyntheticTensors(
        flow=torch.cat([train.flow, val.flow], dim=0),
        metadata=torch.cat([train.metadata, val.metadata], dim=0),
        warrants=torch.cat([train.warrants, val.warrants], dim=0),
        intervention=torch.cat([train.intervention, val.intervention], dim=0),
        intersection_id=np.concatenate([train.intersection_id, val.intersection_id]),
    )
    train_idx = np.arange(0, n_train, dtype=np.int64)
    val_idx = np.arange(n_train, n_train + n_val, dtype=np.int64)
    return bundle, train_idx, val_idx


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--real-data-dir", type=Path, required=True,
                   help="Directory holding train.npz, val.npz, test.npz from load_real_traffic.")
    p.add_argument("--output-dir", type=Path, default=Path("runs/real_cnn"))
    p.add_argument("--seeds", type=int, nargs="+", default=[0])
    p.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    p.add_argument("--lr", type=float, default=DEFAULT_LR)
    p.add_argument("--weight-decay", type=float, default=DEFAULT_WEIGHT_DECAY)
    p.add_argument("--dropout", type=float, default=DEFAULT_DROPOUT)
    p.add_argument("--patience", type=int, default=DEFAULT_PATIENCE)
    p.add_argument("--device", type=str, default="cpu")
    p.add_argument("--loss-type", type=str, default=LOSS_TYPE_UNCERTAINTY,
                   choices=LOSS_TYPE_CHOICES)
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)

    train_bundle, warrant_names_train = _npz_to_tensors(args.real_data_dir / "train.npz")
    val_bundle, warrant_names_val = _npz_to_tensors(args.real_data_dir / "val.npz")
    assert warrant_names_train == warrant_names_val, (
        f"train/val npz warrant_names mismatch: {warrant_names_train} vs {warrant_names_val}"
    )
    warrant_names = warrant_names_train
    n_warrants = len(warrant_names)
    logger.info("Training %d-head CNN, warrants=%s", n_warrants, warrant_names)
    logger.info("Train samples: %d, Val samples: %d",
                train_bundle.flow.shape[0], val_bundle.flow.shape[0])

    bundle, train_idx, val_idx = merge_train_val(train_bundle, val_bundle)

    device = torch.device(args.device)
    summary: dict = {
        "real_data_dir": str(args.real_data_dir),
        "warrant_names": warrant_names,
        "intervention_classes": list(INTERVENTION_CLASSES),
        "metadata_features": list(DEFAULT_METADATA_FEATURES),
        "n_train_samples": int(train_bundle.flow.shape[0]),
        "n_val_samples": int(val_bundle.flow.shape[0]),
        "seeds": args.seeds,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "loss_type": args.loss_type,
        "checkpoints": {},
    }

    for seed in args.seeds:
        logger.info("== Training seed=%d ==", seed)
        model, loss_module, metrics, class_weights = train_one_seed(
            seed=seed,
            data=bundle,
            train_idx=train_idx,
            val_idx=val_idx,
            n_warrants=n_warrants,
            n_intervention_classes=len(INTERVENTION_CLASSES),
            epochs=args.epochs,
            batch_size=args.batch_size,
            lr=args.lr,
            weight_decay=args.weight_decay,
            dropout=args.dropout,
            patience=args.patience,
            device=device,
            loss_type=args.loss_type,
        )
        # Attach the right warrant_names + metadata_features onto the model so
        # the saved checkpoint reflects the 4-head real-data set, not the
        # 6-head synthetic default.
        model.warrant_names = warrant_names
        model.intervention_classes = list(INTERVENTION_CLASSES)
        model.metadata_features = list(DEFAULT_METADATA_FEATURES)

        ckpt_path = args.output_dir / f"real_cnn_seed{seed}.pt"
        save_checkpoint(
            ckpt_path,
            model=model,
            loss_module=loss_module,
            metrics=metrics,
            seed=seed,
            intervention_classes=list(INTERVENTION_CLASSES),
            class_weights=class_weights,
            loss_type=args.loss_type,
        )
        logger.info("Saved %s (best_epoch=%d val_loss=%.4f)",
                    ckpt_path, metrics.best_epoch, metrics.best_val_loss)
        summary["checkpoints"][f"seed{seed}"] = {
            "path": str(ckpt_path),
            "best_epoch": metrics.best_epoch,
            "best_val_loss": metrics.best_val_loss,
            "epochs_run": metrics.epochs_run,
        }

    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = args.output_dir / "training_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    logger.info("Wrote summary: %s", summary_path)


if __name__ == "__main__":
    main()
