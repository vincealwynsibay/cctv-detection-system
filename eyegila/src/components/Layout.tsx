import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { onboardingApi } from '@/services/onboarding';
import { intersectionsApi } from '@/services/intersections';
import { useAuth } from '@/hooks/useAuth';
import { useSSE, type SSEStatus } from '@/hooks/useSSE';
import type { AggregationRow, Intersection } from '@/types';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton,
  SidebarProvider, SidebarTrigger,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { SetupProgressPopoverContent } from '@/components/SetupProgressPopover';
import {
  BarChart3, MapPin, Users, LogOut,
  Wifi, WifiOff, Loader2, ServerCrash, Video, Camera,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/',        label: 'Dashboard', icon: MapPin,    end: true, hint: 'Live intersection health and warrant verdicts' },
  { to: '/cameras', label: 'Cameras',   icon: Camera,               hint: 'Connect and assign cameras to approaches' },
  { to: '/reports', label: 'Reports',   icon: BarChart3,            hint: 'Multi-intersection summary and CSV export' },
  { to: '/videos',  label: 'Videos',    icon: Video,                hint: 'Upload archived footage to backfill counts' },
  { to: '/users',   label: 'Users',     icon: Users,                hint: 'Manage operator accounts' },
];

const SSE_INDICATOR: Record<SSEStatus, { icon: React.ReactNode; label: string; color: string; tip: string }> = {
  connected:     { icon: <Wifi className="size-3 text-emerald-500 sse-pulse" />, label: 'Live',          color: 'text-emerald-500', tip: 'Live data stream connected'       },
  connecting:    { icon: <Loader2 className="size-3 text-amber-500 animate-spin" />, label: 'Connecting', color: 'text-amber-500',   tip: 'Reconnecting to data stream…'     },
  disconnected:  { icon: <WifiOff className="size-3 text-destructive" />,        label: 'Offline',       color: 'text-destructive',  tip: 'Stream dropped - retrying…'       },
  server_offline:{ icon: <ServerCrash className="size-3 text-destructive" />,    label: 'Server offline',color: 'text-destructive',  tip: 'Server unreachable - retrying…'   },
};


