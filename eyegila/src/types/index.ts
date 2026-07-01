export interface TodChunk {
  id: number;
  intersection_id: number;
  name: string;
  start_time: string;  // "HH:MM"
  end_time: string;    // "HH:MM"
}

export interface User {
  id: number;
  username: string;
  time: string;
}

export type SignalStatus = 'unsignalized' | 'fixed_time' | 'actuated';

export type OnboardingTask = 'cameras' | 'regions' | 'timing' | 'first_analysis';

export interface Intersection {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  signal_status: SignalStatus;
  existing_cycle_length: number | null;
  existing_green_splits: Record<string, number> | null;
  effective_green_splits: Record<string, number> | null;
  /** Onboarding tasks the operator has snoozed for this intersection. */
  dismissed_setup_tasks: OnboardingTask[];
  time: string;
}

export type ArmDirection = 'northbound' | 'southbound' | 'eastbound' | 'westbound' | 'unknown';

export interface Street {
  id: number;
  intersection_id: number;
  name: string;
  arm_direction: ArmDirection;
  time: string;
}

export interface CCTV {
  id: number;
  intersection_id: number;
  name: string;
  rtsp_url: string;
  status: 'online' | 'offline' | 'reconnecting';
  last_error: string | null;
  is_being_viewed: boolean;
  enabled: boolean;
  time: string;
}

export interface Region {
  id: number;
  cctv_id: number;
  street_id: number;
  direction: 'inbound' | 'outbound' | 'unknown';
  region_points: RegionPoint[];
  time: string;
}

export interface RegionPoint {
  x: number;
  y: number;
}

export interface Detection {
  id: number;
  cctv_id: number;
  type: string;
  time: string;
}

export interface Video {
  video_id: number;
  filename: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  total_frames: number | null;
  processed_frames: number;
  uploaded_at: string;
  processed_at: string | null;
}

export interface VideoStatus {
  video_id: number;
  status: string;
  total_frames: number | null;
  processed_frames: number;
  percent: number;
  processed_at: string | null;
}

export interface AggregationRow {
  intersection_id: number;
  intersection_name: string;
  street_id: number | null;  // null = camera has no regions (intersection-level count)
  direction: 'inbound' | 'outbound' | 'unknown';
  object_type: string;
  window_start: string;
  count: number;
}

export type InterventionClass = 'signalize' | 'road_widening' | 'timing_only';

export interface Intervention {
  class: InterventionClass;
  confidence: number;
}

export interface Recommendation {
  id: number;
  intersection_id: number;
  warrant_1_met: boolean;
  warrant_1_confidence: number;
  warrant_2_met: boolean;
  warrant_2_confidence: number;
  warrant_4_met: boolean;
  warrant_4_confidence: number;
  recommended: boolean;
  recommended_confidence: number | null;
  major_volume: number | null;
  minor_volume: number | null;
  peds: number | null;
  vpm: number | null;
  phf: number | null;
  hour_start: string | null;
  data_age_hours: number | null;
  notes: string | null;
  generated_at: string;
  timing_cycle: number | null;
  timing_chunk: string | null;
  w_local_1_met: boolean | null;
  w_local_1_confidence: number | null;
  w_local_2_met: boolean | null;
  w_local_2_confidence: number | null;
  w_local_3_met: boolean | null;
  w_local_3_confidence: number | null;
  intervention: Intervention | null;
  // Webster's proposal didn't beat the existing timing on any TOD chunk. Timing
  // and simulation rows still exist for transparency, but the SignalTiming page
  // renders them in a muted comparison mode rather than as a recommended plan.
  proposal_is_no_op: boolean;
  // Daily total vehicle-hours saved (positive) or added (negative) by Webster's
  // proposal across TOD chunks. Lets the dashboard reconcile the volume-based
  // MUTCD verdict with the delay-based outcome without fetching the full
  // simulation. Null when no simulation rows exist for this recommendation.
  webster_vh_saved_per_day: number | null;
}
