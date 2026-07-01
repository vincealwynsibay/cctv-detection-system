import type { Intersection } from '@/types';
import type { RecommendationResponse } from '@/services/recommendations';
import type { SimulationResponse } from '@/services/simulation';

/**
 * Reconciles MUTCD warrants (volume-based, per-hour) with Webster's delay
 * model (delay-based, full-day) into a single recommended action that the
 * dashboard, Live tab, Signal Timing tab, and printed report all share.
 *
 * Trust hierarchy:
 *   1. Backend intervention class (`server/intervention_rules.py`) already
 *      encodes the capacity question - critical_vc > 0.90 → road_widening,
 *      otherwise signalize/timing_only. So we don't re-derive capacity from
 *      the simulation here; if the backend chose 'signalize' we know it's
 *      *not* capacity-bound.
 *   2. Webster's daily vh_saved tells us whether the proposed change actually
 *      reduces delay. A signalize verdict with vh_saved ≤ 0 means the warrant
 *      tripped on a peak hour but adding a signal would add idle red-time
 *      delay across the whole day - the answer is "monitor", not "widen".
 *
 * vh_saved is taken from `rec.webster_vh_saved_per_day` (ships on every rec
 * via the list endpoint) or from `sim.daily_summary.total_vehicle_hours_saved`
 * when a full simulation is on hand. Either source produces the same verdict,
 * which is the point.
 */
/**
 * Below this absolute vh-hr/day, Webster's projection is engineering noise and
 * a near-break-even signal proposal isn't truly "adding delay" — it's wash.
 * Exported so panels rendering raw vh_saved numbers can soften their framing
 * to match the reconciled action banner (avoids the install-signal banner
 * disagreeing visually with a red "signal adds delay" raw-number tile).
 * Mirrors IMPROVEMENT_PROMINENT_VH × 10.
 */
export const MONITOR_THRESHOLD_VH = 100;

export type ActionKind =
  | 'install_signal'
  | 'widen_lanes'
  | 'adjust_timing'
  | 'monitor'         // warrant met but Webster shows no benefit; not capacity-bound per backend
  | 'no_action'
  | 'no_analysis';

export type ActionTone = 'good' | 'warn' | 'info' | 'muted';

export type ActionLane = 'deploy' | 'escalate' | 'later' | 'monitor';

export interface ActionDescriptor {
  kind: ActionKind;
  /** One-line decision-level title. */
  headline: string;
  /** Sentence explaining the reasoning, including reconciliation when relevant. */
  detail: string;
  tone: ActionTone;
  /** Triage lane for the dashboard's "Needs action" card. */
  lane: ActionLane;
  /** True when the action routes to the Signal Timing tool (timing adjustment). */
  isTiming: boolean;
  /**
   * Did MUTCD recommend a change that Webster's contradicts? UI surfaces use
   * this to render the disagreement explicitly rather than picking a side.
   */
  contradictionFlagged: boolean;
}

/**
 * Webster vh_saved/day for the rec. Single source of truth: the scalar that
 * ships on the recommendation, computed server-side from the sim rows tied
 * to *this* rec_id.
 *
 * Why we don't fall back to `sim.daily_summary.total_vehicle_hours_saved`:
 * the sim object (`simulationApi.get`) returns "the latest sim for this
 * intersection" and can lag behind the rec — e.g. a dashboard Analyse
 * regenerates the rec but the Live tab's `<IntersectionShell>` still has
 * the previously-fetched sim. Or the user is viewing a rec from before the
 * backend's `webster_vh_saved_per_day` field existed; the only sim available
 * is the much-older 4-phase one whose total reads as wildly negative.
 * Falling back to sim in either case would demote actionable verdicts to
 * "No action required" while the dashboard correctly shows "Adjust timing".
 *
 * If `rec.webster_vh_saved_per_day` is null we treat Webster as unknown
 * (websterRules=false), not as zero — that's how the helper distinguishes
 * "Webster ran and found no benefit" from "Webster never ran for this rec".
 *
 * Sim is still used elsewhere in this module for context that doesn't ship
 * on the rec (avg_delay_before for the Monitor headline copy).
 */
function pickVhSaved(
  rec: RecommendationResponse,
  _sim: SimulationResponse | null,
  fallback: number | null | undefined,
): number | null {
  if (rec.webster_vh_saved_per_day != null) return rec.webster_vh_saved_per_day;
  if (fallback != null) return fallback;
  return null;
}

