import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { cctvsApi } from '@/services/cctvs';
import { intersectionsApi } from '@/services/intersections';
import type { CCTV, Intersection } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Camera, Wifi, WifiOff, RefreshCw, Search, AlertTriangle,
  MonitorPlay, Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type StatusFilter = 'all' | 'online' | 'reconnecting' | 'offline';

const STATUS_META: Record<StatusFilter, { label: string; chip: string; icon: React.ReactNode; strip: string }> = {
  all:          { label: 'All',          chip: 'bg-muted text-foreground',          icon: <Camera className="size-3" />,    strip: 'bg-muted' },
  online:       { label: 'Online',       chip: 'bg-emerald-100 text-emerald-700',   icon: <Wifi className="size-3" />,      strip: 'bg-emerald-500' },
  reconnecting: { label: 'Reconnecting', chip: 'bg-amber-100 text-amber-700',       icon: <RefreshCw className="size-3" />, strip: 'bg-amber-400' },
  offline:      { label: 'Offline',      chip: 'bg-red-100 text-red-700',           icon: <WifiOff className="size-3" />,   strip: 'bg-red-500' },
};

function CameraCard({ cam, intersectionName, snapshotTick }: { cam: CCTV; intersectionName: string; snapshotTick: number }) {
  const meta = STATUS_META[cam.status as StatusFilter] ?? STATUS_META.offline;
  const isOnline = cam.status === 'online';

  return (
    <div data-testid="camera-card" data-camera-id={cam.id} className="rounded-xl border border-border bg-card flex flex-col overflow-hidden h-full">
      <div className={cn('h-1', meta.strip)} />
      <div className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <Link
              to={`/intersections/${cam.intersection_id}/cameras/${cam.id}`}
              className="font-semibold text-sm leading-tight truncate hover:underline underline-offset-2 block"
            >
              {cam.name}
            </Link>
            <Link
              to={`/intersections/${cam.intersection_id}`}
              className="text-[11px] text-muted-foreground hover:underline truncate block mt-0.5"
            >
              {intersectionName}
            </Link>
          </div>
          <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium flex items-center gap-1 shrink-0', meta.chip)}>
            {meta.icon}
            {cam.status}
          </span>
        </div>

        {isOnline ? (
          <Link
            to={`/intersections/${cam.intersection_id}/cameras/${cam.id}`}
            className="relative block aspect-video rounded-md overflow-hidden bg-black group"
            title="Open live stream"
          >
            <img
              src={cctvsApi.snapshotUrl(cam.id, snapshotTick)}
              alt={cam.name}
              className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span className="absolute bottom-1 right-1 text-[9px] text-white/80 bg-black/60 px-1.5 py-0.5 rounded">
              Snapshot
            </span>
          </Link>
        ) : (
          <div className="aspect-video rounded-md bg-muted/30 border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground">
            {cam.status === 'reconnecting'
              ? <RefreshCw className="size-5 text-amber-500 animate-spin" />
              : <WifiOff className="size-5 text-red-400" />}
            <span className="text-[10px]">{cam.status === 'reconnecting' ? 'Reconnecting…' : 'Offline'}</span>
          </div>
        )}

        {cam.last_error && !isOnline && (
          <div className="flex items-start gap-1.5 rounded-md bg-red-50 dark:bg-red-950/40 px-2 py-1.5 text-[10px] text-red-700 dark:text-red-300">
            <AlertTriangle className="size-3 shrink-0 mt-px" />
            <span className="line-clamp-2">{cam.last_error}</span>
          </div>
        )}

        <div className="flex items-center gap-2 mt-auto">
          <Link to={`/intersections/${cam.intersection_id}/cameras/${cam.id}`} className="flex-1">
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 w-full">
              <MonitorPlay className="size-3" />
              Open
            </Button>
          </Link>
          <Link to={`/intersections/${cam.intersection_id}`}>
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1.5">
              <Settings2 className="size-3" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

export function CamerasPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialStatus = (searchParams.get('status') as StatusFilter | null);
  const validInitial: StatusFilter = initialStatus && initialStatus in STATUS_META ? initialStatus : 'all';

  const [cameras, setCameras]             = useState<CCTV[]>([]);
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [loading, setLoading]             = useState(true);
  const [filter, setFilter]               = useState<StatusFilter>(validInitial);
  const [query, setQuery]                 = useState('');
  // Cache-bust token for snapshot URLs. Bumps every 10 s so a camera that
  // drops mid-session is visible quickly without us holding an open stream
  // for every card on the grid.
  const [snapshotTick, setSnapshotTick]   = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setSnapshotTick(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  function selectFilter(next: StatusFilter) {
    setFilter(next);
    if (next === 'all') {
      searchParams.delete('status');
    } else {
      searchParams.set('status', next);
    }
    setSearchParams(searchParams, { replace: true });
  }

  useEffect(() => {
    Promise.all([cctvsApi.list(), intersectionsApi.list()])
      .then(([cams, ints]) => {
        setCameras(cams);
        setIntersections(ints);
      })
      .catch(err => toast.error(err instanceof Error ? err.message : 'Failed to load cameras'))
      .finally(() => setLoading(false));
  }, []);

  const interById = useMemo(() => {
    const m = new Map<number, Intersection>();
    for (const i of intersections) m.set(i.id, i);
    return m;
  }, [intersections]);

  const counts = useMemo(() => ({
    all:          cameras.length,
    online:       cameras.filter(c => c.status === 'online').length,
    reconnecting: cameras.filter(c => c.status === 'reconnecting').length,
    offline:      cameras.filter(c => c.status === 'offline').length,
  }), [cameras]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cameras
      .filter(c => filter === 'all' ? true : c.status === filter)
      .filter(c => {
        if (!q) return true;
        const interName = interById.get(c.intersection_id)?.name?.toLowerCase() ?? '';
        return c.name.toLowerCase().includes(q) || interName.includes(q);
      })
      .sort((a, b) => {
        // offline first within current filter so issues bubble up
        const order = (s: CCTV['status']) => s === 'offline' ? 0 : s === 'reconnecting' ? 1 : 2;
        const byStatus = order(a.status) - order(b.status);
        return byStatus !== 0 ? byStatus : a.name.localeCompare(b.name);
      });
  }, [cameras, filter, query, interById]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cameras</h1>
          <p className="text-sm text-muted-foreground mt-0.5 print:hidden">
            Connect, preview, and assign cameras to intersection approaches.
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {counts.all} camera{counts.all !== 1 ? 's' : ''} · {counts.offline} offline · {counts.reconnecting} reconnecting
          </p>
        </div>
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Search camera or intersection"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8 h-9 text-xs"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(['all', 'offline', 'reconnecting', 'online'] as StatusFilter[]).map(f => {
          const style = STATUS_META[f];
          const active = filter === f;
          return (
            <button
              key={f}
              data-testid={`filter-${f}`}
              onClick={() => selectFilter(f)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all border',
                active ? `${style.chip} border-current` : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40',
              )}
            >
              {style.icon}
              {style.label}
              <span className="tabular-nums opacity-70">{counts[f]}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-56" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <Camera className="size-8 text-muted-foreground opacity-40" />
          <div>
            <p className="font-medium text-sm">
              {cameras.length === 0 ? 'No cameras configured yet' : 'No cameras match this filter'}
            </p>
            {cameras.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                Add cameras from the dashboard setup wizard.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {filtered.map(cam => (
            <CameraCard
              key={cam.id}
              cam={cam}
              intersectionName={interById.get(cam.intersection_id)?.name ?? `Intersection #${cam.intersection_id}`}
              snapshotTick={snapshotTick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
