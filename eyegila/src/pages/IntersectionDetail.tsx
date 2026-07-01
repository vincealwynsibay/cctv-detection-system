import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { cctvsApi } from '@/services/cctvs';
import { useIntersectionShell } from '@/components/IntersectionShell';
import { deriveIntersectionAction } from '@/lib/intersectionAction';
import { RefreshCw, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export function IntersectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const interId = Number(id);

  const { intersection, rec, streets, cameras, sim, sseData } = useIntersectionShell();
  const action = deriveIntersectionAction(rec, intersection, { sim });

  const liveCount = useMemo(() => {
    let total = 0;
    for (const row of sseData ?? []) {
      if (row.intersection_id === interId) total += row.count;
    }
    return total;
  }, [sseData, interId]);

  const peakCount = useMemo(() => (rec?.major_volume ?? 0) + (rec?.minor_volume ?? 0), [rec]);

  const peakTimeLabel = useMemo(() => {
    if (!rec?.hour_start) return null;
    const d = new Date(rec.hour_start);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }, [rec]);

  const vcCritical = useMemo(() => {
    if (!sim?.chunks?.length) return sim?.daily_summary?.vc_ratio_before ?? null;
    return sim.chunks.reduce((max, c) =>
      (c.vc_ratio_before ?? 0) > (max ?? 0) ? (c.vc_ratio_before ?? 0) : max, null as number | null,
    );
  }, [sim]);

  const hasSim = action.kind !== 'no_analysis';

  return (
    <div className="flex flex-col bg-card rounded-xl border border-border overflow-hidden">

      {hasSim && rec ? (
        <>
          {/* Two-column: metrics + approaches | camera feeds */}
          <div className="grid" style={{ gridTemplateColumns: '1.05fr 0.95fr' }}>
            {/* Left: Key metrics + Approaches */}
            <div className="px-10 py-7 border-r border-border">
              <p className="text-[14px] font-semibold text-foreground/70 mb-5">Key metrics</p>
              <div className="flex gap-0">
                <div className="flex-1 pr-5">
                  <div className="text-[11.5px] text-muted-foreground">Daily count</div>
                  <div className="mt-1.5 text-[30px] font-black tabular-nums leading-none text-foreground"
                    style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                    {sseData ? liveCount.toLocaleString() : '-'}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground mt-1.5">rolling live</div>
                </div>
                <div className="flex-1 px-5 border-l border-border">
                  <div className="text-[11.5px] text-muted-foreground">Warrant-hour</div>
                  <div className="mt-1.5 text-[30px] font-black tabular-nums leading-none text-foreground"
                    style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                    {rec ? peakCount.toLocaleString() : '-'}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground mt-1.5">
                    vph · {(rec?.major_volume ?? 0)} / {(rec?.minor_volume ?? 0)}
                  </div>
                </div>
                <div className="flex-1 pl-5 border-l border-border">
                  <div className="text-[11.5px] text-muted-foreground">Peak time</div>
                  <div className="mt-1.5 text-[26px] font-black tabular-nums leading-none text-foreground"
                    style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                    {peakTimeLabel ?? '-'}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground mt-1.5">busiest hour</div>
                </div>
              </div>

              {streets.length > 0 && (
                <div className="mt-7">
                  <p className="text-[14px] font-semibold text-foreground/70 mb-3">Approaches</p>
                  <div>
                    <div className="grid gap-3 pb-2 border-b border-border text-[11px] font-semibold text-muted-foreground"
                      style={{ gridTemplateColumns: '1.3fr 0.8fr 1.4fr' }}>
                      <span>Approach</span>
                      <span className="text-right">Volume</span>
                      <span />
                    </div>
                    {streets.map((street, i) => {
                      const vol = i === 0 ? (rec?.major_volume ?? 0) : (rec?.minor_volume ?? 0);
                      const maxVol = (rec?.major_volume ?? 0) + (rec?.minor_volume ?? 0);
                      const pct = maxVol > 0 ? (vol / maxVol) * 100 : 0;
                      const isCritical = i === 0 && (vcCritical ?? 0) >= 1;
                      return (
                        <div
                          key={street.id}
                          className="grid gap-3 py-3 items-center border-b border-border/60 last:border-0"
                          style={{ gridTemplateColumns: '1.3fr 0.8fr 1.4fr' }}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[13px] font-semibold text-foreground truncate">{street.name}</span>
                            {isCritical && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-600 shrink-0">Critical</span>
                            )}
                          </div>
                          <span className="text-right font-bold tabular-nums text-[13.5px]"
                            style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                            {vol.toLocaleString()}
                          </span>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Right: Live feeds */}
            <div className="px-10 py-7">
              <div className="flex items-baseline justify-between mb-5">
                <p className="text-[14px] font-semibold text-foreground/70">Live feeds</p>
                <span className="text-[11px] text-muted-foreground">
                  {cameras.filter(c => c.status === 'online').length} / {cameras.length} online
                </span>
              </div>

              {cameras.length > 0 ? (
                <div className={cn(
                  'grid gap-3.5',
                  cameras.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
                )}>
                  {cameras.slice(0, 4).map(cam => {
                    const isOnline = cam.status === 'online';
                    return (
                      <Link
                        key={cam.id}
                        to={`/intersections/${cam.intersection_id}/cameras/${cam.id}`}
                        className="relative block overflow-hidden rounded-xl bg-black group"
                        style={{ aspectRatio: '16/10', boxShadow: '0 12px 28px -14px rgba(20,40,30,0.5)' }}
                        title={`${cam.name} · ${cam.status}`}
                      >
                        {isOnline ? (
                          <img
                            src={cctvsApi.snapshotUrl(cam.id)}
                            alt={cam.name}
                            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                            onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                          />
                        ) : cam.status === 'reconnecting' ? (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted/20">
                            <RefreshCw className="size-5 text-amber-400 animate-spin" />
                          </div>
                        ) : (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted/20">
                            <WifiOff className="size-5 text-red-400" />
                          </div>
                        )}
                        <div className="absolute bottom-2 left-2 flex items-center gap-1.5 pointer-events-none">
                          <span className={cn(
                            'size-1.5 rounded-full shrink-0',
                            cam.status === 'online'       ? 'bg-emerald-400 animate-pulse' :
                            cam.status === 'reconnecting' ? 'bg-amber-400' : 'bg-red-400',
                          )} />
                          <span className="text-[9.5px] font-semibold text-white/90 leading-none drop-shadow truncate">
                            {cam.name}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground">No cameras configured for this intersection.</p>
              )}

              <div className="mt-4 px-4 py-3 rounded-xl bg-muted/40 text-[11.5px] text-muted-foreground leading-relaxed">
                All feeds contribute to the rolling count. Click a tile to open its detection view and region polygon.
              </div>
            </div>
          </div>
        </>
      ) : (
        /* No analysis yet - fallback minimal layout */
        <div className="flex flex-col gap-4 p-6 bg-card">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Daily count</p>
              <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                {sseData ? liveCount.toLocaleString() : '-'}
              </p>
              <p className="mt-2 text-[10px] text-muted-foreground">rolling total from live detections</p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Warrant-hour volume</p>
              <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                {rec ? peakCount.toLocaleString() : '-'}
              </p>
              <p className="mt-2 text-[10px] text-muted-foreground">vph during the hour analysed</p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Peak time</p>
              <p className="mt-1 text-2xl font-black tabular-nums leading-tight">
                {peakTimeLabel ?? '-'}
              </p>
              <p className="mt-2 text-[10px] text-muted-foreground">start of the busiest hour analysed</p>
            </div>
          </div>

          {cameras.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-muted-foreground">Live feeds</p>
                <span className="text-[10px] text-muted-foreground/80">
                  · {cameras.filter(c => c.status === 'online').length}/{cameras.length} online
                </span>
              </div>
              <div className={cn('grid gap-2',
                cameras.length === 1 ? 'grid-cols-1' : cameras.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4',
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
                        <span className={cn('size-1.5 rounded-full shrink-0',
                          cam.status === 'online' ? 'bg-emerald-400 animate-pulse' :
                          cam.status === 'reconnecting' ? 'bg-amber-400' : 'bg-red-400',
                        )} />
                        <span className="text-[10px] text-white/90 leading-none truncate font-medium drop-shadow">{cam.name}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
