import { NavLink } from 'react-router-dom';
import { MonitorPlay, TrendingUp, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  intersectionId: number | string;
}

// Three role-focused tabs. The verdict banner above the tabs carries the
// reconciled action so each tab can focus on one stage:
//   Live   - what the cameras see right now (counts + tiles).
//   Timing - what to change and proof it works (Webster editor + dual canvas).
//   Report - formal write-up for handoff (stochastic confidence + PDF).
const TABS = [
  { to: '',        end: true,  label: 'Live',    icon: MonitorPlay },
  { to: 'timing',  end: false, label: 'Timing',  icon: TrendingUp  },
  { to: 'report',  end: false, label: 'Report',  icon: FileText    },
] as const;

export function IntersectionTabs({ intersectionId }: Props) {
  const base = `/intersections/${intersectionId}`;
  return (
    <nav
      className="inline-flex rounded-md border border-border overflow-hidden bg-card print:hidden"
      aria-label="Intersection sections"
    >
      {TABS.map(({ to, end, label, icon: Icon }) => {
        const href = to ? `${base}/${to}` : base;
        return (
          <NavLink
            key={label}
            to={href}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-l border-border first:border-l-0',
                isActive
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )
            }
          >
            <Icon className="size-3" />
            {label}
          </NavLink>
        );
      })}
    </nav>
  );
}
