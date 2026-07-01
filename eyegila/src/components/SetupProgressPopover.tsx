import { useEffect, useState } from 'react';
import { Check, X, ArrowRight, ChevronDown, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { intersectionsApi } from '@/services/intersections';
import { cctvsApi } from '@/services/cctvs';
import { recommendationsApi } from '@/services/recommendations';
import { request } from '@/services/api';
import type { CCTV, Intersection, OnboardingTask, Region } from '@/types';
import { cn } from '@/lib/utils';

interface TaskStatus {
  task: OnboardingTask;
  label: string;
  done: boolean;
  dismissed: boolean;
  /** Wizard step ID to resume at when the user clicks Resume. */
  wizardStep: string;
}

interface IntersectionTaskSummary {
  intersection: Intersection;
  tasks: TaskStatus[];
  pendingCount: number;
  dismissedCount: number;
}

const TASK_LABELS: Record<OnboardingTask, { label: string; wizardStep: string }> = {
  cameras:        { label: 'Cameras',        wizardStep: 'discover' },
  regions:        { label: 'Regions drawn',  wizardStep: 'regions'  },
  timing:         { label: 'Timing entered', wizardStep: 'timing'   },
  first_analysis: { label: 'First analysis', wizardStep: 'collecting' },
};

const ALL_TASKS: OnboardingTask[] = ['cameras', 'regions', 'timing', 'first_analysis'];

export interface SetupProgressPopoverContentProps {
  intersections: Intersection[];
  onOpenWizard: (step: string) => void;
  onIntersectionsChanged: () => void;
  onClose: () => void;
}

/**
 * Per-intersection onboarding checklist. Rendered inside the sidebar
 * Setup Progress popover. Lets operators jump back into the wizard at the
 * pending step, or dismiss a task they don't intend to complete (e.g. a
 * low-priority intersection whose regions aren't needed yet).
 *
 * Pulls the live CCTV / Region / Recommendation state on open so each row
 * shows the current truth, not whatever was cached when Layout last
 * fetched. Dismissals are persisted server-side via intersectionsApi.
 */
export function SetupProgressPopoverContent({
  intersections,
  onOpenWizard,
  onIntersectionsChanged,
  onClose,
}: SetupProgressPopoverContentProps) {
  const [loading, setLoading] = useState(true);
  const [summaries, setSummaries] = useState<IntersectionTaskSummary[]>([]);
  const [mutating, setMutating] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [cams, regions, recs] = await Promise.all([
        cctvsApi.list(),
        request<Region[]>('/regions/'),
        recommendationsApi.list(),
      ]);
      const regionCamIds = new Set(regions.map(r => r.cctv_id));
      const recIntersectionIds = new Set(recs.map(r => r.intersection_id));
      setSummaries(intersections.map(i => buildSummary(i, cams, regionCamIds, recIntersectionIds)));
    } catch {
      toast.error('Failed to load setup progress');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intersections]);

  async function handleDismiss(intersectionId: number, task: OnboardingTask) {
    setMutating(`${intersectionId}:${task}`);
    try {
      await intersectionsApi.dismissSetupTask(intersectionId, task);
      onIntersectionsChanged();
      await load();
      toast.success('Task dismissed');
    } catch {
      toast.error('Could not dismiss task');
    } finally {
      setMutating(null);
    }
  }

  async function handleRestore(intersectionId: number, task: OnboardingTask) {
    setMutating(`${intersectionId}:${task}`);
    try {
      await intersectionsApi.restoreSetupTask(intersectionId, task);
      onIntersectionsChanged();
      await load();
    } catch {
      toast.error('Could not restore task');
    } finally {
      setMutating(null);
    }
  }

  function handleResume(step: string) {
    onClose();
    onOpenWizard(step);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading setup progress…
      </div>
    );
  }

  if (summaries.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        No intersections yet. Click <strong>Set up</strong> on the Dashboard to add one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pending setup
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Resume a step or dismiss tasks the intersection doesn’t need.
        </p>
      </div>

      {summaries.map(s => (
        <IntersectionRow
          key={s.intersection.id}
          summary={s}
          mutating={mutating}
          onResume={handleResume}
          onDismiss={handleDismiss}
          onRestore={handleRestore}
          showDismissed={showDismissed}
        />
      ))}

      {summaries.some(s => s.dismissedCount > 0) && (
        <button
          type="button"
          onClick={() => setShowDismissed(v => !v)}
          className="self-start text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronDown className={cn('size-3 transition-transform', showDismissed && 'rotate-180')} />
          {showDismissed ? 'Hide dismissed' : 'Show dismissed'}
        </button>
      )}
    </div>
  );
}

