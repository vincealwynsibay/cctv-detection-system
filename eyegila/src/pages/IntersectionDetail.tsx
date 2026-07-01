import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { cctvsApi } from '@/services/cctvs';
import { IntersectionSummary } from '@/components/IntersectionSummary';
import { useIntersectionShell } from '@/components/IntersectionShell';
import { Card, CardContent } from '@/components/ui/card';
import {
  RefreshCw, Activity, TrendingUp, Clock,
  Camera, Wifi, WifiOff,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export function IntersectionDetailPage() {
  const { id }      = useParams<{ id: string }>();
  const interId = Number(id);

  // Live focuses on the *evidence* coming off cameras (counts + tiles +
  // intersection geometry). The reconciled verdict, warrant chips, and
  // re-analyse button now live in the shell-level banner so this page
  // stays a clean drilldown.
  const { intersection, rec, streets, cameras, sim, sseData } = useIntersectionShell();

  const liveCount = useMemo(() => {
    let total = 0;
    for (const row of sseData ?? []) {
      if (row.intersection_id === interId) total += row.count;
    }
    return total;
  }, [sseData, interId]);

  const peakCount = useMemo(() => {
    const major = rec?.major_volume ?? 0;
    const minor = rec?.minor_volume ?? 0;
    return major + minor;
  }, [rec]);

  const peakTimeLabel = useMemo(() => {
    if (!rec?.hour_start) return '-';
    const d = new Date(rec.hour_start);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString(undefined, {
      hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric',
    });
  }, [rec]);

  return (
    <div className="flex flex-col gap-4">
      {/* Headline metrics: live daily count + peak hour stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Daily count</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                  {sseData ? liveCount.toLocaleString() : '-'}
                </p>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  rolling total from live detections
                </p>
              </div>
              <div className="rounded-lg bg-emerald-100 p-2">
                <Activity className="size-4 text-emerald-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Warrant-hour volume</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                  {rec ? peakCount.toLocaleString() : '-'}
                </p>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  vph during the hour analysed (major + minor)
                </p>
              </div>
              <div className="rounded-lg bg-amber-100 p-2">
                <TrendingUp className="size-4 text-amber-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Peak time</p>
                <p className="mt-1 text-2xl font-black tabular-nums leading-tight">
                  {peakTimeLabel}
                </p>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  start of the busiest hour analysed
                </p>
              </div>
              <div className="rounded-lg bg-violet-100 p-2">
                <Clock className="size-4 text-violet-700" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Live cameras - visual confirmation that detections feeding the model
          are coming from real feeds. Click any tile to open its detail view. */}
      {cameras.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Camera className="size-3.5 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">
                Live feeds
              </p>
              <span className="text-[10px] text-muted-foreground/80">
                · {cameras.filter(c => c.status === 'online').length}/{cameras.length} online
              </span>
            </div>
          </div>
          <div className={cn(
            'grid gap-2',
            cameras.length === 1 ? 'grid-cols-1'
              : cameras.length === 2 ? 'grid-cols-2'
              : 'grid-cols-2 sm:grid-cols-4',
          )}>
            {cameras.slice(0, 4).map(cam => {
              const isOnline = cam.status === 'online';
              return (
                <Link
                  key={cam.id}
                  to={`/intersections/${cam.intersection_id}/cameras/${cam.id}`}
                  className="relative block aspect-video rounded-md overflow-hidden bg-black group border border-border"
                  title={`${cam.name} · ${cam.status}`}
                >
                  {isOnline ? (
                    <img
                      src={cctvsApi.snapshotUrl(cam.id)}
                      alt={cam.name}
                      className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                      onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
                      {cam.status === 'reconnecting'
                        ? <RefreshCw className="size-5 text-amber-400/80 animate-spin" />
                        : <WifiOff className="size-5 text-red-400" />}
                      <span className="text-[10px]">{cam.status}</span>
                    </div>
                  )}
                  <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1.5 pointer-events-none">
                    <span className={cn(
                      'size-1.5 rounded-full shrink-0',
                      cam.status === 'online'       ? 'bg-emerald-400 animate-pulse' :
                      cam.status === 'reconnecting' ? 'bg-amber-400' : 'bg-red-400',
                    )} />
                    <span className="text-[10px] text-white/90 leading-none truncate font-medium drop-shadow">
                      {cam.name}
                    </span>
                    {isOnline && (
                      <Wifi className="size-2.5 text-emerald-300 ml-auto" />
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {intersection && (
        <IntersectionSummary
          intersection={intersection}
          streets={streets}
          sim={sim}
          rec={rec}
        />
      )}
    </div>
  );
}
