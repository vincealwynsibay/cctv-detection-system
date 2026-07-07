/**
 * Canonical catalogue of the traffic-signal warrants EyeGila evaluates.
 *
 * Single source of truth for warrant *meaning*, consumed by the warrant
 * reference dialog (components/WarrantReference), the Manual page, and any
 * inline tips, so the plain-English purpose, trigger and threshold never
 * drift between surfaces.
 *
 * Content is derived from the authoritative server evaluators:
 *   - MUTCD W1/W2/W4  → server/warrant_rules.py (MUTCD 2009 §4C)
 *   - Local WL-1/2/3  → server/local_warrants.py (Tagum City conditions)
 * Keep this file in step with those when thresholds change.
 */
import type { Recommendation } from '@/types';

export type WarrantGroup = 'mutcd' | 'local';

export interface WarrantInfo {
  /** Short code shown on chips/badges, e.g. 'W2', 'WL-1'. */
  code: string;
  /** Full warrant name. */
  name: string;
  group: WarrantGroup;
  /** Why this warrant exists: what it protects or catches. */
  purpose: string;
  /** Plain-language condition that makes it fire. */
  triggersWhen: string;
  /** The numeric threshold, in words. */
  threshold: string;
  /** Source reference (MUTCD section or "Tagum City local warrant"). */
  ref: string;
  /** Manual-page anchor slug (matches lib/jargon manualAnchor). */
  anchor: string;
  /** Recommendation fields carrying this warrant's result. */
  metKey: keyof Recommendation;
  confKey: keyof Recommendation;
}

export const WARRANTS: WarrantInfo[] = [
  // ── MUTCD (national) ───────────────────────────────────────────────────────
  {
    code: 'W1',
    name: 'Eight-Hour Vehicular Volume',
    group: 'mutcd',
    purpose:
      'Justifies a signal where both the major and minor streets stay busy through most of the day, not just at one peak.',
    triggersWhen:
      'Combined major + minor street volume clears the MUTCD threshold in at least 8 of any 24 hours.',
    threshold:
      'MUTCD 2009 Table 4C-1 (varies with lane count); thresholds drop to 70% where the 85th-percentile speed is ≤ 40 km/h.',
    ref: 'MUTCD 2009 §4C.02',
    anchor: 'warrant-1',
    metKey: 'warrant_1_met',
    confKey: 'warrant_1_confidence',
  },
  {
    code: 'W2',
    name: 'Four-Hour Vehicular Volume',
    group: 'mutcd',
    purpose:
      'Catches intersections with strong but shorter peaks that the all-day W1 test would miss.',
    triggersWhen:
      'Each of the four highest-volume hours clears the combined major/minor volume threshold.',
    threshold:
      'MUTCD 2009 Figure 4C-1 (curve by lane count); 70% low-speed adjustment at ≤ 40 km/h.',
    ref: 'MUTCD 2009 §4C.03',
    anchor: 'warrant-2',
    metKey: 'warrant_2_met',
    confKey: 'warrant_2_confidence',
  },
  {
    code: 'W4',
    name: 'Pedestrian Volume',
    group: 'mutcd',
    purpose:
      'Protects pedestrians where crossing demand is high relative to the gaps available in vehicle traffic.',
    triggersWhen:
      'Pedestrian crossing volume meets the MUTCD pedestrian threshold against major-street flow.',
    threshold: 'MUTCD 2009 §4C.05 pedestrian volume curves.',
    ref: 'MUTCD 2009 §4C.05',
    anchor: 'warrant-4',
    metKey: 'warrant_4_met',
    confKey: 'warrant_4_confidence',
  },

  // ── Local (Tagum City conditions) ──────────────────────────────────────────
  {
    code: 'WL-1',
    name: 'High Motorcycle / Pedicab Share',
    group: 'local',
    purpose:
      'MUTCD volumes assume car-based traffic. This flags intersections dominated by motorcycles, tricycles and pedicabs, whose gap-acceptance and queueing behave differently.',
    triggersWhen:
      'Motorcycles + tricycles + pedicabs make up 60% or more of vehicles in any time-of-day chunk.',
    threshold: '≥ 60% two/three-wheeler share (configurable per intersection).',
    ref: 'Tagum City local warrant',
    anchor: 'warrant-local-1',
    metKey: 'w_local_1_met',
    confKey: 'w_local_1_confidence',
  },
  {
    code: 'WL-2',
    name: 'Peak Concentration',
    group: 'local',
    purpose:
      'Identifies intersections whose demand is squeezed into one or two parts of the day, where a single all-day signal plan is a poor fit and time-of-day timing pays off.',
    triggersWhen:
      "The busiest one or two time-of-day chunks together carry 70% or more of the day's total volume.",
    threshold: '70% or more of daily volume in the top 1-2 chunks (configurable).',
    ref: 'Tagum City local warrant',
    anchor: 'warrant-local-2',
    metKey: 'w_local_2_met',
    confKey: 'w_local_2_confidence',
  },
  {
    code: 'WL-3',
    name: 'Lights-Off Candidate',
    group: 'local',
    purpose:
      'Finds periods so quiet that running the full signal only adds pointless delay; candidates for flashing / night mode instead of full operation.',
    triggersWhen:
      'Average PCU/hr per approach falls below 30 in any chunk; those chunks are marked signal-off.',
    threshold: '< 30 PCU/hr per approach (configurable).',
    ref: 'Tagum City local warrant',
    anchor: 'warrant-local-3',
    metKey: 'w_local_3_met',
    confKey: 'w_local_3_confidence',
  },
];

export interface WarrantStatus {
  info: WarrantInfo;
  /** True when this warrant tripped. Null = not evaluated (no local-warrant data). */
  met: boolean | null;
  /** 0..1 proximity/strength score, or null when unavailable. */
  confidence: number | null;
}

/** Read every warrant's met/confidence off a recommendation. */
export function warrantStatuses(rec: Recommendation): WarrantStatus[] {
  return WARRANTS.map(info => ({
    info,
    met: rec[info.metKey] as boolean | null,
    confidence: rec[info.confKey] as number | null,
  }));
}

/** Warrants that actually tripped, highest-confidence first. */
export function metWarrants(rec: Recommendation): WarrantStatus[] {
  return warrantStatuses(rec)
    .filter(s => s.met === true)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}
