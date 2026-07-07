import type { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import type { RecommendationResponse } from '@/services/recommendations';
import { WARRANTS, warrantStatuses, type WarrantGroup, type WarrantInfo } from '@/lib/warrants';

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
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start gap-2 mb-1.5">
        <Badge variant="outline" className="text-[10px] font-mono shrink-0 mt-0.5">{info.code}</Badge>
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
    </div>
  );
}

export interface WarrantReferenceProps {
  /** When supplied, each warrant is annotated with this intersection's status. */
  rec?: RecommendationResponse | null;
  intersectionName?: string;
  /** Custom trigger; defaults to a small help-icon button. */
  trigger?: ReactNode;
}

export function WarrantReference({ rec, intersectionName, trigger }: WarrantReferenceProps) {
  const statusByCode = new Map(
    rec ? warrantStatuses(rec).map(s => [s.info.code, s]) : [],
  );
  const groups: WarrantGroup[] = ['mutcd', 'local'];

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
                {WARRANTS.filter(w => w.group === group).map(info => {
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
