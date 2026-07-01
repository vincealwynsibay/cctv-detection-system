import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Printer, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IntersectionTabs } from '@/components/IntersectionTabs';
import { IntersectionVerdictBanner } from '@/components/IntersectionVerdictBanner';
import { IntersectionWindowPicker } from '@/components/IntersectionWindowPicker';
import { SettingsSheet } from '@/components/IntersectionSettingsSheet';
import { intersectionsApi } from '@/services/intersections';
import { cctvsApi } from '@/services/cctvs';
import { streetsApi } from '@/services/streets';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { simulationApi, type SimulationResponse } from '@/services/simulation';
import type { AggregationRow, CCTV, Intersection, Street } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { toast } from 'sonner';

/**
 * Shared layout for the three intersection tabs (Live / Timing / Report).
 *
 * Why this exists: each tab used to render its own header with a different
 * set of action buttons (Analyse / Settings / Print / Edit) that drifted
 * apart over time. Centralising the Back/title/Analyse/Settings/Tabs row
 * here gives every tab a stable spine - tab-specific actions (Print on
 * Report, Edit timing on Timing) ride inside the tab body and don't
 * duplicate what the shell already provides.
 *
 * The shell fetches the four most-shared pieces of data (intersection,
 * latest rec, streets, cameras) and exposes them to children via the
 * outlet context so tabs don't all hammer the API independently. Tabs
 * can still fetch their own extras (simulation, timing chunks, etc.).
 */
/**
 * Globally-selected replay window. Lives on the shell so every tab reads from
 * the same source; brushing the picker in one tab updates the others without
 * page-local state ever forking. `null` means "default (no window)" and tabs
 * fall back to their normal data source (latest sim, full day, etc.).
 */
export interface WindowSelection {
  /** YYYY-MM-DD calendar day the window belongs to. */
  date:        string;
  /** YYYY-MM-DDTHH:MM (naive local time) - inclusive start. */
  start:       string;
  /** YYYY-MM-DDTHH:MM - exclusive end. */
  end:         string;
  /** Average vph over the selected hours (handy for replay-driven visuals). */
  vph:         number;
  /** Preset label if one of the named buttons fired it ('AM Rush', etc). */
  presetLabel: string | null;
}

/**
 * Status of the windowed sim the consuming tab is running for the selected
 * window. Lives on the shell so the picker chip can show a spinner or an
 * error pill directly - removes the need for a separate "Replaying" strip
 * in the tab body that restated the same state in a second place.
 */
export interface WindowStatus {
  state:    'idle' | 'loading' | 'error';
  message?: string;
}

export interface IntersectionShellContext {
  intersection: Intersection | null;
  rec: RecommendationResponse | null;
  streets: Street[];
  cameras: CCTV[];
  /** Live (auto-generated) simulation - null while loading or when none exists. */
  sim: SimulationResponse | null;
  refreshShell: () => Promise<void>;
  sseData: AggregationRow[] | null;
  sseStatus: SSEStatus;
  /** Globally-selected replay window. null = default (no window). */
  window: WindowSelection | null;
  setWindow: (sel: WindowSelection | null) => void;
  /** Tab-reported status of any windowed compute it's running. */
  windowStatus: WindowStatus;
  setWindowStatus: (s: WindowStatus) => void;
}

interface ParentContext {
  sseData: AggregationRow[] | null;
  sseStatus: SSEStatus;
}

