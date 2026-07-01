"""Real-traffic loader for the Toronto Open Data Multimodal TMC dataset.

Consumes ``tmc_raw_data_2020_2029.csv`` from the City of Toronto Open Data
Portal (https://open.toronto.ca/dataset/traffic-volumes-at-intersections-for-all-modes),
reshapes per-approach 15-minute counts into the same ``(5, 96)`` channels-
first format the synthetic generator produces, derives 4-MUTCD-warrant +
intervention labels by applying the existing rule pipeline to those real
flows, and emits intersection-stratified train/val/test splits the existing
training/eval scripts can consume.

Architecture (vs. the synthetic baseline):
  * 4 warrant heads (w1, w2, w3, w4). w_local_2 and w_local_3 dropped —
    w_local_2 was already non-functional in the synthetic model (zero test
    positives, see WARRANT_MODEL_METRICS.md); w_local_3 requires full-day
    coverage that Toronto's 14-hour studies do not provide. Both rules stay
    callable in `server.local_warrants` for the production rule pipeline.
  * Pedestrian channel is REAL (Toronto data has per-approach 15-min peds).
    No synthesis.

Output:
    runs/real_data/{train,val,test}.npz

Usage:
    pip install pandas    # one extra dep, thesis-side only
    python -m scripts.load_real_traffic \\
        --toronto-csv data/toronto_tmc/tmc_raw_2020_2029.csv \\
        --output-dir runs/real_data/

See `docs/REAL_DATA_RETRAIN_PLAN.md` for the surrounding sprint plan.
"""
from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupShuffleSplit

from server.intervention_rules import (
    INTERVENTION_CLASSES,
    assign_intervention_label,
)
from server.ml.synthetic_traffic import (
    N_VEHICLE_CHANNELS,
    PED_CHANNEL_INDEX,
    sample_intersection_meta,
    critical_vc_for_day,
)
from server.warrant_rules import evaluate_all_mutcd
from server.ml.temporal_warrant import DEFAULT_METADATA_FEATURES


# ── Warrant set for real-data retraining ─────────────────────────────────────
# 4 MUTCD heads only. w_local_2 + w_local_3 dropped — see module docstring.
WARRANT_NAMES_REAL: tuple[str, ...] = ("w1", "w2", "w3", "w4")


# ── Toronto TMC schema ───────────────────────────────────────────────────────
# Confirmed by inspecting tmc_raw_data_2020_2029.csv on 2026-06-30.

SLOTS_PER_DAY = 96
SLOTS_PER_HOUR = 4
TARGET_INTERVAL_MIN = 15

# Toronto TMC study coverage. 5,080 studies are 32 slots (8 h), 3,300 are
# 56 slots (14 h). We filter to 56-slot studies — more coverage means more
# of the day's traffic pattern visible to the model.
TARGET_SLOTS_PER_STUDY = 56

# Per-approach movement columns. Each cell is the count of vehicles of that
# class executing that movement during the 15-min slot starting at start_time.
APPROACHES = ("n", "s", "e", "w")              # Toronto column prefix
MOVEMENTS = ("r", "t", "l")                    # right, through, left
VEHICLE_CLASSES = ("cars", "truck", "bus")

# Passenger Car Unit (PCU) weights per HCM / synthetic generator convention.
# Synthetic generator treats one "vehicle" = 1 PCU because it never splits
# classes. Toronto data does, so we weight to keep MUTCD thresholds (which
# are calibrated against PCU) comparable.
PCU_WEIGHTS = {"cars": 1.0, "truck": 1.5, "bus": 2.0}

PED_COLS_PER_APPROACH = {a: f"{a}_appr_peds" for a in APPROACHES}


# ── Per-(intersection, day) sample ───────────────────────────────────────────

@dataclass
class LabeledRealSample:
    """One labeled real-data sample, parallel to LabeledSample in synthetic_traffic.py."""
    flow_matrix: np.ndarray         # (5, 96) float32; zero-padded outside the study window
    meta_vector: np.ndarray         # (5,) float32 — see DEFAULT_METADATA_FEATURES
    warrants_vec: np.ndarray        # (4,) float32 — w1..w4 met flags
    intervention_idx: int           # INTERVENTION_CLASSES index
    intersection_id: int            # Toronto centreline_id used as group key
    count_id: int                   # Toronto count_id (one study)
    count_date: str                 # ISO date of the study
    is_weekend: bool
    n_observed_slots: int           # how many of the 96 slots have real data


# ── Slot / time helpers ──────────────────────────────────────────────────────

