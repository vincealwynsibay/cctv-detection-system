import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useState, useEffect, useMemo } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import {
  PRESETS, fetchAggregation, getBucket, getPresetRange,
  type Preset,
} from '@/lib/aggregation-query';
import type { AggregationRow, Intersection, Street } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { Download, TrendingUp, Users, Clock, Car, Loader2, FileText, ArrowRight, Printer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface OutletCtx { sseData: AggregationRow[] | null; sseStatus: SSEStatus }

const PEDESTRIAN_TYPES = new Set(['pedestrian', 'person']);

const TYPE_HEX: Record<string, string> = {
  car:        '#16a34a',
  motorcycle: '#0369a1',
  tricycle:   '#d97706',
  truck:      '#dc2626',
  pedicab:    '#7c3aed',
  pedestrian: '#0891b2',
  person:     '#0891b2',
};

function toLocalDateString(d: Date) {
  return d.toISOString().slice(0, 10);
}

function formatWindowLabel(iso: string, bucket: 'hour' | 'day' | 'week') {
  const d = new Date(iso);
  if (bucket === 'hour') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (bucket === 'week') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReportsPage() {
  const { sseData } = useOutletContext<OutletCtx>();
  const [searchParams] = useSearchParams();

  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [streets, setStreets]             = useState<Street[]>([]);
  const [selectedIntersection, setSelectedIntersection] = useState<string>(
    searchParams.get('intersection_id') ?? 'all'
  );
  const [selectedStreet, setSelectedStreet] = useState<string>('all');
  const [selectedDirection, setSelectedDirection] = useState<'all' | 'inbound' | 'outbound' | 'unknown'>('all');

  const [preset, setPreset]         = useState<Preset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd]     = useState('');

  const [data, setData]       = useState<AggregationRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    intersectionsApi.list().then(setIntersections).catch(console.error);
    streetsApi.list().then(setStreets).catch(console.error);
  }, []);

  // Compute active range
  const { start, end, bucket } = useMemo(() => {
    if (preset === 'custom') {
      const s = customStart ? new Date(customStart) : new Date();
      const e = customEnd   ? new Date(new Date(customEnd).getTime() + 86_400_000) : new Date();
      return { start: s, end: e, bucket: getBucket(s, e) };
    }
    const { start: s, end: e } = getPresetRange(preset);
    return { start: s, end: e, bucket: getBucket(s, e) };
  }, [preset, customStart, customEnd]);

  useEffect(() => {
    if (preset === 'custom' && (!customStart || !customEnd)) return;
    setLoading(true);
    fetchAggregation({
      start, end, bucket,
      intersection_id: selectedIntersection !== 'all' ? Number(selectedIntersection) : null,
      street_id:       selectedStreet       !== 'all' ? Number(selectedStreet)       : null,
      direction:       selectedDirection    !== 'all' ? selectedDirection            : null,
    })
      .then(setData)
      .catch(err => toast.error(err.message ?? 'Failed to load history'))
      .finally(() => setLoading(false));
  }, [start, end, bucket, selectedIntersection, selectedStreet, selectedDirection, preset, customStart, customEnd]);

  const filteredStreets = streets.filter(s =>
    selectedIntersection === 'all' || s.intersection_id === Number(selectedIntersection)
  );

  // ── Derived stats ──────────────────────────────────────────────────────────

  const totalVehicles    = data.filter(r => !PEDESTRIAN_TYPES.has(r.object_type)).reduce((a, r) => a + r.count, 0);
  const totalPedestrians = data.filter(r =>  PEDESTRIAN_TYPES.has(r.object_type)).reduce((a, r) => a + r.count, 0);

  const typeTotals = data.reduce((acc, r) => {
    if (!PEDESTRIAN_TYPES.has(r.object_type))
      acc[r.object_type] = (acc[r.object_type] ?? 0) + r.count;
    return acc;
  }, {} as Record<string, number>);
  const topType = Object.entries(typeTotals).sort(([, a], [, b]) => b -a)[0];

  // Time-series: vehicles + pedestrians per window
  const timeWindows = [...new Set(data.map(r => r.window_start))].sort();
  const timeSeriesData = timeWindows.map(w => {
    const rows = data.filter(r => r.window_start === w);
    return {
      label:       formatWindowLabel(w, bucket),
      vehicles:    rows.filter(r => !PEDESTRIAN_TYPES.has(r.object_type)).reduce((a, r) => a + r.count, 0),
      pedestrians: rows.filter(r =>  PEDESTRIAN_TYPES.has(r.object_type)).reduce((a, r) => a + r.count, 0),
    };
  });

  // Peak window
  const peak = timeSeriesData.reduce<{ label: string; total: number } | null>((best, row) => {
    const total = row.vehicles + row.pedestrians;
    return (!best || total > best.total) ? { label: row.label, total } : best;
  }, null);

  // Type breakdown bar chart
  const typeChartData = Object.entries(typeTotals)
    .map(([type, count]) => ({ label: type[0].toUpperCase() + type.slice(1), count, type }))
    .sort((a, b) => b.count -a.count);

  // Peak-hour-of-day chart (aggregate counts by hour 0–23 across the full date range)
  const hourlyData = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: h.toString().padStart(2, '0') + ':00',
      vehicles: 0,
      pedestrians: 0,
    }));
    for (const row of data) {
      const h = new Date(row.window_start).getHours();
      if (PEDESTRIAN_TYPES.has(row.object_type)) {
        buckets[h].pedestrians += row.count;
      } else {
        buckets[h].vehicles += row.count;
      }
    }
    return buckets;
  }, [data]);

  // Per-street breakdown
  const streetTotals: Record<string, number> = {};
  for (const r of data) {
    const st = streets.find(s => s.id === r.street_id);
    const key = st?.name ?? `Street ${r.street_id}`;
    streetTotals[key] = (streetTotals[key] ?? 0) + r.count;
  }
  const streetChartData = Object.entries(streetTotals)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count -a.count);

  function exportCSV() {
    if (!data.length) return;
    const rows = [
      ['intersection_id', 'intersection_name', 'street_id', 'object_type', 'window_start', 'count'],
      ...data.map(r => [r.intersection_id, r.intersection_name, r.street_id, r.object_type, r.window_start, r.count]),
    ];
    const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eyegila-${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap print:hidden">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold tracking-tight text-green-950">Reports</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Multi-intersection summary and CSV export for handoff to traffic engineers.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedIntersection !== 'all' && (
            <Button asChild variant="default" size="sm">
              <Link to={`/intersections/${selectedIntersection}/report`}>
                <FileText className="size-3.5 mr-1.5" />
                View full report
                <ArrowRight className="size-3 ml-1" />
              </Link>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!data.length}>
            <Printer className="size-3.5 mr-1.5" />
            Print
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV} disabled={!data.length}>
            <Download data-icon="inline-start" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Print-only header - operator can hand the printout to an engineer */}
      <div className="hidden print:block mb-2">
        <h1 className="text-lg font-bold">
          EyeGila Reports - {selectedIntersection === 'all'
            ? 'All intersections'
            : (intersections.find(i => String(i.id) === selectedIntersection)?.name ?? 'Intersection')}
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">
          {start.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
          {' – '}
          {new Date(end.getTime() - 1).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
          {' · grouped by '}{bucket}
          {' · Generated '}{new Date().toLocaleString('en-PH', { timeZoneName: 'short' })}
        </p>
      </div>

      {/* Date range selector */}
      <div className="rounded-xl border border-border bg-card px-4 py-3 flex flex-col gap-3 print:hidden">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium border transition-colors',
                preset === p.key
                  ? 'bg-green-600 text-white border-green-600'
                  : 'border-border text-muted-foreground hover:border-green-300 hover:text-green-700',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              name="report-start"
              type="date"
              className="w-40 h-8 text-sm"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              max={toLocalDateString(new Date())}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              name="report-end"
              type="date"
              className="w-40 h-8 text-sm"
              value={customEnd}
              onChange={e => setCustomEnd(e.target.value)}
              min={customStart}
              max={toLocalDateString(new Date())}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Select value={selectedIntersection} onValueChange={v => { setSelectedIntersection(v); setSelectedStreet('all'); setSelectedDirection('all'); }}>
            <SelectTrigger className="w-48 h-8 text-sm">
              <SelectValue placeholder="All intersections" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All intersections</SelectItem>
              {intersections.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={selectedStreet} onValueChange={setSelectedStreet} disabled={selectedIntersection === 'all'}>
            <SelectTrigger className="w-40 h-8 text-sm">
              <SelectValue placeholder="All streets" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All streets</SelectItem>
              {filteredStreets.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select
            value={selectedDirection}
            onValueChange={v => setSelectedDirection(v as 'all' | 'inbound' | 'outbound' | 'unknown')}
          >
            <SelectTrigger className="w-36 h-8 text-sm" data-testid="select-direction">
              <SelectValue placeholder="All directions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All directions</SelectItem>
              <SelectItem value="inbound">↓ Inbound</SelectItem>
              <SelectItem value="outbound">↑ Outbound</SelectItem>
              <SelectItem value="unknown">Unspecified</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Live now strip - operators want current state above the historical view */}
      {sseData && (
        <div className="rounded-lg border border-green-100 bg-green-50 px-4 py-2.5 flex items-center justify-between print:hidden">
          <span className="text-xs text-green-700 font-medium flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-green-500 animate-pulse" />
            Live window
          </span>
          <span className="text-xs text-green-600/70">
            {sseData.filter(r => !PEDESTRIAN_TYPES.has(r.object_type)).reduce((a, r) => a + r.count, 0)} vehicles ·{' '}
            {sseData.filter(r =>  PEDESTRIAN_TYPES.has(r.object_type)).reduce((a, r) => a + r.count, 0)} pedestrians
          </span>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="border-green-100 bg-green-50/60">
          <CardContent className="p-4 flex items-start justify-between">
            <div>
              <div className="text-2xl font-black tabular-nums text-green-700">
                {loading ? '-' : totalVehicles.toLocaleString()}
              </div>
              <div className="text-xs text-green-600/70 mt-0.5">vehicles</div>
            </div>
            <Car className="size-5 text-green-300 mt-0.5" />
          </CardContent>
        </Card>
        <Card className="border-cyan-100 bg-cyan-50/40">
          <CardContent className="p-4 flex items-start justify-between">
            <div>
              <div className="text-2xl font-black tabular-nums text-cyan-700">
                {loading ? '-' : totalPedestrians.toLocaleString()}
              </div>
              <div className="text-xs text-cyan-600/70 mt-0.5">pedestrians</div>
            </div>
            <Users className="size-5 text-cyan-300 mt-0.5" />
          </CardContent>
        </Card>
        <Card className="print:break-inside-avoid">
          <CardContent className="p-4 flex items-start justify-between">
            <div>
              <div className="text-2xl font-black tabular-nums">{loading ? '-' : (topType?.[0] ?? '-')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                top type {topType && !loading ? `(${topType[1].toLocaleString()})` : ''}
              </div>
            </div>
            <TrendingUp className="size-5 text-muted-foreground/25 mt-0.5" />
          </CardContent>
        </Card>
        <Card className="print:break-inside-avoid">
          <CardContent className="p-4 flex items-start justify-between">
            <div>
              <div className="text-lg font-bold tabular-nums leading-tight">
                {loading ? '-' : (peak?.label ?? '-')}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                peak {bucket === 'hour' ? 'hour' : bucket === 'day' ? 'day' : 'week'}
                {peak && !loading ? ` (${peak.total.toLocaleString()})` : ''}
              </div>
            </div>
            <Clock className="size-5 text-muted-foreground/25 mt-0.5" />
          </CardContent>
        </Card>
      </div>

      {/* Main time-series */}
      <Card className="print:break-inside-avoid">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-slate-700">
            Vehicles &amp; Pedestrians Over Time
          </CardTitle>
          <CardDescription className="text-xs">
            {start.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
            {' – '}
            {new Date(end.getTime() -1).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
            {' · grouped by '}
            {bucket}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : timeSeriesData.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              No data for this period
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={timeSeriesData} margin={{ left: 4, right: 8, bottom: 14 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  axisLine={false} tickLine={false}
                  interval="preserveStartEnd"
                  label={{ value: bucket === 'hour' ? 'Time' : 'Date', position: 'insideBottom', offset: -10, style: { fontSize: 10, fill: '#64748b' } }}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  axisLine={false} tickLine={false}
                  width={48}
                  label={{ value: 'Count', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: '#64748b', textAnchor: 'middle' } }}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                  cursor={{ stroke: '#e2e8f0' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="vehicles"
                  name="Vehicles"
                  stroke="#16a34a"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="pedestrians"
                  name="Pedestrians"
                  stroke="#0891b2"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Bottom row: type breakdown + street breakdown */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

        {/* Vehicle type breakdown */}
        <Card className="print:break-inside-avoid">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-700">By Vehicle Type</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : typeChartData.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={typeChartData} barCategoryGap="28%" margin={{ left: 4, right: 8, bottom: 14 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false} tickLine={false}
                    label={{ value: 'Vehicle type', position: 'insideBottom', offset: -10, style: { fontSize: 10, fill: '#64748b' } }}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false} tickLine={false}
                    width={48}
                    label={{ value: 'Count', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: '#64748b', textAnchor: 'middle' } }}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                    cursor={{ fill: '#f8fafc' }}
                    formatter={(v: unknown) => [Number(v).toLocaleString(), 'count']}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {typeChartData.map(e => (
                      <Cell key={e.type} fill={TYPE_HEX[e.type] ?? '#16a34a'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Street/approach breakdown */}
        <Card className="print:break-inside-avoid">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-700">By Approach Direction</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : streetChartData.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(220, streetChartData.length * 32 + 24)}>
                <BarChart data={streetChartData} layout="vertical" barCategoryGap="25%" margin={{ left: 4, right: 8, bottom: 14 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    axisLine={false} tickLine={false}
                    tickFormatter={v => Number(v).toLocaleString()}
                    label={{ value: 'Total count', position: 'insideBottom', offset: -10, style: { fontSize: 10, fill: '#64748b' } }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false} tickLine={false}
                    width={110}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                    cursor={{ fill: '#f8fafc' }}
                    formatter={(v: unknown) => [Number(v).toLocaleString(), 'total']}
                  />
                  <Bar dataKey="count" fill="#16a34a" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

      </div>

      {/* Peak hour of day */}
      <Card className="print:break-inside-avoid">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-slate-700">Traffic by Hour of Day</CardTitle>
          <CardDescription className="text-xs">
            Aggregate counts per hour across the selected period
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : data.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">No data</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hourlyData} barCategoryGap="15%" margin={{ left: 4, right: 8, bottom: 14 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: '#94a3b8' }}
                  axisLine={false} tickLine={false}
                  interval={1}
                  label={{ value: 'Hour of day', position: 'insideBottom', offset: -10, style: { fontSize: 10, fill: '#64748b' } }}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  axisLine={false} tickLine={false}
                  width={48}
                  label={{ value: 'Count', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: '#64748b', textAnchor: 'middle' } }}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                  cursor={{ fill: '#f8fafc' }}
                  formatter={(v: unknown, name?: string | number) => [Number(v).toLocaleString(), String(name ?? '')]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="vehicles" name="Vehicles" fill="#16a34a" radius={[3, 3, 0, 0]} stackId="a" />
                <Bar dataKey="pedestrians" name="Pedestrians" fill="#0891b2" radius={[3, 3, 0, 0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