export function IntersectionShell() {
  const { id } = useParams<{ id: string }>();
  const interId = Number(id);
  const navigate = useNavigate();
  const { sseData, sseStatus } = useOutletContext<ParentContext>();

  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [rec, setRec]                   = useState<RecommendationResponse | null>(null);
  const [streets, setStreets]           = useState<Street[]>([]);
  const [cameras, setCameras]           = useState<CCTV[]>([]);
  const [sim, setSim]                   = useState<SimulationResponse | null>(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [generating, setGenerating]     = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Globally-selected replay window. null = default. Reset on intersection
  // change so an "AM Rush" pick on intersection A doesn't bleed into B.
  const [window_, setWindow]            = useState<WindowSelection | null>(null);
  const [windowStatus, setWindowStatus] = useState<WindowStatus>({ state: 'idle' });
  useEffect(() => {
    setWindow(null);
    setWindowStatus({ state: 'idle' });
  }, [interId]);

  const load = useCallback(async () => {
    if (!Number.isFinite(interId)) {
      setError('Invalid intersection id');
      setLoading(false);
      return;
    }
    try {
      // Sim and rec are both needed by every tab's recommended-action banner;
      // fetch them alongside the other shared bits so each tab doesn't refetch.
      const [inter, allStreets, allCams, latestRec, latestSim] = await Promise.all([
        intersectionsApi.get(interId),
        streetsApi.list().catch(() => [] as Street[]),
        cctvsApi.list().catch(() => [] as CCTV[]),
        recommendationsApi.latest(interId).catch(() => null),
        simulationApi.get(interId).catch(() => null),
      ]);
      setIntersection(inter);
      setStreets(allStreets.filter(s => s.intersection_id === interId));
      // Sort cameras by id so the Live grid's slot order is stable across
      // shell refreshes. The /cctvs endpoint returns rows in no guaranteed
      // order, which made the camera tiles visibly shuffle on every refetch.
      setCameras(
        allCams
          .filter(c => c.intersection_id === interId)
          .sort((a, b) => a.id - b.id),
      );
      setRec(latestRec);
      setSim(latestSim);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load intersection');
    } finally {
      setLoading(false);
    }
  }, [interId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Refetch rec + sim when the tab regains focus. The dashboard auto-polls
  // every 5 min and rewrites recs in the DB; without this, an operator who
  // leaves the Live/Timing tab open sees a stale verdict that disagrees with
  // the dashboard until they manually navigate. Keep the refetch quiet
  // (no spinner, no toast) so it's invisible when nothing changed.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [load]);

  async function generate() {
    setGenerating(true);
    try {
      const newRec = await recommendationsApi.generate(interId);
      setRec(newRec);
      // Refresh sim too - generating a new recommendation rewrites the
      // simulation rows, and the recommended-action banner reconciles against
      // them. Without this the banner keeps the previous sim's verdict.
      const freshSim = await simulationApi.get(interId).catch(() => null);
      setSim(freshSim);
      toast.success('Analysis complete');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setGenerating(false);
    }
  }

  // Rolling daily count from the SSE feed, scoped to this intersection. Used
  // by the verdict banner's "Detections" reasoning row so every tab sees the
  // same live number without re-summing it locally. Computed before the early
  // returns so the hook order stays stable across renders.
  const liveCount = useMemo(() => {
    if (!sseData) return null;
    let total = 0;
    for (const row of sseData) {
      if (row.intersection_id === interId) total += row.count;
    }
    return total;
  }, [sseData, interId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading intersection…
      </div>
    );
  }

  if (error || !intersection) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-rose-600">
        {error ?? 'Intersection not found'}
      </div>
    );
  }

  const ctx: IntersectionShellContext = {
    intersection, rec, streets, cameras, sim, refreshShell: load, sseData, sseStatus,
    window: window_, setWindow,
    windowStatus, setWindowStatus,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Unified header - every tab sees the same spine */}
      <div className="flex items-center gap-3 print:hidden">
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => navigate('/')}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight truncate">{intersection.name}</h1>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {intersection.signal_status.replace('_', ' ')}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Live counts, warrant verdict, Webster timing analysis, and printable report.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1.5"
            onClick={generate}
            disabled={generating}
            title="Run warrant analysis (all tabs)"
          >
            {generating ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {generating ? 'Analysing…' : 'Analyse'}
          </Button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Intersection settings"
          >
            <Settings2 className="size-4" />
          </button>
          {/* Print/Export PDF lives in the shell because every tab's print
              action was just window.print() against tab-local print: CSS -
              identical wiring on Live, Timing, and Report. Centralising it
              kills the duplicate buttons and gives every tab the affordance. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => window.print()}
            title="Print the current view as PDF"
          >
            <Printer className="size-3 mr-1" />
            Print
          </Button>
        </div>
      </div>

      {/* Single verdict banner - the reconciled action sits above every tab so
          no individual tab needs to re-render it. The "Why" popover expands the
          full detections -> CNN -> warrant -> Webster -> sim reasoning chain. */}
      <IntersectionVerdictBanner
        intersection={intersection}
        rec={rec}
        sim={sim}
        liveCount={liveCount}
        baseHref={`/intersections/${interId}`}
        busy={generating}
      />

      {/* Tabs row + shell-level window picker. Both right-aligned so they
          read as one group of view-scoping controls (which tab, which time
          window). The picker writes to shell context so every tab can read
          the selected replay window from one place rather than each holding
          its own histStart/histEnd state. */}
      <div className="flex items-center justify-end gap-2 print:hidden flex-wrap">
        <IntersectionTabs intersectionId={interId} />
        <IntersectionWindowPicker
          intersectionId={interId}
          selection={window_}
          onChange={setWindow}
          status={windowStatus}
        />
      </div>

      {/* Active tab renders here */}
      <Outlet context={ctx} />

      <SettingsSheet
        inter={intersection}
        streets={streets}
        cameras={cameras}
        rec={rec}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onRefresh={load}
      />
    </div>
  );
}

/** Convenience hook for child pages that live under <IntersectionShell />. */
export function useIntersectionShell(): IntersectionShellContext {
  return useOutletContext<IntersectionShellContext>();
}
