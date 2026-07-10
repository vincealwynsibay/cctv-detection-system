import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { simulationApi, type SimulationResponse } from '@/services/simulation';
import { selectPeakChunk } from '@/lib/simulation';
import { timingApi, type TimingChunk } from '@/services/timing';
import type { Intersection, Street } from '@/types';
import { Loader2 } from 'lucide-react';
import { IntersectionSummary } from '@/components/IntersectionSummary';
import { ARM_SHORT, GanttDiagram, LosBadge } from '@/components/signal-timing-viz';
import {
  statusBucket, BUCKET_LABEL,
} from '@/components/recommendations/statusBucket';
import { cn } from '@/lib/utils';

function fmt(n: number | null | undefined, unit = 's'): string {
  if (n == null) return '-';
  return `${n.toFixed(1)}${unit}`;
}

/**
 * Print stylesheet for the Report tab.
 *
 * The web view is a stack of cards (border + bg + grid layouts). When the
 * operator hits Print, the browser by default prints those cards verbatim,
 * which reads as "screenshot of a web app" rather than "engineering report".
 *
 * This stylesheet rewrites the page for print into a traditional document:
 *   - A4 page with 2 cm margins and a running footer (page n / total + title)
 *   - Serif typography sized for letter prose, not UI screens
 *   - Sections with underlined uppercase headings and CSS counter numbering
 *   - Cards lose their borders/bg (becoming flat sections); grids collapse
 *     into vertical flow so columns don't crowd narrow page widths
 *   - Print-only tables for tabular data that was previously stat cards
 *   - Page-break-avoid on each section so a Gantt or table doesn't split
 *
 * Why inline a <style> tag instead of a CSS file: this stylesheet only
 * makes sense for the Report page (other tabs have their own print needs),
 * scoping it with `.print-report` and inlining keeps the rule near its
 * markup. The selectors deliberately target the wrapping class so global
 * print rules elsewhere in the app aren't disturbed.
 */
const FONT_BODY = `Arial, "Helvetica Neue", Helvetica, sans-serif`;
const FONT_HEAD = `Arial, "Helvetica Neue", Helvetica, sans-serif`;
const FONT_MONO = `"Courier New", Courier, monospace`;

