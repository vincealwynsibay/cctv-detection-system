import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Loader2, MonitorPlay, Pause, Play,
  Sliders, Sparkles, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIntersectionShell } from '@/components/IntersectionShell';
import { selectPeakChunk } from '@/lib/simulation';
import { timingApi, type TimingChunk } from '@/services/timing';
import {
  DualIntersectionCanvas,
  type TypeFractions,
} from '@/components/IntersectionCanvas';
import {
  ARM_SHORT, GanttDiagram, LosBadge,
} from '@/components/signal-timing-viz';
import { SimulationStripPlot } from '@/components/SimulationStripPlot';
import {
  simulationApi,
  type StochasticApproachStats,
  type StochasticConfidenceResponse,
} from '@/services/simulation';
import { cn } from '@/lib/utils';

/** Plain-language duration formatter.
 *  Under 60 s shows seconds, under an hour shows minutes (and seconds when
 *  the remainder is non-trivial), otherwise hours and minutes. */
function formatWait(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60)   return `${s} sec`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  if (m < 60) {
    if (m >= 10 || rs === 0) return `${m} min`;
    return `${m} min ${rs} sec`;
  }
  const h = Math.floor(m / 60);
  return `${h} hr ${m - h * 60} min`;
}

/**
 * Story tab: a 4-step guided walkthrough of a single intersection's
 * "before, recommend, watch, confirm" arc. Designed so the same page
 * can be opened in production by an operator and projected during a
 * defense panel without changing modes; the steps simply read as a
 * narrative either way.
 *
 * Why 4 steps:
 *   1. "Here is your intersection right now" (current LOS, single playback).
 *   2. "Here is what we recommend changing" (phase comparison + green
 *      delta callout).
 *   3. "Here is the difference, playing side by side" (DualIntersectionCanvas
 *      driven by the same arrivals, live cumulative delay tally).
 *   4. "Here is how confident we are" (ConfidenceBadge with the histogram
 *      and per-approach table always expanded).
 *
 * Step state lives in the URL hash (`#step=3`) so deep links survive
 * a refresh and the panel can pre-load the right slide.
 */

const STEPS = [
  { id: 1, label: 'Now',         icon: MonitorPlay },
  { id: 2, label: 'Recommend',   icon: Sliders     },
  { id: 3, label: 'Watch',       icon: Sparkles    },
  { id: 4, label: 'Confidence',  icon: ShieldCheck },
] as const;

type StepId = typeof STEPS[number]['id'];

function parseStepFromHash(): StepId {
  if (typeof window === 'undefined') return 1;
  const m = window.location.hash.match(/step=(\d+)/);
  const n = m ? Number(m[1]) : 1;
  return (n >= 1 && n <= 4 ? n : 1) as StepId;
}

