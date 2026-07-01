import { AlertCircle, CalendarRange, ChevronDown, Loader2, X } from 'lucide-react';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TrafficTimeline } from '@/components/TrafficTimeline';
import type { WindowSelection, WindowStatus } from '@/components/IntersectionShell';

/**
 * Shell-level chip that opens a popover for picking a replay time window.
 *
 * Why a single global picker:
 *   The replay-a-specific-window control used to live inside the Timing tab
 *   as a tall card with its own "Run analysis" button. That made replay feel
 *   tab-bound (you couldn't tell Live or Report what window you were curious
 *   about) and the page would mode-flip between "current" and "historical"
 *   when you committed.
 *
 *   The Grafana / Cloudflare / Plausible pattern is one global selector:
 *   pick a window, every panel that supports it re-renders. Here the picker
 *   writes to shell context; consumers (currently Timing) watch the
 *   selection and re-fetch.
 *
 * UX:
 *   Collapsed: a chip showing "All day" or the selected window (HH:MM-HH:MM).
 *   Expanded: a popover containing TrafficTimeline plus its preset row.
 *   Brushing the bars or clicking a preset commits to shell state immediately
 *   - no "Apply" button. The Clear pill removes the selection.
 */

interface Props {
  intersectionId: number;
  selection:      WindowSelection | null;
  onChange:       (sel: WindowSelection | null) => void;
  /** Status of the consuming tab's windowed compute. The chip surfaces
   *  loading + error states inline so the replay state is communicated in
   *  one place rather than echoed by a second strip in the tab body. */
  status?:        WindowStatus;
}

function fmtRange(sel: WindowSelection): string {
  const s = sel.start.slice(11, 16);
  const e = sel.end.slice(11, 16);
  return `${s} - ${e === '00:00' ? '24:00' : e}`;
}

export function IntersectionWindowPicker({
  intersectionId, selection, onChange, status,
}: Props) {
  const hasSelection = selection != null;
  const initialDate = selection?.date;
  const initialRange: [number, number] | null = selection
    ? [Number(selection.start.slice(11, 13)),
       (Number(selection.end.slice(11, 13)) || 24) - 1]
    : null;
  const isLoading = hasSelection && status?.state === 'loading';
  const isError   = hasSelection && status?.state === 'error';

  // Tone the chip by status: teal (replay active, ok), amber (loading),
  // rose (compute failed). Default chip stays neutral when nothing selected.
  const chipTone = !hasSelection
    ? ''
    : isError
      ? 'border-rose-500/60 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 hover:bg-rose-100 dark:hover:bg-rose-950/60'
      : 'border-teal-500/60 bg-teal-50 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200 hover:bg-teal-100 dark:hover:bg-teal-950/60';

  return (
    <div className="inline-flex items-stretch gap-1 print:hidden">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-7 px-2.5 text-xs font-medium gap-1.5',
              chipTone,
            )}
            data-testid="window-picker-chip"
            title={
              isError
                ? `Replay failed: ${status?.message ?? 'unknown error'}`
                : hasSelection
                  ? `Replaying ${fmtRange(selection)} on ${selection.date}${isLoading ? ' (loading...)' : ''}`
                  : 'Pick a time window to replay'
            }
          >
            {isLoading
              ? <Loader2 className="size-3 animate-spin" />
              : isError
                ? <AlertCircle className="size-3" />
                : <CalendarRange className="size-3" />}
            {hasSelection
              ? <>
                  <span className="tabular-nums">{fmtRange(selection)}</span>
                  {selection.presetLabel && (
                    <span className="opacity-70 hidden sm:inline">· {selection.presetLabel}</span>
                  )}
                </>
              : <span>All day</span>}
            <ChevronDown className="size-3 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[42rem] max-w-[calc(100vw-2rem)] p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs font-semibold">Replay a specific window</p>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Pick a preset or drag the bars. The whole page re-runs against
                real detections from that window.
              </p>
            </div>
            {hasSelection && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs gap-1"
                onClick={() => onChange(null)}
              >
                <X className="size-3" />
                Clear
              </Button>
            )}
          </div>
          <TrafficTimeline
            intersectionId={intersectionId}
            initialDate={initialDate}
            initialHourRange={initialRange}
            onRange={(start, end, vph, presetLabel) => {
              const date = start.slice(0, 10);
              onChange({ date, start, end, vph, presetLabel });
            }}
          />
        </PopoverContent>
      </Popover>

      {/* Inline clear button when a window is active. Saves the operator from
          having to open the popover just to escape replay mode - they can
          drop back to default with one tap. */}
      {hasSelection && (
        <button
          type="button"
          onClick={() => onChange(null)}
          title="Back to current (clear replay window)"
          className={cn(
            'inline-flex items-center justify-center h-7 w-7 rounded-md border text-xs transition-colors',
            isError
              ? 'border-rose-500/60 text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950/60'
              : 'border-teal-500/60 text-teal-700 hover:bg-teal-100 dark:text-teal-300 dark:hover:bg-teal-950/60',
          )}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
