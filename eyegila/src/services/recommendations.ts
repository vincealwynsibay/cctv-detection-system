import { request } from './api';
import type { Recommendation } from '@/types';

export interface RecommendationResponse extends Recommendation {
  intersection_name: string;
}

export interface DataHealthResponse {
  intersection_id: number;
  last_detection_at: string | null;
  data_age_hours: number | null;
  camera_ok: boolean;
  high_volume_days: string[];
  high_volume_days_note: string | null;
}

export type RecommenderMode = 'temporal_cnn' | 'scalar_baseline';

export type RecommenderVariant = 'synthetic_baseline' | 'real_trained_toronto' | 'custom';

export interface RecommenderModelInfo {
  mode:                  RecommenderMode;
  loaded:                boolean;
  variant?:              RecommenderVariant;
  training_data_source?: string;
  checkpoint_path?:      string | null;
  warrant_names?:        string[];
  intervention_classes?: string[];
  metadata_features?:    string[];
  n_warrants?:           number;
  training_metadata?:    Record<string, unknown>;
  detail?:               string;
}

export const recommendationsApi = {
  list(): Promise<RecommendationResponse[]> {
    return request('/recommendations/');
  },
  generate(intersectionId: number): Promise<RecommendationResponse> {
    return request(`/recommendations/generate/${intersectionId}`, { method: 'POST' });
  },
  generateAll(): Promise<RecommendationResponse[]> {
    return request('/recommendations/generate-all', { method: 'POST' });
  },
  history(intersectionId: number, limit = 50): Promise<RecommendationResponse[]> {
    return request(`/recommendations/history/${intersectionId}?limit=${limit}`);
  },
  updateNotes(id: number, notes: string | null): Promise<RecommendationResponse> {
    return request(`/recommendations/${id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
  },
  dataHealth(intersectionId: number): Promise<DataHealthResponse> {
    return request(`/recommendations/data-health/${intersectionId}`);
  },
  modelInfo(): Promise<RecommenderModelInfo> {
    return request<RecommenderModelInfo>('/recommendations/model-info');
  },
  // Returns the single most-recent recommendation for an intersection, or null
  // if none exists yet. Uses the history endpoint (limit=1) because there is no
  // dedicated /latest/:id route on the server.
  latest(intersectionId: number): Promise<RecommendationResponse | null> {
    return request<RecommendationResponse[]>(
      `/recommendations/history/${intersectionId}?limit=1`
    ).then(list => list[0] ?? null);
  },
};
