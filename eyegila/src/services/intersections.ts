import { request } from './api';
import type { Intersection, OnboardingTask, SignalStatus } from '../types';

export interface SignalTimingPayload {
  signal_status: SignalStatus;
  existing_cycle_length?: number | null;
  existing_green_splits?: Record<string, number> | null;
}

export interface ImportResult {
  created_intersections: string[];
  created_cameras: string[];
  errors: string[];
}

export interface DetectTimingResult {
  intersection_id:   number;
  estimated_cycle_s: number | null;
  confidence:        'low' | 'medium' | 'high';
  note:              string;
  dispersion_index:  number | null;
  best_lag_min:      number | null;
  best_autocorr:     number | null;
}

export const intersectionsApi = {
  list: () => request<Intersection[]>('/intersections/'),

  get: (id: number) => request<Intersection>(`/intersections/${id}`),

  create: (data: { name: string; latitude: number; longitude: number }) =>
    request<Intersection>('/intersections/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: Partial<{ name: string; latitude: number; longitude: number }>) =>
    request<Intersection>(`/intersections/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: number) =>
    request<{ detail: string }>(`/intersections/${id}`, { method: 'DELETE' }),

  importCsv: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ImportResult>('/intersections/import', { method: 'POST', body: form });
  },

  patchTiming: (id: number, data: SignalTimingPayload) =>
    request<Intersection>(`/intersections/${id}/timing`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  detectTiming: (id: number) =>
    request<DetectTimingResult>(`/intersections/${id}/detect-timing`),

  dismissSetupTask: (id: number, task: OnboardingTask) =>
    request<Intersection>(`/intersections/${id}/dismiss-setup-task`, {
      method: 'POST',
      body: JSON.stringify({ task }),
    }),

  restoreSetupTask: (id: number, task: OnboardingTask) =>
    request<Intersection>(`/intersections/${id}/restore-setup-task`, {
      method: 'POST',
      body: JSON.stringify({ task }),
    }),
};
