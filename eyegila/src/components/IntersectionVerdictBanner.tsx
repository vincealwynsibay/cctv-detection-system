import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, BadgeCheck, CheckCircle2, ChevronDown, Circle,
  Clock, Construction, Eye, Loader2, Sparkles, TrafficCone,
  TrendingUp, XCircle,
} from 'lucide-react';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Intersection } from '@/types';
import type { RecommendationResponse } from '@/services/recommendations';
import type { SimulationResponse } from '@/services/simulation';
import {
  deriveIntersectionAction,
  type ActionDescriptor,
  type ActionKind,
  type ActionTone,
} from '@/lib/intersectionAction';

/**
 * Single source-of-truth verdict banner shown above every intersection tab.
 *
 * The intersection workflow runs detections -> CNN -> warrants -> Webster ->
 * simulation -> action; this component compresses the full chain into one
 * line (headline + key evidence) so each tab below it can focus on its own
 * stage instead of re-telling the verdict. The "Why" popover expands the
 * chain into five clickable rows so an operator or panellist can audit any
 * stage without leaving the page.
 */

const ACTION_ICONS: Record<ActionKind, typeof CheckCircle2> = {
  install_signal: TrafficCone,
  widen_lanes:    Construction,
  adjust_timing:  Clock,
  monitor:        Eye,
  no_action:      CheckCircle2,
  no_analysis:    Circle,
};

const TONE_CLASS: Record<ActionTone, string> = {
  good:  'border-emerald-200 dark:border-emerald-800 bg-card text-foreground shadow-sm',
  warn:  'border-amber-200 dark:border-amber-800 bg-card text-foreground shadow-sm',
  info:  'border-sky-200 dark:border-sky-800 bg-card text-foreground shadow-sm',
  muted: 'border-border bg-card text-foreground shadow-sm',
};

const ICON_CLASS: Record<ActionTone, string> = {
  good:  'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400',
  warn:  'bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400',
  info:  'bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400',
  muted: 'bg-muted text-muted-foreground',
};

interface Props {
  intersection: Intersection;
  rec: RecommendationResponse | null;
  sim: SimulationResponse | null;
  /** Live rolling total from SSE, null while waiting for first frame. */
  liveCount: number | null;
  /** Base path like /intersections/123 so popover rows can deep-link. */
  baseHref: string;
  /** When the parent is mid-fetch (e.g. Analyse running) show a spinner. */
  busy?: boolean;
}

interface WarrantSummary {
  metCount:   number;
  totalCount: number;
  metLabels:  string[];
  /** Highest confidence among the warrants that tripped. */
  topConfPct: number | null;
}

