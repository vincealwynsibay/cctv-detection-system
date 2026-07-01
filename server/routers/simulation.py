from datetime import datetime, timezone
from typing import Annotated, Optional
import hashlib
import json
import logging
import math
import os

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from common import models
from common.database import get_db
from server.utils import get_current_user
from server.simulation import delay_to_los

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/simulation", tags=["Simulation"])


# ── Stochastic confidence (Monte Carlo) ────────────────────────────────────
#
# Single-process Redis client for caching MC results. The MC itself takes
# ~10s for 100 runs × 4 approaches, which is too slow to recompute on every
# page view; the cache TTL of 1 hour matches the analytical sim's freshness
# expectations. If REDIS_URL is unset (local dev), we fall back to an
# in-process dict, capped at 64 entries to bound memory.

_REDIS_URL = os.getenv("REDIS_URL", "")
_stoch_redis = None
_stoch_memcache: dict[str, str] = {}

if _REDIS_URL:
    try:
        import redis as _redis_lib
        _stoch_redis = _redis_lib.from_url(_REDIS_URL)
    except Exception as exc:  # pragma: no cover - import/config guard
        logger.warning("stochastic confidence: redis disabled (%s)", exc)
        _stoch_redis = None


def _stoch_cache_get(key: str) -> dict | None:
    raw: str | None = None
    if _stoch_redis is not None:
        try:
            raw_b = _stoch_redis.get(key)
            raw = raw_b.decode("utf-8") if raw_b is not None else None
        except Exception:  # pragma: no cover - network guard
            raw = None
    else:
        raw = _stoch_memcache.get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _stoch_cache_set(key: str, value: dict, ttl_sec: int = 3600) -> None:
    payload = json.dumps(value)
    if _stoch_redis is not None:
        try:
            _stoch_redis.setex(key, ttl_sec, payload)
            return
        except Exception:  # pragma: no cover - network guard
            pass
    # Memcache fallback. Trim oldest if at capacity.
    if len(_stoch_memcache) >= 64:
        _stoch_memcache.pop(next(iter(_stoch_memcache)))
    _stoch_memcache[key] = payload


def _confidence_label(mean: float, ci_low: float, ci_high: float) -> tuple[str, str]:
    """Map a vehicle-hours-saved CI to an operator-facing label.

    Returns (label, plain_sentence). The label drives the badge color in
    the UI; the sentence is what the operator reads next to it.

    Rules (intentionally simple, decision-grade not statistics):

      * marginal: CI crosses zero, or mean savings under 0.5 vh/hr
                  (the proposed timing doesn't reliably help)
      * moderate: CI excludes zero but the lower bound is < 40% of the mean
                  (real savings, but a wide spread, monitor after deploy)
      * high:     CI excludes zero and lower bound >= 40% of mean AND mean >= 2 vh/hr
                  (savings are real and tight enough to act on confidently)
    """
    if mean < 0.5 or ci_low <= 0.0:
        return (
            "marginal",
            "Savings are not statistically distinguishable from zero across "
            "100 simulated hours. Recommend monitoring before re-timing.",
        )
    ratio = ci_low / mean if mean > 0 else 0.0
    if ratio >= 0.4 and mean >= 2.0:
        return (
            "high",
            f"Across 100 simulated hours, savings landed between "
            f"{ci_low:.1f} and {ci_high:.1f} vehicle-hours. The recommendation "
            f"is a confident improvement.",
        )
    return (
        "moderate",
        f"Across 100 simulated hours, savings landed between "
        f"{ci_low:.1f} and {ci_high:.1f} vehicle-hours. Real improvement, "
        f"but variable. Monitor after deployment.",
    )


class SimulationChunkResponse(BaseModel):
    chunk_name: str
    delay_before: float
    delay_after: float
    los_before: str
    los_after: str
    vc_ratio_before: Optional[float] = None
    vc_ratio_after: Optional[float] = None
    volume_pcu_hr: float
    vehicle_hours_saved: float
    queue_series_before: Optional[dict] = None
    queue_series_after: Optional[dict] = None
    generated_at: str

    model_config = ConfigDict(from_attributes=True)


class DailySummaryResponse(BaseModel):
    total_vehicle_hours_saved: float
    avg_delay_before: float
    avg_delay_after: float
    los_before: str
    los_after: str
    total_volume_pcu_hr: float


class SimulationResponse(BaseModel):
    intersection_id: int
    intersection_name: str
    signal_status: str
    baseline_note: str = ""
    existing_cycle_s: Optional[int] = None
    chunks: list[SimulationChunkResponse]
    daily_summary: DailySummaryResponse


class ComputeRequest(BaseModel):
    intersection_id: int
    start: datetime
    end: datetime


class HistoricalSimChunk(BaseModel):
    chunk_name: str
    delay_before: float
    delay_after: float
    los_before: str
    los_after: str
    vc_ratio_before: Optional[float] = None
    vc_ratio_after: Optional[float] = None
    volume_pcu_hr: float
    vehicle_hours_saved: float
    queue_series_before: Optional[dict] = None
    queue_series_after: Optional[dict] = None
    arrivals_per_second: Optional[dict] = None
    generated_at: str
    measured_flows: Optional[dict] = None
    proposed_cycle_s: Optional[int] = None
    proposed_splits: Optional[dict] = None


class HistoricalSimResponse(BaseModel):
    intersection_id: int
    intersection_name: str
    signal_status: str
    baseline_note: str
    existing_cycle_s: Optional[int] = None
    chunks: list[HistoricalSimChunk]
    daily_summary: DailySummaryResponse
    window_start: str
    window_end: str


