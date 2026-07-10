import type { ReactNode } from 'react';
import type { Intersection, Street } from '@/types';
import type { RecommendationResponse } from '@/services/recommendations';
import type { SimulationResponse } from '@/services/simulation';
import { selectPeakChunk } from '@/lib/simulation';
import {
  IMPROVEMENT_PROMINENT_VH,
  buildApproachRows,
  evaluateImprovement,
} from '@/lib/improvement';
import { deriveIntersectionAction, type ActionKind } from '@/lib/intersectionAction';
import { JargonTip } from '@/components/JargonTip';

function buildNarrative(
  intersection: Intersection,
  sim: SimulationResponse | null,
  rec: RecommendationResponse | null,
): string {
  const name = intersection.name;

  if (!rec) {
    return `No analysis has been run yet for ${name}. Run a warrant analysis to generate a recommendation and timing plan.`;
  }

  // Use the shared reconciliation so the narrative agrees with the action
  // banner and the dashboard. The helper handles the awkward cases (warrant
  // met but Webster says no benefit, capacity-bound, etc.) in one place.
  const action = deriveIntersectionAction(rec, intersection, { sim });

  // For signalized intersections with a real before/after we still want the
  // delay/LOS comparison sentence - that's specific colour the banner doesn't
  // carry. Otherwise fall back to the reconciled headline + detail.
  const signalized = intersection.signal_status !== 'unsignalized';
  if (signalized && action.kind === 'adjust_timing') {
    const summary = evaluateImprovement(sim);
    if (summary && summary.worthHighlighting) {
      const before = Math.round(summary.delayBeforeS);
      const after  = Math.round(summary.delayAfterS);
      const saved  = Math.round(summary.vehicleHoursSavedPerDay);
      const losPart = summary.levelOfServiceChanged
        ? ` Level of service would improve from ${summary.losBefore} to ${summary.losAfter}.`
        : '';
      return `${name} is signalized but the current timing is not optimal. A recalculated signal timing plan would cut average wait from ${before}s to ${after}s per car and save about ${saved} vehicle-hours of delay per day.${losPart} A timing adjustment is recommended; a new signal is not needed.`;
    }
  }
  if (signalized && action.kind === 'no_action') {
    const summary = evaluateImprovement(sim);
    if (summary) {
      const before = Math.round(summary.delayBeforeS);
      return `${name} is already running close to an optimal signal timing plan. Average wait per car is about ${before}s (level of service ${summary.losBefore}), and adjusting the timing would save fewer than ${IMPROVEMENT_PROMINENT_VH} vehicle-hours of delay per day - not worth changing.`;
    }
  }

  return `${name}: ${action.headline}. ${action.detail}`;
}

// ── Decomposed variant ────────────────────────────────────────────────────────

interface FindingsData {
  delayBeforeS: number | null;
  losBefore: string | null;
  peakChunkName: string | null;
  peakVcAfter: number | null;
  majorVolume: number | null;
  minorVolume: number | null;
  pedsPerHour: number | null;
  warrantsMet: string[];
}

/** Plain-English label for an HCM Level of Service letter.
 *  Pair with the letter so non-engineers can read the row without
 *  guessing what "LOS C" means. */
const LOS_PLAIN: Record<string, string> = {
  A: 'free flow',
  B: 'stable flow',
  C: 'acceptable',
  D: 'approaching capacity',
  E: 'at capacity',
  F: 'over capacity',
};

/** Plain-English label for a v/c (degree-of-saturation) ratio.
 *  Buckets match the LOS thresholds engineers actually use. */
function vcPlainLabel(vc: number): string {
  if (vc < 0.6)  return 'comfortable';
  if (vc < 0.85) return 'busy';
  if (vc < 1.0)  return 'near capacity';
  return 'over capacity';
}

function buildFindings(
  _intersection: Intersection,
  sim: SimulationResponse | null,
  rec: RecommendationResponse | null,
): FindingsData {
  const peak = selectPeakChunk(sim);
  const warrants: string[] = [];
  if (rec?.warrant_1_met) warrants.push('W1 - peak-hour volume');
  if (rec?.warrant_2_met) warrants.push('W2 - 4-hour volume');
  if (rec?.warrant_4_met) warrants.push('W4 - pedestrian volume');
  if (rec?.w_local_1_met) warrants.push('Local W1');
  if (rec?.w_local_2_met) warrants.push('Local W2');
  if (rec?.w_local_3_met) warrants.push('Local W3');

  return {
    delayBeforeS:    sim?.daily_summary.avg_delay_before ?? null,
    losBefore:       sim?.daily_summary.los_before ?? null,
    peakChunkName:   peak?.chunk_name ?? null,
    peakVcAfter:     peak?.vc_ratio_after ?? null,
    majorVolume:     rec?.major_volume ?? null,
    minorVolume:     rec?.minor_volume ?? null,
    pedsPerHour:     rec?.peds ?? null,
    warrantsMet:     warrants,
  };
}