function SSEIndicator({ status }: { status: SSEStatus }) {
  const { icon, label, color, tip } = SSE_INDICATOR[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground">
          {icon}
          <span className={cn(color)}>{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function Layout() {
  const { username, logout, token } = useAuth();
  const navigate = useNavigate();
  const SSE_URL = token ? '/api/aggregation/stream' : null;
  const { data: sseData, status: sseStatus } = useSSE<AggregationRow[]>(SSE_URL ?? '', !!SSE_URL);

  const [wizardOpen,       setWizardOpen]       = useState(false);
  const [savedStep,        setSavedStep]        = useState<string | null>(null);
  const [intersectionList, setIntersectionList] = useState<Intersection[]>([]);
  const [setupPopoverOpen, setSetupPopoverOpen] = useState(false);
  function fetchIntersections() {
    intersectionsApi.list().then(setIntersectionList).catch(() => {});
  }

  useEffect(() => {
    if (!token) return;
    onboardingApi.getProgress()
      .then(p => setSavedStep(p.step))
      .catch(() => {});
    fetchIntersections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function openWizard(step?: string) {
    if (step) setSavedStep(step);
    setWizardOpen(true);
  }

  function handleWizardClose(currentStep: string | null) {
    setSavedStep(currentStep);
    setWizardOpen(false);
    fetchIntersections();
  }

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <SidebarProvider>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <Sidebar variant="sidebar" collapsible="icon">
          <SidebarHeader className="border-b border-sidebar-border px-4 py-3">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="EyeGila" className="size-7 rounded-md object-contain" />
              <span className="font-bold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">
                EyeGila
              </span>
              <Badge className="ml-auto text-[10px] bg-green-500/20 text-green-300 border-green-500/30 hover:bg-green-500/20 group-data-[collapsible=icon]:hidden">
                TMO
              </Badge>
            </div>
          </SidebarHeader>

          <SidebarContent className="py-2">
            <SidebarMenu>
              {NAV_ITEMS.map(({ to, label, icon: Icon, end, hint }) => (
                <SidebarMenuItem key={to}>
                  <NavLink
                    to={to}
                    end={end}
                    className="w-full"
                    data-testid={`nav-link-${label.toLowerCase()}`}
                  >
                    {({ isActive }) => (
                      <SidebarMenuButton
                        isActive={isActive}
                        // hidden:false overrides the sidebar default that only
                        // shows the tooltip when collapsed - new users need the
                        // context even when the labels are visible.
                        tooltip={{ children: hint, hidden: false, side: 'right' }}
                      >
                        <Icon className="text-white" />
                        <span className="text-sm font-medium text-white">{label}</span>
                      </SidebarMenuButton>
                    )}
                  </NavLink>
                </SidebarMenuItem>
              ))}

            </SidebarMenu>

            {/* Setup progress indicator - click to open wizard */}
            {intersectionList.length > 0 && (() => {
              const configured = intersectionList.filter(i => i.existing_cycle_length != null).length;
              const total      = intersectionList.length;
              const pct        = Math.round((configured / total) * 100);
              return (
                <Popover open={setupPopoverOpen} onOpenChange={setSetupPopoverOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button
                          className="mx-3 mt-2 mb-2 rounded-md border border-white/20 bg-white/5 px-3 py-3 group-data-[collapsible=icon]:hidden w-[calc(100%-1.5rem)] text-left hover:bg-white/10 hover:border-white/40 transition-colors"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-white uppercase tracking-wide">
                              Setup Progress
                            </span>
                            <span className="text-sm font-bold tabular-nums text-white">
                              {configured}/{total}
                            </span>
                          </div>
                          <div className="h-2 rounded-full bg-black/40 overflow-hidden border border-white/10">
                            <div
                              className={cn(
                                'h-full rounded-full transition-all duration-500',
                                pct === 100 ? 'bg-emerald-500' : 'bg-primary',
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="text-xs font-medium text-white/80 mt-2">
                            {configured === total
                              ? 'All intersections configured'
                              : `${total - configured} pending timing setup`}
                          </p>
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="right">Click to resume setup or dismiss pending tasks</TooltipContent>
                  </Tooltip>
                  <PopoverContent side="right" align="start" className="w-80">
                    <SetupProgressPopoverContent
                      intersections={intersectionList}
                      onOpenWizard={openWizard}
                      onIntersectionsChanged={fetchIntersections}
                      onClose={() => setSetupPopoverOpen(false)}
                    />
                  </PopoverContent>
                </Popover>
              );
            })()}
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border p-3">
            <div className="flex items-center justify-between group-data-[collapsible=icon]:justify-center">
              <span className="truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                {username}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={handleLogout}
              >
                <LogOut className="size-4" />
                <span className="sr-only">Logout</span>
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-12 shrink-0 items-center border-b border-border bg-card px-4 gap-3">
            <SidebarTrigger className="size-7" />
            <Separator orientation="vertical" className="h-4" />
            <div className="flex-1" />
            {/* RecommenderBadge intentionally removed from the header (the
                model identity is operator-irrelevant). The component is
                still defined above and can be re-added if needed for a
                panel demo without rebuilding the data hook. */}
            <SSEIndicator status={sseStatus} />
          </header>

          <main className="flex-1 overflow-y-auto p-6">
            <Outlet context={{ sseData, sseStatus, onOpenWizard: openWizard as (step?: string) => void }} />
          </main>
        </div>
      </div>

      <OnboardingWizard
        open={wizardOpen}
        initialStep={savedStep}
        onClose={handleWizardClose}
      />
    </SidebarProvider>
  );
}