@router.post("/compute", response_model=HistoricalSimResponse)
def compute_historical_simulation(
    body: ComputeRequest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Compute on-demand before/after simulation for an explicit datetime window."""
    from server.simulation import compute_simulation_for_window

    intersection = db.get(models.Intersection, body.intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    if body.end <= body.start:
        raise HTTPException(status_code=422, detail="end must be after start")

    # Wrap the compute so any unhandled exception inside the windowed sim
    # surfaces as a 500 *with the actual error message* instead of the
    # generic "Internal Server Error" string FastAPI returns by default.
    # The replay strip in the UI shows this detail to the operator, so a
    # clear message saves a server-log roundtrip when something blows up.
    try:
        result = compute_simulation_for_window(db, intersection, body.start, body.end)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "compute_simulation_for_window failed (intersection=%s window=%s..%s)",
            body.intersection_id, body.start.isoformat(), body.end.isoformat(),
        )
        raise HTTPException(
            status_code=500,
            detail=f"Window simulation failed: {type(exc).__name__}: {exc}",
        ) from exc

    if not result["has_data"]:
        raise HTTPException(
            status_code=404,
            detail=f"No detection data found for {body.start.strftime('%Y-%m-%d %H:%M')} – {body.end.strftime('%H:%M')}",
        )

    status = intersection.signal_status or "unsignalized"
    before_signalized = status in ("fixed_time", "actuated")
    n_arms = len(result["flows"])

    chunk = HistoricalSimChunk(
        chunk_name=result["chunk_label"],
        delay_before=result["delay_before"],
        delay_after=result["delay_after"],
        los_before=delay_to_los(result["delay_before"], signalized=before_signalized),
        los_after=delay_to_los(result["delay_after"], signalized=True),
        vc_ratio_before=result["vc_before"],
        vc_ratio_after=result["vc_after"],
        volume_pcu_hr=result["total_flow"],
        vehicle_hours_saved=result["vh_saved"],
        queue_series_before=result["q_series_before"],
        queue_series_after=result["q_series_after"],
        arrivals_per_second=result.get("vehicle_arrivals_per_second"),
        generated_at=datetime.now(tz=timezone.utc).isoformat(),
        measured_flows=result["flows"],
        proposed_cycle_s=result["proposed_C"],
        proposed_splits=result["proposed_splits"],
    )

    baseline_note = (
        f"Real-data window · {body.start.strftime('%b %d %Y %H:%M')} – {body.end.strftime('%H:%M')} · "
        f"{result['total_flow']:.0f} PCU/hr across {n_arms} arm(s) · Webster's formula applied"
    )

    return HistoricalSimResponse(
        intersection_id=body.intersection_id,
        intersection_name=intersection.name,
        signal_status=status,
        baseline_note=baseline_note,
        existing_cycle_s=intersection.existing_cycle_length,
        chunks=[chunk],
        daily_summary=DailySummaryResponse(
            total_vehicle_hours_saved=round(result["vh_saved"], 2),
            avg_delay_before=round(result["delay_before"], 2),
            avg_delay_after=round(result["delay_after"], 2),
            los_before=delay_to_los(result["delay_before"], signalized=before_signalized),
            los_after=delay_to_los(result["delay_after"], signalized=True),
            total_volume_pcu_hr=round(result["total_flow"], 2),
        ),
        window_start=body.start.isoformat(),
        window_end=body.end.isoformat(),
    )


@router.get("/{intersection_id}", response_model=SimulationResponse)
def get_simulation(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Return the latest simulation results for an intersection."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    latest_rec = db.execute(text("""
        SELECT id FROM recommendations
         WHERE intersection_id = :iid
         ORDER BY generated_at DESC
         LIMIT 1
    """), {"iid": intersection_id}).fetchone()

    if not latest_rec:
        raise HTTPException(status_code=404, detail="No recommendations found for this intersection")

    rows = (
        db.query(models.SimulationResult)
        .filter_by(recommendation_id=latest_rec.id)
        .order_by(models.SimulationResult.chunk_name)
        .all()
    )

    if not rows:
        # The recommendation may have intentionally skipped simulation
        # (not-warranted unsignalized intersection, or signalized with no
        # Webster improvement). In that case the notes field carries the
        # real reason - surface it instead of telling the user to "run
        # generate first" when they just did.
        rec_note = db.execute(
            text("SELECT notes FROM recommendations WHERE id = :id"),
            {"id": latest_rec.id},
        ).scalar()
        if rec_note:
            raise HTTPException(status_code=404, detail=rec_note)
        raise HTTPException(status_code=404, detail="No simulation results found - run generate first")

    status = intersection.signal_status or "unsignalized"
    before_signalized = status in ("fixed_time", "actuated")
    chunks = [
        SimulationChunkResponse(
            chunk_name=r.chunk_name,
            delay_before=r.delay_before,
            delay_after=r.delay_after,
            los_before=delay_to_los(r.delay_before, signalized=before_signalized),
            los_after=delay_to_los(r.delay_after, signalized=True),
            vc_ratio_before=r.vc_ratio_before,
            vc_ratio_after=r.vc_ratio_after,
            volume_pcu_hr=r.volume_pcu_hr,
            vehicle_hours_saved=r.vehicle_hours_saved,
            queue_series_before=r.queue_series_before,
            queue_series_after=r.queue_series_after,
            generated_at=r.generated_at.isoformat(),
        )
        for r in rows
    ]

    total_vh_saved = sum(c.vehicle_hours_saved for c in chunks)
    total_vol = sum(c.volume_pcu_hr for c in chunks)
    n = len(chunks)
    avg_before = sum(c.delay_before for c in chunks) / n if n else 0.0
    avg_after  = sum(c.delay_after  for c in chunks) / n if n else 0.0

    existing_cycle = intersection.existing_cycle_length
    existing_splits = intersection.existing_green_splits

    if status == "unsignalized":
        baseline_note = (
            "Before-state: HCM gap-acceptance (TWSC) - "
            "no signal present; minor approaches yield to major-street gaps"
        )
    elif status == "fixed_time":
        if existing_cycle and existing_splits:
            baseline_note = (
                f"Before-state: Fixed-time signal, {existing_cycle}s cycle · "
                f"{len(existing_splits)}-approach splits (observed or configured)"
            )
        elif existing_cycle:
            baseline_note = (
                f"Before-state: Fixed-time signal, {existing_cycle}s cycle · "
                "equal splits assumed (no per-approach data)"
            )
        else:
            baseline_note = (
                "Before-state: Fixed-time signal · "
                "cycle length and splits assumed (not configured)"
            )
    elif status == "actuated":
        baseline_note = (
            "Before-state: Actuated signal · "
            "delay estimated from average phase utilization"
        )
    else:
        baseline_note = f"Before-state: {status.replace('_', ' ')} signal"

    return SimulationResponse(
        intersection_id=intersection_id,
        intersection_name=intersection.name,
        signal_status=status,
        baseline_note=baseline_note,
        existing_cycle_s=existing_cycle,
        chunks=chunks,
        daily_summary=DailySummaryResponse(
            total_vehicle_hours_saved=round(total_vh_saved, 2),
            avg_delay_before=round(avg_before, 2),
            avg_delay_after=round(avg_after, 2),
            los_before=delay_to_los(avg_before, signalized=before_signalized),
            los_after=delay_to_los(avg_after, signalized=True),
            total_volume_pcu_hr=round(total_vol, 2),
        ),
    )


# ── Stochastic confidence endpoint ─────────────────────────────────────────

class _StatBlock(BaseModel):
    mean: float
    std: float
    ci_low_95: float
    ci_high_95: float
    n_runs: int


class _ApproachStats(BaseModel):
    """Per-approach delay distribution from the Monte Carlo runs.

    Surfaced so the UI can render a per-leg breakdown next to the
    intersection-wide vehicle-hours-saved figure, so the operator sees
    which approach the savings actually come from.
    """
    approach_id:    int
    label:          str          # plain-English label, e.g. "NB - Apokon Road"
    flow_pcu_hr:    float
    before:         _StatBlock   # delay per vehicle (s) under existing timing
    after:          _StatBlock   # delay per vehicle (s) under proposed timing


class _SampleReplay(BaseModel):
    """One concrete replay (Poisson sample) captured for visual playback.

    Exposed so the frontend's "Play 5 stochastic replays" mode can feed
    each run's per-second arrival schedule into the side-by-side canvas,
    snapping between replays with a counter overlay. Only the first
    `n_sample_replays` runs are captured; the rest live as aggregate stats.
    """
    run_index:    int
    vh_saved:     float
    # Per-approach per-second arrival counts, keyed by approach_id as str
    # (so the JSON shape matches SimulationChunk.arrivals_per_second).
    arrivals_per_second: dict[str, list[float]]


class StochasticConfidenceResponse(BaseModel):
    intersection_id: int
    chunk_name: str
    duration_sec: int
    n_runs: int
    label: str                       # "high" | "moderate" | "marginal"
    sentence: str                    # plain-English summary for the operator
    vehicle_hours_saved: _StatBlock  # peak-chunk mean + CI
    per_run_means: list[float]       # raw distribution (for the panel histogram)
    per_approach: list[_ApproachStats]
    sample_replays: list[_SampleReplay]
    analytical_reference_vh: float   # Webster's point estimate over the same window
    cached: bool                     # so the UI can tell first-load from re-render


def _compute_chunk_mc(
    db: Session,
    intersection: models.Intersection,
    rec_id: int,
    chunk_name: str,
    peak_row: models.SimulationResult,
) -> dict:
    """Compute the Monte Carlo payload for one TOD chunk, with Redis cache.

    Pulled out of the endpoint so the "all day" aggregator can fan out to
    every chunk without duplicating ~150 lines. Returns the payload dict
    matching the StochasticConfidenceResponse shape. Raises HTTPException
    on missing TodChunk/flow data so callers can let it surface untouched.
    """
    from server.simulation import _phase_offsets
    from server.stochastic_simulation import (
        DEFAULT_N_RUNS,
        DEFAULT_DURATION_SEC,
        SignalProgram,
        _draw_arrivals,
        _per_run_rng,
        monte_carlo_compare,
        simulate_one_run,
    )
    from server.webster import (
        compute_timing,
        effective_saturation_flow,
        get_street_directions,
        group_phases,
        pcu_flow_per_street,
    )
    from server.pce import resolve_pce

    intersection_id = intersection.id
    cache_key = f"stoch_conf:v2:{intersection_id}:{rec_id}:{chunk_name}"
    cached = _stoch_cache_get(cache_key)
    if cached is not None:
        cached["cached"] = True
        return cached

    # Resolve the actual TodChunk row + flows for the peak chunk.
    chunk = (
        db.query(models.TodChunk)
        .filter_by(intersection_id=intersection_id, name=chunk_name)
        .first()
    )
    if chunk is None:
        raise HTTPException(status_code=404, detail=f"TOD chunk '{chunk_name}' missing")

    pce_map = resolve_pce(db, intersection_id)
    flows   = pcu_flow_per_street(db, intersection_id, chunk, pce_map)
    if not flows:
        raise HTTPException(status_code=404, detail="No flow data for peak chunk")

    directions = get_street_directions(db, intersection_id)
    n_arms     = len(flows)
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
        green_seconds={int(sid): float(g)  for sid, g  in proposed_splits.items()},
        phase_offsets={int(sid): int(off)  for sid, off in after_offsets.items()},
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
            else {int(sid): exist_C / n_arms for sid in flows}
        )
    else:
        # Unsignalized: out of V1 scope for the stochastic sim. Fall back to
        # proposed timing for both arms so the comparison reports ~0 saved
        # and the UI label correctly reads "marginal".
        exist_C = proposed_C
        exist_splits = {int(sid): float(g) for sid, g in proposed_splits.items()}

    before_offsets = _phase_offsets(phases, exist_splits, lost_time, all_red)
    before_program = SignalProgram(
        cycle_length_s=int(exist_C),
        green_seconds={int(sid): float(g)  for sid, g  in exist_splits.items()},
        phase_offsets={int(sid): int(off)  for sid, off in before_offsets.items()},
        lost_time_per_phase=float(lost_time),
        all_red_clearance=float(all_red),
    )

    flows_int = {int(sid): float(q) for sid, q in flows.items()}
    mc = monte_carlo_compare(
        q_pcu_hr_per_approach=flows_int,
        before_program=before_program,
        after_program=after_program,
        n_runs=DEFAULT_N_RUNS,
        duration_sec=DEFAULT_DURATION_SEC,
        sat_flow_pcu_hr=sat_flow,
    )
    vh = mc.vehicle_hours_saved

    # Normalise the analytical reference to the same time window as the MC.
    # The peak SimulationResult row's vehicle_hours_saved is already scaled by
    # the chunk's full duration (e.g. AM Rush ≈ 3 hours); the MC simulates one
    # hour. Dividing by chunk_hours puts both numbers on the same per-hour
    # basis, which is what the consensus bar visualises against.
    chunk_minutes = max(1, chunk.end_minutes - chunk.start_minutes)
    chunk_hours   = chunk_minutes / 60.0
    analytical_per_hour = float(peak_row.vehicle_hours_saved) / chunk_hours

    label, sentence = _confidence_label(vh.mean, vh.ci_low_95, vh.ci_high_95)

    # Build per-approach rows. Plain-language label = "<arm> - <street name>"
    # so the UI can render the table without having to re-join against the
    # streets list.
    street_meta = {
        row.id: (row.name, getattr(row, "arm_direction", None))
        for row in (
            db.query(models.Street)
            .filter_by(intersection_id=intersection_id)
            .all()
        )
    }
    arm_short = {
        "northbound": "NB", "southbound": "SB",
        "eastbound":  "EB", "westbound":  "WB",
    }
    per_approach_payload = []
    for approach_id, ba in mc.per_approach.items():
        name, direction = street_meta.get(approach_id, (f"Approach {approach_id}", None))
        short = arm_short.get(direction or "", "?")
        # Avoid "NB - NB - Apokon Road" when the street name already starts
        # with the arm prefix (some intersections store the direction inline
        # in the street name).
        prefix_dupe = (
            direction is not None
            and (
                name.upper().startswith(f"{short} -")
                or name.upper().startswith(f"{short}-")
                or name.upper().startswith(f"{short} ")
            )
        )
        if direction and not prefix_dupe:
            label_str = f"{short} - {name}"
        else:
            label_str = name
        per_approach_payload.append({
            "approach_id": approach_id,
            "label":       label_str,
            "flow_pcu_hr": round(float(flows_int[approach_id]), 2),
            "before": {
                "mean":       round(ba.before.mean,       4),
                "std":        round(ba.before.std,        4),
                "ci_low_95":  round(ba.before.ci_low_95,  4),
                "ci_high_95": round(ba.before.ci_high_95, 4),
                "n_runs":     ba.before.n_runs,
            },
            "after": {
                "mean":       round(ba.after.mean,       4),
                "std":        round(ba.after.std,        4),
                "ci_low_95":  round(ba.after.ci_low_95,  4),
                "ci_high_95": round(ba.after.ci_high_95, 4),
                "n_runs":     ba.after.n_runs,
            },
        })
    # Sort biggest-improvement-first so the most impactful approach reads at
    # the top of the table.
    per_approach_payload.sort(
        key=lambda r: r["before"]["mean"] - r["after"]["mean"], reverse=True,
    )

    # Capture the first N sample replays so the UI can play them visually.
    # Uses the same SeedSequence the comparison used, so each `run_index`
    # here produces bit-for-bit the same arrival sequence the aggregate
    # stats above were computed from. We re-run the "after" simulation
    # only since the playback only ever shows the post-recommendation
    # outcome on these sample replays. Save a per-second bucketed
    # histogram of arrivals so the canvas's existing arrival-driven
    # spawning loop can consume it without changes.
    N_SAMPLE_REPLAYS = 5
    sample_replays_payload: list[dict] = []
    duration_int = int(DEFAULT_DURATION_SEC)
    for run_index in range(min(N_SAMPLE_REPLAYS, DEFAULT_N_RUNS)):
        arrival_rng = _per_run_rng(42, run_index, stream=0)
        reaction_rng = _per_run_rng(42, run_index, stream=2)
        arrivals = _draw_arrivals(flows_int, DEFAULT_DURATION_SEC, arrival_rng)
        sim_result = simulate_one_run(
            arrivals_per_approach=arrivals,
            signal_program=after_program,
            sat_flow_pcu_hr=sat_flow,
            duration_sec=DEFAULT_DURATION_SEC,
            rng=reaction_rng,
        )
        # Convert continuous arrival times into per-second buckets, keyed
        # by approach_id as str (to match SimulationChunk.arrivals_per_second).
        bucketed: dict[str, list[float]] = {}
        for approach_id, times in arrivals.items():
            buckets = [0.0] * duration_int
            for t in times:
                idx = int(t)
                if 0 <= idx < duration_int:
                    buckets[idx] += 1.0
            bucketed[str(approach_id)] = buckets
        run_vh_saved = vh.per_run_means[run_index] if run_index < len(vh.per_run_means) else 0.0
        sample_replays_payload.append({
            "run_index":  run_index,
            "vh_saved":   round(float(run_vh_saved), 4),
            "arrivals_per_second": bucketed,
        })
        # Defensive: log if simulate_one_run produced no result rows.
        if not sim_result:
            logger.warning("sample replay %d empty", run_index)

    payload = {
        "intersection_id":          intersection_id,
        "chunk_name":               chunk_name,
        "duration_sec":             DEFAULT_DURATION_SEC,
        "n_runs":                   vh.n_runs,
        "label":                    label,
        "sentence":                 sentence,
        "vehicle_hours_saved": {
            "mean":       round(vh.mean,       4),
            "std":        round(vh.std,        4),
            "ci_low_95":  round(vh.ci_low_95,  4),
            "ci_high_95": round(vh.ci_high_95, 4),
            "n_runs":     vh.n_runs,
        },
        "per_run_means":            [round(v, 4) for v in vh.per_run_means],
        "per_approach":             per_approach_payload,
        "sample_replays":           sample_replays_payload,
        "analytical_reference_vh":  round(analytical_per_hour, 4),
        "cached":                   False,
    }
    _stoch_cache_set(cache_key, payload)
    return payload


def _aggregate_all_day(
    db: Session,
    intersection_id: int,
    per_chunk_payloads: list[dict],
) -> dict:
    """Aggregate per-chunk MC payloads into one "All day" payload.

    The per-chunk MC simulates one hour with the chunk's average flow rate.
    To project a per-chunk vh-saved (per hour) to an all-day total, multiply
    by the chunk's duration in hours. The same multiplication is applied
    per Monte Carlo run, so the 95% CI on all-day vh-saved is derived
    cleanly from the t-interval over the aggregated per-run sums.

    Per-approach delays are blended as a vehicle-weighted average across
    chunks (chunk_hours * flow_pcu_hr). Sample replays are taken verbatim
    from the chunk with the highest mean savings, since those are the most
    visually impactful for the panel demo and the "all day" view does not
    have a single arrival sequence of its own.
    """
    import numpy as np
    from scipy import stats

    if not per_chunk_payloads:
        raise HTTPException(status_code=404, detail="No chunks to aggregate")

    # Map chunk_name to duration in hours.
    chunks = {
        c.name: max(1, c.end_minutes - c.start_minutes) / 60.0
        for c in db.query(models.TodChunk).filter_by(intersection_id=intersection_id).all()
    }

    hours_for_chunk: list[float] = []
    for p in per_chunk_payloads:
        hours_for_chunk.append(chunks.get(p["chunk_name"], 1.0))

    # Aggregate vehicle-hours saved per run by linear combination across chunks.
    n_runs = max((p["n_runs"] for p in per_chunk_payloads), default=0)
    all_day_per_run: list[float] = []
    for r in range(n_runs):
        total = 0.0
        for p, h in zip(per_chunk_payloads, hours_for_chunk):
            prm = p.get("per_run_means") or []
            if r < len(prm):
                total += float(prm[r]) * h
        all_day_per_run.append(round(total, 4))

    arr = np.asarray(all_day_per_run, dtype=float) if all_day_per_run else np.zeros(1)
    mean = float(np.mean(arr))
    std  = float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0
    if std > 0 and len(arr) > 1:
        sem = std / math.sqrt(len(arr))
        lo, hi = stats.t.interval(0.95, df=len(arr) - 1, loc=mean, scale=sem)
        ci_low, ci_high = float(lo), float(hi)
    else:
        ci_low, ci_high = mean, mean

    label, sentence = _confidence_label(mean, ci_low, ci_high)

    # Per-approach: blend means weighted by vehicles per chunk per approach.
    # vehicles_in_chunk_for_approach = flow_pcu_hr * chunk_hours
    by_approach: dict[int, dict] = {}
    for p, h in zip(per_chunk_payloads, hours_for_chunk):
        for row in p.get("per_approach", []):
            aid = row["approach_id"]
            slot = by_approach.setdefault(aid, {
                "approach_id":   aid,
                "label":         row["label"],
                "flow_total":    0.0,
                "vehicles":      0.0,
                "before_num":    0.0,
                "after_num":     0.0,
                "before_ci_lo":  0.0,
                "before_ci_hi":  0.0,
                "after_ci_lo":   0.0,
                "after_ci_hi":   0.0,
                "n_runs":        row["before"]["n_runs"],
            })
            vehicles = float(row["flow_pcu_hr"]) * h
            slot["flow_total"]   += float(row["flow_pcu_hr"]) * h  # vehicle-hours by approach
            slot["vehicles"]     += vehicles
            slot["before_num"]   += float(row["before"]["mean"]) * vehicles
            slot["after_num"]    += float(row["after"]["mean"])  * vehicles
            slot["before_ci_lo"] += float(row["before"]["ci_low_95"])  * vehicles
            slot["before_ci_hi"] += float(row["before"]["ci_high_95"]) * vehicles
            slot["after_ci_lo"]  += float(row["after"]["ci_low_95"])   * vehicles
            slot["after_ci_hi"]  += float(row["after"]["ci_high_95"])  * vehicles

    per_approach_payload = []
    for slot in by_approach.values():
        v = slot["vehicles"] if slot["vehicles"] > 0 else 1.0
        per_approach_payload.append({
            "approach_id": slot["approach_id"],
            "label":       slot["label"],
            "flow_pcu_hr": round(slot["flow_total"] / max(sum(hours_for_chunk), 1e-6), 2),
            "before": {
                "mean":       round(slot["before_num"]   / v, 4),
                "std":        0.0,
                "ci_low_95":  round(slot["before_ci_lo"] / v, 4),
                "ci_high_95": round(slot["before_ci_hi"] / v, 4),
                "n_runs":     slot["n_runs"],
            },
            "after": {
                "mean":       round(slot["after_num"]    / v, 4),
                "std":        0.0,
                "ci_low_95":  round(slot["after_ci_lo"]  / v, 4),
                "ci_high_95": round(slot["after_ci_hi"]  / v, 4),
                "n_runs":     slot["n_runs"],
            },
        })
    per_approach_payload.sort(
        key=lambda r: r["before"]["mean"] - r["after"]["mean"], reverse=True,
    )

    # Pick the sample replays from the chunk with the highest mean savings,
    # the most visually striking for the panel. Tag the response so the UI
    # can label them as "from the peak hour" rather than "average across the day".
    peak_for_replays = max(
        per_chunk_payloads,
        key=lambda p: p["vehicle_hours_saved"]["mean"],
    )

    # Sum analytical reference across chunks (per-hour value * hours).
    analytical_total = 0.0
    for p, h in zip(per_chunk_payloads, hours_for_chunk):
        analytical_total += float(p.get("analytical_reference_vh", 0.0)) * h

    return {
        "intersection_id":         intersection_id,
        "chunk_name":              "All day",
        "duration_sec":            int(sum(hours_for_chunk) * 3600),
        "n_runs":                  n_runs,
        "label":                   label,
        "sentence":                sentence,
        "vehicle_hours_saved": {
            "mean":       round(mean,    4),
            "std":        round(std,     4),
            "ci_low_95":  round(ci_low,  4),
            "ci_high_95": round(ci_high, 4),
            "n_runs":     len(arr),
        },
        "per_run_means":           all_day_per_run,
        "per_approach":            per_approach_payload,
        "sample_replays":          peak_for_replays.get("sample_replays") or [],
        "analytical_reference_vh": round(analytical_total, 4),
        "cached":                  False,
    }


@router.get("/{intersection_id}/stochastic-confidence", response_model=StochasticConfidenceResponse)
def get_stochastic_confidence(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
    chunk_name_q: Annotated[str | None, Query(alias="chunk")] = None,
):
    """Run Monte Carlo for one TOD chunk (or all chunks aggregated).

    By default the chunk is the peak (highest analytical vh_saved) on the
    latest recommendation. Override with `?chunk=NAME` to drill into one
    specific period (AM Rush, Midday, etc.), or `?chunk=all` for an
    aggregated "All day" view that sums vh_saved across every chunk.

    Single-chunk results are cached in Redis for 1 hour keyed by
    (intersection_id, recommendation_id, chunk_name). The "all" view
    fans out to per-chunk and aggregates; cached chunks return instantly
    and only missing ones trigger fresh computation.
    """
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    latest_rec = db.execute(text("""
        SELECT id FROM recommendations
         WHERE intersection_id = :iid
         ORDER BY generated_at DESC
         LIMIT 1
    """), {"iid": intersection_id}).fetchone()
    if not latest_rec:
        raise HTTPException(status_code=404, detail="No recommendations found for this intersection")
    rec_id = latest_rec.id

    # "All day" aggregator path. Compute every chunk (cached or fresh) then
    # blend them into one envelope-spanning payload.
    if chunk_name_q in ("all", "All day"):
        all_rows = (
            db.query(models.SimulationResult)
            .filter_by(recommendation_id=rec_id)
            .filter(models.SimulationResult.chunk_name != "overall")
            .order_by(models.SimulationResult.chunk_name)
            .all()
        )
        if not all_rows:
            raise HTTPException(status_code=404, detail="No simulation chunks to aggregate")
        per_chunk_payloads = []
        for row in all_rows:
            try:
                per_chunk_payloads.append(
                    _compute_chunk_mc(db, intersection, rec_id, row.chunk_name, row)
                )
            except HTTPException as exc:
                # Skip chunks with no flow data; an aggregate of the rest is
                # still meaningful (and most intersections only have all-data
                # chunks in practice).
                logger.warning(
                    "all-day MC skipped chunk %s: %s",
                    row.chunk_name, exc.detail,
                )
        aggregated = _aggregate_all_day(db, intersection_id, per_chunk_payloads)
        return StochasticConfidenceResponse(**aggregated)

    # Single-chunk path. Resolve the chunk to compute.
    if chunk_name_q:
        peak_row = (
            db.query(models.SimulationResult)
            .filter_by(recommendation_id=rec_id, chunk_name=chunk_name_q)
            .first()
        )
        if peak_row is None:
            raise HTTPException(
                status_code=404,
                detail=f"Chunk '{chunk_name_q}' has no simulation row on the latest recommendation",
            )
    else:
        peak_row = (
            db.query(models.SimulationResult)
            .filter_by(recommendation_id=rec_id)
            .filter(models.SimulationResult.chunk_name != "overall")
            .order_by(models.SimulationResult.vehicle_hours_saved.desc())
            .first()
        )
        if peak_row is None:
            raise HTTPException(status_code=404, detail="No simulation chunks to score")

    payload = _compute_chunk_mc(db, intersection, rec_id, peak_row.chunk_name, peak_row)
    return StochasticConfidenceResponse(**payload)


def _compute_window_mc(
    db: Session,
    intersection: models.Intersection,
    start: datetime,
    end: datetime,
) -> dict:
    """Monte Carlo for a user-picked time window.

    Mirrors `_compute_chunk_mc` but pulls flows for the window via
    `pcu_flow_for_window` and reports stats as *window totals* (mean+CI
    scaled by window_hrs) so the envelope reads in the same units as the
    windowed Webster's vh_saved shown in the Findings card. Unlike the
    chunk path this is uncached; each window is unique to the operator's
    selection and the MC takes ~10 s.
    """
    from server.simulation import _phase_offsets, compute_uniform_delay
    from server.stochastic_simulation import (
        DEFAULT_N_RUNS,
        DEFAULT_DURATION_SEC,
        SignalProgram,
        _draw_arrivals,
        _per_run_rng,
        monte_carlo_compare,
        simulate_one_run,
    )
    from server.webster import (
        compute_timing,
        effective_saturation_flow,
        get_street_directions,
        group_phases,
        pcu_flow_for_window,
    )
    from server.pce import resolve_pce

    intersection_id = intersection.id
    pce_map = resolve_pce(db, intersection_id)
    flows   = pcu_flow_for_window(db, intersection_id, start, end, pce_map)
    if not flows:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No detection data for "
                f"{start.strftime('%Y-%m-%d %H:%M')} - {end.strftime('%H:%M')}"
            ),
        )

    directions = get_street_directions(db, intersection_id)
    n_arms     = len(flows)
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
        green_seconds={int(sid): float(g)  for sid, g  in proposed_splits.items()},
        phase_offsets={int(sid): int(off)  for sid, off in after_offsets.items()},
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
            else {int(sid): exist_C / n_arms for sid in flows}
        )
    else:
        # Unsignalized fallback: report MC against proposed-vs-proposed so the
        # envelope reads ~zero saving (the label collapses to "marginal", which
        # is honest - we can't replay a no-signal scenario in MC v1).
        exist_C = proposed_C
        exist_splits = {int(sid): float(g) for sid, g in proposed_splits.items()}

    before_offsets = _phase_offsets(phases, exist_splits, lost_time, all_red)
    before_program = SignalProgram(
        cycle_length_s=int(exist_C),
        green_seconds={int(sid): float(g)  for sid, g  in exist_splits.items()},
        phase_offsets={int(sid): int(off)  for sid, off in before_offsets.items()},
        lost_time_per_phase=float(lost_time),
        all_red_clearance=float(all_red),
    )

    flows_int = {int(sid): float(q) for sid, q in flows.items()}
    mc = monte_carlo_compare(
        q_pcu_hr_per_approach=flows_int,
        before_program=before_program,
        after_program=after_program,
        n_runs=DEFAULT_N_RUNS,
        duration_sec=DEFAULT_DURATION_SEC,
        sat_flow_pcu_hr=sat_flow,
    )
    vh = mc.vehicle_hours_saved

    # MC simulates one hour. Scale linearly to window length so the envelope
    # reads in the same units as the windowed Webster's total. Linear because
    # we're projecting a single estimate to a longer window, not aggregating
    # independent samples - the CI bounds scale with the mean.
    window_hrs = max((end - start).total_seconds() / 3600.0, 0.0)
    scaled_mean    = vh.mean      * window_hrs
    scaled_std     = vh.std       * window_hrs
    scaled_ci_low  = vh.ci_low_95 * window_hrs
    scaled_ci_high = vh.ci_high_95 * window_hrs
    scaled_per_run = [round(v * window_hrs, 4) for v in vh.per_run_means]

    # Analytical reference for the window: Webster's deterministic vh_saved
    # over the same period. Computed directly so we don't round-trip through
    # compute_simulation_for_window (which also does the per-second delay sim).
    total_flow = sum(flows.values())
    if total_flow > 0 and proposed_C:
        d_after = sum(
            compute_uniform_delay(proposed_C, proposed_splits.get(int(sid), proposed_C / n_arms), q, sat_flow) * q
            for sid, q in flows.items()
        ) / total_flow
        d_before = sum(
            compute_uniform_delay(exist_C, exist_splits.get(int(sid), exist_C / n_arms), q, sat_flow) * q
            for sid, q in flows.items()
        ) / total_flow
        analytical_vh_window = (d_before - d_after) * total_flow * window_hrs / 3600
    else:
        analytical_vh_window = 0.0

    label, sentence = _confidence_label(scaled_mean, scaled_ci_low, scaled_ci_high)

    # Per-approach labelling (street name + arm prefix). Same shape as
    # _compute_chunk_mc's output so the badge UI can render either response
    # interchangeably.
    street_meta = {
        row.id: (row.name, getattr(row, "arm_direction", None))
        for row in (
            db.query(models.Street)
            .filter_by(intersection_id=intersection_id)
            .all()
        )
    }
    arm_short = {
        "northbound": "NB", "southbound": "SB",
        "eastbound":  "EB", "westbound":  "WB",
    }
    per_approach_payload: list[dict] = []
    for approach_id, ba in mc.per_approach.items():
        name, direction = street_meta.get(approach_id, (f"Approach {approach_id}", None))
        short = arm_short.get(direction or "", "?")
        prefix_dupe = (
            direction is not None
            and (
                name.upper().startswith(f"{short} -")
                or name.upper().startswith(f"{short}-")
                or name.upper().startswith(f"{short} ")
            )
        )
        label_str = f"{short} - {name}" if direction and not prefix_dupe else name
        per_approach_payload.append({
            "approach_id": approach_id,
            "label":       label_str,
            "flow_pcu_hr": round(float(flows_int[approach_id]), 2),
            "before": {
                "mean":       round(ba.before.mean,       4),
                "std":        round(ba.before.std,        4),
                "ci_low_95":  round(ba.before.ci_low_95,  4),
                "ci_high_95": round(ba.before.ci_high_95, 4),
                "n_runs":     ba.before.n_runs,
            },
            "after": {
                "mean":       round(ba.after.mean,       4),
                "std":        round(ba.after.std,        4),
                "ci_low_95":  round(ba.after.ci_low_95,  4),
                "ci_high_95": round(ba.after.ci_high_95, 4),
                "n_runs":     ba.after.n_runs,
            },
        })
    per_approach_payload.sort(
        key=lambda r: r["before"]["mean"] - r["after"]["mean"], reverse=True,
    )

    # Sample replays for the visual playback. Same construction as chunk path.
    N_SAMPLE_REPLAYS = 5
    sample_replays_payload: list[dict] = []
    duration_int = int(DEFAULT_DURATION_SEC)
    for run_index in range(min(N_SAMPLE_REPLAYS, DEFAULT_N_RUNS)):
        arrival_rng = _per_run_rng(42, run_index, stream=0)
        reaction_rng = _per_run_rng(42, run_index, stream=2)
        arrivals = _draw_arrivals(flows_int, DEFAULT_DURATION_SEC, arrival_rng)
        sim_result = simulate_one_run(
            arrivals_per_approach=arrivals,
            signal_program=after_program,
            sat_flow_pcu_hr=sat_flow,
            duration_sec=DEFAULT_DURATION_SEC,
            rng=reaction_rng,
        )
        bucketed: dict[str, list[float]] = {}
        for approach_id, times in arrivals.items():
            buckets = [0.0] * duration_int
            for t in times:
                idx = int(t)
                if 0 <= idx < duration_int:
                    buckets[idx] += 1.0
            bucketed[str(approach_id)] = buckets
        # Report each run's vh saved in window-total units, matching the
        # outer envelope.
        run_vh_saved_scaled = (
            vh.per_run_means[run_index] * window_hrs
            if run_index < len(vh.per_run_means) else 0.0
        )
        sample_replays_payload.append({
            "run_index":  run_index,
            "vh_saved":   round(float(run_vh_saved_scaled), 4),
            "arrivals_per_second": bucketed,
        })
        if not sim_result:
            logger.warning("window MC sample replay %d empty", run_index)

    chunk_label = f"{start.strftime('%b %d %H:%M')} – {end.strftime('%H:%M')}"

    return {
        "intersection_id":          intersection_id,
        "chunk_name":               chunk_label,
        "duration_sec":             int((end - start).total_seconds()),
        "n_runs":                   vh.n_runs,
        "label":                    label,
        "sentence":                 sentence,
        "vehicle_hours_saved": {
            "mean":       round(scaled_mean,    4),
            "std":        round(scaled_std,     4),
            "ci_low_95":  round(scaled_ci_low,  4),
            "ci_high_95": round(scaled_ci_high, 4),
            "n_runs":     vh.n_runs,
        },
        "per_run_means":            scaled_per_run,
        "per_approach":             per_approach_payload,
        "sample_replays":           sample_replays_payload,
        "analytical_reference_vh":  round(analytical_vh_window, 4),
        "cached":                   False,
    }


@router.post("/stochastic-confidence/compute", response_model=StochasticConfidenceResponse)
def compute_stochastic_confidence_for_window(
    body: ComputeRequest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run Monte Carlo against a user-picked time window.

    Pairs with `POST /simulation/compute` so the deterministic Webster's
    sim and the stochastic 100-replay verdict cover the same window with
    the same units (window-total vh_saved). Without this endpoint the
    Confidence badge would still report a daily envelope while the rest of
    the page is showing a windowed replay - the numbers wouldn't align.
    """
    intersection = db.get(models.Intersection, body.intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    if body.end <= body.start:
        raise HTTPException(status_code=422, detail="end must be after start")

    try:
        payload = _compute_window_mc(db, intersection, body.start, body.end)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "compute_window_mc failed (intersection=%s window=%s..%s)",
            body.intersection_id, body.start.isoformat(), body.end.isoformat(),
        )
        raise HTTPException(
            status_code=500,
            detail=f"Windowed stochastic confidence failed: {type(exc).__name__}: {exc}",
        ) from exc

    return StochasticConfidenceResponse(**payload)
