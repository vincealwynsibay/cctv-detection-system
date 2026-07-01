import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';

function formatSince(iso: string | null | undefined, refMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const deltaSec = Math.max(0, Math.round((refMs - t) / 1000));
  if (deltaSec < 60) return 'just now';
  const m = Math.round(deltaSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
import { cctvsApi } from '@/services/cctvs';
import { recommendationsApi } from '@/services/recommendations';
import { IntersectionSummary } from '@/components/IntersectionSummary';
import { useIntersectionShell } from '@/components/IntersectionShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  RefreshCw, Loader2, Activity, TrendingUp, Clock,
  TrafficCone, Construction, CheckCircle2, Circle, Eye,
  Camera, Wifi, WifiOff,
} from 'lucide-react';
import { deriveIntersectionAction, type ActionKind } from '@/lib/intersectionAction';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const ACTION_ICONS: Record<ActionKind, typeof CheckCircle2> = {
  install_signal: TrafficCone,
  widen_lanes:    Construction,
  adjust_timing:  Clock,
  monitor:        Eye,
  no_action:      CheckCircle2,
  no_analysis:    Circle,
};

export function IntersectionDetailPage() {
  const { id }      = useParams<{ id: string }>();
  const interId = Number(id);

  // Shell provides everything the recommended-action banner needs, including
  // the simulation. Keeping the fetch in the shell ensures Live / Timing /
  // Report all reconcile against the same Webster numbers.
  const { intersection, rec, streets, cameras, sim, sseData, refreshShell } = useIntersectionShell();

  const [generating, setGenerating] = useState(false);

  async function generate() {
    setGenerating(true);
    try {
      await recommendationsApi.generate(interId);
      toast.success('Analysis complete');
      await refreshShell();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setGenerating(false);
    }
  }

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

  const warrantChips = useMemo(() => {
    if (!rec) return [];
    type Chip = { key: string; label: string; met: boolean; conf: number | null };
    const chips: Chip[] = [
      { key: 'w1', label: 'W1 8-hour',     met: rec.warrant_1_met, conf: rec.warrant_1_confidence ?? null },
      { key: 'w2', label: 'W2 4-hour',     met: rec.warrant_2_met, conf: rec.warrant_2_confidence ?? null },
      { key: 'w4', label: 'W4 Pedestrian', met: rec.warrant_4_met, conf: rec.warrant_4_confidence ?? null },
    ];
    if (rec.w_local_1_met !== null) chips.push({ key: 'wl1', label: 'WL-1 Vehicle Mix',  met: !!rec.w_local_1_met, conf: rec.w_local_1_confidence ?? null });
    if (rec.w_local_2_met !== null) chips.push({ key: 'wl2', label: 'WL-2 Peak Concen.', met: !!rec.w_local_2_met, conf: rec.w_local_2_confidence ?? null });
    if (rec.w_local_3_met !== null) chips.push({ key: 'wl3', label: 'WL-3 Lights-off',   met: !!rec.w_local_3_met, conf: rec.w_local_3_confidence ?? null });
    return chips;
  }, [rec]);

  const action = useMemo(
    () => deriveIntersectionAction(rec, intersection, { sim }),
    [rec, intersection, sim],
  );

  const ActionIcon = ACTION_ICONS[action.kind];

  const actionTone = {
    good:  'border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
    warn:  'border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
    info:  'border-sky-500/40 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100',
    muted: 'border-border bg-muted/40 text-muted-foreground',
  }[action.tone];

  return (
    <div className="flex flex-col gap-4">
      {/* Recommended action - single decision-level headline */}
      <div className={cn('flex items-start gap-3 rounded-xl border p-4', actionTone)}>
        <div className="rounded-lg bg-white/60 dark:bg-black/30 p-2 shrink-0">
          <ActionIcon className="size-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="text-[10px] uppercase tracking-wide font-semibold opacity-70">Recommended action</p>
            {rec?.generated_at && (
              <span
                className="text-[10px] tabular-nums opacity-60"
                title={`Generated ${new Date(rec.generated_at).toLocaleString()}`}
              >
                · {formatSince(rec.generated_at, Date.now())}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-base font-semibold leading-tight truncate">{action.headline}</p>
          <p className="mt-1 text-xs opacity-80">{action.detail}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {action.isTiming && (
            <Link to={`/intersections/${interId}/timing?edit=1`}>
              <Button
                size="sm"
                variant="default"
                data-testid="btn-open-timing"
                className="h-7 text-xs"
                title="Open the Signal Timing tool with the edit dialog ready"
              >
                <TrendingUp className="size-3 mr-1" />
                Open in Timing tool
              </Button>
            </Link>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs bg-white/70 dark:bg-black/30"
            onClick={generate}
            disabled={generating}
          >
            {generating ? <Loader2 className="size-3 animate-spin mr-1" /> : <RefreshCw className="size-3 mr-1" />}
            Re-analyse
          </Button>
        </div>
      </div>

      {/* Warrant status chips. The chips are MUTCD warrants (W1/W2/W4) plus
          local variants - they answer "should an unsignalized intersection
          get a signal?". For intersections that already have one, that
          question is moot, so reframe the chips as "Volume indicators" so the
          engineer reads them as informational (audit / future-planning) rather
          than as a gate on a non-existent installation decision. */}
      {warrantChips.length > 0 && (() => {
        const alreadySignalized =
          intersection != null &&
          (intersection.signal_status === 'fixed_time' || intersection.signal_status === 'actuated');
        return (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
            {alreadySignalized ? 'Volume indicators (for reference)' : 'Warrant status'}
          </p>
        <div className="flex flex-wrap gap-1.5">
          {warrantChips.map(chip => (
            <span
              key={chip.key}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
                chip.met
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-border bg-muted/40 text-muted-foreground',
              )}
              title={chip.conf != null ? `${Math.round(chip.conf * 100)}% confidence` : undefined}
            >
              {chip.met
                ? <CheckCircle2 className="size-3" />
                : <Circle className="size-3" />}
              <span className="font-medium">{chip.label}</span>
              {chip.conf != null && (
                <span className="font-mono tabular-nums opacity-70">{Math.round(chip.conf * 100)}%</span>
              )}
            </span>
          ))}
        </div>
        </div>
        );
      })()}

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
