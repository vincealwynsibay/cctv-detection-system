"""Analytical delay simulation: Webster's uniform delay + HCM gap-acceptance baseline.

Before-state by signal_status:
  fixed_time / actuated  →  Webster's uniform delay using existing timing
  unsignalized           →  HCM gap-acceptance average delay (TWSC)

After-state (all types):
  Webster's uniform delay using proposed timing from timing_recommendations rows
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from common.models import Intersection, SimulationResult, TodChunk, TimingRecommendation
from server.webster import (
    pcu_flow_per_street,
    pcu_flow_for_window,
    arrivals_per_second_for_window,
    vehicle_arrivals_per_second_for_window,
    SATURATION_FLOW,
    effective_saturation_flow,
    get_street_directions,
    group_phases,
    compute_timing,
)

_TC = 6.5   # critical gap (s), TWSC through movement HCM 6th ed.
_TF = 3.3   # follow-up time (s)
_N_MINUTES = 60

# HCM 6th ed. LOS thresholds (control delay, s/veh)
_LOS_SIGNALIZED   = [(10, "A"), (20, "B"), (35, "C"), (55, "D"), (80, "E")]
_LOS_UNSIGNALIZED = [(10, "A"), (15, "B"), (25, "C"), (35, "D"), (50, "E")]


def delay_to_los(delay: float, signalized: bool = True) -> str:
    """Return HCM Level of Service letter (A–F) for a given control delay (s/veh)."""
    thresholds = _LOS_SIGNALIZED if signalized else _LOS_UNSIGNALIZED
    for limit, grade in thresholds:
        if delay <= limit:
            return grade
    return "F"


def compute_vc_ratio(C: int, g: float, q_pcu_hr: float, sat_flow: int = SATURATION_FLOW) -> float:
    """Degree of saturation (v/c ratio) for a signalized approach."""
    if g <= 0 or C <= 0:
        return 0.0
    return round(min(q_pcu_hr * C / (sat_flow * g), 1.0), 3)


def compute_uniform_delay(C: int, g: float, q_pcu_hr: float, sat_flow: int = SATURATION_FLOW) -> float:
    """Webster's 1958 uniform delay per vehicle (seconds).

    d = C(1 - λ)² / (2(1 - λ · x))

    where λ = g/C and x = q·C / (s·g) is the degree of saturation
    (q/capacity), capped at 0.98 to keep delay finite under near-saturation.

    Equivalent forms in the literature:
      * Webster's original: d = c(1 − λ)² / (2(1 − y)),  y = q/s = λ·x
      * HCM 6th Ed. d1:    d = 0.5·C·(1 − λ)² / (1 − x·λ)

    All three forms produce the same number; we keep the (λ·x) form because
    it lines up with HCM 6th Ed. notation in `server.simulation_validation`,
    which is where the cross-validation tests live.

    Cross-validation against a Monte Carlo stochastic microsim lives in
    `server.stochastic_simulation`. The MC mean converges to this function
    in the no-noise limit and exceeds it at high saturation by the HCM d2
    amount — see `docs/PANEL_DEFENSE_GUIDE.md` Part 7.5.
    """
    if q_pcu_hr <= 0 or g <= 0 or C <= 0:
        return 0.0
    lam = g / C
    x = min(q_pcu_hr * C / (sat_flow * g), 0.98)
    return round(max(0.0, C * (1 - lam) ** 2 / (2 * (1 - lam * x))), 2)


def compute_hcm_gap_delay(q_major_pcu_hr: float, q_minor_pcu_hr: float) -> float:
    """HCM 6th Edition control delay (s/veh) for a TWSC minor-street approach."""
    if q_major_pcu_hr <= 0:
        return 5.0
    q_s = q_major_pcu_hr / 3600
    try:
        c_p = q_major_pcu_hr * math.exp(-q_s * _TC) / (1 - math.exp(-q_s * _TF))
    except (ZeroDivisionError, OverflowError):
        return 5.0
    if c_p <= 0:
        return 3600.0
    v_c = min(q_minor_pcu_hr / c_p, 0.98)
    T = 0.25  # 15-min analysis period (hours)
    d = 3600 / c_p + 900 * T * (
        (v_c - 1) + math.sqrt(max(0.0, (v_c - 1) ** 2 + v_c / (450 * T * c_p)))
    )
    return round(max(5.0, d), 2)


def _gap_acceptance_capacity(q_major_pcu_hr: float, sat_flow: int = SATURATION_FLOW) -> float:
    """Potential capacity of a minor TWSC approach given major-street flow."""
    if q_major_pcu_hr <= 0:
        return sat_flow
    q_s = q_major_pcu_hr / 3600
    try:
        c_p = q_major_pcu_hr * math.exp(-q_s * _TC) / (1 - math.exp(-q_s * _TF))
        return max(1.0, c_p)
    except (ZeroDivisionError, OverflowError):
        return 1.0


def _queue_series_signalized(
    q_pcu_hr: float, C: int, g: float, n_minutes: int = _N_MINUTES, sat_flow: int = SATURATION_FLOW
) -> list[float]:
    """Queue length (vehicles) at each minute boundary for a signalized approach."""
    arrival = q_pcu_hr / 3600
    departure = sat_flow / 3600
    red_time = C - g
    queue = 0.0
    series: list[float] = []
    for t in range(n_minutes * 60):
        phase = t % C
        if phase < red_time:
            queue += arrival
        else:
            queue = max(0.0, queue + arrival - departure)
        if t % 60 == 59:
            series.append(round(queue, 1))
    return series


def _queue_series_unsignalized(
    q_pcu_hr: float, capacity_pcu_hr: float, n_minutes: int = _N_MINUTES
) -> list[float]:
    """Queue length (vehicles) at each minute boundary for an uncontrolled approach."""
    arrival = q_pcu_hr / 3600
    service = max(capacity_pcu_hr / 3600, arrival + 1e-9)
    queue = 0.0
    series: list[float] = []
    for t in range(n_minutes * 60):
        queue = max(0.0, queue + arrival - service)
        if t % 60 == 59:
            series.append(round(queue, 1))
    return series


def _simulate_signalized_from_arrivals(
    arrivals_per_sec: list[float],
    C: int,
    g: float,
    offset: int,
    sat_flow: int,
) -> tuple[list[float], float]:
    """Per-second discrete-event queue sim driven by real PCU arrivals.

    During each second t the approach discharges at sat_flow/3600 PCU/s only
    when (t + offset) mod C is inside its green window [0, g). Arrivals join
    the queue immediately; departures bounded below at 0.

    Returns (queue_series_per_minute, mean_delay_seconds). Mean delay derives
    from Little's law: ∫queue·dt / total_arrivals.
    """
    n = len(arrivals_per_sec)
    if n == 0 or C <= 0:
        return [], 0.0
    discharge = sat_flow / 3600.0
    queue = 0.0
    total_q_time = 0.0
    total_arr = 0.0
    series: list[float] = []
    for t in range(n):
        queue += arrivals_per_sec[t]
        total_arr += arrivals_per_sec[t]
        phase = (t + offset) % C
        if phase < g:
            queue = max(0.0, queue - discharge)
        total_q_time += queue
        if t % 60 == 59:
            series.append(round(queue, 1))
    mean_delay = (total_q_time / total_arr) if total_arr > 0 else 0.0
    return series, round(mean_delay, 2)


def _simulate_unsignalized_from_arrivals(
    arrivals_per_sec: list[float],
    capacity_pcu_hr: float,
) -> tuple[list[float], float]:
    """Per-second queue sim for an uncontrolled approach.

    Service rate is constant capacity/3600. Returns (queue_series_per_minute,
    mean_delay_seconds) — same shape as the signalized helper.
    """
    n = len(arrivals_per_sec)
    if n == 0:
        return [], 0.0
    service = max(capacity_pcu_hr / 3600.0, 0.0)
    queue = 0.0
    total_q_time = 0.0
    total_arr = 0.0
    series: list[float] = []
    for t in range(n):
        queue += arrivals_per_sec[t]
        total_arr += arrivals_per_sec[t]
        queue = max(0.0, queue - service)
        total_q_time += queue
        if t % 60 == 59:
            series.append(round(queue, 1))
    mean_delay = (total_q_time / total_arr) if total_arr > 0 else 0.0
    return series, round(mean_delay, 2)


def _phase_offsets(
    phases: list[list[int]],
    splits: dict[int, float],
    lost_time_per_phase: int,
    all_red_clearance: int,
) -> dict[int, int]:
    """Map street_id → green-start second within the cycle.

    Walks `phases` in order, advancing the cursor by each phase's green plus
    the inter-green clearance (lost + all-red). All streets in a phase share
    the same offset and green duration.
    """
    inter_green = lost_time_per_phase + all_red_clearance
    offsets: dict[int, int] = {}
    cursor = 0
    for phase in phases:
        if not phase:
            continue
        g_phase = splits.get(phase[0], 0.0)
        for sid in phase:
            offsets[sid] = cursor
        cursor += int(round(g_phase)) + inter_green
    return offsets


def compute_simulation_for_window(
    db: Session,
    intersection: Intersection,
    start: datetime,
    end: datetime,
) -> dict:
    """On-demand before/after simulation for an explicit time window. Returns a plain dict, not DB rows."""
    from server.pce import resolve_pce

    pce_map         = resolve_pce(db, intersection.id)
    flows           = pcu_flow_for_window(db, intersection.id, start, end, pce_map)
    directions      = get_street_directions(db, intersection.id)
    arrivals        = arrivals_per_second_for_window(db, intersection.id, start, end, pce_map)
    vehicle_arrivals = vehicle_arrivals_per_second_for_window(db, intersection.id, start, end)

    status         = intersection.signal_status or "unsignalized"
    min_c          = intersection.min_cycle_length    or 40
    max_c          = intersection.max_cycle_length    or 120
    lost_time      = intersection.lost_time_per_phase or 4
    all_red        = intersection.all_red_clearance   or 3
    crossing_width = getattr(intersection, "crossing_width_m", 12.0) or 12.0
    sat_flow       = effective_saturation_flow(intersection)
    n_seconds      = max(0, int((end - start).total_seconds()))

    chunk_label = f"{start.strftime('%b %d %H:%M')} – {end.strftime('%H:%M')}"

    if not flows:
        return {"has_data": False, "chunk_label": chunk_label}

    n      = len(flows)
    phases = group_phases(flows, directions)
    proposed_C, proposed_splits = compute_timing(
        flows, phases, lost_time, all_red, min_c, max_c, crossing_width, sat_flow
    )

    # Arrivals are driven by actual detection timestamps. v/c stays Webster-based
    # (structural metric tied to flow + capacity, not arrival pattern); delays
    # come from the per-second sim — they reflect the real arrival sequence
    # rather than a Poisson reconstruction.
    after_offsets = _phase_offsets(phases, proposed_splits, lost_time, all_red)

    delay_after_per: dict[int, float] = {}
    vc_after_per:    dict[int, float] = {}
    q_series_after:  dict[str, list[float]] = {}

    for sid, q in flows.items():
        g = proposed_splits.get(sid, proposed_C / n)
        vc_after_per[sid] = compute_vc_ratio(proposed_C, g, q, sat_flow)
        sid_arrivals = arrivals.get(sid) or [0.0] * n_seconds
        series, mean_d = _simulate_signalized_from_arrivals(
            sid_arrivals, proposed_C, g, after_offsets.get(sid, 0), sat_flow
        )
        delay_after_per[sid] = mean_d
        q_series_after[str(sid)] = series

    delay_before_per: dict[int, float] = {}
    vc_before_per:    dict[int, float] = {}
    q_series_before:  dict[str, list[float]] = {}

    if status in ("fixed_time", "actuated"):
        exist_C    = intersection.existing_cycle_length or proposed_C
        raw_splits = intersection.existing_green_splits or {}
        exist_splits = (
            {int(k): v for k, v in raw_splits.items()}
            if raw_splits
            else {sid: exist_C / n for sid in flows}
        )
        # Reuse the proposed phase grouping for offset ordering — existing splits
        # carry duration but not phase order, so we assume the same NS/EW pairing.
        before_offsets = _phase_offsets(phases, exist_splits, lost_time, all_red)
        for sid, q in flows.items():
            g = exist_splits.get(sid, exist_C / n)
            vc_before_per[sid] = compute_vc_ratio(exist_C, g, q, sat_flow)
            sid_arrivals = arrivals.get(sid) or [0.0] * n_seconds
            series, mean_d = _simulate_signalized_from_arrivals(
                sid_arrivals, exist_C, g, before_offsets.get(sid, 0), sat_flow
            )
            delay_before_per[sid] = mean_d
            q_series_before[str(sid)] = series
    else:
        major_id = max(flows, key=flows.__getitem__)
        q_major  = flows[major_id]
        for sid, q in flows.items():
            if sid == major_id:
                cap = sat_flow
                vc_before_per[sid] = round(q / sat_flow, 3)
            else:
                cap = _gap_acceptance_capacity(q_major, sat_flow)
                vc_before_per[sid] = round(min(q / max(cap, 1), 1.0), 3)
            sid_arrivals = arrivals.get(sid) or [0.0] * n_seconds
            series, mean_d = _simulate_unsignalized_from_arrivals(sid_arrivals, cap)
            delay_before_per[sid] = mean_d
            q_series_before[str(sid)] = series

    total_flow = sum(flows.values())
    window_hrs = (end - start).total_seconds() / 3600

    if total_flow > 0:
        delay_before = sum(delay_before_per[sid] * flows[sid] for sid in flows) / total_flow
        delay_after  = sum(delay_after_per[sid]  * flows[sid] for sid in flows) / total_flow
    else:
        delay_before = delay_after = 0.0

    vc_before = max(vc_before_per.values(), default=0.0)
    vc_after  = max(vc_after_per.values(),  default=0.0)
    vh_saved  = (delay_before - delay_after) * total_flow * window_hrs / 3600

    return {
        "has_data":        True,
        "chunk_label":     chunk_label,
        "flows":           {str(sid): round(q, 1) for sid, q in flows.items()},
        "proposed_C":      proposed_C,
        "proposed_splits": {str(sid): round(g, 1) for sid, g in proposed_splits.items()},
        "delay_before":    round(delay_before, 2),
        "delay_after":     round(delay_after, 2),
        "vc_before":       round(vc_before, 3),
        "vc_after":        round(vc_after, 3),
        "total_flow":      round(total_flow, 2),
        "vh_saved":        round(vh_saved, 3),
        "q_series_before": q_series_before,
        "q_series_after":  q_series_after,
        "vehicle_arrivals_per_second": {str(sid): v for sid, v in vehicle_arrivals.items()},
        "status":          status,
    }


def generate_simulation(
    db: Session,
    intersection: Intersection,
    recommendation_id: int,
    timing_rows: list[TimingRecommendation],
) -> list[SimulationResult]:
    """Compute before/after delay per TOD chunk; return unsaved SimulationResult rows."""
    from server.pce import resolve_pce

    pce_map = resolve_pce(db, intersection.id)

    chunks = (
        db.query(TodChunk)
        .filter_by(intersection_id=intersection.id)
        .order_by(TodChunk.start_minutes)
        .all()
    )

    timing_by_chunk = {t.chunk_name: t for t in timing_rows if t.chunk_name != "overall"}
    status = intersection.signal_status or "unsignalized"
    sat_flow = effective_saturation_flow(intersection)
    results: list[SimulationResult] = []

    for chunk in chunks:
        timing = timing_by_chunk.get(chunk.name)
        if timing is None:
            continue

        flows = pcu_flow_per_street(db, intersection.id, chunk, pce_map)
        if not flows:
            results.append(SimulationResult(
                intersection_id=intersection.id,
                recommendation_id=recommendation_id,
                chunk_name=chunk.name,
                delay_before=0.0,
                delay_after=0.0,
                volume_pcu_hr=0.0,
                vehicle_hours_saved=0.0,
                queue_series_before=None,
                queue_series_after=None,
            ))
            continue

        n = len(flows)
        proposed_C = timing.cycle_length
        proposed_splits = {int(k): v for k, v in (timing.green_splits or {}).items()}

        # ── After: proposed Webster's timing ────────────────────────────
        delay_after_per: dict[int, float] = {}
        vc_after_per:    dict[int, float] = {}
        q_series_after:  dict[str, list[float]] = {}

        for sid, q in flows.items():
            g = proposed_splits.get(sid, proposed_C / n)
            delay_after_per[sid] = compute_uniform_delay(proposed_C, g, q, sat_flow)
            vc_after_per[sid]    = compute_vc_ratio(proposed_C, g, q, sat_flow)
            q_series_after[str(sid)] = _queue_series_signalized(q, proposed_C, g, sat_flow=sat_flow)

        # ── Before: existing timing or gap-acceptance ────────────────────
        delay_before_per: dict[int, float] = {}
        vc_before_per:    dict[int, float] = {}
        q_series_before:  dict[str, list[float]] = {}

        if status in ("fixed_time", "actuated"):
            exist_C = intersection.existing_cycle_length or proposed_C
            raw_splits = intersection.existing_green_splits or {}
            exist_splits = (
                {int(k): v for k, v in raw_splits.items()}
                if raw_splits
                else {sid: exist_C / n for sid in flows}
            )
            for sid, q in flows.items():
                g = exist_splits.get(sid, exist_C / n)
                delay_before_per[sid] = compute_uniform_delay(exist_C, g, q, sat_flow)
                vc_before_per[sid]    = compute_vc_ratio(exist_C, g, q, sat_flow)
                q_series_before[str(sid)] = _queue_series_signalized(q, exist_C, g, sat_flow=sat_flow)
        else:
            # unsignalized: major-street approach has near-zero delay
            major_id = max(flows, key=flows.__getitem__)
            q_major = flows[major_id]
            for sid, q in flows.items():
                if sid == major_id:
                    delay_before_per[sid] = 2.0
                    cap = sat_flow
                    vc_before_per[sid] = round(q / sat_flow, 3)
                else:
                    delay_before_per[sid] = compute_hcm_gap_delay(q_major, q)
                    cap = _gap_acceptance_capacity(q_major, sat_flow)
                    vc_before_per[sid] = round(min(q / max(cap, 1), 1.0), 3)
                q_series_before[str(sid)] = _queue_series_unsignalized(q, cap)

        # ── Weighted averages ────────────────────────────────────────────
        total_flow = sum(flows.values())
        if total_flow > 0:
            delay_before = sum(delay_before_per[sid] * flows[sid] for sid in flows) / total_flow
            delay_after  = sum(delay_after_per[sid]  * flows[sid] for sid in flows) / total_flow
        else:
            delay_before = delay_after = 0.0

        # Worst-approach v/c (most useful for diagnosing congestion)
        vc_before = max(vc_before_per.values(), default=0.0)
        vc_after  = max(vc_after_per.values(),  default=0.0)

        chunk_hours = (chunk.end_minutes - chunk.start_minutes) / 60.0
        vh_saved = (delay_before - delay_after) * total_flow * chunk_hours / 3600

        results.append(SimulationResult(
            intersection_id=intersection.id,
            recommendation_id=recommendation_id,
            chunk_name=chunk.name,
            delay_before=round(delay_before, 2),
            delay_after=round(delay_after, 2),
            vc_ratio_before=round(vc_before, 3),
            vc_ratio_after=round(vc_after, 3),
            volume_pcu_hr=round(total_flow, 2),
            vehicle_hours_saved=round(vh_saved, 3),
            queue_series_before=q_series_before,
            queue_series_after=q_series_after,
        ))

    return results