/** Daily average delay (s/veh) before applying Webster's, if a sim is on hand. */
function avgDelayBefore(sim: SimulationResponse | null): number | null {
  return sim?.daily_summary?.avg_delay_before ?? null;
}

export interface DeriveOptions {
  /** Full simulation (Live + Timing tabs). Preferred when available. */
  sim?: SimulationResponse | null;
  /** Fallback when only the rec is on hand (dashboard list). */
  vhSavedPerDayFallback?: number | null;
}

export function deriveIntersectionAction(
  rec: RecommendationResponse | null,
  intersection: Intersection | null,
  opts: DeriveOptions = {},
): ActionDescriptor {
  if (!rec) {
    return {
      kind: 'no_analysis',
      headline: 'No analysis yet',
      detail: 'Run a warrant analysis to populate this dashboard.',
      tone: 'muted',
      lane: 'monitor',
      isTiming: false,
      contradictionFlagged: false,
    };
  }

  const sim = opts.sim ?? null;
  const vhSaved = pickVhSaved(rec, sim, opts.vhSavedPerDayFallback);
  const websterRules = vhSaved != null;
  // Webster's simulation is approximate — small negative vh_saved (within
  // ~100 vh-hr/day) is engineering noise, not a real reason to suppress an
  // MUTCD-warranted signal. Only demote to Monitor when the projected delay
  // increase is unambiguous (i.e., adding the signal would clearly make
  // things worse, like applying one to a near-empty intersection). The
  // threshold mirrors IMPROVEMENT_PROMINENT_VH × 10 — same order of
  // magnitude as the "near-optimal" cutoff used elsewhere.
  const websterClearlyHurts = websterRules && vhSaved < -MONITOR_THRESHOLD_VH;
  const delayBefore = avgDelayBefore(sim);

  // Backend's intervention class already encodes the capacity question:
  // `assign_intervention_label` in server/intervention_rules.py returns
  // 'road_widening' iff critical_vc > 0.90. So we don't re-derive capacity
  // from the simulation - if the backend chose 'signalize' over widening,
  // we know it's *not* capacity-bound and a no-benefit Webster verdict means
  // free-flow, not saturation.
  if (rec.intervention?.class === 'road_widening') {
    const confPct = Math.round((rec.intervention.confidence ?? 0) * 100);
    // When Webster still recovers meaningful delay even though widening is the
    // long-term fix, surface that as an interim mitigation. Widening removes
    // the v/c ceiling; retiming reclaims most of the operational headroom
    // beneath it. Both recommendations are real; the dashboard chip stays
    // "Widen" (escalate lane) but the detail copy makes the dual play explicit.
    const interimBenefit =
      websterRules && (vhSaved as number) >= MONITOR_THRESHOLD_VH
        ? ` Retiming the signal still recovers about ${Math.round(vhSaved as number).toLocaleString()} vh/day in the meantime (see Timing tab).`
        : '';
    return {
      kind: 'widen_lanes',
      headline: 'Widen approach lanes (long-term fix)',
      detail:
        `Even with optimised timing, critical v/c stays above 0.90, so lane capacity is the binding constraint.${interimBenefit} ${confPct}% confidence.`,
      tone: 'warn',
      lane: 'escalate',
      isTiming: false,
      contradictionFlagged: false,
    };
  }

  // Fallback for older recs without an intervention object: only treat them as
  // signalize candidates when at least one warrant is actually met. The CNN's
  // overall `recommended` flag and its per-warrant heads can disagree (different
  // output heads of the same model); without a concrete warrant we have no
  // justification to surface "install a signal", so we drop through to "no
  // action" instead of inventing one.
  const anyWarrantMet =
    rec.warrant_1_met || rec.warrant_2_met || rec.warrant_4_met ||
    !!rec.w_local_1_met || !!rec.w_local_2_met || !!rec.w_local_3_met;
  const wantsSignalize =
    rec.intervention?.class === 'signalize' ||
    (rec.recommended && rec.intervention == null && anyWarrantMet);

  if (wantsSignalize) {
    if (websterClearlyHurts) {
      // Webster says adding a signal would meaningfully *add* delay (>100
      // vh-hr/day). Backend already excluded capacity (it'd have returned
      // 'road_widening'), so this is the free-flow case: warrant tripped
      // on a peak hour, but most of the day is empty and a signal would
      // impose pointless red-time delay.
      const delayStr = delayBefore != null
        ? `Current average delay is only ${delayBefore.toFixed(1)}s/veh`
        : 'Current intersection runs near free-flow';
      return {
        kind: 'monitor',
        headline: 'Monitor - signal not yet justified by delay',
        detail:
          `${delayStr}; adding a signal would impose red-time delay on otherwise empty ` +
          `approaches. The MUTCD warrant tripped on a single peak hour - keep monitoring ` +
          `as volumes grow.`,
        tone: 'muted',
        lane: 'monitor',
        isTiming: false,
        contradictionFlagged: true,
      };
    }
    const conf = rec.intervention?.confidence ?? rec.recommended_confidence ?? 0;
    const confPct = Math.round(conf * 100);
    // Distinguish three Webster outcomes for an MUTCD-warranted signal:
    //   > 0 vh:       signal is both safer and faster - clear win
    //   > -15 vh:     truly negligible - engineering noise at this scale
    //   -15 to -100:  signal adds meaningful delay - honest about the cost,
    //                 but still recommend on safety/access grounds (flag contradiction)
    const vhNum = vhSaved as number;
    const addsDelay = websterRules && vhNum < -15;
    // W4 is a pedestrian safety warrant - its purpose is protected crossing time,
    // not vehicular throughput. When W4 is the sole trigger and the signal adds
    // vehicular delay, that delay is the expected cost of prioritising pedestrians.
    const pedestrianOnly =
      rec.warrant_4_met &&
      !rec.warrant_1_met && !rec.warrant_2_met &&
      !rec.w_local_1_met && !rec.w_local_2_met && !rec.w_local_3_met;
    const websterDetail = !websterRules
      ? 'Intersection is unsignalized.'
      : vhNum > 0
        ? `Webster projects ${vhNum.toFixed(1)} vh/day of delay reduction on top of the safety benefit.`
        : addsDelay
          ? pedestrianOnly
            ? `W4 is a pedestrian safety warrant - protected crossing time is the goal, not vehicular throughput. The signal will add ~${Math.abs(vhNum).toFixed(0)} vh/day of vehicular delay; that is the expected cost of prioritising pedestrians at this crossing.`
            : `Installing the signal will add ~${Math.abs(vhNum).toFixed(0)} vh/day of vehicular delay. Still recommended on safety/access grounds - warrants assess crossing safety, not delay minimisation.`
          : `Webster projects negligible operational cost (under 15 vh/day).`;
    return {
      kind: 'install_signal',
      headline: 'Install traffic signal',
      detail: `Volume/safety warrant met. ${websterDetail} ${confPct}% confidence.`,
      tone: 'good',
      lane: 'escalate',
      isTiming: false,
      contradictionFlagged: addsDelay,
    };
  }

  // Webster generates a timing_cycle even for unsignalized intersections (as an
  // "if-you-signalised" projection). Don't surface "Adjust timing" as a verdict
  // unless the intersection actually has a signal to adjust.
  const isSignalized =
    intersection != null && intersection.signal_status !== 'unsignalized';
  if (rec.timing_cycle != null && isSignalized) {
    if (websterClearlyHurts) {
      return {
        kind: 'no_action',
        headline: 'Current timing already near-optimal',
        detail:
          `Webster's projects no measurable delay reduction from adjusting the signal timing. ` +
          `Keep ${rec.timing_cycle}s cycle and monitor.`,
        tone: 'muted',
        lane: 'monitor',
        isTiming: false,
        contradictionFlagged: false,
      };
    }
    return {
      kind: 'adjust_timing',
      headline: `Retime to ${rec.timing_cycle}s cycle`,
      detail: websterRules
        ? `Rebalance green splits to save ${Math.round(vhSaved as number)} vh/day.`
        : 'Rebalance green time per approach to match demand.',
      tone: 'info',
      lane: 'deploy',
      isTiming: true,
      contradictionFlagged: false,
    };
  }

  return {
    kind: 'no_action',
    headline: 'No action required',
    detail: 'Current timing absorbs the demand. Keep monitoring.',
    tone: 'muted',
    lane: 'monitor',
    isTiming: false,
    contradictionFlagged: false,
  };
}

/** Short verb for chips/labels - used in places too narrow for the headline. */
export function actionShortLabel(kind: ActionKind): string {
  switch (kind) {
    case 'install_signal': return 'Signalize';
    case 'widen_lanes':    return 'Widen';
    case 'adjust_timing':  return 'Adjust';
    case 'monitor':        return 'Monitor';
    case 'no_action':      return 'No action';
    case 'no_analysis':    return 'No analysis';
  }
}