const PRINT_STYLES = `

@media print {
  @page {
    size: A4;
    margin: 12mm 14mm 16mm 14mm;

    @bottom-left {
      content: "Intersection Traffic Analysis Report";
      font-family: ${FONT_HEAD};
      font-size: 8.5pt;
      font-weight: 500;
      letter-spacing: 0.04em;
      color: #6b7280;
    }
    @bottom-right {
      content: counter(page) " / " counter(pages);
      font-family: ${FONT_MONO};
      font-size: 8.5pt;
      color: #6b7280;
    }
  }

  /* Reset web chrome inside the print scope. */
  .print-report {
    font-family: ${FONT_BODY} !important;
    font-size: 9pt;
    line-height: 1.4;
    color: #111 !important;
    background: white !important;
    counter-reset: section;
    font-feature-settings: "liga", "kern", "onum", "pnum";
  }

  .print-report * {
    color-adjust: exact;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Cover / title block. */
  .print-cover {
    display: block !important;
    border-bottom: 1.5pt solid #111;
    padding-bottom: 7pt;
    margin-bottom: 8pt;
  }
  .print-cover .doc-kind {
    font-family: ${FONT_HEAD};
    font-size: 7.5pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: #4b5563;
    margin: 0 0 3pt 0;
  }
  .print-cover h1 {
    font-family: ${FONT_BODY};
    font-size: 18pt;
    font-weight: 700;
    margin: 0;
    line-height: 1.05;
    letter-spacing: -0.015em;
  }
  .print-cover .meta {
    font-family: ${FONT_HEAD};
    font-size: 8pt;
    color: #374151;
    margin-top: 5pt;
    line-height: 1.4;
  }
  .print-cover .meta-row {
    display: flex;
    gap: 18pt;
    flex-wrap: wrap;
  }
  .print-cover .meta-label {
    color: #9ca3af;
    margin-right: 5pt;
    text-transform: uppercase;
    font-size: 7.5pt;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  /* Numbered sections via CSS counter. Sans-serif heads make the hierarchy
     pop against the serif body without looking academic-stuffy. */
  .print-section {
    counter-increment: section;
    break-inside: avoid;
    page-break-inside: avoid;
    margin-top: 8pt;
  }
  .print-section > h2 {
    font-family: ${FONT_HEAD};
    font-size: 8.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #111;
    margin: 0 0 5pt 0;
    padding-bottom: 3pt;
    border-bottom: 0.5pt solid #9ca3af;
  }
  .print-section > h2::before {
    content: counter(section, decimal-leading-zero) " — ";
    color: #9ca3af;
    font-weight: 500;
  }

  /* Subheadings inside summary sections. */
  .print-report h3 {
    font-family: ${FONT_HEAD};
    font-size: 9.5pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #374151;
    margin: 8pt 0 4pt 0;
  }

  /* Cards collapse to flat sections. */
  .print-flat {
    border: none !important;
    background: white !important;
    background-color: white !important;
    padding: 0 !important;
    box-shadow: none !important;
    border-radius: 0 !important;
  }

  /* Body prose */
  .print-report p,
  .print-report li,
  .print-report dd {
    font-family: ${FONT_BODY};
    font-size: 9pt;
    line-height: 1.45;
    margin: 0 0 4pt 0;
  }
  .print-report dt {
    font-family: ${FONT_HEAD};
    font-size: 8pt;
    font-weight: 600;
    color: #374151;
  }

  /* Print-only tables - sans for clarity at small sizes, mono for numbers. */
  .print-table {
    width: 100%;
    border-collapse: collapse;
    font-family: ${FONT_HEAD};
    font-size: 8.5pt;
    margin: 4pt 0 2pt 0;
  }
  .print-table th,
  .print-table td {
    text-align: left;
    padding: 3pt 6pt;
    border-bottom: 0.5pt solid #d1d5db;
    vertical-align: top;
  }
  .print-table th {
    border-bottom: 1pt solid #111;
    font-weight: 600;
    text-transform: uppercase;
    font-size: 7.5pt;
    letter-spacing: 0.06em;
    color: #4b5563;
  }
  .print-table td.num,
  .print-table th.num {
    text-align: right;
    font-family: ${FONT_MONO};
    font-variant-numeric: tabular-nums;
    font-size: 8.5pt;
  }

  /* Force vertical flow inside report grids so columns don't squash on A4. */
  .print-report .print-stack > * + * {
    margin-top: 6pt;
  }

  /* Hide tinted backgrounds; we want a monochrome document feel. */
  .print-report [class*="bg-emerald"],
  .print-report [class*="bg-amber"],
  .print-report [class*="bg-rose"],
  .print-report [class*="bg-teal"],
  .print-report [class*="bg-sky"],
  .print-report [class*="bg-violet"],
  .print-report [class*="bg-muted"] {
    background: transparent !important;
    background-color: transparent !important;
  }

  /* Keep large composite charts together. */
  .print-section .print-keep {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}
`;

