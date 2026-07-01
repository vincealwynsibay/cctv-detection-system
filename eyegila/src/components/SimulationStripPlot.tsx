import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer, Cell,
} from 'recharts';

interface Props {
  /** One number per run (vehicle-hours saved on each simulated hour). */
  perRunMeans: number[];
  mean: number;
  /** 95% CI bounds. Accepted for API parity but the histogram shows the
   *  literal distribution, not the CI bracket. */
  ciLow:  number;
  ciHigh: number;
  /** Webster's analytical point estimate, normalised to per-hour by the
   *  backend so it shares an axis with the MC runs. */
  analyticalRef: number;
}

const BIN_COUNT = 12;

interface Bin {
  label:    string;   // tooltip label, e.g. "78.3 – 82.1 vh"
  midpoint: number;   // X-axis position
  count:    number;   // how many of the 100 replays fell in this bin
  isMean:   boolean;  // bar containing the average gets highlighted
}

/** Bin the per-run values into `BIN_COUNT` equal-width buckets so the
 *  bar chart shows the actual distribution shape. Bin boundaries include
 *  the textbook reference's range so its reference line lands on-axis
 *  even when it's an outlier. */
function buildBins(values: number[], analyticalRef: number, mean: number): Bin[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values, analyticalRef);
  const hi = Math.max(...values, analyticalRef);
  const span = Math.max(hi - lo, 1e-6);
  const step = span / BIN_COUNT;

  const bins: Bin[] = Array.from({ length: BIN_COUNT }, (_, i) => {
    const from = lo + i * step;
    const to   = i === BIN_COUNT - 1 ? hi : from + step;
    return {
      label:    `${from.toFixed(1)} – ${to.toFixed(1)} vh`,
      midpoint: (from + to) / 2,
      count:    0,
      isMean:   mean >= from && mean < to + (i === BIN_COUNT - 1 ? 1e-9 : 0),
    };
  });

  for (const v of values) {
    let idx = Math.floor((v - lo) / step);
    if (idx >= BIN_COUNT) idx = BIN_COUNT - 1;
    if (idx < 0) idx = 0;
    bins[idx].count += 1;
  }
  return bins;
}

interface TooltipPayloadEntry { payload?: Bin }
interface HistogramTooltipProps {
  active?:  boolean;
  payload?: TooltipPayloadEntry[];
}

function HistogramTooltip({ active, payload }: HistogramTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  if (!p) return null;
  return (
    <div className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] shadow-md">
      <div className="font-semibold">{p.label}</div>
      <div className="text-muted-foreground">
        {p.count} of 100 replays
      </div>
    </div>
  );
}

/** Histogram of the 100 Monte Carlo replays.
 *
 *  Each bar = number of replays whose vehicle-hours-saved fell in that
 *  bucket. Two reference lines: solid for the average across all runs
 *  ("Typical"), dashed for Webster's analytical point estimate
 *  ("Textbook"). A short verdict line below reads "✓ both methods agree"
 *  or "⚠ textbook outside" so a non-statistician can read it at a glance.
 *
 *  Lives behind a default-closed `<details>` toggle in `ConfidenceBadge`
 *  so the operator never sees it and the panel can open it during defense.
 */
