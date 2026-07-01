import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { simulationApi, type SimulationResponse } from '@/services/simulation';
import { selectPeakChunk } from '@/lib/simulation';
import { timingApi, type TimingChunk } from '@/services/timing';
import type { Intersection, Street } from '@/types';
import { Button } from '@/components/ui/button';
import { Loader2, Printer } from 'lucide-react';
import { IntersectionSummary } from '@/components/IntersectionSummary';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { ARM_SHORT, GanttDiagram, LosBadge } from '@/components/signal-timing-viz';
import {
  statusBucket, BUCKET_LABEL,
} from '@/components/recommendations/statusBucket';
import { cn } from '@/lib/utils';

function fmt(n: number | null | undefined, unit = 's'): string {
  if (n == null) return '-';
  return `${n.toFixed(1)}${unit}`;
}

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

  return (
    <div className="flex flex-col gap-5 print:gap-2">
      {/* Tab-local action row - shell already shows Back/title/Analyse/Settings.
          Only Print is tab-specific. */}
      <div className="flex items-center justify-end gap-2 print:hidden">
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="size-3.5 mr-1.5" />
          Print / Export PDF
        </Button>
      </div>

      {/* Print-only header */}
      <div className="hidden print:block mb-3">
        <h1 className="text-lg font-bold">{intersection.name} - Intersection Report</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Generated {new Date().toLocaleString('en-PH', { timeZoneName: 'short' })}
          {' · '}{intersection.signal_status.replace('_', ' ')}
          {bucket && ` · ${BUCKET_LABEL[bucket]}`}
        </p>
      </div>

      {/* Key stats - the 3 numbers an operator needs to decide.
          Total flow (PCU/hr) was cut: it's engineering jargon and the
          plain veh/hr Major/Minor volume in Findings carries the same info. */}
      {ds && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border bg-card p-4 print:p-3">
            <p className="text-xs text-muted-foreground">Avg delay before</p>
            <p className="text-xl font-semibold mt-1">{fmt(ds.avg_delay_before)}</p>
            <div className="flex items-center gap-1.5 mt-1">
              <p className="text-xs text-muted-foreground">per vehicle</p>
              <LosBadge grade={ds.los_before} />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 print:p-3">
            <p className="text-xs text-muted-foreground">Avg delay after</p>
            <p className="text-xl font-semibold mt-1 text-emerald-600">{fmt(ds.avg_delay_after)}</p>
            <div className="flex items-center gap-1.5 mt-1">
              <p className="text-xs text-muted-foreground">per vehicle</p>
              <LosBadge grade={ds.los_after} />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 print:p-3">
            <p className="text-xs text-muted-foreground">Vehicle-hours saved</p>
            <p className={cn('text-xl font-semibold mt-1', ds.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
              {ds.total_vehicle_hours_saved.toFixed(1)} vh
            </p>
            <p className="text-xs text-muted-foreground mt-1">per day</p>
          </div>
        </div>
      )}

      {/* Stochastic confidence (Monte Carlo) — peak-chunk CI on vh saved.
          Lazy fetch, Redis-cached server-side; full width to give the
          plain-English sentence room to breathe. */}
      {ds && ds.total_vehicle_hours_saved > 0 && (
        <ConfidenceBadge intersectionId={interId} variant="card" />
      )}

      {/* Phase comparison - current vs recommended */}
      {recommendedTiming && usableStreets.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-5 print:p-3 print:break-inside-avoid">
          <h2 className="text-sm font-semibold mb-4 print:mb-2">Phase comparison{peak ? ` - ${peak.chunk_name}` : ''}</h2>
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
              cycleLength={recommendedTiming.cycle_length}
              approaches={recommendedApproaches}
            />
          </div>
        </div>
      )}

      {/* Findings + Recommendations/Conclusion - decomposed for the printed report */}
      <IntersectionSummary
        intersection={intersection}
        streets={streets}
        sim={sim}
        rec={rec}
        variant="decomposed"
      />
    </div>
  );
}