export function IntersectionStoryPage() {
  const ctx = useIntersectionShell();
  const { intersection, streets, rec, sim } = ctx;

  const [step, setStep] = useState<StepId>(() => parseStepFromHash());
  const [timing, setTiming] = useState<TimingChunk[]>([]);

  useEffect(() => {
    if (!intersection) return;
    timingApi.list(intersection.id)
      .then(setTiming)
      .catch(() => setTiming([]));
  }, [intersection]);

  // Reflect step into the URL hash. Listen for hash changes too so back/forward
  // navigation moves between steps.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = `#step=${step}`;
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [step]);

  useEffect(() => {
    const onHash = () => setStep(parseStepFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const autoPeak = useMemo(() => selectPeakChunk(sim), [sim]);

  // Selected chunk drives the canvas, MC fetch, and stat cards. Defaults to
  // the peak chunk (highest analytical vh_saved); the dropdown lets an
  // engineer drill into other periods without leaving the page.
  const [selectedChunkName, setSelectedChunkName] = useState<string | null>(null);
  useEffect(() => {
    if (selectedChunkName == null && autoPeak) {
      setSelectedChunkName(autoPeak.chunk_name);
    }
  }, [autoPeak, selectedChunkName]);

  const selectedChunk = useMemo(() => {
    if (!sim) return null;
    if (!selectedChunkName) return autoPeak;
    return sim.chunks.find(c => c.chunk_name === selectedChunkName) ?? autoPeak;
  }, [sim, selectedChunkName, autoPeak]);

  const selectedTiming = useMemo(() => {
    if (!selectedChunk) return timing[0] ?? null;
    return timing.find(t => t.chunk_name === selectedChunk.chunk_name) ?? timing[0] ?? null;
  }, [selectedChunk, timing]);

  if (!intersection) return null;

  const go = (delta: number) => {
    const next = Math.min(4, Math.max(1, step + delta)) as StepId;
    setStep(next);
    // Smooth scroll to top of the step container so the next slide starts clean.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // "All day" is a special option that asks the backend to aggregate MC
  // across every chunk. It's first in the list so the operator sees the
  // whole-day verdict by default-conscious clicking; the peak chunk
  // remains the auto-default for first page load.
  const chunkOptions = ['All day', ...(sim?.chunks
    .map(c => c.chunk_name)
    .filter(n => n !== 'overall') ?? [])];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 flex-wrap print:hidden">
        <StepProgress step={step} onJump={(s) => setStep(s)} />
        {chunkOptions.length > 0 && selectedChunkName && (
          <ChunkPicker
            options={chunkOptions}
            selected={selectedChunkName}
            peakName={autoPeak?.chunk_name ?? null}
            onChange={setSelectedChunkName}
          />
        )}
      </div>

      <div className="min-h-[400px]">
        {step === 1 && (
          <Step1Now
            intersection={intersection}
            streets={streets}
            sim={sim}
            peakChunk={selectedChunk}
            peakTiming={selectedTiming}
            selectedChunkName={selectedChunkName}
          />
        )}
        {step === 2 && (
          <Step2Recommend
            intersection={intersection}
            streets={streets}
            rec={rec}
            peakChunk={selectedChunk}
            peakTiming={selectedTiming}
          />
        )}
        {step === 3 && (
          <Step3Watch
            intersection={intersection}
            streets={streets}
            peakChunk={selectedChunk}
            peakTiming={selectedTiming}
            signalStatus={intersection.signal_status}
          />
        )}
        {step === 4 && (
          <Step4Confidence
            intersectionId={intersection.id}
            chunkName={selectedChunkName}
          />
        )}
      </div>

      {/* Navigation bar pinned to the bottom of the content. */}
      <div className="flex items-center justify-between gap-3 pt-4 border-t border-border print:hidden">
        <Button
          variant="outline" size="sm"
          onClick={() => go(-1)}
          disabled={step === 1}
        >
          <ChevronLeft className="size-3.5 mr-1" />
          Back
        </Button>
        <span className="text-xs text-muted-foreground">
          Step {step} of {STEPS.length}: {STEPS[step - 1].label}
        </span>
        <Button
          variant={step === 4 ? 'outline' : 'default'}
          size="sm"
          onClick={() => go(1)}
          disabled={step === 4}
        >
          Next
          <ChevronRight className="size-3.5 ml-1" />
        </Button>
      </div>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────

function StepProgress({
  step, onJump,
}: { step: StepId; onJump: (s: StepId) => void }) {
  return (
    <nav
      aria-label="Story progress"
      className="inline-flex items-center gap-1.5 print:hidden"
    >
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const isActive = s.id === step;
        const isDone   = s.id < step;
        return (
          <div key={s.id} className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onJump(s.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
                isActive
                  ? 'bg-foreground text-background'
                  : isDone
                    ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
              )}
              aria-current={isActive ? 'step' : undefined}
            >
              <Icon className="size-3.5" />
              <span className="hidden sm:inline">{s.label}</span>
            </button>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  'h-0.5 w-4 sm:w-6 rounded-full transition-colors',
                  isDone ? 'bg-emerald-400 dark:bg-emerald-500' : 'bg-border',
                )}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ── Step 1: Right now ──────────────────────────────────────────────────────

type Step1Props = {
  intersection: NonNullable<ReturnType<typeof useIntersectionShell>['intersection']>;
  streets: ReturnType<typeof useIntersectionShell>['streets'];
  sim: ReturnType<typeof useIntersectionShell>['sim'];
  peakChunk: ReturnType<typeof selectPeakChunk>;
  peakTiming: TimingChunk | null;
  selectedChunkName: string | null;
};

function Step1Now({
  intersection, streets, sim, peakChunk, peakTiming, selectedChunkName,
}: Step1Props) {
  const ds = sim?.daily_summary ?? null;
  const [paused, setPaused] = useState(false);
  const [speed,  setSpeed]  = useState<1 | 4 | 8 | 16 | 32 | 64>(8);
  const typeMix: Record<string, TypeFractions> = {};

  // Cards switch source based on the chunk picker. "All day" uses the
  // intersection-wide daily summary; a specific chunk uses that chunk's
  // row so the numbers match the playback period the operator chose.
  const isAllDay = selectedChunkName === 'All day' || selectedChunkName == null;
  const waitSeconds = isAllDay
    ? ds?.avg_delay_before ?? null
    : peakChunk?.delay_before ?? null;
  const losGrade = isAllDay
    ? ds?.los_before ?? null
    : peakChunk?.los_before ?? null;
  const flowVph = isAllDay
    ? ds?.total_volume_pcu_hr ?? null
    : peakChunk?.volume_pcu_hr ?? null;
  const periodLabel = isAllDay ? 'today' : `during ${selectedChunkName}`;
  const introText = isAllDay
    ? `Watching real CCTV detections from ${intersection.name}. The numbers below are the average wait time a driver sees across the whole day.`
    : `Watching real CCTV detections from ${intersection.name} during ${selectedChunkName}. The numbers below are the average wait time a driver sees in this time period.`;

  return (
    <section className="flex flex-col gap-4">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Step 1 of 4</p>
        <h2 className="text-xl font-semibold">Here is your intersection right now.</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-snug">
          {introText}
        </p>
      </header>

      {waitSeconds != null && flowVph != null && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <StatCard
            label={`Average wait ${periodLabel}`}
            value={`${waitSeconds.toFixed(1)} s`}
            sub={<>per vehicle{losGrade && <> <LosBadge grade={losGrade} /></>}</>}
          />
          <StatCard
            label={isAllDay ? 'Daily flow' : `Flow ${periodLabel}`}
            value={`${Math.round(flowVph).toLocaleString()}`}
            sub="vehicles per hour"
          />
        </div>
      )}

      {peakChunk && peakTiming && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3 print:hidden">
            <h3 className="text-sm font-semibold">Live playback (current timing)</h3>
            <PlaybackControls
              paused={paused} onTogglePause={() => setPaused(p => !p)}
              speed={speed}   onSpeed={setSpeed}
            />
          </div>
          <DualIntersectionCanvas
            chunk={peakChunk}
            timing={peakTiming}
            signalStatus={intersection.signal_status}
            typeMix={typeMix}
            paused={paused}
            speed={speed}
            streets={streets}
            existingCycleS={intersection.existing_cycle_length ?? null}
            existingGreenSplits={intersection.existing_green_splits ?? null}
            lockedViewMode="before"
          />
        </div>
      )}
    </section>
  );
}

// ── Step 2: Recommended change ─────────────────────────────────────────────

type Step2Props = {
  intersection: NonNullable<ReturnType<typeof useIntersectionShell>['intersection']>;
  streets: ReturnType<typeof useIntersectionShell>['streets'];
  rec: ReturnType<typeof useIntersectionShell>['rec'];
  peakChunk: ReturnType<typeof selectPeakChunk>;
  peakTiming: TimingChunk | null;
};

function Step2Recommend({ intersection, streets, peakTiming }: Step2Props) {
  const usableStreets = streets.filter(s => s.arm_direction !== 'unknown');
  const currentApproaches = usableStreets.map(s => ({
    label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
    greenSec: (intersection.existing_green_splits as Record<string, number> | null)?.[String(s.id)] ?? 0,
  }));
  const recommendedApproaches = usableStreets.map(s => ({
    label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
    greenSec: peakTiming?.green_splits[String(s.id)] ?? 0,
  }));

  // Per-approach green-time delta, sorted by absolute change.
  const deltas = usableStreets.map((s, i) => ({
    label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
    delta: recommendedApproaches[i].greenSec - currentApproaches[i].greenSec,
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return (
    <section className="flex flex-col gap-4">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Step 2 of 4</p>
        <h2 className="text-xl font-semibold">Here is what we recommend changing.</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-snug">
          Webster's signal-timing formula picks a cycle length and a green-time
          split for each approach to minimize total wait. The numbers below
          show how each green window would shift.
        </p>
      </header>

      {peakTiming && usableStreets.length > 0 ? (
        <>
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="text-sm font-semibold mb-4">Phase comparison{peakTiming.chunk_name ? ` (${peakTiming.chunk_name})` : ''}</h3>
            <div className="flex gap-6 flex-col sm:flex-row">
              {intersection.existing_cycle_length && intersection.existing_green_splits ? (
                <GanttDiagram
                  title="Current timing"
                  cycleLength={intersection.existing_cycle_length}
                  approaches={currentApproaches}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center py-8 rounded-md border border-dashed border-border text-xs text-muted-foreground text-center px-4">
                  No current timing entered.
                </div>
              )}
              <div className="w-px bg-border hidden sm:block shrink-0" />
              <GanttDiagram
                title="Recommended (Webster)"
                titleClassName="text-emerald-600"
                cycleLength={peakTiming.cycle_length}
                approaches={recommendedApproaches}
              />
            </div>
          </div>

          {/* Plain-language delta callouts. */}
          {deltas.some(d => Math.abs(d.delta) > 0.5) && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-2">What changes</h3>
              <ul className="space-y-1 text-sm">
                {deltas.filter(d => Math.abs(d.delta) > 0.5).map((d) => (
                  <li key={d.label} className="flex items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums',
                        d.delta > 0
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                          : 'bg-amber-100   text-amber-800   dark:bg-amber-900/40   dark:text-amber-300',
                      )}
                    >
                      {d.delta > 0 ? '+' : ''}{d.delta.toFixed(0)}s
                    </span>
                    <span className="text-muted-foreground">
                      green on {d.label}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground mt-3 leading-snug">
                Green time is a zero-sum game: every second added to one approach
                is taken from another. Webster's allocates it to the approach
                with the highest demand-to-capacity ratio.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No timing recommendation available yet. Run Analyse to generate one.
        </div>
      )}
    </section>
  );
}

// ── Step 3: Side-by-side playback ──────────────────────────────────────────

type Step3Props = {
  intersection: NonNullable<ReturnType<typeof useIntersectionShell>['intersection']>;
  streets: ReturnType<typeof useIntersectionShell>['streets'];
  peakChunk: ReturnType<typeof selectPeakChunk>;
  peakTiming: TimingChunk | null;
  signalStatus: string;
};

function Step3Watch({
  intersection, streets, peakChunk, peakTiming, signalStatus,
}: Step3Props) {
  const [paused, setPaused] = useState(false);
  const [speed,  setSpeed]  = useState<1 | 4 | 8 | 16 | 32 | 64>(16);
  const typeMix: Record<string, TypeFractions> = {};

  // Headline savings number for the peak chunk (the same hour we are
  // visualising). Webster's per-chunk vh_saved is the "expected" delta;
  // the panel can compare to the Confidence step for the CI.
  const vhSavedPerHour = useMemo(() => {
    if (!peakChunk) return null;
    return peakChunk.vehicle_hours_saved;
  }, [peakChunk]);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Step 3 of 4</p>
        <h2 className="text-xl font-semibold">Here is the difference.</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-snug">
          Same hour of real CCTV arrivals fed into both timings. Left side
          uses the current timing; right side uses the recommended one. The
          difference in how fast queues clear is the saving.
        </p>
      </header>

      {peakChunk && peakTiming ? (
        <>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3 print:hidden flex-wrap gap-2">
              <h3 className="text-sm font-semibold">Current (left) vs Recommended (right)</h3>
              <PlaybackControls
                paused={paused} onTogglePause={() => setPaused(p => !p)}
                speed={speed}   onSpeed={setSpeed}
              />
            </div>
            <DualIntersectionCanvas
              chunk={peakChunk}
              timing={peakTiming}
              signalStatus={signalStatus}
              typeMix={typeMix}
              paused={paused}
              speed={speed}
              streets={streets}
              existingCycleS={intersection.existing_cycle_length ?? null}
              existingGreenSplits={intersection.existing_green_splits ?? null}
              lockedViewMode="dual"
            />
          </div>

          {vhSavedPerHour != null && vhSavedPerHour > 0 && (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/10 p-4">
              <p className="text-xs text-muted-foreground">Headline saving (peak period)</p>
              <p className="text-2xl font-semibold text-emerald-700 dark:text-emerald-400 mt-0.5 tabular-nums">
                {vhSavedPerHour.toFixed(1)} vh saved
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">
                This is Webster's deterministic estimate for the peak period.
                The next step shows how 100 stochastic replays compare.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No simulation data yet. Run Analyse first.
        </div>
      )}
    </section>
  );
}

// ── Step 4: Confidence ─────────────────────────────────────────────────────

const VERDICT: Record<
  StochasticConfidenceResponse['label'],
  { hero: string; headline: string; subtitle: string; actions: string[]; tone: string }
> = {
  high: {
    hero:     'Yes, you can deploy this.',
    headline: 'Very confident',
    subtitle: 'We replayed this hour 100 times. Every replay agreed the recommended timing performs better than what you have today.',
    actions: [
      'Deploy the recommended timing.',
      'Re-check this intersection after one week to confirm.',
    ],
    tone: 'emerald',
  },
  moderate: {
    hero:     'You can deploy this, with care.',
    headline: 'Moderately confident',
    subtitle: 'We replayed this hour 100 times. The improvement is real on average, but the savings varied between replays. Some hours saw more benefit than others.',
    actions: [
      'Deploy the recommended timing.',
      'Watch the next peak hour closely.',
      'If wait times do not drop as expected, retune the green splits.',
    ],
    tone: 'amber',
  },
  marginal: {
    hero:     'Hold off for now.',
    headline: 'Not confident',
    subtitle: 'We replayed this hour 100 times. The savings were small enough that random traffic patterns explain them. We cannot tell apart a real improvement from luck.',
    actions: [
      'Do not change the timing yet.',
      'Collect at least one more week of traffic data.',
      'Re-run analysis and check again.',
    ],
    tone: 'rose',
  },
};

const TONE_CLASS: Record<string, { badge: string; card: string; text: string }> = {
  emerald: {
    badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    card:  'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/10',
    text:  'text-emerald-700 dark:text-emerald-400',
  },
  amber: {
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    card:  'border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10',
    text:  'text-amber-700 dark:text-amber-400',
  },
  rose: {
    badge: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    card:  'border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/10',
    text:  'text-rose-700 dark:text-rose-400',
  },
};

function ApproachRow({ row }: { row: StochasticApproachStats }) {
  const saved = row.before.mean - row.after.mean;
  const improved = saved > 0.5;
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="font-medium text-sm">{row.label}</span>
        {improved && (
          <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
            saves {formatWait(saved)} per driver
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-1 leading-snug">
        Average wait drops from{' '}
        <span className="font-medium text-foreground">{formatWait(row.before.mean)}</span>
        {' '}to{' '}
        <span className="font-medium text-foreground">{formatWait(row.after.mean)}</span>.
      </p>
    </div>
  );
}

function Step4Confidence({
  intersectionId, chunkName,
}: { intersectionId: number; chunkName: string | null }) {
  const [data,    setData]    = useState<StochasticConfidenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    simulationApi.stochasticConfidence(intersectionId, chunkName ?? undefined)
      .then(r => { if (!cancelled) setData(r); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [intersectionId, chunkName]);

  const verdict = data ? VERDICT[data.label] : null;
  const tone = verdict ? TONE_CLASS[verdict.tone] : null;

  return (
    <section className="flex flex-col gap-4">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Step 4 of 4</p>
        <h2 className="text-xl font-semibold">Should you deploy this?</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-snug">
          The playback you just watched is one example hour. To check the
          recommendation holds up under different traffic patterns, we
          replayed the same hour 100 more times with realistic random
          arrivals. Here is the verdict.
        </p>
      </header>

      {loading && (
        <div className="rounded-lg border border-border bg-card p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Running 100 replays, this takes about ten seconds.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <p className="text-muted-foreground italic">We could not run the replay test.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">{error}</p>
        </div>
      )}

      {data && verdict && tone && (
        <>
          {/* Hero verdict card */}
          <div className={cn('rounded-lg border p-5', tone.card)}>
            <span className={cn(
              'inline-flex items-center px-2 py-0.5 rounded text-xs font-bold',
              tone.badge,
            )}>
              {verdict.headline}
            </span>
            <h3 className={cn('text-2xl font-semibold mt-2', tone.text)}>
              {verdict.hero}
            </h3>
            <p className="text-sm text-muted-foreground mt-2 leading-snug max-w-3xl">
              {verdict.subtitle}
            </p>
          </div>

          {/* What this means per direction */}
          {data.per_approach.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-2">Where the savings come from</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {data.per_approach.map(r => (
                  <ApproachRow key={r.approach_id} row={r} />
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
                These are the average wait times per driver during the busiest
                period of the day.
              </p>
            </div>
          )}

          {/* Action list, only for this confidence level */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold mb-2">What to do next</h3>
            <ul className="space-y-1.5 text-sm">
              {verdict.actions.map((a, i) => (
                <li key={i} className="flex items-start gap-2 leading-snug">
                  <span className={cn('mt-0.5 shrink-0', tone.text)}>
                    {data.label === 'marginal' ? '✗' : '✓'}
                  </span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Engineer-only details: histogram + raw numbers. Default-closed
              so non-technical viewers never see it. */}
          <details className="group print:hidden">
            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground select-none list-none inline-flex items-center gap-1">
              <span className="inline-block transition-transform group-open:rotate-90">▸</span>
              Show the full simulation data (engineer view)
            </summary>
            <div className="mt-3 space-y-4">
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground mb-1.5 leading-snug">
                  Each row shows the per-driver wait time with a 95% confidence
                  interval in brackets, computed across the 100 replays.
                </p>
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left  font-medium py-1 pr-2">Direction</th>
                      <th className="text-right font-medium py-1 px-2">Before (s/veh)</th>
                      <th className="text-right font-medium py-1 px-2">After (s/veh)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.per_approach.map(r => (
                      <tr key={r.approach_id} className="border-b border-border/40 last:border-0">
                        <td className="py-1 pr-2 font-medium">
                          {r.label}
                          <span className="text-muted-foreground font-normal">
                            {' '}({r.flow_pcu_hr.toFixed(0)} PCU/hr)
                          </span>
                        </td>
                        <td className="py-1 px-2 text-right tabular-nums">
                          {r.before.mean.toFixed(1)}
                          <span className="text-muted-foreground">
                            {' '}[{r.before.ci_low_95.toFixed(1)}, {r.before.ci_high_95.toFixed(1)}]
                          </span>
                        </td>
                        <td className="py-1 px-2 text-right tabular-nums">
                          {r.after.mean.toFixed(1)}
                          <span className="text-muted-foreground">
                            {' '}[{r.after.ci_low_95.toFixed(1)}, {r.after.ci_high_95.toFixed(1)}]
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <SimulationStripPlot
                  perRunMeans={data.per_run_means}
                  mean={data.vehicle_hours_saved.mean}
                  ciLow={data.vehicle_hours_saved.ci_low_95}
                  ciHigh={data.vehicle_hours_saved.ci_high_95}
                  analyticalRef={data.analytical_reference_vh}
                />
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

// ── Chunk picker ───────────────────────────────────────────────────────────

/**
 * Pill-button row at the top of the Story page for switching the
 * time-of-day period the narrative is about. Visually matches the tab
 * nav so the page reads as one consistent control surface, not a tabs
 * row plus a styled dropdown. The peak chunk is marked with a small dot
 * so it's obvious which one is recommended.
 */
function ChunkPicker({
  options, selected, peakName, onChange,
}: {
  options: string[];
  selected: string;
  peakName: string | null;
  onChange: (s: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Time of day period"
      className="flex flex-wrap rounded-md border border-border bg-card print:hidden overflow-hidden"
    >
      {options.map(name => {
        const isActive = name === selected;
        const isPeak   = name === peakName;
        return (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(name)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-l border-border first:border-l-0',
              isActive
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
          >
            {name}
            {isPeak && (
              <span
                className={cn(
                  'inline-block size-1.5 rounded-full',
                  isActive ? 'bg-emerald-300' : 'bg-emerald-500',
                )}
                aria-label="peak"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Small shared pieces ────────────────────────────────────────────────────

function StatCard({
  label, value, sub,
}: { label: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold mt-1 tabular-nums">{value}</p>
      <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
        {sub}
      </div>
    </div>
  );
}

type PlaybackSpeed = 1 | 4 | 8 | 16 | 32 | 64;

function PlaybackControls({
  paused, onTogglePause, speed, onSpeed,
}: {
  paused: boolean;
  onTogglePause: () => void;
  speed: PlaybackSpeed;
  onSpeed: (s: PlaybackSpeed) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Button
        variant="outline" size="sm" className="h-7 px-2 text-xs"
        onClick={onTogglePause}
      >
        {paused ? <Play className="size-3 mr-1" /> : <Pause className="size-3 mr-1" />}
        {paused ? 'Play' : 'Pause'}
      </Button>
      {([1, 4, 8, 16, 32, 64] as const).map(s => (
        <Button
          key={s}
          variant={speed === s ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-2 text-xs tabular-nums"
          onClick={() => onSpeed(s)}
        >
          {s}x
        </Button>
      ))}
    </div>
  );
}