export function SimulationStripPlot({
  perRunMeans, mean, analyticalRef,
}: Props) {
  const bins = useMemo(
    () => buildBins(perRunMeans, analyticalRef, mean),
    [perRunMeans, analyticalRef, mean],
  );

  if (perRunMeans.length === 0 || bins.length === 0) return null;

  const minRun = Math.min(...perRunMeans);
  const maxRun = Math.max(...perRunMeans);
  const textbookInsideRange = analyticalRef >= minRun && analyticalRef <= maxRun;
  const verdict = textbookInsideRange
    ? "What this means: the textbook formula and the 100 simulated replays agree on the saving. You can trust the recommendation."
    : analyticalRef < minRun
      ? "What this means: every simulated replay saved more than the textbook formula predicted. The recommendation is at least as good as the textbook says, probably better."
      : "What this means: every simulated replay saved less than the textbook formula predicted. The textbook is too optimistic for this case; expect saving closer to the simulation range.";

  // Tight Y-domain so a small count peak still feels like a peak.
  const maxCount = Math.max(...bins.map(b => b.count));
  const yMax = Math.max(5, Math.ceil(maxCount * 1.15));

  return (
    <figure className="w-full">
      <h3 className="text-sm font-semibold mb-1">
        How many of the {perRunMeans.length} replays saved each amount
      </h3>
      <div className="text-xs text-muted-foreground mb-3 leading-snug space-y-1.5 max-w-2xl">
        <p>
          We re-ran this hour {perRunMeans.length} times with realistic random
          traffic patterns. Each bar shows how many of those runs produced a
          particular amount of vehicle-hours saved. The taller the bar, the
          more often we got that result.
        </p>
        <p>
          <span className="font-medium text-emerald-700 dark:text-emerald-400">Typical</span>
          {' '}(solid green line) is the average saving across all replays.
          {' '}
          <span className="font-medium">Textbook</span>
          {' '}(dashed grey line) is what Webster's formula predicts on its own.
          When the textbook line falls inside the bars, both methods agree.
          When it falls outside, the simulation is telling us the textbook is
          either too optimistic or too conservative for this case.
        </p>
      </div>

      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={bins}
            margin={{ top: 18, right: 18, bottom: 28, left: 4 }}
            barCategoryGap={1}
          >
            <XAxis
              dataKey="midpoint"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 10, fill: 'currentColor' }}
              tickFormatter={(v: number) => v.toFixed(0)}
              stroke="currentColor"
              className="text-muted-foreground"
              label={{
                value: 'vehicle-hours saved (per simulated hour)',
                position: 'insideBottom',
                offset: -16,
                fontSize: 10,
                fill: 'currentColor',
                className: 'fill-muted-foreground',
              }}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10, fill: 'currentColor' }}
              stroke="currentColor"
              className="text-muted-foreground"
              domain={[0, yMax]}
              label={{
                value: 'replays',
                angle: -90,
                position: 'insideLeft',
                offset: 14,
                fontSize: 10,
                fill: 'currentColor',
                className: 'fill-muted-foreground',
              }}
            />
            <Tooltip
              content={<HistogramTooltip />}
              cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
              {bins.map((b, i) => (
                <Cell
                  key={i}
                  fill={b.isMean ? 'rgb(5 150 105)' /* emerald-600 */
                                 : 'rgb(167 243 208)' /* emerald-200 */}
                />
              ))}
            </Bar>
            <ReferenceLine
              x={mean}
              stroke="rgb(4 120 87)" /* emerald-700 */
              strokeWidth={2}
              label={{
                value: `Typical: ${mean.toFixed(1)}`,
                position: 'top',
                fontSize: 10,
                fill: 'rgb(4 120 87)',
              }}
            />
            <ReferenceLine
              x={analyticalRef}
              stroke={textbookInsideRange ? 'rgb(100 116 139)' /* slate-500 */
                                          : 'rgb(225 29 72)' /* rose-600 */}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              label={{
                value: `Textbook: ${analyticalRef.toFixed(1)}`,
                position: 'insideTopRight',
                fontSize: 10,
                fill: textbookInsideRange ? 'rgb(71 85 105)' : 'rgb(190 18 60)',
                offset: 6,
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p
        className={
          textbookInsideRange
            ? 'text-[11px] text-emerald-700 dark:text-emerald-400 mt-1 leading-snug'
            : 'text-[11px] text-rose-700 dark:text-rose-400 mt-1 leading-snug'
        }
      >
        {textbookInsideRange ? '✓ ' : '⚠ '}{verdict}
      </p>
    </figure>
  );
}
