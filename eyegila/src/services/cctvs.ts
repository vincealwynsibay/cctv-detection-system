import { request, getToken } from './api';
import type { CCTV } from '../types';

export const cctvsApi = {
  list: () => request<CCTV[]>('/cctvs/'),

  get: (id: number) => request<CCTV>(`/cctvs/${id}`),

  create: (data: { intersection_id: number; name: string; rtsp_url: string }) =>
    request<CCTV>('/cctvs/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: Partial<{ name: string; rtsp_url: string; intersection_id: number }>) =>
    request<CCTV>(`/cctvs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: number) =>
    request<{ detail: string }>(`/cctvs/${id}`, { method: 'DELETE' }),

  retry: (id: number) =>
    request<void>(`/cctvs/${id}/retry`, { method: 'POST' }),

  disable: (id: number) =>
    request<void>(`/cctvs/${id}/disable`, { method: 'POST' }),

  enable: (id: number) =>
    request<void>(`/cctvs/${id}/enable`, { method: 'POST' }),

  snapshotUrl: (id: number, cacheBust?: number | string) => {
    const token = getToken();
    // Without a token the server returns 401 - let the <img onError> show
    // the placeholder instead of issuing a doomed request.
    if (!token) return '';
    // The server sets Cache-Control: max-age=5 on snapshots, so a fresh URL
    // is the only way to force the browser to re-fetch and reveal a camera
    // that just went offline. Callers that want a stable URL omit cacheBust.
    const params = new URLSearchParams({ token });
    if (cacheBust != null) params.set('t', String(cacheBust));
    const q = `?${params.toString()}`;
    return import.meta.env.DEV
      ? `http://${window.location.hostname}:8000/cctvs/${id}/snapshot${q}`
      : `/api/cctvs/${id}/snapshot${q}`;
  },

  scanNvr: (data: { host: string; username: string; password: string; max_channels: number; subtype: number }) =>
    request<{ reachable: boolean; channels: { channel: number; rtsp_url: string }[] }>('/cctvs/scan-nvr', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  discover: (opts?: { simulate?: boolean; count?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.simulate) qs.set('simulate', 'true');
    if (opts?.count != null) qs.set('count', String(opts.count));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ address: string; rtsp_url: string | null; xaddrs: string[] }[]>(
      `/cctvs/discover${suffix}`,
    );
  },
};
