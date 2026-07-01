import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { JARGON, type JargonKey } from '@/lib/jargon';
import { cn } from '@/lib/utils';

export interface JargonTipProps {
  /** Key into the JARGON dictionary in @/lib/jargon. */
  term: JargonKey;
  /** Optional className applied to the trigger icon wrapper. */
  className?: string;
  /** Icon size in px (defaults to 12). */
  size?: number;
}

/**
 * Inline help affordance for traffic-engineering jargon.
 *
 * Renders a small Info icon that, on hover or tap, shows a plain-English
 * one-liner from the JARGON dictionary plus a "Learn more" link into the
 * Manual page. Designed to sit immediately after the term it describes:
 *
 *     LOS B <JargonTip term="los" />
 */
export function JargonTip({ term, className, size = 12 }: JargonTipProps) {
  const entry = JARGON[term];
  if (!entry) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${entry.term}?`}
          className={cn(
            'inline-flex items-center justify-center align-middle text-muted-foreground/70 hover:text-foreground transition-colors print:hidden',
            className,
          )}
        >
          <Info style={{ width: size, height: size }} />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="flex max-w-xs flex-col items-start gap-0 whitespace-normal text-left leading-relaxed"
      >
        <p className="font-semibold mb-1">{entry.term}</p>
        <p className={entry.options ? 'mb-1' : 'mb-1.5'}>{entry.short}</p>
        {entry.options && (
          <ul className="mb-1.5 flex flex-col gap-0.5">
            {entry.options.map(opt => (
              <li key={opt.label} className="leading-snug">
                <span className="font-medium">{opt.label}</span>
                <span className="text-background/70"> - {opt.desc}</span>
              </li>
            ))}
          </ul>
        )}
        <Link
          to={`/manual${entry.manualTab ? `?tab=${entry.manualTab}` : ''}#${entry.manualAnchor}`}
          className="text-[10px] underline text-background/80 hover:text-background"
        >
          Learn more →
        </Link>
      </TooltipContent>
    </Tooltip>
  );
}
