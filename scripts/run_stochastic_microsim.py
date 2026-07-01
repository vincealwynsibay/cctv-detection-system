"""CLI: run the Monte Carlo stochastic microsim for one intersection window.

Produces `runs/stochastic/{intersection_id}_{window}.json`, the artifact
referenced by the methods chapter and the panel defense guide.

The script does three things in sequence:

  1. Resolve per-approach flows + signal programs for the chosen window.
     Flows come from the production aggregation pipeline; signal programs
     mirror what `server.simulation.compute_simulation_for_window` would
     use (existing timing vs. Webster's proposed timing).
  2. Run `monte_carlo_compare` with paired before/after seeds. Outputs
     per-approach DelayStatistics and a global vehicle-hours-saved CI.
  3. Run the analytical sim on the same window for cross-validation; the
     resulting point estimates land in the JSON next to the stochastic
     CIs so the methods-chapter narrative can point at one file.

Two input modes:

  * `--db` (default): pulls flows from the live database.
  * `--counts-json FILE`: reads a `{approach_id: pcu_hr}` JSON file plus
    a `--signal-config FILE` describing before/after signal programs.
    Useful for offline replays and CI-friendly examples.

The JSON output schema is documented in `docs/STOCHASTIC_MICROSIM_PLAN.md`
under "CLI output format". Do not change the field names without updating
the methods chapter at the same time.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Make `server.*` importable when the script runs from the repo root.
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from server.stochastic_simulation import (  # noqa: E402
    DEFAULT_DRIVER_REACTION_SD_SEC,
    DEFAULT_N_RUNS,
    DEFAULT_SAT_FLOW_PCU_HR,
    SignalProgram,
    monte_carlo_compare,
)


# ── Argument parsing ───────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Monte Carlo stochastic microsim for one intersection window.",
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--intersection-id", type=int,
        help="Pull flows + signal programs from the live DB for this intersection.",
    )
    src.add_argument(
        "--counts-json", type=Path,
        help="Offline mode: read flows from a JSON file (see README in docs).",
    )

    p.add_argument(
        "--signal-config", type=Path,
        help="Required in --counts-json mode: JSON with `before` and `after` SignalProgram fields.",
    )
    p.add_argument(
        "--start", type=str,
        help="ISO timestamp for window start (DB mode).",
    )
    p.add_argument(
        "--end", type=str,
        help="ISO timestamp for window end (DB mode).",
    )
    p.add_argument("--n-runs",      type=int,   default=DEFAULT_N_RUNS)
    p.add_argument("--sat-flow",    type=float, default=DEFAULT_SAT_FLOW_PCU_HR)
    p.add_argument("--reaction-sd", type=float, default=DEFAULT_DRIVER_REACTION_SD_SEC)
    p.add_argument("--base-seed",   type=int,   default=42)
    p.add_argument(
        "--output", type=Path, default=None,
        help="Override default output path (runs/stochastic/{id}_{window}.json).",
    )
    return p.parse_args()


# ── Input resolution ───────────────────────────────────────────────────────

def _load_from_json(
    counts_path: Path,
    config_path: Path,
) -> tuple[dict[int, float], SignalProgram, SignalProgram, dict]:
    """Offline mode: counts + signal config from JSON files."""
    counts_raw = json.loads(counts_path.read_text())
    config_raw = json.loads(config_path.read_text())
    flows = {int(k): float(v) for k, v in counts_raw.items()}
    before = _program_from_dict(config_raw["before"])
    after  = _program_from_dict(config_raw["after"])
    return flows, before, after, {
        "intersection_id": config_raw.get("intersection_id"),
        "window":          config_raw.get("window", {}),
        "approach_labels": config_raw.get("approach_labels", {}),
    }


def _program_from_dict(d: dict) -> SignalProgram:
    return SignalProgram(
        cycle_length_s=int(d["cycle_length_s"]),
        green_seconds={int(k): float(v) for k, v in d["green_seconds"].items()},
        phase_offsets={int(k): int(v)   for k, v in d["phase_offsets"].items()},
        lost_time_per_phase=float(d.get("lost_time_per_phase", 4.0)),
        all_red_clearance=float(d.get("all_red_clearance",  3.0)),
    )


def _load_from_db(
    intersection_id: int,
    start: datetime,
    end: datetime,
) -> tuple[dict[int, float], SignalProgram, SignalProgram, dict, dict]:
    """Live-DB mode: derive flows + programs the same way the production
    analytical sim does, so the cross-validation compares apples to apples.

    Returns (flows, before_program, after_program, metadata, analytical_result).
    The analytical result is the point estimate from
    `compute_simulation_for_window`, packaged for inclusion in the JSON
    so the methods chapter has it inline with the MC CIs.
    """
    from common.database  import SessionLocal
    from common.models    import Intersection
    from server.pce       import resolve_pce
    from server.simulation import (
        _phase_offsets,
        compute_simulation_for_window,
    )
    from server.webster import (
        compute_timing,
        effective_saturation_flow,
        get_street_directions,
        group_phases,
        pcu_flow_for_window,
    )

    with SessionLocal() as db:
        intersection = db.query(Intersection).filter(
            Intersection.id == intersection_id,
        ).first()
        if intersection is None:
            raise SystemExit(f"intersection_id={intersection_id} not found")

        pce_map    = resolve_pce(db, intersection.id)
        flows      = pcu_flow_for_window(db, intersection.id, start, end, pce_map)
        directions = get_street_directions(db, intersection.id)

        if not flows:
            raise SystemExit("no flows in window; check times")

        n          = len(flows)
        lost_time  = intersection.lost_time_per_phase or 4
        all_red    = intersection.all_red_clearance   or 3
        min_c      = intersection.min_cycle_length    or 40
        max_c      = intersection.max_cycle_length    or 120
        crossing_w = getattr(intersection, "crossing_width_m", 12.0) or 12.0
        sat_flow   = effective_saturation_flow(intersection)

        phases = group_phases(flows, directions)
        proposed_C, proposed_splits = compute_timing(
            flows, phases, lost_time, all_red, min_c, max_c, crossing_w, sat_flow,
        )
        after_offsets = _phase_offsets(phases, proposed_splits, lost_time, all_red)
        after_program = SignalProgram(
            cycle_length_s=proposed_C,
            green_seconds={sid: float(g) for sid, g in proposed_splits.items()},
            phase_offsets={sid: int(off) for sid, off in after_offsets.items()},
            lost_time_per_phase=float(lost_time),
            all_red_clearance=float(all_red),
        )

        status = intersection.signal_status or "unsignalized"
        if status in ("fixed_time", "actuated"):
            exist_C    = intersection.existing_cycle_length or proposed_C
            raw_splits = intersection.existing_green_splits or {}
            exist_splits = (
                {int(k): float(v) for k, v in raw_splits.items()}
                if raw_splits
                else {sid: exist_C / n for sid in flows}
            )
        else:
            # Unsignalized intersections aren't in V1 scope; fall back to
            # proposed timing so the CLI still produces a usable output.
            print(
                "[warn] intersection is unsignalized; using proposed timing for both "
                "before and after. monte_carlo_compare will report ≈0 vh_saved.",
                file=sys.stderr,
            )
            exist_C = proposed_C
            exist_splits = {sid: float(g) for sid, g in proposed_splits.items()}

        before_offsets = _phase_offsets(phases, exist_splits, lost_time, all_red)
        before_program = SignalProgram(
            cycle_length_s=int(exist_C),
            green_seconds={sid: float(g) for sid, g in exist_splits.items()},
            phase_offsets={sid: int(off) for sid, off in before_offsets.items()},
            lost_time_per_phase=float(lost_time),
            all_red_clearance=float(all_red),
        )

        analytical = compute_simulation_for_window(db, intersection, start, end)

        approach_labels = {sid: directions.get(sid, "") for sid in flows}
        meta = {
            "intersection_id": intersection.id,
            "intersection_name": intersection.name,
            "signal_status":   status,
            "saturation_flow_pcu_hr": sat_flow,
            "approach_labels": approach_labels,
        }
        return ({int(sid): float(q) for sid, q in flows.items()},
                before_program, after_program, meta, analytical)


# ── Main ───────────────────────────────────────────────────────────────────

def main() -> None:
    args = _parse_args()

    analytical_reference: dict | None = None

    if args.intersection_id is not None:
        if not args.start or not args.end:
            raise SystemExit("--start and --end are required in DB mode")
        start = datetime.fromisoformat(args.start)
        end   = datetime.fromisoformat(args.end)
        flows, before, after, meta, analytical_reference = _load_from_db(
            args.intersection_id, start, end,
        )
        window_meta = {
            "start_iso":    args.start,
            "end_iso":      args.end,
            "duration_sec": int((end - start).total_seconds()),
        }
        window_tag = f"{args.intersection_id}_{start.strftime('%Y%m%dT%H%M')}"
    else:
        if args.signal_config is None:
            raise SystemExit("--signal-config is required with --counts-json")
        flows, before, after, meta = _load_from_json(args.counts_json, args.signal_config)
        window_meta = meta.get("window", {})
        window_tag = f"{meta.get('intersection_id', 'offline')}_offline"

    duration_sec = int(window_meta.get("duration_sec") or 3600)

    print(f"[info] flows: {flows}", file=sys.stderr)
    print(f"[info] running monte_carlo_compare n_runs={args.n_runs} dur={duration_sec}", file=sys.stderr)
    result = monte_carlo_compare(
        q_pcu_hr_per_approach=flows,
        before_program=before,
        after_program=after,
        n_runs=args.n_runs,
        duration_sec=duration_sec,
        sat_flow_pcu_hr=args.sat_flow,
        driver_reaction_sd_sec=args.reaction_sd,
        base_seed=args.base_seed,
    )

    per_approach_out: dict[str, dict] = {}
    approach_labels: dict = meta.get("approach_labels", {})
    for approach_id, ba in result.per_approach.items():
        per_approach_out[str(approach_id)] = {
            "approach_label": approach_labels.get(approach_id) or approach_labels.get(str(approach_id), ""),
            "flow_pcu_hr":    round(flows[approach_id], 2),
            "before":         ba.before.to_dict(),
            "after":          ba.after.to_dict(),
        }

    output_doc: dict = {
        "intersection_id":   meta.get("intersection_id"),
        "intersection_name": meta.get("intersection_name", ""),
        "signal_status":     meta.get("signal_status", ""),
        "window":            window_meta,
        "config": {
            "n_runs":                 args.n_runs,
            "sat_flow_pcu_hr":        args.sat_flow,
            "driver_reaction_sd_sec": args.reaction_sd,
            "base_seed":              args.base_seed,
        },
        "per_approach": per_approach_out,
        "vehicle_hours_saved": result.vehicle_hours_saved.to_dict(),
    }
    if analytical_reference is not None and analytical_reference.get("has_data"):
        output_doc["analytical_reference"] = {
            "delay_before":        analytical_reference["delay_before"],
            "delay_after":         analytical_reference["delay_after"],
            "vehicle_hours_saved": analytical_reference["vh_saved"],
            "note": (
                "From server.simulation.compute_simulation_for_window, the "
                "production analytical sim. Used for cross-validation; see "
                "docs/PANEL_DEFENSE_GUIDE.md Part 7.5."
            ),
        }

    output_path: Path = args.output or (
        REPO_ROOT / "runs" / "stochastic" / f"{window_tag}.json"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output_doc, indent=2, default=str))
    print(f"[ok] wrote {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