interface IntersectionRowProps {
  summary: IntersectionTaskSummary;
  mutating: string | null;
  showDismissed: boolean;
  onResume: (step: string) => void;
  onDismiss: (intersectionId: number, task: OnboardingTask) => void;
  onRestore: (intersectionId: number, task: OnboardingTask) => void;
}

function IntersectionRow({
  summary, mutating, showDismissed, onResume, onDismiss, onRestore,
}: IntersectionRowProps) {
  const visibleTasks = summary.tasks.filter(t => showDismissed || !t.dismissed);
  if (visibleTasks.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-card/40 p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold truncate">{summary.intersection.name}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {summary.pendingCount === 0 ? 'Complete' : `${summary.pendingCount} pending`}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {visibleTasks.map(t => {
          const isMut = mutating === `${summary.intersection.id}:${t.task}`;
          return (
            <li
              key={t.task}
              className={cn(
                'flex items-center gap-2 text-[11px] rounded px-1.5 py-1',
                t.dismissed && 'opacity-60',
              )}
            >
              <span
                className={cn(
                  'size-3.5 rounded-full flex items-center justify-center shrink-0',
                  t.done ? 'bg-emerald-500/20 text-emerald-600' : 'bg-muted text-muted-foreground',
                )}
              >
                {t.done ? <Check className="size-2.5" /> : <span className="text-[8px]">○</span>}
              </span>
              <span className={cn('flex-1 truncate', t.dismissed && 'line-through')}>{t.label}</span>
              {!t.done && !t.dismissed && (
                <>
                  <button
                    type="button"
                    onClick={() => onResume(t.wizardStep)}
                    className="text-[10px] inline-flex items-center gap-0.5 text-primary hover:underline disabled:opacity-50"
                    disabled={isMut}
                  >
                    Resume <ArrowRight className="size-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismiss(summary.intersection.id, t.task)}
                    className="text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                    disabled={isMut}
                    title="Dismiss - this intersection doesn’t need it"
                  >
                    {isMut ? <Loader2 className="size-2.5 animate-spin" /> : <X className="size-2.5" />}
                  </button>
                </>
              )}
              {t.dismissed && (
                <button
                  type="button"
                  onClick={() => onRestore(summary.intersection.id, t.task)}
                  className="text-[10px] inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  disabled={isMut}
                  title="Restore - re-surface this task"
                >
                  {isMut ? <Loader2 className="size-2.5 animate-spin" /> : <RotateCcw className="size-2.5" />}
                  Restore
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function buildSummary(
  intersection: Intersection,
  allCams: CCTV[],
  regionCamIds: Set<number>,
  recIntersectionIds: Set<number>,
): IntersectionTaskSummary {
  const cams = allCams.filter(c => c.intersection_id === intersection.id);
  const hasAnyCam = cams.length > 0;
  const allCamsHaveRegions = hasAnyCam && cams.every(c => regionCamIds.has(c.id));
  const hasTiming = intersection.existing_cycle_length != null && intersection.existing_green_splits != null;
  const hasRec = recIntersectionIds.has(intersection.id);
  const dismissed = new Set(intersection.dismissed_setup_tasks ?? []);

  const tasks: TaskStatus[] = ALL_TASKS.map(t => {
    const meta = TASK_LABELS[t];
    let done = false;
    switch (t) {
      case 'cameras':        done = hasAnyCam;          break;
      case 'regions':        done = allCamsHaveRegions; break;
      case 'timing':         done = hasTiming;          break;
      case 'first_analysis': done = hasRec;             break;
    }
    return {
      task: t,
      label: meta.label,
      wizardStep: meta.wizardStep,
      done,
      dismissed: dismissed.has(t) && !done,
    };
  });

  return {
    intersection,
    tasks,
    pendingCount:   tasks.filter(t => !t.done && !t.dismissed).length,
    dismissedCount: tasks.filter(t => t.dismissed).length,
  };
}
