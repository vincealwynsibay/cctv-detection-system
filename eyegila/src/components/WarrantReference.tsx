import type { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import type { RecommendationResponse } from '@/services/recommendations';
import { WARRANTS, warrantStatuses, metWarrants, type WarrantGroup, type WarrantInfo } from '@/lib/warrants';
import { cn } from '@/lib/utils';

/**
 * "Warrant guide": the built-in reference explaining what every signal
 * warrant checks, its threshold, and (when a recommendation is supplied) where
 * this intersection stands on each one. Exists so operators and review panels
 * can audit the "why" without leaving the app or searching the MUTCD.
 */

const GROUP_LABEL: Record<WarrantGroup, string> = {
  mutcd: 'MUTCD warrants · national standard',
  local: 'Local warrants · Tagum City conditions',
};

function StatusPill({ met, confidence }: { met: boolean | null; confidence: number | null }) {
  const pct = confidence != null ? Math.round(confidence * 100) : null;
  if (met == null) {
    return (
      <Badge variant="outline" className="text-[10px] border-muted text-muted-foreground shrink-0">
        No data
      </Badge>
    );
  }
  if (met) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] shrink-0 border-emerald-500/40 text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/30"
      >
        Met{pct != null ? ` · ${pct}%` : ''}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] shrink-0 border-muted text-muted-foreground bg-muted/30">
      Not met{pct != null ? ` · ${pct}%` : ''}
    </Badge>
  );
}

function WarrantRow({ info, met, confidence }: { info: WarrantInfo; met?: boolean | null; confidence?: number | null }) {
  const isMet = met === true;
  const pct = confidence != null ? Math.round(confidence * 100) : null;
  return (
    <div className={cn(
      'rounded-lg border p-3 transition-colors',
      isMet
        ? 'border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/20'
        : 'border-border',
    )}>
      <div className="flex items-start gap-2 mb-1.5">
        <Badge variant="outline" className={cn(
          'text-[10px] font-mono shrink-0 mt-0.5',
          isMet && 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300',
        )}>{info.code}</Badge>
        <h4 className="text-sm font-medium leading-tight flex-1">{info.name}</h4>
        {met !== undefined && <StatusPill met={met ?? null} confidence={confidence ?? null} />}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{info.purpose}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
        <dt className="font-medium text-foreground/70">Triggers when</dt>
        <dd className="text-muted-foreground">{info.triggersWhen}</dd>
        <dt className="font-medium text-foreground/70">Threshold</dt>
        <dd className="text-muted-foreground">{info.threshold}</dd>
        <dt className="font-medium text-foreground/70">Source</dt>
        <dd className="text-muted-foreground">{info.ref}</dd>
      </dl>
      {met !== undefined && pct != null && (
        <div className="mt-2.5 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn('h-full rounded-full', isMet ? 'bg-emerald-500' : 'bg-muted-foreground/30')}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right shrink-0">{pct}%</span>
        </div>
      )}
    </div>
  );
}

const ACTION_BANNER: Record<string, { border: string; bg: string; text: string; label: string }> = {
  install_signal: {
    border: 'border-yellow-400/60',
    bg:     'bg-yellow-50/70 dark:bg-yellow-950/20',
    text:   'text-yellow-800 dark:text-yellow-300',
    label:  'Signalize',
  },
  adjust_timing: {
    border: 'border-sky-500/40',
    bg:     'bg-sky-50/70 dark:bg-sky-950/20',
    text:   'text-sky-800 dark:text-sky-300',
    label:  'Adjust timing',
  },
  widen_lanes: {
    border: 'border-red-500/40',
    bg:     'bg-red-50/70 dark:bg-red-950/20',
    text:   'text-red-800 dark:text-red-300',
    label:  'Widen lanes',
  },
};

export interface WarrantReferenceProps {
  /** When supplied, each warrant is annotated with this intersection's status. */
  rec?: RecommendationResponse | null;
  intersectionName?: string;
  /** Reconciled action kind — colours the met-warrant banner. */
  actionKind?: string;
  /** Custom trigger; defaults to a small help-icon button. */
  trigger?: ReactNode;
}

export function WarrantReference({ rec, intersectionName, actionKind, trigger }: WarrantReferenceProps) {
  const statusByCode = new Map(
    rec ? warrantStatuses(rec).map(s => [s.info.code, s]) : [],
  );
  const met = rec ? metWarrants(rec) : [];
  const groups: WarrantGroup[] = ['mutcd', 'local'];
  const banner = actionKind ? ACTION_BANNER[actionKind] : null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label="What do these warrants mean?"
            className="inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground transition-colors print:hidden"
          >
            <HelpCircle className="size-3.5" />
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Signal warrants{intersectionName ? ` · ${intersectionName}` : ''}</DialogTitle>
          <DialogDescription>
            What each warrant checks, its threshold, and where this intersection stands.
          </DialogDescription>
        </DialogHeader>

        {rec && (
          <div className={cn(
            'rounded-md border px-3 py-2.5 text-xs leading-relaxed',
            met.length > 0 && banner
              ? `${banner.border} ${banner.bg} ${banner.text}`
              : met.length > 0
              ? 'border-emerald-500/40 bg-emerald-50/60 text-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-300'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}>
            {met.length > 0 ? (
              <>
                {banner && (
                  <span className="font-semibold uppercase tracking-wide text-[10px] mr-1.5">
                    {banner.label}
                  </span>
                )}
                <span className="font-semibold">{met.length} warrant{met.length > 1 ? 's' : ''} met: </span>
                {met.map((s, i) => (
                  <span key={s.info.code}>
                    <span className="font-mono font-semibold">{s.info.code}</span>
                    {s.confidence != null && ` (${Math.round(s.confidence * 100)}%)`}
                    {i < met.length - 1 ? ', ' : ''}
                  </span>
                ))}
                . Met warrants are highlighted below.
              </>
            ) : (
              'No warrants met for this intersection at the current volumes.'
            )}
          </div>
        )}

        {/* Defuses the "green = done" confusion up front. */}
        <p className="text-xs text-muted-foreground leading-relaxed rounded-md bg-muted/40 border border-border p-2.5">
          A <strong>warrant</strong> is a standard test for whether an intersection justifies a
          traffic signal. <strong>Met</strong> means the condition is satisfied, but it does{' '}
          <em>not</em> mean "nothing to do": at an intersection that already has a signal, a met
          warrant becomes a <strong>timing recommendation</strong>, not a new signal.{' '}
          <strong>Confidence</strong> is how far the measured value sits past (or below) the threshold.
        </p>

        <div className="flex flex-col gap-4">
          {groups.map(group => (
            <section key={group} className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {GROUP_LABEL[group]}
              </h3>
              <div className="flex flex-col gap-2">
                {WARRANTS
                  .filter(w => w.group === group)
                  .sort((a, b) => {
                    const sa = statusByCode.get(a.code);
                    const sb = statusByCode.get(b.code);
                    return (sb?.met ? 1 : 0) - (sa?.met ? 1 : 0);
                  })
                  .map(info => {
                    const s = statusByCode.get(info.code);
                    return (
                      <WarrantRow
                        key={info.code}
                        info={info}
                        met={rec ? s?.met ?? null : undefined}
                        confidence={s?.confidence ?? null}
                      />
                    );
                  })}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
