import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { simulationApi, type SimulationChunk, type SimulationResponse } from '@/services/simulation';
import { timingApi, type TimingChunk } from '@/services/timing';
import { aggregationApi } from '@/services/aggregation';
import { streetsApi } from '@/services/streets';
import { intersectionsApi } from '@/services/intersections';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { IntersectionSummary } from '@/components/IntersectionSummary';
import { ARM_SHORT, GanttDiagram, LosBadge } from '@/components/signal-timing-viz';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { useIntersectionShell } from '@/components/IntersectionShell';
import { selectPeakChunk } from '@/lib/simulation';
import { DualIntersectionCanvas, type VehicleType, type TypeFractions } from '@/components/IntersectionCanvas';
import { IntersectionScene3D } from '@/components/IntersectionScene3D';
import type { AggregationRow, Street, Intersection } from '@/types';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { TrendingDown, Play, Pause, Columns2, MonitorPlay, X, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { JargonTip } from '@/components/JargonTip';
import { deriveIntersectionAction, MONITOR_THRESHOLD_VH } from '@/lib/intersectionAction';


const OBJECT_TO_VEHICLE: Record<string, VehicleType> = {
  motorcycle: 'MC', pedicab: 'MC', tricycle: 'MC', bicycle: 'MC',
  car: 'CAR',
  jeepney: 'JEP',
  bus: 'BUS',
  truck: 'TRUCK',
};

function buildTypeMix(rows: AggregationRow[]): Record<string, TypeFractions> {
  const byStreet = new Map<string, Record<VehicleType, number>>();
  for (const row of rows) {
    if (!row.street_id) continue;
    const vt = OBJECT_TO_VEHICLE[row.object_type];
    if (!vt) continue;
    const key = String(row.street_id);
    if (!byStreet.has(key)) byStreet.set(key, { MC: 0, CAR: 0, JEP: 0, BUS: 0, TRUCK: 0 });
    byStreet.get(key)![vt] += row.count;
  }

  const mix: Record<string, TypeFractions> = {};
  for (const [sid, counts] of byStreet) {
    const total = (counts.MC + counts.CAR + counts.JEP + counts.BUS + counts.TRUCK);
    if (total === 0) continue;
    mix[sid] = {
      MC:    counts.MC    / total,
      CAR:   counts.CAR   / total,
      JEP:   counts.JEP   / total,
      BUS:   counts.BUS   / total,
      TRUCK: counts.TRUCK / total,
    };
  }
  return mix;
}

function fmt(n: number | null | undefined, unit = 's'): string {
  if (n == null) return '-';
  return `${n.toFixed(1)}${unit}`;
}

function fmtVc(n: number | null | undefined): string {
  if (n == null) return '-';
  return n.toFixed(2);
}

function deltaClass(before: number, after: number): string {
  return after < before ? 'text-emerald-600' : after > before ? 'text-rose-600' : '';
}

function ChunkQueueChart({ chunk }: { chunk: SimulationChunk }) {
  const before = chunk.queue_series_before ?? {};
  const after  = chunk.queue_series_after  ?? {};
  const len = Math.max(
    ...Object.values(before).map(s => s.length),
    ...Object.values(after).map(s => s.length),
    0,
  );
  if (len === 0) return <p className="text-xs text-muted-foreground py-4 text-center">No queue data</p>;

  const data = Array.from({ length: len }, (_, i) => ({
    minute: i + 1,
    current: Object.values(before).reduce((s, arr) => s + (arr[i] ?? 0), 0),
    webster: Object.values(after).reduce((s, arr)  => s + (arr[i] ?? 0), 0),
  }));

  return (
    <>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="minute" tick={{ fontSize: 11 }} tickFormatter={v => `${v}m`} />
          <YAxis tick={{ fontSize: 11 }} width={32} />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(v, name) => [`${Number(v).toFixed(1)} veh`, name === 'current' ? 'Current timing' : 'Webster timing']}
          />
          <Line type="monotone" dataKey="current" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
          <Line type="monotone" dataKey="webster" stroke="#10b981" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-1">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block w-5 border-t-2 border-dashed border-[#94a3b8]" />
          Current timing (total queue)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block w-5 border-t-2 border-[#10b981]" />
          Webster timing (total queue)
        </span>
      </div>
    </>
  );
}



export function SignalTimingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const intersectionId = Number(id);

  // Shell owns the globally-selected replay window (the picker in the tabs
  // row writes to it). Reading the selection here means the "Replay a specific
  // window" UI lives in exactly one place rather than being duplicated on
  // this tab.
  const shellCtx = useIntersectionShell();
  const shellWindow = shellCtx.window;

  const [data, setData] = useState<SimulationResponse | null>(null);
  const [timingData, setTimingData] = useState<TimingChunk[]>([]);
  const [streets, setStreets] = useState<Street[]>([]);
  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [rec, setRec] = useState<RecommendationResponse | null>(null);
  const [typeMix, setTypeMix] = useState<Record<string, TypeFractions>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);
  function selectChunk(chunkName: string | null) {
    setSelectedChunk(chunkName);
  }
  const [view3D, setView3D] = useState(false);
  const [show3DBefore, setShow3DBefore] = useState(false);
  const [sbs3D, setSbs3D] = useState(false);
  const [paused3D, setPaused3D] = useState(false);
  // 1× = real-time (sim seconds advance at wall clock). Previously 1× meant
  // 15× wall clock, which played a full 60 s cycle in ~4 real seconds - too
  // fast to watch during demos. 8× is kept as the "skip ahead" option.
  const [speed3D, setSpeed3D] = useState<1 | 4 | 8 | 16 | 32 | 64>(1);
  const [presentMode, setPresentMode] = useState(false);
  // Signal/cycle/splits editing moved to the Settings sheet (shell cog) so
  // there's one path to edit an intersection. The Edit timing dialog that
  // used to live here is gone; the warning banner below routes operators to
  // Settings instead.

  // Historical window analysis: input (start/end/vph) comes from the shell
  // window picker; only the *result* of the windowed compute lives here.
  // Raw veh/hr over the selected window (no PCE) - feeds the 3D playback
  // rate so a freshly-picked window animates at the right pace even before
  // the analytical sim returns.
  const histVph   = shellWindow?.vph ?? null;
  const [histData, setHistData]   = useState<SimulationResponse | null>(null);
  // Loading/error moved to shell context (windowStatus) so the picker chip
  // renders the state; we no longer keep local copies here.
  // Historical mode = a window is selected AND we have its computed result.
  // Derived rather than stored so the picker chip and the page stay in sync.
  const histMode = shellWindow != null && histData != null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPresentMode(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const loadAll = useCallback(async () => {
    if (!intersectionId) return;
    setLoading(true);

    // Last complete hour window for aggregation
    const now = new Date();
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    const start = new Date(end.getTime() - 3600 * 1000);

    try {
      // Absorb a missing-simulation error so unsignalized + not-warranted
      // intersections (where Webster never ran) still load - operators
      // need the "Analyse a specific window" panel to drill into past
      // dates regardless of whether a recommendation exists.
      const [sim, tim, agg, allStreets, inter, latestRec] = await Promise.all([
        simulationApi.get(intersectionId).catch(() => null),
        timingApi.list(intersectionId).catch(() => [] as TimingChunk[]),
        aggregationApi.history({
          start: start.toISOString(),
          end: end.toISOString(),
          intersection_id: intersectionId,
          bucket: 'hour',
        }).catch(() => []),
        streetsApi.list().catch(() => [] as Street[]),
        intersectionsApi.get(intersectionId).catch(() => null),
        recommendationsApi.latest(intersectionId).catch(() => null),
      ]);
      setData(sim);
      setTimingData(tim);
      setStreets(allStreets.filter(s => s.intersection_id === intersectionId));
      setIntersection(inter);
      setRec(latestRec);
      setTypeMix(buildTypeMix(agg));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [intersectionId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Strip any legacy ?edit=1 deep-link param. The Edit timing dialog moved
  // to Settings; without this an old bookmark would leave the URL marker
  // sitting around forever.
  useEffect(() => {
    if (searchParams.get('edit') == null) return;
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const [generating, setGenerating] = useState(false);
  async function runAnalyse() {
    if (!intersectionId) return;
    setGenerating(true);
    try {
      await recommendationsApi.generate(intersectionId);
      toast.success('Analysis complete');
      await loadAll();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setGenerating(false);
    }
  }

  // When in historical mode, drive all visuals from histData; fall back to saved simulation
  const displayData = histMode && histData ? histData : data;

  // null selectedChunk = "All" (aggregate view); specific name = per-chunk view
  const displayChunk = selectedChunk
    ? (displayData?.chunks.find(c => c.chunk_name === selectedChunk) ?? null)
    : null;

  // For charts that require a single chunk (queue, simulation, Gantt),
  // fall back to the highest-volume chunk when "All" is selected.
  const peakChunk = selectPeakChunk(displayData);
  const activeChunk = displayChunk ?? peakChunk;
  // As soon as the user picks a range on the bar chart, that rate feeds the 3D
  // visual - no need to wait for the Analyse button. Visual-only: analytical
  // numbers still come from the server-side compute. Raw veh/hr (no PCE) is
  // intentional - the scene is illustrative, not analytical, so we don't
  // duplicate PCE multipliers client-side.
  const effectiveVolumePcuHr = histVph != null
    ? histVph
    : (activeChunk?.volume_pcu_hr ?? 0);

  // Synthesize a TimingChunk from historical proposed splits so Gantt + 3D still work
  const histTiming = histMode && activeChunk?.proposed_cycle_s != null ? {
    id: -1,
    intersection_id: intersectionId,
    recommendation_id: -1,
    chunk_name: activeChunk.chunk_name,
    cycle_length: activeChunk.proposed_cycle_s!,
    green_splits: activeChunk.proposed_splits ?? {},
    effective_date: '',
    pce_tier_used: 'measured',
    signal_off: false,
    generated_at: activeChunk.generated_at,
    measured_flows: activeChunk.measured_flows ?? null,
    assumptions: null,
  } : null;

  const peakTiming      = peakChunk ? (timingData.find(t => t.chunk_name === peakChunk.chunk_name) ?? null) : null;
  const selectedTiming  = timingData.find(t => t.chunk_name === selectedChunk) ?? null;
  const displayTiming   = histMode ? histTiming : (selectedTiming ?? peakTiming);
  const activeTiming    = displayTiming;

  // openEdit / fillFromRecommendation / saveEdit removed - the signal +
  // cycle + splits editor lives in the Settings sheet now (cog icon in the
  // shell). The "Use recommendation" shortcut moved with it; the in-sheet
  // version pulls from the latest sim's peak chunk rather than the per-chunk
  // context that used to be available on this page.


  // Auto-fires the windowed sim whenever the shell picker commits a new
  // selection. The picker is the action; this page just listens and reports
  // status back to the shell so the picker chip can show its own spinner /
  // error pill (replacing the standalone "Replaying" strip this page used
  // to render under itself).
  const setWindowStatus = shellCtx.setWindowStatus;
  const analyseWindow = useCallback(async (start: string, end: string) => {
    if (end <= start) {
      setWindowStatus({ state: 'error', message: 'End must be after start' });
      return;
    }
    setWindowStatus({ state: 'loading' });
    try {
      const result = await simulationApi.compute({
        intersection_id: intersectionId,
        start: start.length === 16 ? start + ':00' : start,
        end:   end.length   === 16 ? end + ':00'   : end,
      });
      setHistData(result);
      setSelectedChunk(null);
      setWindowStatus({ state: 'idle' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'No data for this window';
      setWindowStatus({ state: 'error', message: msg });
    }
  }, [intersectionId, setWindowStatus]);

  useEffect(() => {
    if (!shellWindow) {
      setHistData(null);
      setSelectedChunk(null);
      setWindowStatus({ state: 'idle' });
      return;
    }
    analyseWindow(shellWindow.start, shellWindow.end);
  }, [shellWindow, analyseWindow, setWindowStatus]);

  return (
    <div className="flex flex-col gap-5 print:gap-2">
      {/* Tab-local action row gone - the only thing it carried was Edit
          timing, and that lives in the Settings sheet now (shell cog). */}

      {/* Print header - only visible when printing */}
      <div className="hidden print:block mb-4">
        <h1 className="text-lg font-bold">{displayData?.intersection_name} - Signal Timing Report</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Generated {new Date().toLocaleString('en-PH', { timeZoneName: 'short' })} · Webster's formula · {displayData?.signal_status.replace('_', ' ')}
          {histMode && displayData?.window_start ? ` · Window: ${new Date(displayData.window_start).toLocaleString('en-PH')} – ${new Date(displayData.window_end!).toLocaleString('en-PH')}` : ''}
        </p>
      </div>

      {loading && <Skeleton className="h-64" />}

      {error && (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-rose-600">
          {error}
        </div>
      )}

      {/* Empty-state when no recommendation has been generated yet (typical
          for unsignalized + not-warranted intersections). Pick a window from
          the picker in the tabs row to drill into historical data. */}
      {!loading && !displayData && !error && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <p className="font-medium">No timing recommendation generated.</p>
          <p className="text-xs text-muted-foreground mt-1">
            {intersection?.signal_status === 'unsignalized'
              ? 'This intersection is unsignalized and current volumes don’t trigger any warrant. Pick a time window from the picker in the tabs row to analyse a specific historical period.'
              : 'Run analysis from the parent header to generate a timing comparison, or pick a window from the picker in the tabs row to drill into a specific period.'}
          </p>
        </div>
      )}

      {/* Replay status is now communicated by the picker chip itself
          (loading spinner / error pill / inline clear-X). No separate strip
          in the tab body. */}

      {displayData && !loading && (
        <>
          {/* Before-state source banner. In replay mode the Replaying strip
              above already names the window in plain language; the
              baseline_note ("Real-data window · ... · 1178 PCU/hr ...") then
              duplicates that information in a second green box right under
              the first. Suppress it in replay mode and keep it for the
              default sim (where it conveys data freshness). */}
          {!histMode && displayData.baseline_note && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 text-amber-800 dark:text-amber-300 px-4 py-2.5 text-xs">
              {displayData.baseline_note}
            </div>
          )}

          {/* Warning: signalized but no existing timing entered - before-state is fictional.
              Routes the operator to the Settings cog in the shell, which now
              owns the timing editor. */}
          {!histMode && (displayData.signal_status === 'fixed_time' || displayData.signal_status === 'actuated') && !displayData.existing_cycle_s && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-900 px-4 py-3 text-xs text-rose-800 dark:text-rose-300">
              <span className="font-semibold">Before-state is an assumption, not measured data.</span>{' '}
              This intersection is marked as {data.signal_status.replace('_', '-')} but no existing cycle length
              or green time per approach has been entered. The "before" delay is computed using an equal-split default
              and will understate or overstate the real improvement. Open Settings (cog icon in the header) to enter
              the current cycle length and per-approach splits.
            </div>
          )}

          {/* No-op proposal: Webster didn't beat existing on any chunk. Sim is
              kept for transparency but rendered as informational, not a plan. */}
          {!histMode && rec?.proposal_is_no_op && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-900 px-4 py-3 text-xs text-emerald-800 dark:text-emerald-300">
              <span className="font-semibold">No retune recommended.</span>{' '}
              Existing signal timing already meets or beats Webster's proposal at every TOD chunk.
              The simulation below is shown for comparison only - applying the proposed splits would
              not improve average delay on any chunk by the {'≥'} 0.5 s/veh threshold.
            </div>
          )}

          {/* LOS data missing - analysis predates the upgrade, will self-heal on next scheduled run */}
          {!histMode && displayData.chunks.some(c => c.vc_ratio_before == null) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-300">
              LOS grades and v/c ratios are not yet available for this intersection -
              they will appear automatically after the next scheduled analysis (within the hour).
            </div>
          )}

          {/* Findings panel - the reconciled recommendation (single source of
              truth shared with the Dashboard and Live tab) plus Webster's
              raw delay numbers, side by side, so engineers can audit both. */}
          {(() => {
            const totalVhSaved = displayData.daily_summary.total_vehicle_hours_saved;
            const peakVhChunk = displayData.chunks.length > 0
              ? [...displayData.chunks].sort((a, b) => b.vehicle_hours_saved - a.vehicle_hours_saved)[0]
              : null;
            const peakVhSaved = peakVhChunk?.vehicle_hours_saved ?? 0;
            const websterPositive = peakVhSaved > 0;
            const action = deriveIntersectionAction(rec, intersection, { sim: displayData });
            // Near-break-even guard: when the reconciled banner says "install
            // signal" with the engineering-noise footnote, the raw Webster tile
            // should match that framing instead of loudly contradicting it with
            // a red "signal adds delay" headline. Same number, honest framing.
            const negligibleDelay =
              action.kind === 'install_signal' &&
              Math.abs(totalVhSaved) < MONITOR_THRESHOLD_VH;
            // Tone for the headline mirrors the dashboard banner colour family.
            const headlineClass = action.tone === 'good'
              ? 'text-emerald-700 dark:text-emerald-400'
              : action.tone === 'warn'
              ? 'text-amber-700 dark:text-amber-400'
              : action.tone === 'info'
              ? 'text-sky-700 dark:text-sky-400'
              : 'text-muted-foreground';
            return (
              <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3 print:hidden">
                <p className="text-[11px] uppercase tracking-widest font-medium text-muted-foreground">
                  Findings
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Reconciled recommendation - matches Dashboard and Live tab */}
                  <div className="flex flex-col gap-1">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1">
                      Recommended action
                      <JargonTip term="mutcd" />
                    </p>
                    <p className={cn('text-xl font-bold leading-tight', headlineClass)}>
                      {action.headline}
                    </p>
                    <p className="text-xs text-muted-foreground">{action.detail}</p>
                  </div>

                  {/* Webster's operational-cost / delay-impact panel. Label
                      flips with the action: an install_signal verdict with
                      near-zero vh_saved reads as "operational cost: negligible"
                      so the panel tells the same story as the banner. A
                      positive Webster number is always good news, regardless
                      of which action verdict the helper picked. */}
                  <div className="flex flex-col gap-1">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1">
                      {negligibleDelay ? 'Operational cost (Webster)' : 'Delay impact (Webster)'}
                      <JargonTip term="websters" />
                    </p>
                    <p className={cn(
                      'text-xl font-bold leading-tight tabular-nums',
                      websterPositive
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : negligibleDelay
                          ? 'text-muted-foreground'
                          : 'text-foreground',
                    )}>
                      {websterPositive
                        ? `+${peakVhSaved.toFixed(1)} vh/day at ${peakVhChunk?.chunk_name}`
                        : negligibleDelay
                          ? 'Negligible (within engineering noise)'
                          : totalVhSaved < 0
                            ? `${totalVhSaved.toFixed(1)} vh/day, signal adds delay`
                            : 'No net delay reduction'}
                    </p>
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                      Daily total: <span className="font-medium tabular-nums">
                        {totalVhSaved >= 0 ? '+' : ''}{totalVhSaved.toFixed(1)} vh/day
                      </span>
                      <JargonTip term="vh_saved" />
                    </p>
                  </div>
                </div>

                {/* Per-chunk breakdown */}
                {displayData.chunks.length > 1 && (
                  <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border">
                    <p className="basis-full text-[10px] uppercase tracking-wide text-muted-foreground mb-1 mt-2 inline-flex items-center gap-1">
                      Per period <JargonTip term="tod_chunk" />
                    </p>
                    {displayData.chunks.map(c => (
                      <span
                        key={c.chunk_name}
                        className={cn(
                          'text-[11px] px-2 py-0.5 rounded border tabular-nums',
                          c.vehicle_hours_saved > 0
                            ? 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400'
                            : 'border-border text-muted-foreground',
                        )}
                      >
                        {c.chunk_name}: {c.vehicle_hours_saved >= 0 ? '+' : ''}
                        {c.vehicle_hours_saved.toFixed(1)} vh
                      </span>
                    ))}
                  </div>
                )}

                {action.contradictionFlagged && (
                  <p className="text-xs italic text-muted-foreground leading-relaxed border-t border-border pt-3">
                    MUTCD warrants check a single peak hour against count thresholds; Webster's
                    integrates delay across the whole day. When the warrant trips on a brief peak
                    but most of the day is free-flow, adding a signal imposes idle red-time delay
                    on empty approaches - Webster scores that as worse, not better. Both models
                    are correct; the headline reflects the daily picture.
                  </p>
                )}

                {/* Stochastic confidence (Monte Carlo) - lives inside the
                    Findings card so action, deterministic projection, and
                    100-replay verdict read as one block of evidence. Default
                    mode aggregates across every TOD chunk into an "All day"
                    envelope; replay mode runs MC against the picked window
                    so the envelope matches windowed Webster's units. */}
                {displayData.daily_summary.total_vehicle_hours_saved > 0 && (
                  <div className="border-t border-border pt-3">
                    <ConfidenceBadge
                      intersectionId={intersectionId}
                      variant="section"
                      window={shellWindow ? { start: shellWindow.start, end: shellWindow.end } : null}
                    />
                  </div>
                )}
              </div>
            );
          })()}

          {/* Global TOD chunk filter - only shown for the default (latest) sim,
              which has multiple chunks. In replay mode the windowed sim returns
              a single synthetic chunk (e.g. "Jun 30 20:00 – 21:00") so the
              filter row would collapse to one always-active pill and only
              confuse the operator. The Replaying strip above already names
              the active window. */}
          {!histMode && (
            <div className="flex flex-wrap items-center gap-1.5 print:hidden">
              <button
                data-testid="btn-chunk-all"
                onClick={() => selectChunk(null)}
                className={cn(
                  'px-3 py-1 text-xs rounded-md border transition-colors',
                  selectedChunk === null
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
                )}
              >
                All periods
              </button>
              {displayData.chunks.map(c => (
                <button
                  key={c.chunk_name}
                  data-testid={`btn-chunk-${c.chunk_name.toLowerCase().replace(/\s+/g, '-')}`}
                  onClick={() => selectChunk(c.chunk_name)}
                  className={cn(
                    'px-3 py-1 text-xs rounded-md border transition-colors',
                    selectedChunk === c.chunk_name
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
                  )}
                >
                  {c.chunk_name}
                </button>
              ))}
              <TodChunkInfoDialog />
            </div>
          )}

          {/* Summary strip - shows selected chunk when one is active, daily totals for "All" */}
          {(() => {
            const delayBefore = displayChunk ? displayChunk.delay_before : displayData.daily_summary.avg_delay_before;
            const losBefore   = displayChunk ? displayChunk.los_before   : displayData.daily_summary.los_before;
            const delayAfter  = displayChunk ? displayChunk.delay_after  : displayData.daily_summary.avg_delay_after;
            const losAfter    = displayChunk ? displayChunk.los_after    : displayData.daily_summary.los_after;
            const vhSaved     = displayChunk ? displayChunk.vehicle_hours_saved : displayData.daily_summary.total_vehicle_hours_saved;
            // "Total flow" (PCU/hr) card was cut here too — same reason as the
            // IntersectionReport page: PCU is a jargon unit and the plain
            // veh/hr Major/Minor figure in Findings covers the same ground.
            const vhLabel     = displayChunk ? 'vh saved this period' : (histMode ? 'vh for this window' : 'vh saved per day');
            return (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-border bg-card p-4 print:p-3">
                  <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                    Avg delay before <JargonTip term="los" />
                  </p>
                  <p className="text-xl font-semibold mt-1">{fmt(delayBefore)}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <p className="text-xs text-muted-foreground">per vehicle</p>
                    <LosBadge grade={losBefore} />
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 print:p-3">
                  <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                    Avg delay after <JargonTip term="websters" />
                  </p>
                  <p className="text-xl font-semibold mt-1 text-emerald-600">{fmt(delayAfter)}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <p className="text-xs text-muted-foreground">per vehicle</p>
                    <LosBadge grade={losAfter} />
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 print:p-3">
                  <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                    Vehicle-hours saved <JargonTip term="vh_saved" />
                  </p>
                  <p className={cn('text-xl font-semibold mt-1', vhSaved > 0 && 'text-emerald-600')}>
                    {vhSaved.toFixed(1)} vh
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">{vhLabel}</p>
                </div>
              </div>
            );
          })()}

          {/* LOS legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground print:hidden">
            <span className="font-medium text-foreground inline-flex items-center gap-1">
              LOS grade: <JargonTip term="los" />
            </span>
            {([
              ['A', '≤10s - free flow'],
              ['B', '10–20s - stable'],
              ['C', '20–35s - acceptable'],
              ['D', '35–55s - approaching unstable'],
              ['E', '55–80s - unstable'],
              ['F', '>80s - forced/breakdown'],
            ] as const).map(([g, desc]) => (
              <span key={g} className="flex items-center gap-1">
                <LosBadge grade={g} /><span>{desc}</span>
              </span>
            ))}
          </div>

          {/* Per-chunk table - click a row to select it for the chart / simulation */}
          <div className="rounded-lg border border-border overflow-hidden print:hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Before delay</TableHead>
                  <TableHead className="text-right">After delay</TableHead>
                  <TableHead className="text-right">Improvement</TableHead>
                  <TableHead className="text-right">v/c ratio</TableHead>
                  <TableHead className="text-right">Veh-hrs saved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayData.chunks.map(chunk => {
                  const improvement = chunk.delay_before - chunk.delay_after;
                  const pct = chunk.delay_before > 0 ? Math.round((improvement / chunk.delay_before) * 100) : 0;
                  return (
                    <TableRow
                      key={chunk.chunk_name}
                      className={cn('cursor-pointer', selectedChunk === chunk.chunk_name && 'bg-muted/50')}
                      onClick={() => selectChunk(chunk.chunk_name)}
                    >
                      <TableCell className="font-medium">{chunk.chunk_name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="mr-1.5">{fmt(chunk.delay_before)}</span>
                        <LosBadge grade={chunk.los_before} />
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', deltaClass(chunk.delay_before, chunk.delay_after))}>
                        <span className="mr-1.5">{fmt(chunk.delay_after)}</span>
                        <LosBadge grade={chunk.los_after} />
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', improvement > 0 ? 'text-emerald-600' : 'text-muted-foreground')}>
                        {improvement > 0 ? `−${improvement.toFixed(1)}s (${pct}%)` : '-'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {fmtVc(chunk.vc_ratio_before)}
                        {chunk.vc_ratio_before != null && chunk.vc_ratio_after != null && (
                          <span className={cn('ml-1', chunk.vc_ratio_after < chunk.vc_ratio_before ? 'text-emerald-600' : 'text-rose-600')}>
                            → {fmtVc(chunk.vc_ratio_after)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', chunk.vehicle_hours_saved > 0 && 'text-emerald-600')}>
                        {chunk.vehicle_hours_saved > 0 ? `${chunk.vehicle_hours_saved.toFixed(2)} vh` : '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/30 font-semibold border-t-2 border-border">
                  <TableCell>{histMode ? 'Window total' : 'Daily avg'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="mr-1.5">{fmt(displayData.daily_summary.avg_delay_before)}</span>
                    <LosBadge grade={displayData.daily_summary.los_before} />
                  </TableCell>
                  <TableCell className={cn('text-right tabular-nums', deltaClass(displayData.daily_summary.avg_delay_before, displayData.daily_summary.avg_delay_after))}>
                    <span className="mr-1.5">{fmt(displayData.daily_summary.avg_delay_after)}</span>
                    <LosBadge grade={displayData.daily_summary.los_after} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">avg</TableCell>
                  <TableCell className="text-right text-muted-foreground">-</TableCell>
                  <TableCell className={cn('text-right tabular-nums', displayData.daily_summary.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
                    {displayData.daily_summary.total_vehicle_hours_saved.toFixed(2)} vh
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {/* Phase comparison - Current vs Recommended */}
          {activeTiming && streets.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-5 print:p-3 print:break-inside-avoid">
              <h2 className="text-sm font-semibold mb-4 print:mb-2">Phase comparison - {selectedChunk ? activeTiming.chunk_name : `All periods · using ${activeTiming.chunk_name} (peak)`}</h2>
              <div className="flex gap-6 flex-col sm:flex-row">
                {intersection?.existing_cycle_length && intersection?.existing_green_splits ? (
                  <GanttDiagram
                    title="Current timing"
                    cycleLength={intersection.existing_cycle_length}
                    approaches={streets
                      .filter(s => s.arm_direction !== 'unknown')
                      .map(s => ({
                        label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
                        greenSec: (intersection.existing_green_splits as Record<string, number>)[String(s.id)] ?? 0,
                      }))}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center py-8 rounded-md border border-dashed border-border text-xs text-muted-foreground text-center px-4">
                    No current timing entered.{' '}
                    <span className="font-medium">Use the wizard to add your existing cycle length and splits.</span>
                  </div>
                )}
                <div className="w-px bg-border hidden sm:block shrink-0" />
                <GanttDiagram
                  title="Recommended (Webster)"
                  cycleLength={activeTiming.cycle_length}
                  approaches={streets
                    .filter(s => s.arm_direction !== 'unknown')
                    .map(s => ({
                      label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
                      greenSec: activeTiming.green_splits[String(s.id)] ?? 0,
                    }))}
                  titleClassName="text-emerald-600"
                />
              </div>
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border">
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-2.5 rounded-sm bg-emerald-500" /> Green
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-2.5 rounded-sm bg-amber-400" /> Yellow (3s)
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-2.5 rounded-sm bg-rose-400/40" /> Red
                </span>
              </div>
            </div>
          )}

          {/* Queue time-series chart */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <div className="mb-3">
                <h2 className="text-sm font-semibold">
                  Total queue - {selectedChunk ? activeChunk.chunk_name : 'All periods'}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Combined vehicles queued across all approaches · 60-min simulation
                  {!selectedChunk && <span className="ml-1 text-muted-foreground/60">· using {activeChunk.chunk_name} (peak)</span>}
                </p>
              </div>
              <ChunkQueueChart chunk={activeChunk} />
            </div>
          )}

          {/* Intersection simulation - 2D / 3D toggle */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <div>
                  <h2 className="text-sm font-semibold">
                    Intersection simulation - {selectedChunk ? activeChunk.chunk_name : 'All periods'}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {view3D ? 'drag to orbit · scroll to zoom' : 'top-down · queue bars grow on red, clear on green'}
                  </p>
                  {histVph != null && view3D && (
                    <p className="text-[11px] text-teal-600 dark:text-teal-400 mt-1 font-medium">
                      Visual rate: {Math.round(histVph)} veh/hr · selected range
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {/* 2D / 3D */}
                  <div className="flex rounded-md border border-border overflow-hidden">
                    <button className={cn('px-3 py-1 text-xs font-medium transition-colors', !view3D ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setView3D(false)}>2D</button>
                    <button className={cn('px-3 py-1 text-xs font-medium transition-colors border-l border-border', view3D ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setView3D(true)}>3D</button>
                  </div>

                  {/* Side-by-side - 3D only */}
                  {view3D && (
                    <button
                      title="Side by side"
                      onClick={() => setSbs3D(v => !v)}
                      className={cn('flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors',
                        sbs3D ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted')}
                    >
                      <Columns2 className="size-3" />
                      Side by side
                    </button>
                  )}

                  {/* Before / After - 3D single-view only */}
                  {view3D && !sbs3D && (
                    <div className="flex rounded-md border border-border overflow-hidden">
                      <button className={cn('px-3 py-1 text-xs font-medium transition-colors', show3DBefore ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setShow3DBefore(true)}>Before</button>
                      <button className={cn('px-3 py-1 text-xs font-medium transition-colors border-l border-border', !show3DBefore ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setShow3DBefore(false)}>After</button>
                    </div>
                  )}

                  {/* Play / Pause - shared for both 2D and 3D */}
                  <button
                    onClick={() => setPaused3D(v => !v)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors"
                    title={paused3D ? 'Resume' : 'Pause'}
                  >
                    {paused3D ? <Play className="size-3" /> : <Pause className="size-3" />}
                    {paused3D ? 'Play' : 'Pause'}
                  </button>

                  {/* Speed - shared for both 2D and 3D */}
                  <div className="flex rounded-md border border-border overflow-hidden">
                    {([1, 4, 8, 16, 32, 64] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setSpeed3D(s)}
                        className={cn('px-2.5 py-1 text-xs font-medium transition-colors border-l first:border-l-0 border-border',
                          speed3D === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>

                  {/* Present mode button */}
                  <button
                    title="Present / council view - hides all chrome"
                    onClick={() => setPresentMode(true)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors"
                  >
                    <MonitorPlay className="size-3" />
                    Present
                  </button>
                </div>
              </div>

              {!view3D && (
                <DualIntersectionCanvas
                  chunk={activeChunk}
                  timing={activeTiming}
                  signalStatus={displayData.signal_status}
                  typeMix={typeMix}
                  paused={paused3D}
                  speed={speed3D}
                  streets={streets}
                  existingCycleS={intersection?.existing_cycle_length ?? null}
                  existingGreenSplits={intersection?.existing_green_splits ?? null}
                />
              )}

              {view3D && activeTiming && activeChunk && !sbs3D && (
                <IntersectionScene3D
                  timing={activeTiming}
                  streets={streets}
                  signalOff={activeTiming.signal_off}
                  volumePcuHr={effectiveVolumePcuHr}
                  typeMix={typeMix}
                  showBefore={show3DBefore}
                  signalStatus={displayData.signal_status}
                  existingCycleS={intersection?.existing_cycle_length ?? null}
                  existingGreenSplits={intersection?.existing_green_splits ?? null}
                  paused={paused3D}
                  speed={speed3D}
                  sim={activeChunk}
                />
              )}

              {view3D && activeTiming && activeChunk && sbs3D && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground text-center mb-1.5">Current timing (before)</p>
                    <IntersectionScene3D
                      timing={activeTiming}
                      streets={streets}
                      signalOff={activeTiming.signal_off}
                      volumePcuHr={effectiveVolumePcuHr}
                      typeMix={typeMix}
                      showBefore={true}
                      signalStatus={displayData.signal_status}
                      existingCycleS={intersection?.existing_cycle_length ?? null}
                      existingGreenSplits={intersection?.existing_green_splits ?? null}
                      paused={paused3D}
                      speed={speed3D}
                      height={340}
                      sim={activeChunk}
                    />
                  </div>
                  <div>
                    <p className="text-xs text-emerald-600 text-center mb-1.5">Webster timing (after)</p>
                    <IntersectionScene3D
                      timing={activeTiming}
                      streets={streets}
                      signalOff={activeTiming.signal_off}
                      volumePcuHr={effectiveVolumePcuHr}
                      typeMix={typeMix}
                      showBefore={false}
                      signalStatus={displayData.signal_status}
                      existingCycleS={intersection?.existing_cycle_length ?? null}
                      existingGreenSplits={intersection?.existing_green_splits ?? null}
                      paused={paused3D}
                      speed={speed3D}
                      height={340}
                      sim={activeChunk}
                    />
                  </div>
                </div>
              )}

              {view3D && !activeTiming && (
                <div className="flex items-center justify-center h-48 text-xs text-muted-foreground">
                  No timing data for this chunk - regenerate recommendation to enable 3D view.
                </div>
              )}
            </div>
          )}

          {/* "Calculation basis" panel was cut (Webster's parameters +
              observed flows) — operator-irrelevant and duplicated by
              Findings (plain veh/hr) and the print export's audit trail.
              The data still ships in the API response for engineers /
              panel review. */}

          {displayData.chunks.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <TrendingDown className="size-10 opacity-30" />
              <p className="text-sm">No simulation data - regenerate the recommendation to compute delay estimates.</p>
            </div>
          )}

          {/* Per-approach action card + narrative summary - visible on-screen and at the bottom of the print */}
          {intersection && (
            <div className="mt-2 print:mt-3">
              <IntersectionSummary
                intersection={intersection}
                streets={streets}
                sim={displayData}
                rec={rec}
              />
            </div>
          )}
        </>
      )}

      {/* Present / council mode overlay - hides all nav chrome for clean screenshots */}
      {presentMode && activeChunk && data && (
        <div className="fixed inset-0 z-[100] bg-[#0a0f1a] flex flex-col">
          {/* Minimal header */}
          <div className="flex items-center justify-between px-6 py-3 shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-white">{displayData.intersection_name}</span>
              <span className="text-[11px] text-white/40 font-mono">{activeChunk.chunk_name}</span>
            </div>
            <div className="flex items-center gap-6">
              {activeChunk.vehicle_hours_saved > 0 && (
                <div className="text-right">
                  <p className="text-[10px] text-white/40 uppercase tracking-wide">Vehicle-hours saved</p>
                  <p className="text-xl font-semibold tabular-nums text-emerald-400">
                    {activeChunk.vehicle_hours_saved.toFixed(2)} vh
                  </p>
                </div>
              )}
              <button
                onClick={() => setPresentMode(false)}
                className="text-white/40 hover:text-white transition-colors p-1"
                title="Exit present mode (Esc)"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>

          {/* Minimal controls */}
          <div className="flex items-center gap-2 px-6 pb-2 shrink-0">
            <div className="flex rounded-md border border-white/20 overflow-hidden text-xs">
              <button
                className={cn('px-3 py-1 font-medium transition-colors', !view3D ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                onClick={() => setView3D(false)}
              >2D</button>
              <button
                className={cn('px-3 py-1 font-medium transition-colors border-l border-white/20', view3D ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                onClick={() => setView3D(true)}
              >3D</button>
            </div>
            {view3D && activeTiming && (
              <>
                <button
                  onClick={() => setSbs3D(v => !v)}
                  className={cn('flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors',
                    sbs3D ? 'bg-white/20 text-white border-white/30' : 'border-white/20 text-white/40 hover:bg-white/10')}
                >
                  <Columns2 className="size-3" /> Side by side
                </button>
                {!sbs3D && (
                  <div className="flex rounded-md border border-white/20 overflow-hidden text-xs">
                    <button
                      className={cn('px-3 py-1 font-medium transition-colors', show3DBefore ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                      onClick={() => setShow3DBefore(true)}
                    >Before</button>
                    <button
                      className={cn('px-3 py-1 font-medium transition-colors border-l border-white/20', !show3DBefore ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                      onClick={() => setShow3DBefore(false)}
                    >After</button>
                  </div>
                )}
                <button
                  onClick={() => setPaused3D(v => !v)}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-white/20 text-white/40 hover:bg-white/10 transition-colors"
                >
                  {paused3D ? <Play className="size-3" /> : <Pause className="size-3" />}
                  {paused3D ? 'Play' : 'Pause'}
                </button>
                <div className="flex rounded-md border border-white/20 overflow-hidden">
                  {([1, 4, 8, 16, 32, 64] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setSpeed3D(s)}
                      className={cn('px-2.5 py-1 text-xs font-medium transition-colors border-l first:border-l-0 border-white/20',
                        speed3D === s ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                    >{s}×</button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Simulation body */}
          <div className="flex-1 overflow-hidden px-4 pb-4">
            {!view3D && activeChunk && (
              <DualIntersectionCanvas
                chunk={activeChunk}
                timing={activeTiming}
                signalStatus={displayData.signal_status}
                typeMix={typeMix}
                paused={paused3D}
                speed={speed3D}
                streets={streets}
                existingCycleS={intersection?.existing_cycle_length ?? null}
                existingGreenSplits={intersection?.existing_green_splits ?? null}
              />
            )}
            {view3D && activeTiming && activeChunk && !sbs3D && (
              <IntersectionScene3D
                timing={activeTiming}
                streets={streets}
                signalOff={activeTiming.signal_off}
                volumePcuHr={activeChunk.volume_pcu_hr}
                typeMix={typeMix}
                showBefore={show3DBefore}
                signalStatus={displayData.signal_status}
                existingCycleS={intersection?.existing_cycle_length ?? null}
                existingGreenSplits={intersection?.existing_green_splits ?? null}
                paused={paused3D}
                speed={speed3D}
                height={window.innerHeight - 140}
                sim={activeChunk}
              />
            )}
            {view3D && activeTiming && activeChunk && sbs3D && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] text-white/40 text-center mb-1.5">Current timing (before)</p>
                  <IntersectionScene3D
                    timing={activeTiming}
                    streets={streets}
                    signalOff={activeTiming.signal_off}
                    volumePcuHr={effectiveVolumePcuHr}
                    typeMix={typeMix}
                    showBefore={true}
                    signalStatus={displayData.signal_status}
                    existingCycleS={intersection?.existing_cycle_length ?? null}
                    existingGreenSplits={intersection?.existing_green_splits ?? null}
                    paused={paused3D}
                    speed={speed3D}
                    height={window.innerHeight - 160}
                    sim={activeChunk}
                  />
                </div>
                <div>
                  <p className="text-[11px] text-emerald-400 text-center mb-1.5">Webster timing (after)</p>
                  <IntersectionScene3D
                    timing={activeTiming}
                    streets={streets}
                    signalOff={activeTiming.signal_off}
                    volumePcuHr={effectiveVolumePcuHr}
                    typeMix={typeMix}
                    showBefore={false}
                    signalStatus={displayData.signal_status}
                    existingCycleS={intersection?.existing_cycle_length ?? null}
                    existingGreenSplits={intersection?.existing_green_splits ?? null}
                    paused={paused3D}
                    speed={speed3D}
                    height={window.innerHeight - 160}
                    sim={activeChunk}
                  />
                </div>
              </div>
            )}
            {view3D && !activeTiming && (
              <div className="flex items-center justify-center h-48 text-xs text-white/30">
                No timing data for this chunk - regenerate recommendation to enable 3D view.
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

function TodChunkInfoDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="About time-of-day chunks"
          className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Info className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>About these time-of-day periods</DialogTitle>
          <DialogDescription>
            Each intersection's day is split into traffic regimes. Webster's equation
            computes optimal signal timing per regime, and the highest-demand regime
            ("peak") drives the headline recommendation.
          </DialogDescription>
        </DialogHeader>
        <div className="text-xs leading-relaxed text-muted-foreground space-y-2.5 mt-1">
          <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
            <div className="font-semibold text-foreground">Overnight</div>
            <div>00:00–06:00 · low demand, often flashing-mode eligible</div>
            <div className="font-semibold text-foreground">AM Rush</div>
            <div>06:00–09:00 · morning commute peak</div>
            <div className="font-semibold text-foreground">Midday</div>
            <div>09:00–12:00 · commercial/school activity</div>
            <div className="font-semibold text-foreground">PM Rush</div>
            <div>12:00–18:00 · the dominant period in most Tagum intersections</div>
            <div className="font-semibold text-foreground">Evening</div>
            <div>18:00–24:00 · tapering demand</div>
          </div>
          <div className="pt-2 border-t border-border">
            Defaults match an unsupervised K-means clustering of Tagum-realistic
            24-hour flow profiles. You can edit the boundaries per intersection - the
            CNN's warrant predictions and Webster's per-chunk timing both follow the
            edited boundaries.
          </div>
          <div className="text-[10px] italic">
            On the recommendations card the multi-task CNN already reasons over the
            full 96-slot 15-minute timeseries; the chunks here are the operator-facing
            buckets Webster's solves in closed form.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
