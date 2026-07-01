import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  simulationApi,
  type StochasticApproachStats,
  type StochasticConfidenceResponse,
} from '@/services/simulation';
import { JargonTip } from '@/components/JargonTip';
import { SimulationStripPlot } from '@/components/SimulationStripPlot';
import { cn } from '@/lib/utils';

/** Compact per-approach delay table (which approach the savings come from).
 *  Reads "before -> after (Δ s/veh saved)" per leg. Hidden behind the same
 *  disclosure as the histogram so the operator never sees raw numbers; the
 *  panel can expand on demand. */
function PerApproachTable({ rows }: { rows: StochasticApproachStats[] }) {
  return (
    <div className="overflow-x-auto">
      <p className="text-[11px] text-muted-foreground mb-1.5 leading-snug">
        Per-approach delay, before vs after:
      </p>
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-left  font-medium py-1 pr-2">Approach</th>
            <th className="text-right font-medium py-1 px-2">Before (s/veh)</th>
            <th className="text-right font-medium py-1 px-2">After (s/veh)</th>
            <th className="text-right font-medium py-1 pl-2">Saved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const delta = r.before.mean - r.after.mean;
            return (
              <tr key={r.approach_id} className="border-b border-border/40 last:border-0">
                <td className="py-1 pr-2 font-medium">
                  {r.label}
                  <span className="text-muted-foreground font-normal">
                    {' '}· {r.flow_pcu_hr.toFixed(0)} PCU/hr
                  </span>
                </td>
                <td className="py-1 px-2 text-right tabular-nums">
                  {r.before.mean.toFixed(1)}
                  <span className="text-muted-foreground">
                    {' '}[{r.before.ci_low_95.toFixed(1)}–{r.before.ci_high_95.toFixed(1)}]
                  </span>
                </td>
                <td className="py-1 px-2 text-right tabular-nums">
                  {r.after.mean.toFixed(1)}
                  <span className="text-muted-foreground">
                    {' '}[{r.after.ci_low_95.toFixed(1)}–{r.after.ci_high_95.toFixed(1)}]
                  </span>
                </td>
                <td
                  className={cn(
                    'py-1 pl-2 text-right tabular-nums font-semibold',
                    delta > 0.5
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : delta < -0.5
                        ? 'text-rose-700 dark:text-rose-400'
                        : 'text-muted-foreground',
                  )}
                >
                  {delta >= 0 ? '−' : '+'}{Math.abs(delta).toFixed(1)} s
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground/70 mt-1 leading-snug">
        Numbers in brackets are the 95% CI of average delay across 100 simulated hours.
      </p>
    </div>
  );
}

const LABEL_STYLE: Record<StochasticConfidenceResponse['label'], string> = {
  high:     'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  moderate: 'bg-amber-100   text-amber-800   dark:bg-amber-900/40   dark:text-amber-300',
  marginal: 'bg-rose-100    text-rose-800    dark:bg-rose-900/40    dark:text-rose-300',
};

const LABEL_TEXT: Record<StochasticConfidenceResponse['label'], string> = {
  high:     'High confidence',
  moderate: 'Moderate confidence',
  marginal: 'Marginal',
};

interface Props {
  intersectionId: number;
  /**
   * Render style:
   *   * 'card'    - self-wrapped card (border + bg). Default.
   *   * 'section' - same content as 'card' but no outer wrapper, for slotting
   *                 inside an existing card (e.g. the Findings panel) so the
   *                 verdict and the confidence read as one block.
   *   * 'inline'  - tiny pill for placing beside a vh_saved number.
   */
  variant?: 'card' | 'section' | 'inline';
  /**
   * Optional time window. When set, runs MC against that window via
   * `/simulation/stochastic-confidence/compute` so the envelope reads in
   * the same window-total units as the windowed Webster's Findings card.
   * When null, defaults to `?chunk=all` (all-day aggregate), which keeps
   * the badge's denominator the same as the daily Findings card.
   */
  window?: { start: string; end: string } | null;
}

/**
 * Surfaces the Monte Carlo confidence level for the active recommendation.
 *
 * Two modes:
 *   * Default (no `window` prop): aggregates MC across every TOD chunk into
 *     an "All day" envelope, matching the daily Findings card's denominator.
 *   * Windowed (`window` set): runs MC against the user-picked window so the
 *     envelope reads in window-total units, matching the windowed Findings.
 *
 * Why two paths instead of one:
 *   The aggregated "All day" view is cached (~50 ms on a hit, ~10 s on a
 *   cold miss across chunks) and is the right denominator for the default
 *   page. The windowed view is uncached (each window is unique) but only
 *   fires when the operator actively picks a replay window, so the 10 s
 *   wait is paired with the same wait they already incur for the windowed
 *   Webster's sim.
 */
export function ConfidenceBadge({ intersectionId, variant = 'card', window }: Props) {
  const [data, setData] = useState<StochasticConfidenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Memoise the window key for the effect deps so a re-render with the same
  // window object (different identity) doesn't refetch.
  const windowKey = window ? `${window.start}|${window.end}` : '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetcher = window
      ? simulationApi.stochasticConfidenceWindow({
          intersection_id: intersectionId,
          start: window.start.length === 16 ? window.start + ':00' : window.start,
          end:   window.end.length   === 16 ? window.end + ':00'   : window.end,
        })
      : simulationApi.stochasticConfidence(intersectionId, 'all');
    fetcher
      .then(r => { if (!cancelled) setData(r); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intersectionId, windowKey]);

  if (variant === 'card' || variant === 'section') {
    // Shared body: section omits the outer wrapper so it can sit inside an
    // existing card; card adds the border + bg so it can live on its own.
    const body = (
      <>
        <div className="flex items-center gap-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1">
            Confidence
            <JargonTip term="monte_carlo" />
          </p>
        </div>
        {loading ? (
          <div className="flex items-center gap-1.5 mt-1.5 text-muted-foreground text-xs">
            <Loader2 className="size-3 animate-spin" />
            Running 100 simulations…
          </div>
        ) : error ? (
          <div className="mt-1.5">
            <p className="text-xs text-muted-foreground italic">Not available</p>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-snug">
              {error}
            </p>
          </div>
        ) : data ? (
          <>
            <span
              className={cn(
                'inline-flex items-center px-2 py-0.5 rounded text-xs font-bold mt-1',
                LABEL_STYLE[data.label],
              )}
            >
              {LABEL_TEXT[data.label]}
            </span>
            <p className="text-xs text-muted-foreground mt-1.5 leading-snug">
              {data.sentence}
            </p>

            {/* Default-closed disclosure of the raw 100-run distribution.
                Operator never sees it; the panel can expand during defense.
                <details> is native, accessible, and works without extra state. */}
            <details className="mt-3 group print:hidden">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground select-none list-none inline-flex items-center gap-1">
                <span className="inline-block transition-transform group-open:rotate-90">▸</span>
                Show the {data.per_run_means.length} simulations
              </summary>
              <div className="mt-3 space-y-4">
                {/* Per-approach delay table. Exposes which approach the savings
                    actually come from; the 100-run aggregate above hides this. */}
                {data.per_approach.length > 0 && (
                  <PerApproachTable rows={data.per_approach} />
                )}
                <SimulationStripPlot
                  perRunMeans={data.per_run_means}
                  mean={data.vehicle_hours_saved.mean}
                  ciLow={data.vehicle_hours_saved.ci_low_95}
                  ciHigh={data.vehicle_hours_saved.ci_high_95}
                  analyticalRef={data.analytical_reference_vh}
                />
              </div>
            </details>
          </>
        ) : null}
      </>
    );
    if (variant === 'section') return <div className="flex flex-col">{body}</div>;
    return (
      <div className="rounded-lg border border-border bg-card p-4 print:p-3">
        {body}
      </div>
    );
  }

  // Inline variant for use beside a vh_saved number.
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="size-2.5 animate-spin" />
        confidence…
      </span>
    );
  }
  if (error || !data) return null;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <span
        className={cn(
          'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold',
          LABEL_STYLE[data.label],
        )}
      >
        {LABEL_TEXT[data.label]}
      </span>
      <JargonTip term="monte_carlo" />
    </span>
  );
}