def slot_index_from_start_time(start_time: pd.Timestamp) -> int:
    """Map a 15-min slot's start_time to its 0..95 slot index for the day."""
    return int((start_time.hour * 60 + start_time.minute) // TARGET_INTERVAL_MIN)


# ── Per-slot flow row → channel values ───────────────────────────────────────

def _approach_pcu_per_hr(row: pd.Series, approach: str) -> float:
    """Total PCU/hr entering the intersection from one approach during this slot.

    Sums (cars + truck + bus) × (r + t + l) movements, applies PCU weights,
    converts 15-min count to hourly rate.
    """
    pcu = 0.0
    for cls in VEHICLE_CLASSES:
        cls_count = 0
        for m in MOVEMENTS:
            col = f"{approach}_appr_{cls}_{m}"
            v = row[col]
            if pd.notna(v):
                cls_count += int(v)
        pcu += cls_count * PCU_WEIGHTS[cls]
    return pcu * SLOTS_PER_HOUR


def _ped_per_hr(row: pd.Series) -> float:
    """Total pedestrians/hr crossing any leg during this slot.

    Summed across the four approach legs because the synthetic generator's
    channel 4 is a single intersection-wide ped flow, not per-approach.
    """
    total = 0
    for col in PED_COLS_PER_APPROACH.values():
        v = row[col]
        if pd.notna(v):
            total += int(v)
    return total * SLOTS_PER_HOUR


def build_flow_matrix(study_df: pd.DataFrame) -> tuple[np.ndarray, int]:
    """Compose one study's rows into a (5, 96) flow matrix.

    Returns ``(flow_matrix, n_observed_slots)``. Slots outside the study
    window stay at zero (zero-padding for tensor shape).
    """
    flow = np.zeros((N_VEHICLE_CHANNELS + 1, SLOTS_PER_DAY), dtype=np.float64)
    n_observed = 0
    for _, row in study_df.iterrows():
        slot = slot_index_from_start_time(row["start_time"])
        if not (0 <= slot < SLOTS_PER_DAY):
            continue
        flow[0, slot] = _approach_pcu_per_hr(row, "n")
        flow[1, slot] = _approach_pcu_per_hr(row, "s")
        flow[2, slot] = _approach_pcu_per_hr(row, "e")
        flow[3, slot] = _approach_pcu_per_hr(row, "w")
        flow[PED_CHANNEL_INDEX, slot] = _ped_per_hr(row)
        n_observed += 1
    return flow, n_observed


# ── Label generation ─────────────────────────────────────────────────────────

def _meta_vector(meta) -> np.ndarray:
    return np.array(
        [getattr(meta, name) for name in DEFAULT_METADATA_FEATURES],
        dtype=np.float32,
    )


def label_sample(
    flow_matrix: np.ndarray,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray, int]:
    """Apply the rule pipeline to derive ``(meta_vec, warrants_vec, intervention_idx)``.

    Intersection metadata is sampled from the existing Tagum priors because
    Toronto TMC does not publish lane counts / posted speed / signalized
    flag in the count CSV. This is documented as a limitation in the
    methods chapter — the *flows* are real, the *meta* is sampled.
    """
    meta = sample_intersection_meta(rng)
    mutcd = dict(evaluate_all_mutcd(flow_matrix, meta))
    warrants_dict = {name: bool(mutcd[name][0]) for name in WARRANT_NAMES_REAL}

    critical_vc = critical_vc_for_day(flow_matrix)
    intervention = assign_intervention_label(
        critical_vc=critical_vc,
        is_signalized=meta.is_signalized,
        warrant_results={k: (v, 0.0) for k, v in warrants_dict.items()},
    )

    warrants_vec = np.array(
        [float(warrants_dict[name]) for name in WARRANT_NAMES_REAL],
        dtype=np.float32,
    )
    intervention_idx = INTERVENTION_CLASSES.index(intervention)
    return _meta_vector(meta), warrants_vec, intervention_idx


# ── Study filtering ──────────────────────────────────────────────────────────

def filter_studies(df: pd.DataFrame, min_intersections: int) -> pd.DataFrame:
    """Filter to studies that yield clean per-approach training samples.

    Criteria:
      1. 56-slot studies (14-hour coverage).
      2. All 4 approaches must have nonzero vehicle counts somewhere in the
         study (4-leg intersections only — 3-leg T-intersections complicate
         the synthetic-vs-real comparison).
      3. Each intersection (centreline_id) keeps at most its N most recent
         studies, to balance the dataset.

    After filtering, ensures at least ``min_intersections`` distinct
    centreline_ids remain (we need 30 for the 21/4/5 split).
    """
    counts_per_study = df.groupby("count_id").size()
    valid_count_ids = counts_per_study[counts_per_study == TARGET_SLOTS_PER_STUDY].index
    df = df[df["count_id"].isin(valid_count_ids)].copy()
    logging.info("After 56-slot filter: %d rows, %d studies",
                 len(df), df["count_id"].nunique())

    # Drop 3-leg intersections: require nonzero vehicle counts on all 4 approaches.
    def has_all_four_approaches(study_df: pd.DataFrame) -> bool:
        for a in APPROACHES:
            ax_sum = 0
            for cls in VEHICLE_CLASSES:
                for m in MOVEMENTS:
                    ax_sum += study_df[f"{a}_appr_{cls}_{m}"].fillna(0).sum()
            if ax_sum == 0:
                return False
        return True

    keep_ids: list[int] = []
    for cid, study_df in df.groupby("count_id"):
        if has_all_four_approaches(study_df):
            keep_ids.append(cid)
    df = df[df["count_id"].isin(keep_ids)].copy()
    logging.info("After 4-leg filter: %d rows, %d studies, %d intersections",
                 len(df), df["count_id"].nunique(), df["centreline_id"].nunique())

    n_inters = df["centreline_id"].nunique()
    if n_inters < min_intersections:
        raise SystemExit(
            f"Only {n_inters} clean 4-leg intersections after filtering; "
            f"need at least {min_intersections}. Relax filters or use a "
            f"larger time range."
        )
    return df


# ── Sample assembly ──────────────────────────────────────────────────────────

def build_real_dataset(
    df: pd.DataFrame,
    data_seed: int,
    max_studies_per_intersection: int,
) -> list[LabeledRealSample]:
    """Iterate every (count_id, count_date) → one labeled sample."""
    df["start_time"] = pd.to_datetime(df["start_time"])
    df["count_date"] = pd.to_datetime(df["count_date"]).dt.date

    samples: list[LabeledRealSample] = []
    # Build a stable mapping from centreline_id → 0..N-1 group key for the split.
    centreline_to_gid = {
        cid: i for i, cid in enumerate(sorted(df["centreline_id"].unique()))
    }

    for centreline_id, inter_df in df.groupby("centreline_id"):
        # Most-recent studies first; cap per intersection to keep the dataset
        # balanced and avoid one intersection dominating.
        study_count_ids = (
            inter_df.groupby("count_id")["count_date"].first()
            .sort_values(ascending=False)
            .head(max_studies_per_intersection)
            .index
        )
        for count_id in study_count_ids:
            study_df = inter_df[inter_df["count_id"] == count_id].sort_values("start_time")
            count_date = study_df["count_date"].iloc[0]
            is_weekend = count_date.weekday() >= 5

            day_rng = np.random.default_rng(
                np.random.SeedSequence(
                    [data_seed, int(centreline_id), int(count_id), int(is_weekend)]
                ).generate_state(2)
            )
            try:
                flow_matrix, n_observed = build_flow_matrix(study_df)
                meta_vec, warrants_vec, intervention_idx = label_sample(
                    flow_matrix, day_rng,
                )
            except Exception as exc:                                  # noqa: BLE001
                logging.warning("centreline=%s count=%s build failed: %s",
                                centreline_id, count_id, exc)
                continue

            samples.append(LabeledRealSample(
                flow_matrix=flow_matrix.astype(np.float32),
                meta_vector=meta_vec,
                warrants_vec=warrants_vec,
                intervention_idx=intervention_idx,
                intersection_id=centreline_to_gid[centreline_id],
                count_id=int(count_id),
                count_date=str(count_date),
                is_weekend=bool(is_weekend),
                n_observed_slots=n_observed,
            ))
    logging.info("Built %d labeled samples across %d intersections",
                 len(samples), len(centreline_to_gid))
    return samples


# ── Intersection-stratified split + save ─────────────────────────────────────

def split_and_save(
    samples: list[LabeledRealSample],
    n_train_intersections: int,
    n_val_intersections: int,
    n_intersections_total: int,
    split_seed: int,
    output_dir: Path,
) -> dict[str, dict]:
    intersection_id = np.array([s.intersection_id for s in samples], dtype=np.int64)

    n_test = n_intersections_total - n_train_intersections - n_val_intersections
    gss_test = GroupShuffleSplit(
        n_splits=1, test_size=n_test / n_intersections_total, random_state=split_seed,
    )
    train_val_idx, test_idx = next(
        gss_test.split(np.zeros_like(intersection_id), groups=intersection_id)
    )
    train_val_groups = intersection_id[train_val_idx]
    gss_val = GroupShuffleSplit(
        n_splits=1,
        test_size=n_val_intersections / (n_train_intersections + n_val_intersections),
        random_state=split_seed + 1,
    )
    sub_train_idx, sub_val_idx = next(
        gss_val.split(np.zeros_like(train_val_groups), groups=train_val_groups)
    )
    train_idx = train_val_idx[sub_train_idx]
    val_idx = train_val_idx[sub_val_idx]

    splits = {"train": train_idx, "val": val_idx, "test": test_idx}
    summary: dict[str, dict] = {}
    output_dir.mkdir(parents=True, exist_ok=True)
    for split_name, idx in splits.items():
        flow = np.stack([samples[i].flow_matrix for i in idx])
        meta = np.stack([samples[i].meta_vector for i in idx])
        warrants = np.stack([samples[i].warrants_vec for i in idx])
        intervention = np.array([samples[i].intervention_idx for i in idx], dtype=np.int64)
        inter_ids = np.array([samples[i].intersection_id for i in idx], dtype=np.int64)
        count_ids = np.array([samples[i].count_id for i in idx], dtype=np.int64)
        np.savez(
            output_dir / f"{split_name}.npz",
            flow=flow,
            metadata=meta,
            warrants=warrants,
            intervention=intervention,
            intersection_id=inter_ids,
            count_id=count_ids,
            warrant_names=np.array(WARRANT_NAMES_REAL),
            metadata_features=np.array(DEFAULT_METADATA_FEATURES),
            ped_source=np.array(["toronto_real"] * len(idx)),
        )
        summary[split_name] = {
            "n_samples": int(len(idx)),
            "n_intersections": int(len(np.unique(intersection_id[idx]))),
            "intervention_class_counts": {
                INTERVENTION_CLASSES[k]: int((intervention == k).sum())
                for k in range(len(INTERVENTION_CLASSES))
            },
            "warrant_positive_rates": {
                name: float(warrants[:, j].mean())
                for j, name in enumerate(WARRANT_NAMES_REAL)
            },
        }
        logging.info("Wrote %s: %d samples, %d intersections",
                     split_name, summary[split_name]["n_samples"],
                     summary[split_name]["n_intersections"])
    return summary


# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--toronto-csv", type=Path, required=True,
                   help="Path to tmc_raw_data_2020_2029.csv from Toronto Open Data.")
    p.add_argument("--output-dir", type=Path, default=Path("runs/real_data"))
    p.add_argument("--max-studies-per-intersection", type=int, default=8,
                   help="Cap on studies kept per centreline_id (most-recent first).")
    p.add_argument("--n-intersections-total", type=int, default=30,
                   help="Target intersection count (matches synthetic dataset).")
    p.add_argument("--n-train-intersections", type=int, default=21)
    p.add_argument("--n-val-intersections", type=int, default=4)
    p.add_argument("--data-seed", type=int, default=42)
    p.add_argument("--split-seed", type=int, default=42)
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)

    logging.info("Loading Toronto TMC CSV: %s", args.toronto_csv)
    df = pd.read_csv(args.toronto_csv, low_memory=False)
    logging.info("Loaded %d rows, %d columns", len(df), len(df.columns))

    df = filter_studies(df, min_intersections=args.n_intersections_total)

    # Sample down to exactly --n-intersections-total to match the synthetic count.
    keep_centrelines = sorted(df["centreline_id"].unique())[: args.n_intersections_total]
    df = df[df["centreline_id"].isin(keep_centrelines)].copy()
    logging.info("Sampled to %d intersections for the split.", df["centreline_id"].nunique())

    samples = build_real_dataset(
        df,
        data_seed=args.data_seed,
        max_studies_per_intersection=args.max_studies_per_intersection,
    )

    split_summary = split_and_save(
        samples=samples,
        n_train_intersections=args.n_train_intersections,
        n_val_intersections=args.n_val_intersections,
        n_intersections_total=args.n_intersections_total,
        split_seed=args.split_seed,
        output_dir=args.output_dir,
    )

    summary = {
        "source": "toronto_open_data_multimodal_tmc",
        "license": "Open Government Licence - Toronto",
        "n_intersections": int(df["centreline_id"].nunique()),
        "n_samples": len(samples),
        "warrant_names": list(WARRANT_NAMES_REAL),
        "metadata_features": list(DEFAULT_METADATA_FEATURES),
        "ped_source": "toronto_real",
        "study_slot_count": TARGET_SLOTS_PER_STUDY,
        "data_seed": args.data_seed,
        "split_seed": args.split_seed,
        "splits": split_summary,
    }
    summary_path = args.output_dir / "real_data_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    logging.info("Wrote summary: %s", summary_path)


if __name__ == "__main__":
    main()