function summarizeWarrants(rec: RecommendationResponse): WarrantSummary {
  const rows: Array<{ label: string; met: boolean; conf: number | null }> = [
    { label: 'W1',   met: rec.warrant_1_met, conf: rec.warrant_1_confidence },
    { label: 'W2',   met: rec.warrant_2_met, conf: rec.warrant_2_confidence },
    { label: 'W4',   met: rec.warrant_4_met, conf: rec.warrant_4_confidence },
  ];
  if (rec.w_local_1_met != null) {
    rows.push({ label: 'WL-1', met: !!rec.w_local_1_met, conf: rec.w_local_1_confidence ?? null });
  }
  if (rec.w_local_2_met != null) {
    rows.push({ label: 'WL-2', met: !!rec.w_local_2_met, conf: rec.w_local_2_confidence ?? null });
  }
  if (rec.w_local_3_met != null) {
    rows.push({ label: 'WL-3', met: !!rec.w_local_3_met, conf: rec.w_local_3_confidence ?? null });
  }
  const met = rows.filter(r => r.met);
  const topConf = met
    .map(r => r.conf ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  return {
    metCount:   met.length,
    totalCount: rows.length,
    metLabels:  met.map(r => r.label),
    topConfPct: met.length > 0 ? Math.round(topConf * 100) : null,
  };
}

export function IntersectionVerdictBanner({
  intersection, rec, sim, liveCount, baseHref, busy,
}: Props) {
  const action = useMemo(
    () => deriveIntersectionAction(rec, intersection, { sim }),
    [rec, intersection, sim],
  );
  const Icon = ACTION_ICONS[action.kind];
  const tone = TONE_CLASS[action.tone];
  const iconCls = ICON_CLASS[action.tone];

  const warrants = useMemo(
    () => (rec ? summarizeWarrants(rec) : null),
    [rec],
  );

  // Build the compact evidence line: warrants + Webster summary, separated
  // by middots. Each piece is independently optional so the line degrades
  // gracefully when, say, no sim has run yet.
  const evidenceBits: string[] = [];
  // Warrants are only relevant for signalize/monitor decisions. For a timing
  // adjustment on an existing signal, "no warrants met" is expected and adds noise.
  if (action.kind !== 'adjust_timing') {
    if (warrants && warrants.metCount > 0) {
      const conf = warrants.topConfPct;
      evidenceBits.push(
        `${warrants.metLabels.join('+')} met${conf != null ? ` (${conf}%)` : ''}`,
      );
    } else if (warrants && warrants.metCount === 0) {
      evidenceBits.push('no warrants met');
    }
  }
  if (rec?.timing_cycle != null) {
    const vh = rec.webster_vh_saved_per_day;
    if (action.kind === 'adjust_timing') {
      // Cycle is already in the headline - just show the savings number
      if (vh != null && vh > 1) {
        evidenceBits.push(`+${Math.round(vh).toLocaleString()} vh/day`);
      }
    } else if (vh != null && vh > 1) {
      evidenceBits.push(`${rec.timing_cycle}s cycle saves ${Math.round(vh).toLocaleString()} vh/day`);
    } else {
      evidenceBits.push(`${rec.timing_cycle}s cycle`);
    }
  }

  // The whole banner is the popover trigger now (not just a small "Why"
  // button on the right). Clicking anywhere on the banner row opens the
  // reasoning chain; the chevron on the right is purely an affordance.
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'group flex items-center gap-3 rounded-xl border px-3 py-2.5 print:hidden w-full text-left transition-all',
            'hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-foreground/30',
            tone,
          )}
          data-testid="verdict-banner"
          title="Click for full reasoning chain"
        >
          <div className={cn('rounded-md p-2 shrink-0', iconCls)}>
            {busy
              ? <Loader2 className="size-5 animate-spin" />
              : <Icon className="size-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <p className="text-sm font-semibold leading-tight">{action.headline}</p>
              {evidenceBits.length > 0 && (
                <p className="text-xs text-muted-foreground leading-snug">
                  {evidenceBits.map((b, i) => (
                    <span key={i}>
                      {i > 0 && <span className="text-muted-foreground/50"> · </span>}
                      {b}
                    </span>
                  ))}
                </p>
              )}
            </div>
            {action.detail && (
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug line-clamp-1">
                {action.detail}
              </p>
            )}
          </div>
          <span className="inline-flex items-center gap-1 shrink-0 text-[11px] font-medium text-muted-foreground group-hover:text-foreground transition-colors">
            Why
            <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[28rem] p-0">
        <ReasoningChain
          intersection={intersection}
          rec={rec}
          sim={sim}
          liveCount={liveCount}
          action={action}
          baseHref={baseHref}
        />
      </PopoverContent>
    </Popover>
  );
}

// ── Popover content ───────────────────────────────────────────────────────

interface ChainProps {
  intersection: Intersection;
  rec: RecommendationResponse | null;
  sim: SimulationResponse | null;
  liveCount: number | null;
  action: ActionDescriptor;
  baseHref: string;
}

