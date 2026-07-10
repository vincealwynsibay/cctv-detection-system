import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '@/context/AuthContext';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { cctvsApi } from '@/services/cctvs';
import { streetsApi } from '@/services/streets';
import { intersectionsApi } from '@/services/intersections';
import { request, triggerUnauthorized } from '@/services/api';
import type { CCTV, Street, Region, RegionPoint, Intersection, ArmDirection } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { ArrowLeft, Plus, Trash2, Loader2, Pencil, Check, X, MapPin, MonitorPlay, Eye, EyeOff, RotateCcw, RefreshCw, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

const REGION_COLORS = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899',
];

const ARM_DIRECTION_OPTIONS: { value: ArmDirection; label: string; short: string }[] = [
  { value: 'unknown',    label: 'Unknown',    short: '?' },
  { value: 'northbound', label: 'Northbound', short: 'NB' },
  { value: 'southbound', label: 'Southbound', short: 'SB' },
  { value: 'eastbound',  label: 'Eastbound',  short: 'EB' },
  { value: 'westbound',  label: 'Westbound',  short: 'WB' },
];

interface RegionWithName extends Region {
  streetName?: string;
  colorIndex: number;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const WS_BASE = import.meta.env.DEV ? 'ws://localhost:8000' : `ws://${window.location.host}/api`;

function maskRtsp(url: string): string {
  return url.replace(/(:\/\/)([^:@]+:[^@]+)@/, '$1•••@');
}


// ── Inline editable street row ────────────────────────────────────────────────
function StreetRow({
  street,
  onUpdated,
  onDeleted,
}: {
  street: Street;
  onUpdated: (id: number, patch: Partial<Street>) => void;
  onDeleted: (id: number) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(street.name);
  const [saving, setSaving] = useState(false);

  async function saveName() {
    if (!nameValue.trim() || nameValue === street.name) { setEditingName(false); return; }
    setSaving(true);
    try {
      await streetsApi.update(street.id, { name: nameValue.trim() });
      onUpdated(street.id, { name: nameValue.trim() });
      setEditingName(false);
    } catch {
      toast.error('Failed to rename street');
    } finally {
      setSaving(false);
    }
  }

  async function saveArmDirection(dir: ArmDirection) {
    try {
      await streetsApi.update(street.id, { arm_direction: dir });
      onUpdated(street.id, { arm_direction: dir });
    } catch {
      toast.error('Failed to update arm direction');
    }
  }

  const armOpt = ARM_DIRECTION_OPTIONS.find(o => o.value === (street.arm_direction ?? 'unknown'));

  return (
    <div className="flex items-center gap-1 py-1 group">
      {/* Arm direction badge / select */}
      <Select value={street.arm_direction ?? 'unknown'} onValueChange={v => saveArmDirection(v as ArmDirection)}>
        <SelectTrigger className={cn(
          'h-5 w-10 px-1 text-[10px] font-mono border rounded shrink-0 focus:ring-0',
          street.arm_direction === 'unknown' || !street.arm_direction
            ? 'border-muted text-muted-foreground'
            : 'border-blue-400/60 text-blue-700 bg-blue-50',
        )}>
          <SelectValue>{armOpt?.short ?? '?'}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ARM_DIRECTION_OPTIONS.map(o => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Street name */}
      {editingName ? (
        <>
          <Input
            autoFocus
            value={nameValue}
            onChange={e => setNameValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
            className="h-7 text-xs flex-1"
          />
          <Button size="icon" variant="ghost" className="size-7" onClick={saveName} disabled={saving}>
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-emerald-600" />}
          </Button>
          <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditingName(false)}>
            <X className="size-3" />
          </Button>
        </>
      ) : (
        <>
          <span className="text-xs flex-1 truncate">{street.name}</span>
          <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => setEditingName(true)}>
            <Pencil className="size-3" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive">
                <Trash2 className="size-3" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete "{street.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  Regions linked to this street will lose their street association.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => onDeleted(street.id)} className="bg-destructive text-destructive-foreground">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

// ── Stream-health row ──────────────────────────────────────────────────────

function HealthRow({
  label, hint, state, value,
}: {
  label: string;
  hint:  string;
  state: 'ok' | 'warn' | 'bad';
  value: string;
}) {
  const dotClass = state === 'ok'
    ? 'bg-emerald-500'
    : state === 'warn'
      ? 'bg-amber-400'
      : 'bg-rose-500';
  const valueClass = state === 'ok'
    ? 'text-emerald-700 dark:text-emerald-400'
    : state === 'warn'
      ? 'text-amber-700 dark:text-amber-400'
      : 'text-rose-700 dark:text-rose-400';
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <span className={cn('size-2 rounded-full shrink-0 mt-1', dotClass)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className={cn('text-[11px] font-mono tabular-nums', valueClass)}>
            {value}
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-snug">
          {hint}
        </p>
      </div>
    </li>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function CameraDetailPage() {
  const { id, intersectionId } = useParams<{ id: string; intersectionId?: string }>();
  const cctv_id = Number(id);
  const { token } = useContext(AuthContext);
  const navigate = useNavigate();

const [cctv, setCctv] = useState<CCTV | null>(null);
  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [streets, setStreets] = useState<Street[]>([]);
  const [regions, setRegions] = useState<RegionWithName[]>([]);
  const [loading, setLoading] = useState(true);

  // Region drawing
  const [drawing, setDrawing] = useState(false);
  const [points, setPoints] = useState<RegionPoint[]>([]);
  const [selectedStreet, setSelectedStreet] = useState<string>('');
  const [selectedDirection, setSelectedDirection] = useState<string>('unknown');
  const [saving, setSaving] = useState(false);

  const redrawRef = useRef<() => void>(() => {});

  // Intersection inline edit
  const [editingIntersection, setEditingIntersection] = useState(false);
  const [intersectionName, setIntersectionName] = useState('');
  const [savingIntersection, setSavingIntersection] = useState(false);

  // Add street
  const [newStreetName, setNewStreetName] = useState('');
  const [addingStreet, setAddingStreet] = useState(false);

  // Camera name / RTSP URL inline edit
  const [editingCamName, setEditingCamName] = useState(false);
  const [camNameValue, setCamNameValue] = useState('');
  const [editingRtspUrl, setEditingRtspUrl] = useState(false);
  const [rtspUrlValue, setRtspUrlValue] = useState('');
  const [showRtspUrl, setShowRtspUrl] = useState(false);
  const [savingCam, setSavingCam] = useState(false);

  // Canvas / stream
  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'live' | 'error' | 'reconnecting'>('connecting');
  const [workerLive, setWorkerLive] = useState<boolean | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [retrying, setRetrying] = useState(false);

  async function loadData() {
    try {
      const [cam, allStreets] = await Promise.all([cctvsApi.get(cctv_id), streetsApi.list()]);
      setCctv(cam);
      const camStreets = allStreets.filter(s => s.intersection_id === cam.intersection_id);
      setStreets(camStreets);

      if (cam.intersection_id) {
        const inter = await intersectionsApi.get(cam.intersection_id);
        setIntersection(inter);
        setIntersectionName(inter.name);
      }

      const allRegions: Region[] = await request('/regions/');
      const camRegions = allRegions.filter(r => r.cctv_id === cctv_id);
      setRegions(camRegions.map((r, i) => ({
        ...r,
        streetName: allStreets.find(s => s.id === r.street_id)?.name,
        colorIndex: i % REGION_COLORS.length,
      })));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load camera');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [cctv_id]);

  useEffect(() => {
    async function checkWorker() {
      try {
        const data = await request<{ worker_live: boolean }>(`/cctvs/${cctv_id}/worker-status`);
        setWorkerLive(data.worker_live);
      } catch { setWorkerLive(false); }
    }
    checkWorker();
    const interval = setInterval(checkWorker, 5000);
    return () => clearInterval(interval);
  }, [cctv_id]);

  useEffect(() => {
    if (cctv) {
      setCamNameValue(cctv.name);
      setRtspUrlValue(cctv.rtsp_url);
    }
  }, [cctv?.id]);

  async function saveCamName() {
    if (!cctv || !camNameValue.trim() || camNameValue === cctv.name) { setEditingCamName(false); return; }
    setSavingCam(true);
    try {
      await cctvsApi.update(cctv.id, { name: camNameValue.trim() });
      setCctv(prev => prev ? { ...prev, name: camNameValue.trim() } : prev);
      setEditingCamName(false);
      toast.success('Camera renamed');
    } catch { toast.error('Failed to rename camera'); }
    finally { setSavingCam(false); }
  }

  async function handleRetry() {
    if (!cctv) return;
    setRetrying(true);
    try {
      await cctvsApi.retry(cctv.id);
      toast.success('Retry signal sent - worker will reconnect immediately');
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const message = err instanceof Error ? err.message : 'Failed to send retry signal';
      if (status === 409) {
        toast.warning(message);
      } else {
        toast.error(message);
      }
    } finally {
      setRetrying(false);
    }
    setReconnectKey(k => k + 1);
  }

  async function handleToggleEnabled() {
    if (!cctv) return;
    setRetrying(true);
    try {
      if (cctv.enabled) {
        await cctvsApi.disable(cctv.id);
        toast.success('Camera disabled - worker will stop trying to reconnect');
      } else {
        await cctvsApi.enable(cctv.id);
        toast.success('Camera enabled - worker will reclaim shortly');
      }
      await loadData();
    } catch {
      toast.error(cctv.enabled ? 'Disable failed' : 'Enable failed');
    } finally {
      setRetrying(false);
    }
    setReconnectKey(k => k + 1);
  }

  async function saveRtspUrl() {
    if (!cctv || rtspUrlValue.trim() === cctv.rtsp_url) { setEditingRtspUrl(false); return; }
    setSavingCam(true);
    try {
      await cctvsApi.update(cctv.id, { rtsp_url: rtspUrlValue.trim() });
      setCctv(prev => prev ? { ...prev, rtsp_url: rtspUrlValue.trim() } : prev);
      setEditingRtspUrl(false);
      toast.success('RTSP URL updated - camera will reconnect');
    } catch { toast.error('Failed to update RTSP URL'); }
    finally { setSavingCam(false); }
  }

  // Container size → canvas dimensions
  // Depends on `loading` so it re-runs once the container div actually mounts
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // WebSocket → video canvas (server burns boxes onto frames before sending)
  useEffect(() => {
    if (loading) return;
    // Don't open the socket without a token - the server would close it with
    // 4001 and the unauth handler would fire a "Session expired" toast. Wait
    // for the token to arrive (effect re-runs on token change) instead.
    if (!token) return;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Track the most-recently created socket so reconnected sockets (spawned by
    // the onclose retry timer) are also closed on unmount. Also: token is in the
    // dep array so that if the session rotates, the old socket is torn down and a
    // new one opens with the fresh token instead of using the stale closure value.
    let activeWs: WebSocket | null = null;

    function connect() {
      if (stopped) return;
      setWsStatus('connecting');
      const ws = new WebSocket(`${WS_BASE}/cctvs/${cctv_id}/ws?token=${token}&overlay=true`);
      activeWs = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen  = () => setWsStatus('live');
      ws.onerror = () => setWsStatus('error');
      ws.onclose = (event: CloseEvent) => {
        if (event.code === 4001) { triggerUnauthorized(); return; }
        setWsStatus('error');
        if (!stopped) retryTimer = setTimeout(connect, 3000);
      };
      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        // Text frame = status message from server (e.g. reconnecting)
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.status === 'reconnecting') setWsStatus('reconnecting');
          } catch { /* ignore */ }
          return;
        }
        setWsStatus('live');
        const canvas = videoCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const blob = new Blob([event.data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          const cw = canvas.width, ch = canvas.height;
          const scale = Math.min(cw / img.width, ch / img.height);
          const dw = img.width * scale, dh = img.height * scale;
          const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, dx, dy, dw, dh);
          URL.revokeObjectURL(url);
          redrawRef.current();
        };
        img.src = url;
      };
    }

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      activeWs?.close();
    };
  }, [cctv_id, loading, token, reconnectKey]);

  // Sync canvas internal resolution to container size, scaled by devicePixelRatio for sharp rendering
  useEffect(() => {
    if (!canvasSize) return;
    const dpr = window.devicePixelRatio || 1;
    const vc = videoCanvasRef.current;
    const oc = overlayCanvasRef.current;
    if (vc) { vc.width = canvasSize.w * dpr; vc.height = canvasSize.h * dpr; }
    if (oc) { oc.width = canvasSize.w * dpr; oc.height = canvasSize.h * dpr; }
  }, [canvasSize]);

  // Redraw region overlay (boxes are now burned into video frames server-side)
  const redrawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !canvasSize) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = canvasSize;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // saved region polygons
    for (const region of regions) {
      if (region.region_points.length < 2) continue;
      const color = REGION_COLORS[region.colorIndex];
      ctx.beginPath();
      ctx.moveTo(region.region_points[0].x * w, region.region_points[0].y * h);
      for (const p of region.region_points.slice(1)) ctx.lineTo(p.x * w, p.y * h);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(color, 0.22);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      const cx = region.region_points.reduce((a, p) => a + p.x, 0) / region.region_points.length;
      const cy = region.region_points.reduce((a, p) => a + p.y, 0) / region.region_points.length;
      ctx.fillStyle = color;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      const dirLabel = region.direction !== 'unknown' ? ` (${region.direction})` : '';
      ctx.fillText((region.streetName ?? `Region ${region.id}`) + dirLabel, cx * w, cy * h);
    }

    // in-progress polygon
    if (drawing && points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(points[0].x * w, points[0].y * h);
      for (const p of points.slice(1)) ctx.lineTo(p.x * w, p.y * h);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < points.length; i++) {
        ctx.beginPath();
        ctx.arc(points[i].x * w, points[i].y * h, i === 0 ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#22c55e' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }, [drawing, points, regions, canvasSize]);

  useEffect(() => {
    redrawRef.current = redrawOverlay;
    redrawOverlay();
  }, [redrawOverlay]);

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drawing || !canvasSize) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (points.length >= 3 && Math.hypot(x - points[0].x, y - points[0].y) < 0.015) {
      finishPolygon(); return;
    }
    setPoints(prev => [...prev, { x, y }]);
  }

  async function finishPolygon() {
    if (!selectedStreet) { toast.error('Select a street first'); return; }
    if (points.length < 3) { toast.error('Need at least 3 points'); return; }
    setSaving(true);
    try {
      await request('/regions/', {
        method: 'POST',
        body: JSON.stringify({
          cctv_id,
          street_id: Number(selectedStreet),
          direction: selectedDirection,
          region_points: points,
        }),
      });
      toast.success('Region saved');
      setPoints([]); setDrawing(false);
      await loadData();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally { setSaving(false); }
  }

  async function handleDeleteRegion(regionId: number) {
    try {
      await request(`/regions/${regionId}`, { method: 'DELETE' });
      toast.success('Region deleted');
      await loadData();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function saveIntersectionName() {
    if (!intersection || !intersectionName.trim()) return;
    setSavingIntersection(true);
    try {
      await intersectionsApi.update(intersection.id, { name: intersectionName.trim() });
      setIntersection(prev => prev ? { ...prev, name: intersectionName.trim() } : prev);
      setEditingIntersection(false);
      toast.success('Intersection renamed');
    } catch { toast.error('Failed to rename intersection'); }
    finally { setSavingIntersection(false); }
  }

  async function handleAddStreet() {
    if (!newStreetName.trim() || !cctv?.intersection_id) return;
    setAddingStreet(true);
    try {
      const s = await streetsApi.create({ intersection_id: cctv.intersection_id, name: newStreetName.trim() });
      setStreets(prev => [...prev, s]);
      setNewStreetName('');
      toast.success(`Street "${s.name}" added`);
    } catch { toast.error('Failed to add street'); }
    finally { setAddingStreet(false); }
  }

  async function handleDeleteStreet(id: number) {
    try {
      await streetsApi.delete(id);
      setStreets(prev => prev.filter(s => s.id !== id));
      if (selectedStreet === String(id)) setSelectedStreet('');
      toast.success('Street deleted');
      await loadData();
    } catch { toast.error('Failed to delete street'); }
  }

  function handleStreetUpdated(id: number, patch: Partial<Street>) {
    setStreets(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
    if (patch.name !== undefined) {
      setRegions(prev => prev.map(r => r.street_id === id ? { ...r, streetName: patch.name } : r));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => intersectionId ? navigate(`/intersections/${intersectionId}`) : navigate(-1)}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{cctv?.name ?? 'Camera'}</h1>
          <p className="text-xs text-muted-foreground mt-0.5 print:hidden">
            Live preview, detection regions, and stream health for this camera.
          </p>
        </div>
        {/* Single stream-health badge consolidating three layers that used to
            sit as three competing badges (camera / websocket / worker). The
            dominant state collapses to one verdict; the popover breaks it
            apart so engineers can still diagnose which layer is broken. */}
        {cctv && (() => {
          const camStr   = cctv.status; // 'online' | 'offline' | 'reconnecting'
          const wsStr    = wsStatus;    // 'live' | 'connecting' | 'reconnecting' | 'error'
          const workerStr = workerLive === null ? 'unknown' : workerLive ? 'live' : 'offline';

          // Worst layer wins. Red beats amber beats green.
          const anyRed   = camStr === 'offline' || wsStr === 'error' || workerStr === 'offline';
          const allGreen = camStr === 'online' && wsStr === 'live' && (workerStr === 'live' || workerStr === 'unknown');
          const tone     = anyRed ? 'red' : allGreen ? 'green' : 'amber';

          const verdictLabel = tone === 'green' ? '● Live'
                              : tone === 'amber' ? '○ Degraded'
                              : '✕ Offline';
          const verdictClass = tone === 'green'
            ? 'border-emerald-500/40 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30'
            : tone === 'amber'
              ? 'border-amber-500/40 text-amber-600 bg-amber-50 dark:bg-amber-950/30'
              : 'border-destructive/40 text-destructive bg-destructive/10';

          return (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="badge-camera-status"
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ml-2 hover:opacity-80 transition-opacity',
                    verdictClass,
                  )}
                  title="Stream health - click for layer breakdown"
                >
                  {verdictLabel}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-0">
                <div className="px-4 py-2.5 border-b border-border">
                  <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                    Stream health
                  </p>
                  <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-snug">
                    Three layers between the camera and your browser. The
                    badge shows the worst.
                  </p>
                </div>
                <ul className="flex flex-col divide-y divide-border text-xs">
                  <HealthRow
                    label="Camera"
                    hint="RTSP feed reaching the worker"
                    state={camStr === 'online' ? 'ok' : camStr === 'offline' ? 'bad' : 'warn'}
                    value={camStr}
                  />
                  <HealthRow
                    label="Worker"
                    hint="Detection process consuming the feed"
                    state={workerStr === 'live' ? 'ok' : workerStr === 'offline' ? 'bad' : 'warn'}
                    value={workerStr}
                  />
                  <HealthRow
                    label="Preview stream"
                    hint="WebSocket pushing frames to this browser"
                    state={wsStr === 'live' ? 'ok' : wsStr === 'error' ? 'bad' : 'warn'}
                    value={wsStr}
                  />
                </ul>
              </PopoverContent>
            </Popover>
          );
        })()}
        <div className="flex rounded-md border border-border overflow-hidden shrink-0">
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-foreground text-background"
          >
            <Pencil className="size-3" />
            Edit
          </button>
          <button
            type="button"
            disabled={!cctv?.intersection_id}
            onClick={() => cctv?.intersection_id && navigate(`/intersections/${cctv.intersection_id}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border-l border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <MonitorPlay className="size-3" />
            Live
          </button>
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-80 w-full rounded-lg" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          {/* ── Video + overlay ── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Live Stream</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                ref={containerRef}
                data-testid="feed-container"
                className="relative overflow-hidden rounded-md bg-black"
                style={{ aspectRatio: '16/9' }}
              >
                <canvas ref={videoCanvasRef} className="absolute inset-0 w-full h-full" />
                <canvas
                  ref={overlayCanvasRef}
                  className="absolute inset-0 w-full h-full"
                  style={{ cursor: drawing ? 'crosshair' : 'default' }}
                  onClick={handleCanvasClick}
                  onDoubleClick={() => { if (drawing && points.length >= 3) finishPolygon(); }}
                />
                {wsStatus === 'reconnecting' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 className="size-6 text-white animate-spin" />
                      <span className="text-white/70 text-xs">Camera reconnecting…</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleRetry}
                          disabled={retrying}
                          className="flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors px-3 py-1.5 text-xs text-white/80 disabled:opacity-50"
                        >
                          {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                          Reconnect
                        </button>
                        <button
                          type="button"
                          onClick={handleToggleEnabled}
                          disabled={retrying}
                          className="flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors px-3 py-1.5 text-xs text-white/80 disabled:opacity-50"
                          title="Disable - stop the worker from reconnecting until re-enabled"
                        >
                          <WifiOff className="size-3" />
                          Disable
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {wsStatus !== 'live' && wsStatus !== 'reconnecting' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    {wsStatus === 'error' ? (
                      <>
                        <span className="text-white/50 text-sm">Stream unavailable</span>
                        <button
                          type="button"
                          onClick={handleRetry}
                          disabled={retrying}
                          className="flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors px-3 py-1.5 text-xs text-white/80 disabled:opacity-50"
                        >
                          {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                          Reconnect
                        </button>
                      </>
                    ) : (
                      <Loader2 className="size-5 text-white/30 animate-spin" />
                    )}
                  </div>
                )}
              </div>

              {drawing && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="text-green-600 font-medium">Drawing</span>
                  <span>· click to add · dbl-click or click ① to close</span>
                  <div className="ml-auto flex gap-2">
                    {points.length >= 3 && (
                      <Button size="sm" variant="outline" onClick={finishPolygon} disabled={saving}>
                        {saving && <Loader2 className="size-3 mr-1 animate-spin" />}
                        Save region
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => { setDrawing(false); setPoints([]); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Right panel ── */}
          <div className="flex flex-col gap-4">

            {/* Camera Settings */}
            {cctv && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Camera Settings</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {/* Name */}
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Name</Label>
                    {editingCamName ? (
                      <div className="flex gap-1">
                        <Input
                          data-testid="input-cam-name"
                          autoFocus
                          value={camNameValue}
                          onChange={e => setCamNameValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveCamName(); if (e.key === 'Escape') { setEditingCamName(false); setCamNameValue(cctv.name); } }}
                          className="h-7 text-xs"
                        />
                        <Button size="icon" variant="ghost" className="size-7" onClick={saveCamName} disabled={savingCam}>
                          {savingCam ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-emerald-600" />}
                        </Button>
                        <Button size="icon" variant="ghost" className="size-7" onClick={() => { setEditingCamName(false); setCamNameValue(cctv.name); }}>
                          <X className="size-3" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 group">
                        <span data-testid="display-cam-name" className="text-sm font-medium flex-1 truncate">{cctv.name}</span>
                        <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => setEditingCamName(true)}>
                          <Pencil className="size-3" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Enable / retry / disable */}
                  {!cctv.enabled ? (
                    <div className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                      <span className="text-xs text-amber-600">Disabled - worker will not connect to this camera.</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleToggleEnabled}
                        disabled={retrying}
                        className="h-7 px-2.5 text-xs self-start"
                      >
                        {retrying ? <Loader2 className="size-3 mr-1 animate-spin" /> : <RefreshCw className="size-3 mr-1" />}
                        Enable camera
                      </Button>
                    </div>
                  ) : cctv.status !== 'online' && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleRetry}
                        disabled={retrying}
                        className="h-7 px-2.5 text-xs self-start"
                      >
                        {retrying ? <Loader2 className="size-3 mr-1 animate-spin" /> : <RotateCcw className="size-3 mr-1" />}
                        Retry connection
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleToggleEnabled}
                        disabled={retrying}
                        className="h-7 px-2.5 text-xs self-start text-muted-foreground hover:text-foreground"
                        title="Stop the worker from reconnecting until re-enabled"
                      >
                        <WifiOff className="size-3 mr-1" />
                        Disable
                      </Button>
                    </div>
                  )}

                  {/* RTSP URL */}
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">RTSP URL</Label>
                    {editingRtspUrl ? (
                      <div className="flex gap-1">
                        <Input
                          autoFocus
                          value={rtspUrlValue}
                          onChange={e => setRtspUrlValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') saveRtspUrl();
                            if (e.key === 'Escape') { setEditingRtspUrl(false); setRtspUrlValue(cctv.rtsp_url); }
                          }}
                          className="h-7 text-xs font-mono"
                          placeholder="rtsp://..."
                          data-testid="input-rtsp-url"
                        />
                        <Button size="icon" variant="ghost" className="size-7" onClick={saveRtspUrl} disabled={savingCam}>
                          {savingCam ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-emerald-600" />}
                        </Button>
                        <Button size="icon" variant="ghost" className="size-7" onClick={() => { setEditingRtspUrl(false); setRtspUrlValue(cctv.rtsp_url); }}>
                          <X className="size-3" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 group">
                        <span
                          className="text-xs font-mono flex-1 truncate text-muted-foreground"
                          data-testid="display-rtsp-url"
                          title={cctv.rtsp_url}
                        >
                          {showRtspUrl ? cctv.rtsp_url : maskRtsp(cctv.rtsp_url)}
                        </span>
                        <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => setShowRtspUrl(v => !v)}>
                          {showRtspUrl ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                        </Button>
                        <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => { setRtspUrlValue(cctv.rtsp_url); setEditingRtspUrl(true); }}>
                          <Pencil className="size-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Intersection */}
            {intersection && (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <MapPin className="size-3.5 text-muted-foreground" />
                    <CardTitle className="text-sm">Intersection</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {editingIntersection ? (
                    <div className="flex gap-1">
                      <Input
                        autoFocus
                        value={intersectionName}
                        onChange={e => setIntersectionName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveIntersectionName(); if (e.key === 'Escape') setEditingIntersection(false); }}
                        className="h-7 text-xs"
                      />
                      <Button size="icon" variant="ghost" className="size-7" onClick={saveIntersectionName} disabled={savingIntersection}>
                        {savingIntersection ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-emerald-600" />}
                      </Button>
                      <Button size="icon" variant="ghost" className="size-7" onClick={() => { setEditingIntersection(false); setIntersectionName(intersection.name); }}>
                        <X className="size-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 group">
                      <button
                        type="button"
                        onClick={() => navigate(`/intersections/${intersection.id}`)}
                        className="text-sm font-medium flex-1 text-left hover:underline underline-offset-2"
                      >
                        {intersection.name}
                      </button>
                      <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => setEditingIntersection(true)}>
                        <Pencil className="size-3" />
                      </Button>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {intersection.latitude.toFixed(5)}, {intersection.longitude.toFixed(5)}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Streets */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Streets ({streets.length})</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {streets.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No streets yet - add one below.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {streets.map(s => (
                      <StreetRow
                        key={s.id}
                        street={s}
                        onUpdated={handleStreetUpdated}
                        onDeleted={handleDeleteStreet}
                      />
                    ))}
                  </div>
                )}
                <Separator />
                <div className="flex gap-1.5">
                  <Input
                    placeholder="New street name…"
                    value={newStreetName}
                    onChange={e => setNewStreetName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddStreet(); }}
                    className="h-7 text-xs"
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2.5"
                    onClick={handleAddStreet}
                    disabled={!newStreetName.trim() || addingStreet || !cctv?.intersection_id}
                  >
                    {addingStreet ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Draw region */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Draw Region</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Link to street</Label>
                  <Select value={selectedStreet} onValueChange={setSelectedStreet}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={streets.length ? 'Select street…' : 'Add a street first'} />
                    </SelectTrigger>
                    <SelectContent>
                      {streets.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Direction</Label>
                  <Select value={selectedDirection} onValueChange={setSelectedDirection}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unknown">Unknown</SelectItem>
                      <SelectItem value="inbound">Inbound (towards intersection)</SelectItem>
                      <SelectItem value="outbound">Outbound (away from intersection)</SelectItem>
                    </SelectContent>
                  </Select>
                  {selectedStreet && selectedDirection === 'inbound' &&
                    regions.some(r => r.street_id === Number(selectedStreet) && r.direction === 'inbound') && (
                    <p className="text-[11px] text-amber-600 leading-tight">
                      This street already has an inbound region - adding another will double-count flow for timing.
                    </p>
                  )}
                </div>
                {!drawing ? (
                  <Button size="sm" onClick={() => { setDrawing(true); setPoints([]); }} disabled={!selectedStreet || !canvasSize}>
                    <Plus className="size-3.5 mr-1" />
                    Draw polygon
                  </Button>
                ) : (
                  <p className="text-xs text-green-600">
                    {points.length} pt{points.length !== 1 ? 's' : ''} placed.
                    {points.length < 3 ? ` Need ${3 - points.length} more.` : ' Close to save.'}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Regions list */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Regions ({regions.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {regions.length === 0 ? (
                  <p className="px-4 pb-4 text-xs text-muted-foreground">No regions yet.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {regions.map(r => (
                      <div key={r.id} className="flex items-center gap-2 px-4 py-2">
                        <div className="size-3 rounded-sm shrink-0" style={{ backgroundColor: REGION_COLORS[r.colorIndex] }} />
                        <span className="text-xs flex-1 truncate">{r.streetName ?? `Region ${r.id}`}</span>
                        {r.direction !== 'unknown' && (
                          <Badge variant="outline" className={cn(
                            'text-[9px] px-1 h-4',
                            r.direction === 'inbound' && 'border-blue-500/40 text-blue-600',
                            r.direction === 'outbound' && 'border-amber-500/40 text-amber-600',
                          )}>
                            {r.direction === 'inbound' ? '↓ in' : '↑ out'}
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground">{r.region_points.length}pt</span>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-6 text-destructive hover:text-destructive">
                              <Trash2 className="size-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete region?</AlertDialogTitle>
                              <AlertDialogDescription>Removes this region and all detection links.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDeleteRegion(r.id)} className="bg-destructive text-destructive-foreground">
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
