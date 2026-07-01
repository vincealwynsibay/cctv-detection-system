import { useEffect, useRef, useState } from 'react';
import { aggregationApi } from '@/services/aggregation';
import { JargonTip } from '@/components/JargonTip';
import { cn } from '@/lib/utils';

/**
 * Brushable 24-bar histogram for picking a replay window from a single day.
 *
 * Originally a private component inside SignalTiming.tsx. Lifted out so the
 * shell-level window picker can host the same chart, keeping one source of
 * truth for the "pick a time-of-day window" UX across tabs.
 *
 * Behaviour:
 *  - Loads the hourly vehicle counts for the selected date via aggregationApi.
 *  - Drag-to-select a custom range, or click a preset (Peak / TOD chunks).
 *  - On every selection change (release of drag or preset click) the consumer
 *    receives onRange(startISO, endISO, vph). Decision to commit (fire a sim,
 *    persist to shell state, etc.) lives with the parent.
 */

function pad2(n: number) { return String(n).padStart(2, '0'); }

function barGradient(count: number, max: number): string {
  if (count === 0) return 'none';
  const r = count / max;
  if (r < 0.33) return 'linear-gradient(to top, #14532d, #4ade80)';
  if (r < 0.66) return 'linear-gradient(to top, #78350f, #fbbf24)';
  if (r < 0.85) return 'linear-gradient(to top, #7c2d12, #fb923c)';
  return                'linear-gradient(to top, #7f1d1d, #f87171)';
}

export interface TrafficTimelineProps {
  intersectionId: number;
  /** Called whenever a range is selected. */
  onRange: (start: string, end: string, vph: number, presetLabel: string | null) => void;
  /** Optional initial date (YYYY-MM-DD). Defaults to today. */
  initialDate?: string;
  /** Optional initial selection (hour ints 0..23 inclusive). */
  initialHourRange?: [number, number] | null;
}