function ReasoningChain({
  intersection, rec, sim, liveCount, action, baseHref,
}: ChainProps) {
  const warrants = rec ? summarizeWarrants(rec) : null;
  const sigStatus = intersection.signal_status;
  const isSignalized = sigStatus === 'fixed_time' || sigStatus === 'actuated';
  const dailySummary = sim?.daily_summary ?? null;

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2.5 border-b border-border">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
          How we got to this recommendation
        </p>
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-snug">
          Each row is one stage of the analysis. Click to jump to its tab.
        </p>
      </div>

      <ol className="flex flex-col divide-y divide-border">
        {/* 1. Detections - the raw camera input */}
        <ChainRow
          step={1}
          label="Detections"
          to={baseHref}
          icon={Activity}
        >
          {liveCount != null
            ? <>Rolling total today: <strong className="tabular-nums">{liveCount.toLocaleString()}</strong> vehicles across all CCTVs.</>
            : 'Waiting for first frame from the live SSE feed.'}
        </ChainRow>

        {/* 2. CNN warrant prediction */}
        <ChainRow
          step={2}
          label="CNN warrant model"
          to={`${baseHref}/report`}
          icon={Sparkles}
        >
          {!rec
            ? 'No analysis has been run yet.'
            : warrants && warrants.metCount > 0
              ? <>
                  Predicts <strong>{warrants.metLabels.join(', ')}</strong> met
                  {warrants.topConfPct != null && <> at up to <strong>{warrants.topConfPct}% confidence</strong></>}.
                  {' '}{warrants.totalCount - warrants.metCount} warrant(s) not met.
                </>
              : <>None of {warrants?.totalCount ?? 0} MUTCD warrants tripped.</>}
        </ChainRow>

        {/* 3. Warrant verdict (the legal gate) */}
        <ChainRow
          step={3}
          label="MUTCD verdict"
          to={`${baseHref}/report`}
          icon={warrants && warrants.metCount > 0 ? BadgeCheck : XCircle}
        >
          {!rec
            ? 'Pending.'
            : isSignalized
              ? <>Intersection is already <strong>{sigStatus.replace('_', ' ')}</strong>, so the warrant gate is informational.</>
              : warrants && warrants.metCount > 0
                ? <>Gate passed: at least one warrant trips, so signalisation is eligible under MUTCD.</>
                : <>Gate failed: no warrant trips, so a signal cannot be justified on volume alone.</>}
        </ChainRow>

        {/* 4. Webster timing */}
        <ChainRow
          step={4}
          label="Webster timing"
          to={`${baseHref}/timing`}
          icon={Clock}
        >
          {!rec || rec.timing_cycle == null
            ? 'No timing proposal generated.'
            : <>
                Optimal cycle <strong className="tabular-nums">{rec.timing_cycle}s</strong>
                {rec.webster_vh_saved_per_day != null && (
                  rec.webster_vh_saved_per_day > 1
                    ? <> · projected savings <strong className="tabular-nums">{Math.round(rec.webster_vh_saved_per_day).toLocaleString()} vh/day</strong>.</>
                    : rec.webster_vh_saved_per_day < -1
                      ? <> · projected change <strong className="tabular-nums">{Math.round(rec.webster_vh_saved_per_day).toLocaleString()} vh/day</strong> (adds delay).</>
                      : ' · projected change near zero (engineering noise).'
                )}
              </>}
        </ChainRow>

        {/* 5. Stochastic simulation */}
        <ChainRow
          step={5}
          label="Stochastic replays"
          to={`${baseHref}/report`}
          icon={TrendingUp}
        >
          {!sim
            ? 'No deterministic sim yet. Run Analyse to generate one.'
            : dailySummary
              ? <>
                  Webster's deterministic run shows
                  {' '}<strong>{dailySummary.los_before}</strong> -&gt; <strong>{dailySummary.los_after}</strong>.
                  {' '}Open Report for the 100-run replay verdict.
                </>
              : 'Sim available. Open Report to run 100 replays.'}
        </ChainRow>

        {/* 6. Final action */}
        <li className="px-4 py-3 bg-muted/40">
          <div className="flex items-start gap-2">
            <div className="text-[10px] font-mono text-muted-foreground mt-0.5">→</div>
            <div className="flex-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Reconciled action
              </p>
              <p className="text-sm font-semibold mt-0.5">{action.headline}</p>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">{action.detail}</p>
              {action.contradictionFlagged && (
                <p className="text-[11px] mt-1.5 text-amber-700 dark:text-amber-400 italic leading-snug">
                  MUTCD and Webster disagree on this one; the banner shows the reconciled verdict.
                </p>
              )}
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}

interface RowProps {
  step:     number;
  label:    string;
  to?:      string;
  icon:     typeof CheckCircle2;
  children: React.ReactNode;
}

function ChainRow({ step, label, to, icon: Icon, children }: RowProps) {
  const body = (
    <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors">
      <div className="flex flex-col items-center gap-0.5 shrink-0 pt-0.5">
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">{step}</span>
        <Icon className="size-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <div className="text-xs leading-snug mt-0.5">
          {children}
        </div>
      </div>
    </div>
  );
  return (
    <li>
      {to ? <Link to={to} className="block">{body}</Link> : body}
    </li>
  );
}
