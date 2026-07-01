import { request } from './api';

export interface SimulationChunk {
  chunk_name: string;
  delay_before: number;
  delay_after: number;
  los_before: string;
  los_after: string;
  vc_ratio_before: number | null;
  vc_ratio_after: number | null;
  volume_pcu_hr: number;
  vehicle_hours_saved: number;
  queue_series_before: Record<string, number[]> | null;
  queue_series_after: Record<string, number[]> | null;
  // Real per-second vehicle counts from `detection_street_view`, keyed by
  // street_id. Only set by the on-demand `/simulation/compute` endpoint;
  // when present, the canvas/3D playback spawns vehicles from this schedule
  // instead of resampling Poisson from `volume_pcu_hr`.
  arrivals_per_second?: Record<string, number[]> | null;
  generated_at: string;
  // Only present on historical (on-demand) results
  measured_flows?: Record<string, number> | null;
  proposed_cycle_s?: number | null;
  proposed_splits?: Record<string, number> | null;
}

export interface DailySummary {
  total_vehicle_hours_saved: number;
  avg_delay_before: number;
  avg_delay_after: number;
  los_before: string;
  los_after: string;
  total_volume_pcu_hr: number;
}

export interface SimulationResponse {
  intersection_id: number;
  intersection_name: string;
  signal_status: string;
  baseline_note: string;
  existing_cycle_s: number | null;
  chunks: SimulationChunk[];
  daily_summary: DailySummary;
  // Only present on historical results
  window_start?: string;
  window_end?: string;
}

export interface StochasticStatBlock {
  mean: number;
  std: number;
  ci_low_95: number;
  ci_high_95: number;
  n_runs: number;
}

export interface StochasticApproachStats {
  approach_id: number;
  label: string;            // plain-English, e.g. "NB - Apokon Road"
  flow_pcu_hr: number;
  before: StochasticStatBlock;
  after:  StochasticStatBlock;
}

export interface StochasticConfidenceResponse {
  intersection_id: number;
  chunk_name: string;
  duration_sec: number;
  n_runs: number;
  label: 'high' | 'moderate' | 'marginal';
  sentence: string;
  vehicle_hours_saved: StochasticStatBlock;
  per_run_means: number[];
  per_approach: StochasticApproachStats[];
  analytical_reference_vh: number;
  cached: boolean;
}

export const simulationApi = {
  get: (intersectionId: number) =>
    request<SimulationResponse>(`/simulation/${intersectionId}`),

  compute: (params: { intersection_id: number; start: string; end: string }) =>
    request<SimulationResponse>('/simulation/compute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  stochasticConfidence: (intersectionId: number, chunkName?: string) => {
    const qs = chunkName ? `?chunk=${encodeURIComponent(chunkName)}` : '';
    return request<StochasticConfidenceResponse>(
      `/simulation/${intersectionId}/stochastic-confidence${qs}`,
    );
  },

  /** Run the 100-replay Monte Carlo against a user-picked time window. Pairs
   *  with simulationApi.compute so the deterministic windowed sim and the
   *  stochastic confidence cover the same period in the same units. */
  stochasticConfidenceWindow: (params: { intersection_id: number; start: string; end: string }) =>
    request<StochasticConfidenceResponse>('/simulation/stochastic-confidence/compute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
};