export function TrafficTimeline({
  intersectionId, onRange, initialDate, initialHourRange,
}: TrafficTimelineProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate]           = useState(initialDate ?? today);
  const [bars, setBars]           = useState<{ hour: number; count: number }[]>([]);
  const [tlLoading, setTlLoading] = useState(false);
  const [selA, setSelA]           = useState<number | null>(initialHourRange?.[0] ?? null);
  const [selB, setSelB]           = useState<number | null>(initialHourRange?.[1] ?? null);
  const [anchor, setAnchor]       = useState<number | null>(null);
  const [dragging, setDragging]   = useState(false);
  const [hovered, setHovered]     = useState<number | null>(null);
  const containerRef              = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTlLoading(true);
    const next = new Date(date + 'T12:00:00');
    next.setDate(next.getDate() + 1);
    const end = next.toISOString().slice(0, 10) + 'T00:00:00';
    aggregationApi.history({ start: date + 'T00:00:00', end, intersection_id: intersectionId, bucket: 'hour' })
      .then(rows => {
        const byHour: Record<number, number> = {};
        for (const r of rows) {
          if (r.object_type === 'pedestrian' || r.object_type === 'person') continue;
          const h = new Date(r.window_start).getHours();
          byHour[h] = (byHour[h] ?? 0) + r.count;
        }
        setBars(Array.from({ length: 24 }, (_, h) => ({ hour: h, count: byHour[h] ?? 0 })));
      })
      .catch(() => setBars(Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }))))
      .finally(() => setTlLoading(false));
  }, [date, intersectionId]);

  function shiftDate(days: number) {
    const d = new Date(date + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const s = d.toISOString().slice(0, 10);
    if (s > today) return;
    setDate(s); setSelA(null); setSelB(null);
  }

  function hourFromClientX(x: number): number {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(23, Math.floor(((x - rect.left) / rect.width) * 24)));
  }

  function applySelection(a: number, b: number, presetLabel: string | null = null) {
    const h1 = Math.min(a, b);
    const h2 = Math.max(a, b);
    setSelA(h1); setSelB(h2);
    let endStr: string;
    if (h2 + 1 < 24) {
      endStr = `${date}T${pad2(h2 + 1)}:00`;
    } else {
      const next = new Date(date + 'T12:00:00');
      next.setDate(next.getDate() + 1);
      endStr = next.toISOString().slice(0, 10) + 'T00:00';
    }
    const total = bars.slice(h1, h2 + 1).reduce((s, b) => s + b.count, 0);
    const hours = h2 - h1 + 1;
    const vph = hours > 0 ? total / hours : 0;
    onRange(`${date}T${pad2(h1)}:00`, endStr, vph, presetLabel);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const h = hourFromClientX(e.clientX);
    setAnchor(h); setSelA(h); setSelB(h); setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const h = hourFromClientX(e.clientX);
    setHovered(h);
    if (dragging && anchor !== null) { setSelA(Math.min(anchor, h)); setSelB(Math.max(anchor, h)); }
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (anchor !== null) {
      const h = hourFromClientX(e.clientX);
      applySelection(anchor, h);
    }
    setDragging(false);
  }

  const maxCount = Math.max(1, ...bars.map(b => b.count));
  const peakHour = bars.reduce((best, b) => b.count > (bars[best]?.count ?? 0) ? b.hour : best, 0);
  const selCount = selA !== null && selB !== null
    ? bars.slice(selA, selB + 1).reduce((s, b) => s + b.count, 0)
    : 0;

  function selectPreset(label: string, h1: number, h2: number) {
    applySelection(h1, h2 - 1, label);
  }
  function selectPeakHour() {
    const a = Math.max(0, peakHour - 1);
    const b = Math.min(23, peakHour + 1);
    applySelection(a, b, 'Peak hour ± 1');
  }

  const peakRange: [number, number] = [Math.max(0, peakHour - 1), Math.min(24, peakHour + 2)];
  const peakActive = bars[peakHour]?.count > 0 && selA === peakRange[0] && selB === peakRange[1] - 1;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mr-0.5">
          Preset
        </span>
        <button type="button" onClick={selectPeakHour}
          disabled={!bars[peakHour]?.count}
          title={bars[peakHour]?.count ? `Peak hour ± 1 (${pad2(peakRange[0])}:00–${pad2(peakRange[1])}:00)` : 'No traffic data for this date'}
          className={cn(
            'h-8 px-2.5 text-[11px] rounded-md border transition-all font-medium flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed',
            peakActive
              ? 'border-amber-500 bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200 dark:border-amber-600 shadow-sm'
              : 'border-amber-400/60 text-amber-700 dark:text-amber-300 bg-amber-50/70 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-900/40',
          )}>
          <span className="text-[10px]">▲</span>
          <span>Peak hour</span>
          {bars[peakHour]?.count > 0 && (
            <span className="font-mono tabular-nums opacity-70 text-[10px]">
              {pad2(peakRange[0])}–{pad2(peakRange[1])}
            </span>
          )}
        </button>
        {([
          ['Overnight', 0,  6],
          ['AM Rush',   6,  9],
          ['Midday',    9, 12],
          ['PM Rush',  12, 18],
          ['Evening',  18, 24],
          ['Full day',  0, 24],
        ] as const).map(([label, h1, h2]) => {
          const active = selA === h1 && selB === h2 - 1;
          return (
            <button key={label} type="button" onClick={() => selectPreset(label, h1, h2)}
              title={`${label} · ${pad2(h1)}:00–${pad2(h2)}:00`}
              className={cn(
                'h-8 px-2.5 text-[11px] rounded-md border transition-all font-medium flex items-center gap-1.5',
                active
                  ? 'border-teal-500 bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200 dark:border-teal-600 shadow-sm'
                  : 'border-border bg-card text-foreground/80 hover:bg-muted hover:border-foreground/30',
              )}>
              <span>{label}</span>
              <span className="font-mono tabular-nums opacity-60 text-[10px]">
                {pad2(h1)}–{pad2(h2)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[10px]">
        <span className="uppercase tracking-wide font-semibold text-muted-foreground">
          Day
        </span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => shiftDate(-1)}
            title="Previous day"
            className="size-7 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted transition-colors text-base leading-none">
            ‹
          </button>
          <input type="date" value={date} max={today}
            onChange={e => { setDate(e.target.value); setSelA(null); setSelB(null); }}
            className="h-7 text-xs px-2 rounded border border-input bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button type="button" onClick={() => shiftDate(1)} disabled={date >= today}
            title="Next day"
            className="size-7 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted transition-colors text-base leading-none disabled:opacity-30">
            ›
          </button>
        </div>
        {tlLoading && <span className="text-muted-foreground animate-pulse ml-1">loading…</span>}
      </div>

      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>↑ Vehicles per hour (vph)</span>
        <JargonTip term="vph" size={11} />
      </div>

      <div className="flex items-stretch gap-2">
        <div className="relative shrink-0 w-9" style={{ height: 140 }}>
          {(() => {
            const bottomReservedPct = (24 / 140) * 100;
            const barTopPct = 12;
            const barBottomPct = 100 - bottomReservedPct;
            const ticks: { value: number; topPct: number }[] = [
              { value: maxCount,                 topPct: barTopPct },
              { value: Math.round(maxCount / 2), topPct: (barTopPct + barBottomPct) / 2 },
              { value: 0,                        topPct: barBottomPct },
            ];
            return ticks.map((t, i) => (
              <div
                key={i}
                className="absolute right-1 text-[11px] text-muted-foreground font-mono tabular-nums"
                style={{ top: `${t.topPct}%`, transform: 'translateY(-50%)' }}
              >
                {t.value.toLocaleString()}
              </div>
            ));
          })()}
        </div>

        <div
          ref={containerRef}
          className="relative flex-1 rounded-lg overflow-hidden border border-border select-none"
          style={{ height: 140, background: '#070d19', cursor: dragging ? 'col-resize' : 'crosshair', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { setDragging(false); setHovered(null); }}
        >
          {!tlLoading && bars.every(b => b.count === 0) && (
            <div className="absolute inset-0 bottom-6 flex flex-col items-center justify-center gap-1 text-white/60 pointer-events-none z-10">
              <span className="text-xs font-medium">No detections recorded for this day</span>
              <span className="text-[10px] text-white/40">Try an earlier date with the arrows above</span>
            </div>
          )}

          {[6, 12, 18].map(h => (
            <div key={h} className="absolute top-0 bottom-6 w-px bg-white/[0.06]"
              style={{ left: `${(h / 24) * 100}%` }} />
          ))}

          {[0.12, 0.56, 0.857].map((topFrac, i) => (
            <div key={i} className="absolute inset-x-0 h-px bg-white/[0.08] pointer-events-none"
              style={{ top: `${topFrac * 100}%` }} />
          ))}

          {selA !== null && selB !== null && (
            <>
              <div className="absolute top-0 bottom-6 bg-teal-400/[0.08] pointer-events-none"
                style={{ left: `${(selA / 24) * 100}%`, width: `${((selB - selA + 1) / 24) * 100}%` }} />
              <div className="absolute top-0 bottom-6 w-0.5 bg-teal-400/80 pointer-events-none"
                style={{ left: `${(selA / 24) * 100}%` }} />
              <div className="absolute top-0 bottom-6 w-0.5 bg-teal-400/80 pointer-events-none"
                style={{ left: `${((selB + 1) / 24) * 100}%` }} />
              <div className="absolute top-2 w-1 h-6 rounded-sm bg-teal-400 pointer-events-none"
                style={{ left: `calc(${(selA / 24) * 100}% - 2px)` }} />
              <div className="absolute top-2 w-1 h-6 rounded-sm bg-teal-400 pointer-events-none"
                style={{ left: `calc(${((selB + 1) / 24) * 100}% + 1px)` }} />
            </>
          )}

          <div className="absolute inset-x-0 bottom-6 top-0 flex items-end" style={{ gap: '1.5px', padding: '0 1.5px' }}>
            {bars.map(b => {
              const inSel = selA !== null && selB !== null && b.hour >= selA && b.hour <= selB;
              const isHov = hovered === b.hour;
              const isPeak = b.hour === peakHour && b.count > 0;
              const heightPct = Math.max(2, (b.count / maxCount) * 88);
              return (
                <div
                  key={b.hour}
                  className="flex-1 rounded-t transition-all duration-75"
                  style={{
                    height: `${heightPct}%`,
                    background: b.count === 0
                      ? '#111827'
                      : inSel
                        ? 'linear-gradient(to top, #0d9488, #5eead4)'
                        : isHov || isPeak
                          ? 'linear-gradient(to top, #3730a3, #a5b4fc)'
                          : barGradient(b.count, maxCount),
                    opacity: b.count === 0 ? 0.25 : 1,
                    boxShadow: inSel ? '0 0 6px #14b8a640' : isPeak ? '0 0 8px #818cf860' : 'none',
                  }}
                />
              );
            })}
          </div>

          {bars[peakHour]?.count > 0 && (
            <div className="absolute bottom-6 pointer-events-none flex flex-col items-center"
              style={{ left: `${((peakHour + 0.5) / 24) * 100}%`, transform: 'translateX(-50%)' }}>
              <span className="text-[7px] font-bold text-indigo-400/70 leading-none">▲</span>
            </div>
          )}

          {hovered !== null && (
            <div className="absolute top-0 bottom-6 w-px bg-white/10 pointer-events-none"
              style={{ left: `${((hovered + 0.5) / 24) * 100}%` }} />
          )}

          {hovered !== null && bars[hovered]?.count > 0 && (
            <div
              className="absolute top-2 pointer-events-none z-10"
              style={{ left: `${Math.min(Math.max(((hovered + 0.5) / 24) * 100, 5), 78)}%`, transform: 'translateX(-50%)' }}
            >
              <div className="bg-slate-900/95 border border-white/10 text-white text-[9px] px-2 py-1 rounded whitespace-nowrap shadow-lg">
                <span className="font-mono font-semibold">{pad2(hovered)}:00</span>
                <span className="text-white/50 mx-1">·</span>
                <span className="text-white/80">{bars[hovered].count.toLocaleString()} veh</span>
              </div>
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 h-6 border-t border-white/10">
            {Array.from({ length: 24 }, (_, h) => h + 1).map(h => {
              const barIndex = h - 1;
              return (
                <div
                  key={h}
                  className="absolute top-1 text-[10px] text-white/70 font-mono tabular-nums leading-none"
                  style={{ left: `${((barIndex + 0.5) / 24) * 100}%`, transform: 'translateX(-50%)' }}
                >
                  {h}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground text-center -mt-1">Hour of day (1 = 00:00 to 01:00 ... 24 = 23:00 to 24:00)</p>

      {selA !== null && selB !== null ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            <span className="font-semibold text-foreground">{selCount.toLocaleString()}</span> vehicles in this window
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{selB - selA + 1}h span</span>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          Tip: drag across the bars for a custom range, or click a single bar for one hour. Color = traffic density.
        </p>
      )}
    </div>
  );
}
