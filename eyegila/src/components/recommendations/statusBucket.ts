import type { RecommendationResponse } from '@/services/recommendations';

export type StatusBucket = 'warranted' | 'borderline' | 'not_warranted' | 'no_data';

const BORDERLINE_LOW = 0.3;
const BORDERLINE_HIGH = 0.5;

/** Classify a recommendation into one of four triage buckets.
 * `hour_start === null` covers rows written before the migration.
 * The triple-zero check covers the empty-data short-circuit.
 *
 * 'warranted' requires at least one *individual* warrant to be met. The CNN's
 * overall `recommended` flag and its per-warrant heads are independent and can
 * disagree (e.g. recommended=true with all of w1/w2/w4 below 0.5). Promoting
 * those edge cases to "Warranted" misled the Timing tab into showing a
 * Warranted badge alongside body copy that read "doesn't trigger any warrant".
 */
export function statusBucket(rec: RecommendationResponse): StatusBucket {
  if (
    rec.hour_start === null ||
    ((rec.major_volume ?? 0) === 0 && (rec.minor_volume ?? 0) === 0 && (rec.peds ?? 0) === 0)
  ) {
    return 'no_data';
  }
  const anyWarrantMet =
    rec.warrant_1_met || rec.warrant_2_met || rec.warrant_4_met ||
    !!rec.w_local_1_met || !!rec.w_local_2_met || !!rec.w_local_3_met;
  // Trust the individual warrant heads - they are the MUTCD gate. The CNN's
  // overall `recommended` flag can disagree with per-warrant heads (independent
  // output heads); we already guard the opposite edge case (recommended=true,
  // no warrant met) by not promoting that to 'warranted'.
  if (anyWarrantMet) return 'warranted';
  const confs = [rec.warrant_1_confidence, rec.warrant_2_confidence, rec.warrant_4_confidence];
  if (confs.some(c => c >= BORDERLINE_LOW && c < BORDERLINE_HIGH)) return 'borderline';
  return 'not_warranted';
}

export const BUCKET_LABEL: Record<StatusBucket, string> = {
  warranted: 'Warranted',
  borderline: 'Borderline',
  not_warranted: 'Not warranted',
  no_data: 'No data',
};

export const BUCKET_BADGE_CLASS: Record<StatusBucket, string> = {
  warranted:     'border-emerald-500/40 text-emerald-700 bg-emerald-50',
  borderline:    'border-amber-500/40 text-amber-700 bg-amber-50',
  not_warranted: 'border-muted text-muted-foreground bg-muted/40',
  no_data:       'border-rose-500/40 text-rose-700 bg-rose-50',
};
