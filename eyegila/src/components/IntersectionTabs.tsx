import { NavLink } from 'react-router-dom';
import { MonitorPlay, TrendingUp, FileText, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  intersectionId: number | string;
}

// Recommendation is the default landing tab (the 4-step decision narrative).
// The others are role-specific drill-downs: Live (camera feeds + warrant
// chips), Timing (Webster math + per-chunk splits), Report (printable PDF
// for handoff). The first tab existing means a user can return to the
// narrative from any drill-down.
const TABS = [
  { to: '',        end: true,  label: 'Recommendation', icon: Sparkles    },
  { to: 'live',    end: false, label: 'Live',           icon: MonitorPlay },
  { to: 'timing',  end: false, label: 'Timing',         icon: TrendingUp  },
  { to: 'report',  end: false, label: 'Report',         icon: FileText    },
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