export function IntersectionReportPage() {
  const { id } = useParams<{ id: string }>();
  const interId = Number(id);

  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [streets, setStreets] = useState<Street[]>([]);
  const [rec, setRec] = useState<RecommendationResponse | null>(null);
  const [sim, setSim] = useState<SimulationResponse | null>(null);
  const [timing, setTiming] = useState<TimingChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(interId)) {
      setError('Invalid intersection id');
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      intersectionsApi.get(interId),
      streetsApi.list().catch(() => [] as Street[]),
      recommendationsApi.latest(interId).catch(() => null),
      simulationApi.get(interId).catch(() => null),
      timingApi.list(interId).catch(() => [] as TimingChunk[]),
    ])
      .then(([inter, allStreets, r, s, t]) => {
        setIntersection(inter);
        setStreets(allStreets.filter(st => st.intersection_id === interId));
        setRec(r);
        setSim(s);
        setTiming(t);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [interId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading report…
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

  const peak = selectPeakChunk(sim);
  // Pick the timing chunk that matches the peak sim chunk, else first available.
  const recommendedTiming = peak
    ? (timing.find(t => t.chunk_name === peak.chunk_name) ?? timing[0] ?? null)
    : (timing[0] ?? null);
  const bucket = rec ? statusBucket(rec) : null;
  const ds = sim?.daily_summary ?? null;
  const usableStreets = streets.filter(s => s.arm_direction !== 'unknown');

  const currentApproaches = usableStreets.map(s => ({
    label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
    greenSec: (intersection.existing_green_splits as Record<string, number> | null)?.[String(s.id)] ?? 0,
  }));
  const recommendedApproaches = usableStreets.map(s => ({
    label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
    greenSec: recommendedTiming?.green_splits[String(s.id)] ?? 0,
  }));

  const generated = new Date().toLocaleString('en-PH', { timeZoneName: 'short' });

  return (
    <div className="print-report flex flex-col gap-5 print:gap-0">
      <style>{PRINT_STYLES}</style>

      {/* Print-only cover / title block. Replaces the inline "h1 + small p"
          header with a proper document head: doc-kind label, intersection
          name as the headline, then a metadata row with generated date,
          signal status, and MUTCD verdict. */}
      <header className="hidden print-cover">
        <p className="doc-kind">Intersection Traffic Analysis Report</p>
        <h1>{intersection.name}</h1>
        <div className="meta">
          <div className="meta-row">
            <span><span className="meta-label">Generated</span>{generated}</span>
            <span><span className="meta-label">Signal status</span>{intersection.signal_status.replace('_', ' ')}</span>
            {bucket && (
              <span><span className="meta-label">MUTCD verdict</span>{BUCKET_LABEL[bucket]}</span>
            )}
          </div>
        </div>
      </header>

      {/* Section 1: Findings - key stats. Web shows 3 stat cards; print shows
          a compact two-column "metric / before / after" table for the same
          numbers in document form. */}
      <section className="print-section">
        <h2 className="hidden print:block">Findings</h2>

        {/* Web view: stat cards */}
        {ds && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 print:hidden">
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Avg delay before</p>
              <p className="text-xl font-semibold mt-1">{fmt(ds.avg_delay_before)}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <p className="text-xs text-muted-foreground">per vehicle</p>
                <LosBadge grade={ds.los_before} />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Avg delay after</p>
              <p className="text-xl font-semibold mt-1 text-emerald-600">{fmt(ds.avg_delay_after)}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <p className="text-xs text-muted-foreground">per vehicle</p>
                <LosBadge grade={ds.los_after} />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Vehicle-hours saved</p>
              <p className={cn('text-xl font-semibold mt-1', ds.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
                {ds.total_vehicle_hours_saved.toFixed(1)} vh
              </p>
              <p className="text-xs text-muted-foreground mt-1">per day</p>
            </div>
          </div>
        )}

        {/* Print view: metric table */}
        {ds && (
          <table className="hidden print:table print-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num">Before</th>
                <th className="num">After</th>
                <th className="num">Δ</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Average delay per vehicle</td>
                <td className="num">{fmt(ds.avg_delay_before)}</td>
                <td className="num">{fmt(ds.avg_delay_after)}</td>
                <td className="num">
                  {ds.avg_delay_after < ds.avg_delay_before ? '−' : '+'}
                  {Math.abs(ds.avg_delay_before - ds.avg_delay_after).toFixed(1)} s
                </td>
              </tr>
              <tr>
                <td>Level of service (LOS)</td>
                <td className="num">{ds.los_before}</td>
                <td className="num">{ds.los_after}</td>
                <td className="num">{ds.los_before === ds.los_after ? '—' : `${ds.los_before} → ${ds.los_after}`}</td>
              </tr>
              <tr>
                <td>Vehicle-hours saved per day</td>
                <td className="num" colSpan={2}>—</td>
                <td className="num">
                  {ds.total_vehicle_hours_saved >= 0 ? '+' : ''}
                  {ds.total_vehicle_hours_saved.toFixed(1)} vh
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* Section 2: Phase comparison - current vs Webster-recommended Gantt. */}
      {recommendedTiming && usableStreets.length > 0 && (
        <section className="print-section">
          <h2 className="hidden print:block">Phase Comparison{peak ? ` - ${peak.chunk_name}` : ''}</h2>

          {/* Web heading hidden in print to avoid double heading. */}
          <div className="rounded-lg border border-border bg-card p-5 print:print-flat print-keep">
            <h2 className="text-sm font-semibold mb-4 print:hidden">Phase comparison{peak ? ` - ${peak.chunk_name}` : ''}</h2>
            <div className="flex gap-6 flex-col sm:flex-row print:flex-row">
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
              <div className="w-px bg-border hidden sm:block shrink-0 print:hidden" />
              <GanttDiagram
                title="Recommended (Webster)"
                titleClassName="text-emerald-600"
                cycleLength={recommendedTiming.cycle_length}
                approaches={recommendedApproaches}
              />
            </div>
          </div>
        </section>
      )}

      {/* Section 3 + 4: Findings narrative + Recommendations/Conclusion.
          Wrapped so the IntersectionSummary's existing sections each get
          a numbered heading in print and lose their card chrome. */}
      <section className="print-section">
        <h2 className="hidden print:block">Detailed Findings</h2>
        <div className="print:print-flat">
          <IntersectionSummary
            intersection={intersection}
            streets={streets}
            sim={sim}
            rec={rec}
            variant="decomposed"
          />
        </div>
      </section>

    </div>
  );
}