interface RoadComparison {
  /** Direction of the major (highest-flow) approach (e.g. "Eastbound"). */
  majorLabel: string;
  /** Combined direction(s) of the minor approach(es), e.g. "Northbound + Southbound". */
  minorLabel: string;
  majorGreenCurrent: number | null;
  majorGreenProposed: number | null;
  minorGreenCurrent: number | null;
  minorGreenProposed: number | null;
}

function buildRoadComparison(
  streets: Street[],
  sim: SimulationResponse | null,
  existingSplits: Record<string, number> | null | undefined,
): RoadComparison | null {
  const peak = selectPeakChunk(sim);
  const rows = buildApproachRows(streets, existingSplits, peak?.proposed_splits);
  const named = rows.filter(r => r.recommendedGreen != null || r.currentGreen != null);
  if (named.length < 2) return null;

  // Highest proposed green time wins (Webster's allocates more green to the
  // critical approach). Fall back to current green when proposed is missing.
  const ranked = [...named].sort((a, b) => {
    const ag = a.recommendedGreen ?? a.currentGreen ?? 0;
    const bg = b.recommendedGreen ?? b.currentGreen ?? 0;
    return bg - ag;
  });
  const major = ranked[0];
  const minorRows = ranked.slice(1);

  // Compose a multi-direction minor label like "NB + SB" when there are
  // multiple minor approaches; the head-to-head still reads as two roads.
  const minorLabel = minorRows.map(r => r.label.split(' - ')[0]).join(' + ');

  const sum = (xs: (number | null)[]) =>
    xs.some(x => x != null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null;

  return {
    majorLabel:         major.label,
    minorLabel:         minorLabel || 'minor approaches',
    majorGreenCurrent:  major.currentGreen,
    majorGreenProposed: major.recommendedGreen,
    minorGreenCurrent:  sum(minorRows.map(r => r.currentGreen)),
    minorGreenProposed: sum(minorRows.map(r => r.recommendedGreen)),
  };
}

interface DecomposedSummary {
  findings: FindingsData;
  comparison: RoadComparison | null;
  vhSavedPerDay: number | null;
  recAction: string;
  actionKind: ActionKind;
  /** True when the MUTCD recommendation disagrees with Webster's delay impact. */
  showCaveat: boolean;
}

function buildDecomposedSummary(
  intersection: Intersection,
  streets: Street[],
  sim: SimulationResponse | null,
  rec: RecommendationResponse | null,
): DecomposedSummary {
  const findings = buildFindings(intersection, sim, rec);
  const comparison = buildRoadComparison(streets, sim, intersection.existing_green_splits);
  const vhSavedPerDay = sim?.daily_summary.total_vehicle_hours_saved ?? null;
  const action = deriveIntersectionAction(rec, intersection, { sim });
  const recAction = action.headline;
  // The reconciliation helper now owns the "do MUTCD and Webster's disagree?"
  // judgement - surface its flag so the printed report can explain the conflict
  // in the same words as the live UI.
  const showCaveat = action.contradictionFlagged;
  return {
    findings, comparison, vhSavedPerDay,
    recAction, actionKind: action.kind, showCaveat,
  };
}

export interface IntersectionSummaryProps {
  intersection: Intersection;
  streets: Street[];
  sim: SimulationResponse | null;
  rec: RecommendationResponse | null;
  /** Hide the print-only sections (useful inside SignalTiming where print is already wired) */
  noPrint?: boolean;
  /**
   * `narrative` = single-paragraph prose (default, used on dashboards).
   * `decomposed` = two stacked sections (Findings + Recommendations / Conclusion)
   * for the IntersectionReport page so an engineer can read each independently.
   */
  variant?: 'narrative' | 'decomposed';
}

export function IntersectionSummary({
  intersection, streets, sim, rec, noPrint, variant = 'narrative',
}: IntersectionSummaryProps) {
  if (variant === 'decomposed') {
    const d = buildDecomposedSummary(intersection, streets, sim, rec);
    return (
      <div className={noPrint ? 'flex flex-col gap-3' : 'flex flex-col gap-3 print:gap-2'}>
        {/* Findings */}
        <section className="rounded-lg border border-border bg-muted/30 p-4 print:p-3 print:break-inside-avoid bg-white">
          <h3 className="text-md font-semibold text-muted-foreground uppercase tracking-wide mb-2 print:mb-1">
            Findings
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm print:text-xs">
            <FindingRow label="Signal status">
              {intersection.signal_status.replace('_', ' ')}
            </FindingRow>
            {d.findings.delayBeforeS != null && (
              <FindingRow label={<>Avg delay <JargonTip term="los" /></>}>
                {d.findings.delayBeforeS.toFixed(1)}s/veh
                {d.findings.losBefore && (
                  <> · LOS {d.findings.losBefore}
                    {LOS_PLAIN[d.findings.losBefore] && (
                      <span className="text-muted-foreground"> — {LOS_PLAIN[d.findings.losBefore]}</span>
                    )}
                  </>
                )}
              </FindingRow>
            )}
            {d.findings.majorVolume != null && d.findings.minorVolume != null && (
              <FindingRow label="Major / minor volume">
                {d.findings.majorVolume.toLocaleString()} / {d.findings.minorVolume.toLocaleString()} veh/hr
              </FindingRow>
            )}
            {d.findings.pedsPerHour != null && d.findings.pedsPerHour > 0 && (
              <FindingRow label="Pedestrians">{d.findings.pedsPerHour}/hr</FindingRow>
            )}
            {d.findings.peakChunkName && d.findings.peakVcAfter != null && (
              <FindingRow label={<>How busy at peak <JargonTip term="critical_vc" /></>}>
                {vcPlainLabel(d.findings.peakVcAfter)}
                <span className="text-muted-foreground"> · v/c {d.findings.peakVcAfter.toFixed(2)} ({d.findings.peakChunkName})</span>
              </FindingRow>
            )}
            {d.findings.warrantsMet.length > 0 && (
              <FindingRow label={<>Warrants met <JargonTip term="mutcd" /></>}>
                {d.findings.warrantsMet.join(' · ')}
              </FindingRow>
            )}
          </dl>
        </section>

        {/* Recommendations / Conclusion */}
        <section className="rounded-lg border border-border bg-muted/30 p-4 print:p-3 print:break-inside-avoid bg-white">
          <h3 className="text-md font-semibold text-muted-foreground uppercase tracking-wide mb-2 print:mb-1">
            Recommendations / Conclusion
          </h3>
          <p className="text-sm leading-relaxed print:text-xs">
            <span className="font-semibold">{intersection.name}: </span>
            {buildComparisonProse(intersection, d)}
          </p>
          {d.showCaveat && (
            <p className="text-xs text-muted-foreground italic mt-2 leading-relaxed">
              Note: MUTCD warrants this on volume grounds, but Webster’s projects no net daily
              delay reduction at current 7-day flows - off-peak hours dominate the daily sum.
              The recommendation is still valid; the delay savings will materialise as volumes
              grow toward the threshold across the full day.
            </p>
          )}
          {/* Print-only signature block */}
          <div className="hidden print:block mt-4 pt-4 border-t border-border text-[10px] text-muted-foreground">
            <div className="flex gap-8">
              <span>Reviewed by: ______________________________</span>
              <span>Date: __________________</span>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // Narrative variant - single-paragraph summary used on dashboards and detail.
  const narrative = buildNarrative(intersection, sim, rec);
  return (
    <div className={noPrint ? 'flex flex-col gap-4' : 'flex flex-col gap-4 print:gap-2'}>
      <div className="rounded-lg border border-border bg-muted/30 p-4 print:p-3 print:break-inside-avoid bg-white">
        <h3 className="text-md font-semibold text-muted-foreground uppercase tracking-wide mb-2 print:mb-1">
          Summary
        </h3>
        <p className="text-sm leading-relaxed print:text-xs">{narrative}</p>
      </div>
    </div>
  );
}

function FindingRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground inline-flex items-center gap-1">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </>
  );
}

function buildComparisonProse(
  _intersection: Intersection,
  d: DecomposedSummary,
): string {
  const action = d.recAction;
  // Headline savings number: one figure, daily total. The peak-hour
  // breakdown that used to live here was cut as duplicate noise — the
  // ConfidenceBadge already says "across 100 simulated hours …" with
  // the CI bounds.
  const totalStr = d.vhSavedPerDay != null
    ? ` Estimated savings: ${d.vhSavedPerDay >= 0 ? '+' : ''}${d.vhSavedPerDay.toFixed(1)} vehicle-hours per day.`
    : '';

  if (!d.comparison) {
    return `Recommended action: ${action}.${totalStr}`;
  }

  const c = d.comparison;
  const majGreen = c.majorGreenProposed ?? c.majorGreenCurrent;
  const minGreen = c.minorGreenProposed ?? c.minorGreenCurrent;
  const greenStr = majGreen != null && minGreen != null
    ? ` Proposed green split: ${majGreen.toFixed(0)}s on ${c.majorLabel}, ${minGreen.toFixed(0)}s combined on ${c.minorLabel}.`
    : '';

  const head = (['no_action', 'monitor', 'no_analysis'] as ActionKind[]).includes(d.actionKind)
    ? `${c.majorLabel} is the dominant approach but volumes don’t justify a change.`
    : `${c.majorLabel} is the critical road versus ${c.minorLabel}. Recommended action: ${action}.`;

  return `${head}${greenStr}${totalStr}`;
}
