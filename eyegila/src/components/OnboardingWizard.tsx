import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { JargonTip } from '@/components/JargonTip';
import { onboardingApi } from '@/services/onboarding';
import { cctvsApi } from '@/services/cctvs';
import { intersectionsApi } from '@/services/intersections';
import { recommendationsApi } from '@/services/recommendations';
import { streetsApi } from '@/services/streets';
import { request } from '@/services/api';
import type { ArmDirection, Region } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  X, ArrowRight, ArrowLeft, Check, Search,
  Loader2, ScanSearch, Plus, Wifi, Server, RefreshCw, ExternalLink,
  BarChart3,
} from 'lucide-react';

// Leaflet default icon fix (works once per module load)
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const TAGUM_CENTER: [number, number] = [7.4478, 125.8057];

const DIRECTIONS: { value: ArmDirection; label: string }[] = [
  { value: 'northbound', label: 'Northbound (N)' },
  { value: 'southbound', label: 'Southbound (S)' },
  { value: 'eastbound',  label: 'Eastbound (E)'  },
  { value: 'westbound',  label: 'Westbound (W)'  },
  { value: 'unknown',    label: 'Unknown'         },
];

const DEFAULT_DIR_ORDER: ArmDirection[] = ['northbound', 'southbound', 'eastbound', 'westbound', 'unknown'];

const WIZARD_STEPS = [
  // Welcome step removed - it was a placeholder ("Demo preview will appear
  // here once ... is implemented") that added a click before the operator
  // could do anything real. The Find cameras step is now the entry point.
  //
  // Timing step also removed - the intersection Settings sheet (cog icon
  // in the shell) now owns the signal + cycle + splits editor, and the
  // wizard's copy of that form was near-identical. Setup ends at Collecting
  // and the operator can enter timing on their own schedule from Settings.
  { id: 'discover',  label: 'Find cameras'  },
  { id: 'group',     label: 'Group by IP'   },
  { id: 'name',      label: 'Name & pin'    },
  { id: 'assign',    label: 'Directions'    },
  { id: 'regions',   label: 'Draw regions'  },
  { id: 'collecting',label: 'Collecting'    },
] as const;

/** Last-octet of an IPv4 dotted-quad. Returns NaN for anything that
 *  doesn't look like `a.b.c.d` - the group detector treats NaN as a
 *  hard break in the contiguous-block scan. */
function ipLastOctet(address: string): number {
  const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m ? Number(m[4]) : NaN;
}
function ipSubnet24(address: string): string | null {
  const m = address.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  return m ? m[1] : null;
}

interface IpGroup {
  /** Stable id derived from the subnet + start octet - also serves as React key. */
  key: string;
  /** Pre-filled intersection name, editable inline. */
  name: string;
  /** Exactly 4 camera keys from `found` in IP-ascending order. */
  cameraKeys: [string, string, string, string];
}

/** Detect contiguous /24 blocks of four cameras with strictly-incrementing
 *  last octets (e.g. .31/.32/.33/.34). Any gap of 1+ resets the run so
 *  malformed groups don't silently merge across a dead camera. */
function detectIpGroups(found: { key: string; address: string }[]): IpGroup[] {
  // Bucket by /24, sort each by last octet
  const bySubnet = new Map<string, { key: string; octet: number }[]>();
  for (const f of found) {
    const sub = ipSubnet24(f.address);
    const oct = ipLastOctet(f.address);
    if (sub == null || Number.isNaN(oct)) continue;
    if (!bySubnet.has(sub)) bySubnet.set(sub, []);
    bySubnet.get(sub)!.push({ key: f.key, octet: oct });
  }

  const groups: IpGroup[] = [];
  let groupIdx = 1;
  for (const [subnet, entries] of bySubnet) {
    entries.sort((a, b) => a.octet - b.octet);
    let runStart = 0;
    for (let i = 1; i <= entries.length; i++) {
      const broken = i === entries.length || entries[i].octet !== entries[i - 1].octet + 1;
      if (broken) {
        // Emit every 4-IP chunk inside the run. Leftover tail (<4) stays ungrouped.
        for (let s = runStart; s + 4 <= i; s += 4) {
          const block = entries.slice(s, s + 4);
          groups.push({
            key: `${subnet}.${block[0].octet}`,
            name: `Intersection ${groupIdx++}`,
            cameraKeys: [block[0].key, block[1].key, block[2].key, block[3].key],
          });
        }
        runStart = i;
      }
    }
  }
  return groups;
}

/** Direction pre-fill order - first IP gets N, then S, E, W. */
const GROUP_DIRECTION_ORDER: ArmDirection[] = ['northbound', 'southbound', 'eastbound', 'westbound'];

type WizardStepId = typeof WIZARD_STEPS[number]['id'];

const STEP_IDS = WIZARD_STEPS.map(s => s.id);

function isValidStepId(s: string | null): s is WizardStepId {
  return s !== null && (STEP_IDS as readonly string[]).includes(s);
}

interface FoundCamera {
  key: string;
  address: string;
  rtsp_url: string;
  selected: boolean;
  alreadyAdded?: boolean;
  needsPassword?: boolean;
}

interface WizardCamera {
  key: string;
  rtsp_url: string;
  name: string;
  direction: ArmDirection;
}

function MapClickPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: e => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

export interface OnboardingWizardProps {
  open: boolean;
  initialStep: string | null;
  onClose: (currentStep: string | null) => void;
}

export function OnboardingWizard({ open, initialStep, onClose }: OnboardingWizardProps) {
  const navigate = useNavigate();
  const [stepId, setStepId]   = useState<WizardStepId>('discover');
  const [saving, setSaving]   = useState(false);
  const [creating, setCreating] = useState(false);

  // ── Discover step state ────────────────────────────────────────────────────
  const [found, setFound]         = useState<FoundCamera[]>([]);
  const [scanning, setScanning]   = useState(false);
  // Rotating status text shown under the spinner while the simulated scan
  // runs. Mirrors the phases of a real WS-Discovery sweep so the operator
  // sees something happening instead of a static "Scanning…".
  const [scanStatus, setScanStatus] = useState<string>('');
  const [nvrScanning, setNvrScanning] = useState(false);
  const [showNvr, setShowNvr]     = useState(false);
  const [nvrHost, setNvrHost]     = useState('');
  const [nvrUser, setNvrUser]     = useState('admin');
  const [nvrPass, setNvrPass]     = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [existingRtsp, setExistingRtsp] = useState<Set<string>>(new Set());
  // When >=1 contiguous block of 4 is detected, default to bulk-group mode so
  // a city operator with 60 ONVIF cameras doesn't slog through the wizard 15
  // times. Cleared if they manually pick a smaller subset.
  const [useBulkGroup, setUseBulkGroup] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [batchUsername, setBatchUsername]           = useState('admin');
  const [batchPassword, setBatchPassword]           = useState('');

  // ── Group step state ──────────────────────────────────────────────────────
  const [groups, setGroups] = useState<IpGroup[]>([]);

  // When false (default), the regions step renders as a fullscreen wizard
  // page so the operator can't miss the transition. They can opt to
  // minimise into the floating corner panel to multitask (draw regions
  // on the camera detail page while the panel tracks progress).
  const [regionsMinimized, setRegionsMinimized] = useState(false);

  // ── Name step state ────────────────────────────────────────────────────────
  const [interName, setInterName] = useState('');
  const [lat, setLat]             = useState('');
  const [lng, setLng]             = useState('');

  // ── Assign step state ─────────────────────────────────────────────────────
  const [cameras, setCameras]     = useState<WizardCamera[]>([]);

  // ── Created intersection ───────────────────────────────────────────────────
  const [createdIntersectionId, setCreatedIntersectionId] = useState<number | null>(null);

  // ── Regions step state ────────────────────────────────────────────────────
  interface RegionCamStatus { id: number; name: string; hasRegions: boolean }
  const [regionCams, setRegionCams]       = useState<RegionCamStatus[]>([]);
  const [regionLoading, setRegionLoading] = useState(false);
  const [regionTargetId, setRegionTargetId] = useState<number | null>(null);

  // ── Timing step state ─────────────────────────────────────────────────────
  // Timing-step state removed with the step itself. Signal + cycle + splits
  // are edited in the Settings sheet post-onboarding.

  // ── Collecting step state ──────────────────────────────────────────────────
  const [collectingTargetId, setCollectingTargetId]         = useState<number | null>(null);
  const [collectingHasRec, setCollectingHasRec]             = useState(false);
  const [collectingLastDetection, setCollectingLastDetection] = useState<string | null>(null);
  const [collectingLoading, setCollectingLoading]           = useState(false);

  useEffect(() => {
    if (open) {
      setStepId(isValidStepId(initialStep) ? initialStep : 'discover');
    }
  }, [open, initialStep]);

  // Pre-fetch existing camera RTSP URLs so we can filter duplicates
  useEffect(() => {
    if (!open) return;
    cctvsApi.list().then(cams => {
      setExistingRtsp(new Set(cams.map(c => c.rtsp_url)));
    }).catch(() => {});
  }, [open]);

  const stepIndex = WIZARD_STEPS.findIndex(s => s.id === stepId);

  const goTo = useCallback(async (newId: WizardStepId) => {
    setSaving(true);
    try {
      await onboardingApi.setProgress(newId);
      setStepId(newId);
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Regions helpers ────────────────────────────────────────────────────────

  const loadRegionStatus = useCallback(async (intersectionId: number) => {
    setRegionLoading(true);
    try {
      const [allCams, allRegions] = await Promise.all([
        cctvsApi.list(),
        request<Region[]>('/regions/'),
      ]);
      const camsWithRegions = new Set(allRegions.map(r => r.cctv_id));
      setRegionCams(
        allCams
          .filter(c => c.intersection_id === intersectionId)
          .map(c => ({ id: c.id, name: c.name, hasRegions: camsWithRegions.has(c.id) })),
      );
    } catch {
      toast.error('Failed to load camera status');
    } finally {
      setRegionLoading(false);
    }
  }, []);

  // Initialise region step when entering it
  useEffect(() => {
    if (!open || stepId !== 'regions') return;

    async function init() {
      let targetId = createdIntersectionId;
      if (targetId == null) {
        // Wizard was closed and resumed - use the most recently created intersection
        try {
          const inters = await intersectionsApi.list();
          if (inters.length > 0) {
            targetId = inters.sort((a, b) => b.time.localeCompare(a.time))[0].id;
          }
        } catch {}
      }
      if (targetId == null) return;
      setRegionTargetId(targetId);
      await loadRegionStatus(targetId);
    }

    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepId]);

  // (Timing step init effect removed with the step.)

  // Initialise collecting step when entering it
  useEffect(() => {
    if (!open || stepId !== 'collecting') return;

    async function initCollecting() {
      setCollectingLoading(true);
      try {
        let targetId = createdIntersectionId ?? regionTargetId;
        if (targetId == null) {
          const inters = await intersectionsApi.list();
          if (inters.length > 0) {
            targetId = inters.sort((a, b) => b.time.localeCompare(a.time))[0].id;
          }
        }
        if (targetId == null) return;
        setCollectingTargetId(targetId);

        const [recs, health] = await Promise.all([
          recommendationsApi.list(),
          recommendationsApi.dataHealth(targetId).catch(() => null),
        ]);
        setCollectingHasRec(recs.some(r => r.intersection_id === targetId));
        setCollectingLastDetection(health?.last_detection_at ?? null);
      } catch {
        // silent - show placeholder state
      } finally {
        setCollectingLoading(false);
      }
    }

    initCollecting();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepId]);

  // ── Discover helpers ───────────────────────────────────────────────────────

  async function scanNetwork() {
    setScanning(true);
    // Step through the phases of a WS-Discovery sweep so the operator can
    // see what the system is doing during the ~2-second probe. Timed to
    // match the server's simulated sleep - fall-through to "Found …" once
    // the request resolves.
    const phases = [
      'Sweeping local network (192.168.1.0/24)…',
      'Probing ONVIF endpoints on port 80…',
      'Resolving RTSP stream URLs…',
      'Aggregating results…',
    ];
    setScanStatus(phases[0]);
    let phaseIdx = 0;
    const phaseTimer = window.setInterval(() => {
      phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
      setScanStatus(phases[phaseIdx]);
    }, 550);
    try {
      // Prototype path: ONVIF multicast can't reach anything off the LAN, so
      // ask the server for a deterministic synthetic deployment instead.
      // Already-imported RTSP URLs are filtered below so re-running the scan
      // is idempotent against the existing test data.
      const results = await cctvsApi.discover({ simulate: true });
      if (results.length === 0) {
        toast.info('No ONVIF cameras found on the network. Try NVR scan or add manually.');
      }
      setFound(prev => {
        const existingKeys = new Set(prev.map(f => f.address));
        const fresh = results
          .filter(r => !existingKeys.has(r.address))
          .map((r, i) => {
            const alreadyAdded  = existingRtsp.has(r.rtsp_url ?? '');
            const needsPassword = !alreadyAdded && (i === 3 || i === 7 || i === 10);
            return {
              key:          `onvif-${r.address}-${i}`,
              address:      r.address,
              rtsp_url:     r.rtsp_url ?? `rtsp://${r.address}:554/stream1`,
              alreadyAdded,
              selected:     !alreadyAdded && !needsPassword,
              needsPassword,
            };
          });
        const newCount = fresh.filter(f => !f.alreadyAdded).length;
        if (newCount === 0 && results.length > 0) {
          toast.info('All discovered cameras are already in the system.');
        } else if (newCount > 0) {
          toast.success(`Found ${newCount} new camera${newCount === 1 ? '' : 's'}`);
        }
        return [...prev, ...fresh];
      });
    } catch {
      toast.error('Network scan failed');
    } finally {
      window.clearInterval(phaseTimer);
      setScanStatus('');
      setScanning(false);
    }
  }

  async function scanNvr() {
    if (!nvrHost) return;
    setNvrScanning(true);
    try {
      const result = await cctvsApi.scanNvr({
        host: nvrHost, username: nvrUser, password: nvrPass,
        max_channels: 16, subtype: 1,
      });
      if (!result.reachable) {
        toast.error(`NVR at ${nvrHost} is not reachable`);
        return;
      }
      setFound(prev => {
        const existingUrls = new Set(prev.map(f => f.rtsp_url));
        const fresh = result.channels
          .filter(ch => !existingUrls.has(ch.rtsp_url) && !existingRtsp.has(ch.rtsp_url))
          .map(ch => ({
            key:      `nvr-${nvrHost}-ch${ch.channel}`,
            address:  `${nvrHost} Ch${ch.channel}`,
            rtsp_url: ch.rtsp_url,
            selected: true,
          }));
        return [...prev, ...fresh];
      });
      toast.success(`Found ${result.channels.length} channels on NVR`);
    } catch {
      toast.error('NVR scan failed');
    } finally {
      setNvrScanning(false);
    }
  }

  function addManual() {
    if (!manualUrl.trim()) return;
    if (existingRtsp.has(manualUrl.trim())) {
      toast.info('This camera is already in the system');
      return;
    }
    setFound(prev => [...prev, {
      key:      `manual-${Date.now()}`,
      address:  'Manual entry',
      rtsp_url: manualUrl.trim(),
      selected: true,
    }]);
    setManualUrl('');
  }

  function toggleCamera(key: string) {
    setFound(prev => prev.map(f => f.key === key ? { ...f, selected: !f.selected } : f));
  }

  function updateCameraField(key: string, field: 'name' | 'direction', value: string) {
    setCameras(prev => prev.map(c => c.key === key ? { ...c, [field]: value } : c));
  }

  // ── Create intersection (assign → regions) ─────────────────────────────────

  async function createIntersectionAndAdvance() {
    setCreating(true);
    try {
      const inter = await intersectionsApi.create({
        name:      interName.trim(),
        latitude:  parseFloat(lat) || TAGUM_CENTER[0],
        longitude: parseFloat(lng) || TAGUM_CENTER[1],
      });

      const uniqueDirs = [...new Set(cameras.map(c => c.direction))];
      await Promise.all([
        ...uniqueDirs.map(dir =>
          streetsApi.create({
            intersection_id: inter.id,
            name: dir.charAt(0).toUpperCase() + dir.slice(1),
            arm_direction: dir as ArmDirection,
          })
        ),
        ...cameras.map(c =>
          cctvsApi.create({ intersection_id: inter.id, name: c.name, rtsp_url: c.rtsp_url })
        ),
      ]);

      setCreatedIntersectionId(inter.id);
      toast.success(`${interName} created`);
      await goTo('regions');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create intersection');
    } finally {
      setCreating(false);
    }
  }

  // ── Bulk group creation ────────────────────────────────────────────────────

  async function createGroupsAndAdvance() {
    setCreating(true);
    const created: string[] = [];
    const failed: string[] = [];
    try {
      // Sequential per-group to avoid clobbering each other; ~200ms per group
      // × 15 groups = ~3s, acceptable for a prototype demo. Failures don't
      // abort the loop - a single bad RTSP URL shouldn't lose the other 14
      // intersections' worth of work.
      for (const g of groups) {
        try {
          const cams = g.cameraKeys
            .map(k => found.find(f => f.key === k))
            .filter((c): c is FoundCamera => !!c);
          if (cams.length !== 4) {
            failed.push(g.name);
            continue;
          }
          const inter = await intersectionsApi.create({
            name:      g.name.trim() || 'Intersection',
            latitude:  TAGUM_CENTER[0],
            longitude: TAGUM_CENTER[1],
          });
          // One street per cardinal direction, one camera per street.
          await Promise.all(
            GROUP_DIRECTION_ORDER.map(dir =>
              streetsApi.create({
                intersection_id: inter.id,
                name: dir.charAt(0).toUpperCase() + dir.slice(1).replace('bound', ''),
                arm_direction: dir,
              }),
            ),
          );
          await Promise.all(
            cams.map((c, i) =>
              cctvsApi.create({
                intersection_id: inter.id,
                name: `${GROUP_DIRECTION_ORDER[i].replace('bound', '').toUpperCase()} camera`,
                rtsp_url: c.rtsp_url,
              }),
            ),
          );
          created.push(g.name);
        } catch {
          failed.push(g.name);
        }
      }
      if (failed.length > 0) {
        toast.error(`Created ${created.length}/${groups.length} - ${failed.length} failed`);
      } else {
        toast.success(`Created ${created.length} intersections`);
      }
      // Skip Name/Assign/Regions/Timing entirely - the city operator
      // prioritises regions and timing per-intersection from the sidebar
      // Setup Progress popover on their own schedule.
      await goTo('collecting');
    } finally {
      setCreating(false);
    }
  }

  // ── Step-aware Next handler ────────────────────────────────────────────────

  async function handleNext() {
    const nextStep = WIZARD_STEPS[stepIndex + 1].id;

    if (stepId === 'discover') {
      const selected = found.filter(f => f.selected && !f.alreadyAdded);
      if (selected.length === 0) { toast.error('Select at least one camera'); return; }
      // Bulk path: route to the Group step instead of Name, but only when the
      // operator opted in AND the IP scan actually produced groupable cameras.
      const selectedAddrs = new Set(selected.map(s => s.key));
      const groupable = detectIpGroups(selected.map(s => ({ key: s.key, address: s.address })));
      if (useBulkGroup && groupable.length > 0) {
        // Filter groups so they only reference *selected* cameras (operator
        // may have unticked a few).
        const filtered = groupable.filter(g => g.cameraKeys.every(k => selectedAddrs.has(k)));
        setGroups(filtered);
        await goTo('group');
        return;
      }
      await goTo('name');
      return;
    } else if (stepId === 'group') {
      if (groups.length === 0) { toast.error('No groups to create'); return; }
      await createGroupsAndAdvance();
      return;
    } else if (stepId === 'name') {
      if (!interName.trim()) { toast.error('Enter an intersection name'); return; }
      // Prepare cameras array from selected found cameras
      const selected = found.filter(f => f.selected && !f.alreadyAdded);
      setCameras(selected.map((f, i) => ({
        key:       f.key,
        rtsp_url:  f.rtsp_url,
        name:      `Camera ${i + 1}`,
        direction: DEFAULT_DIR_ORDER[i] ?? 'unknown',
      })));
      await goTo(nextStep);
    } else if (stepId === 'assign') {
      await createIntersectionAndAdvance();
    } else {
      await goTo(nextStep);
    }
  }

  async function handleClose() {
    try { await onboardingApi.setProgress(stepId); } catch {}
    onClose(stepId);
  }

  if (!open) return null;

  // ── Regions guide panel (compact floating overlay) ─────────────────────────
  // Only takes over the screen when the operator explicitly minimised it.
  // Otherwise the regions step renders as a normal fullscreen wizard page
  // (see the stepId === 'regions' block in the main return below).
  if (stepId === 'regions' && regionsMinimized) {
    const allDone = regionCams.length > 0 && regionCams.every(c => c.hasRegions);
    return (
      <div className="fixed top-4 right-4 z-50 w-80 bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* Panel header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/40 shrink-0">
          <img src="/logo.png" alt="EyeGila" className="size-5 rounded-md object-contain" />
          <span className="font-semibold text-sm flex-1">Draw Detection Regions</span>
          <button
            type="button"
            onClick={handleClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Pause wizard"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Instructions - the "Step X of N" pill was removed; the minimized
            regions panel already lives in the "Draw regions" step so the
            wizard's step context is implicit. */}
        <p className="px-4 py-3 text-xs text-muted-foreground leading-relaxed">
          Open each camera below and draw a counting polygon on the live video frame.
          Click the first point again (green dot) to close the polygon and save the region.
        </p>

        {/* Camera list */}
        <div className="px-4 pb-3 flex flex-col gap-2">
          {regionLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading cameras…</span>
            </div>
          ) : regionCams.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No cameras found. Go back and complete the camera setup steps.
            </p>
          ) : (
            regionCams.map(cam => (
              <div key={cam.id} className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2',
                cam.hasRegions
                  ? 'border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20'
                  : 'border-border bg-muted/20',
              )}>
                <div className={cn(
                  'size-5 rounded-full flex items-center justify-center shrink-0',
                  cam.hasRegions ? 'bg-emerald-500/20' : 'bg-muted',
                )}>
                  {cam.hasRegions
                    ? <Check className="size-3 text-emerald-600" />
                    : <span className="text-[10px] text-muted-foreground">○</span>}
                </div>
                <span className={cn(
                  'text-xs flex-1 truncate',
                  cam.hasRegions ? 'text-emerald-700 dark:text-emerald-400' : '',
                )}>
                  {cam.name}
                </span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" asChild>
                  <Link to={`/intersections/${createdIntersectionId}/cameras/${cam.id}`}>
                    Open
                    <ExternalLink className="size-2.5 ml-1" />
                  </Link>
                </Button>
              </div>
            ))
          )}
        </div>

        {allDone ? (
          <div className="mx-4 mb-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400 font-medium">
            All cameras have regions - ready to continue!
          </div>
        ) : regionCams.length > 0 && (
          // Advisory note - operators on high-priority intersections want to
          // come back to regions later, not be blocked at this step.
          <div className="mx-4 mb-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {regionCams.filter(c => !c.hasRegions).length} of {regionCams.length} cameras don't have regions yet -
            counts from those will be ignored until you draw one. You can continue and finish later from the Cameras page.
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goTo(WIZARD_STEPS[stepIndex - 1].id)}
            disabled={saving || regionLoading}
            className="h-7 px-2.5 text-xs"
          >
            <ArrowLeft className="size-3.5 mr-1" />
            Back
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => regionTargetId != null && loadRegionStatus(regionTargetId)}
            disabled={regionLoading}
            className="h-7 px-2.5 text-xs"
          >
            {regionLoading
              ? <Loader2 className="size-3.5 mr-1 animate-spin" />
              : <RefreshCw className="size-3.5 mr-1" />}
            Refresh
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={handleNext}
            disabled={saving || regionLoading}
            className="h-7 px-2.5 text-xs"
          >
            Next
            <ArrowRight className="size-3.5 ml-1" />
          </Button>
        </div>
      </div>
    );
  }

  const canGoBack    = stepIndex > 0;
  const isLast       = stepIndex === WIZARD_STEPS.length - 1;
  const selectedCount = found.filter(f => f.selected && !f.alreadyAdded).length;
  const newCameraCount = found.filter(f => !f.alreadyAdded).length;
  const busy         = saving || creating;

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
        <img src="/logo.png" alt="EyeGila" className="size-7 rounded-md object-contain shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-none">Set up EyeGila</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-none">Takes about 10 minutes · you can stop and finish later</p>
        </div>
        <span className="text-xs font-medium text-muted-foreground shrink-0 tabular-nums">
          Step {stepIndex + 1} of {WIZARD_STEPS.length}
        </span>
        <button
          type="button"
          onClick={handleClose}
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          aria-label="Close wizard - progress is saved"
        >
          <X className="size-5" />
        </button>
      </div>

      {/* Two-column body: sidebar progress + step content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar progress tracker */}
        <aside className="hidden sm:flex w-[220px] shrink-0 flex-col border-r border-border bg-muted/10 py-5 px-3">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-2 mb-3">Your progress</div>
          <div className="flex flex-col gap-0.5">
            {WIZARD_STEPS.filter(s => s.id !== 'group' || stepId === 'group' || (stepId === 'collecting' && groups.length > 0)).map((step, idx) => {
              const isCurrent = step.id === stepId;
              const isDone    = WIZARD_STEPS.findIndex(s => s.id === step.id) < stepIndex;
              return (
                <div key={step.id} className={cn(
                  'flex items-center gap-3 px-2 py-2 rounded-lg',
                  isCurrent && 'bg-primary/10',
                )}>
                  <span className={cn(
                    'size-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold',
                    isDone    && 'bg-emerald-500 text-white',
                    isCurrent && 'bg-primary text-primary-foreground',
                    !isDone && !isCurrent && 'border border-border text-muted-foreground',
                  )}>
                    {isDone ? <Check className="size-3" /> : idx + 1}
                  </span>
                  <span className={cn(
                    'text-sm leading-snug',
                    isCurrent && 'font-semibold text-foreground',
                    !isCurrent && 'text-muted-foreground',
                  )}>
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-auto px-2 pt-4">
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                style={{ width: `${((stepIndex + 1) / WIZARD_STEPS.length) * 100}%` }}
              />
            </div>
            <p className="text-[11px] font-mono font-semibold text-muted-foreground mt-1.5">
              {stepIndex + 1}/{WIZARD_STEPS.length}
            </p>
          </div>
        </aside>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl px-6 sm:px-8 py-8">

          {/* ── Discover ─────────────────────────────────────────────────────── */}
          {stepId === 'discover' && (
            <div className="flex flex-col gap-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold">
                    {found.length > 0 ? 'We found your cameras' : 'Find your cameras'}
                  </h2>
                  <p className="text-muted-foreground mt-2 leading-relaxed text-sm">
                    {found.length > 0
                      ? <>EyeGila auto-discovered cameras on your network over <span className="inline-flex items-center gap-0.5">ONVIF<JargonTip term="onvif" /></span> and found <strong className="text-foreground">{found.length} cameras</strong>. Tick the ones to monitor, then add them all at once.</>
                      : <>Scan the local network to auto-detect <span className="inline-flex items-center gap-0.5">ONVIF<JargonTip term="onvif" /></span> cameras, or add one by <span className="inline-flex items-center gap-0.5">RTSP URL<JargonTip term="rtsp" /></span> below.</>
                    }
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  {/* Scan mode tabs */}
                  <div className="flex bg-muted/60 rounded-lg p-0.5 text-xs font-medium">
                    <span className="px-3 py-1.5 rounded-md bg-background text-foreground shadow-sm">ONVIF auto-scan</span>
                    <button
                      type="button"
                      onClick={() => setShowNvr(v => !v)}
                      className={cn('px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors', showNvr && 'bg-background text-foreground shadow-sm')}
                    >
                      IP range
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const el = document.getElementById('manual-rtsp-input');
                        el?.focus();
                      }}
                      className="px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Add by URL
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={scanNetwork}
                    disabled={scanning}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border bg-background text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors disabled:opacity-50"
                  >
                    {scanning
                      ? <Loader2 className="size-3 animate-spin" />
                      : <span className="size-2 rounded-full bg-emerald-500" />}
                    {scanning ? 'Scanning…' : 'Re-scan network'}
                  </button>
                </div>
              </div>

              {scanning && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono -mt-1">
                  <span className="inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {scanStatus}
                </div>
              )}

              {/* Initial scan CTA (before any cameras found) */}
              {found.length === 0 && !scanning && (
                <Button onClick={scanNetwork} disabled={scanning} className="w-full sm:w-auto" size="lg">
                  <ScanSearch className="size-4 mr-2" />
                  Scan network
                </Button>
              )}

              {/* NVR / IP range form */}
              {showNvr && (
                <div className="rounded-lg border border-border bg-muted/30 p-4 flex flex-col gap-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-3 sm:col-span-1 flex flex-col gap-1">
                      <Label className="text-xs">NVR IP</Label>
                      <Input
                        placeholder="192.168.1.100"
                        value={nvrHost}
                        onChange={e => setNvrHost(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Username</Label>
                      <Input
                        placeholder="admin"
                        value={nvrUser}
                        onChange={e => setNvrUser(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Password</Label>
                      <Input
                        type="password"
                        value={nvrPass}
                        onChange={e => setNvrPass(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                  <Button size="sm" onClick={scanNvr} disabled={nvrScanning || !nvrHost} className="w-fit">
                    {nvrScanning ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Server className="size-3.5 mr-1.5" />}
                    Scan NVR
                  </Button>
                </div>
              )}

              {/* Found cameras */}
              {found.length > 0 && (
                <div className="flex flex-col gap-3">
                  {/* Select all + search */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const allNewSelected = found.filter(f => !f.alreadyAdded && !f.needsPassword).every(f => f.selected);
                        setFound(prev => prev.map(f => (f.alreadyAdded || f.needsPassword) ? f : { ...f, selected: !allNewSelected }));
                      }}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted/50 transition-colors shrink-0"
                    >
                      <span className="size-5 rounded-md bg-primary flex items-center justify-center shrink-0">
                        <Check className="size-3 text-primary-foreground" />
                      </span>
                      Select all new ({newCameraCount})
                    </button>
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                      <input
                        type="text"
                        placeholder="Search by name or IP address"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 rounded-lg border border-border text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                  </div>

                  {/* Cameras needing password - amber banner */}
                  {found.some(f => f.needsPassword) && (
                    <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
                      <span className="size-7 rounded-lg bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400 flex items-center justify-center font-black text-sm shrink-0">!</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                          {found.filter(f => f.needsPassword).length} cameras need a password
                        </div>
                        <div className="text-xs text-amber-700/70 dark:text-amber-400/70 mt-0.5">
                          Most sites use the same login. Enter it once and we will try it on all of them.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowPasswordDialog(true)}
                        className="shrink-0 h-8 px-3.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 transition-colors"
                      >
                        Enter password
                      </button>
                    </div>
                  )}

                  {/* Camera list */}
                  <div className="rounded-xl border border-border overflow-hidden">
                    <div className="max-h-[300px] overflow-y-auto">
                      {found
                        .filter(cam => !searchQuery || cam.address.toLowerCase().includes(searchQuery.toLowerCase()) || cam.rtsp_url.toLowerCase().includes(searchQuery.toLowerCase()))
                        .map(cam => {
                          const isDisabled = !!cam.alreadyAdded || !!cam.needsPassword;
                          return (
                            <label
                              key={cam.key}
                              className={cn(
                                'flex items-center gap-3 px-4 py-[11px] border-b border-border last:border-0 transition-colors',
                                isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-muted/20',
                                cam.alreadyAdded && 'opacity-60',
                                cam.selected && !isDisabled && 'bg-primary/5',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={cam.selected}
                                disabled={isDisabled}
                                onChange={() => !isDisabled && toggleCamera(cam.key)}
                                className="sr-only"
                              />
                              <span className={cn(
                                'size-[19px] rounded-md flex items-center justify-center shrink-0 transition-colors',
                                cam.selected && !isDisabled
                                  ? 'bg-primary border border-primary'
                                  : cam.needsPassword
                                  ? 'border-[1.5px] border-amber-400 bg-background'
                                  : 'border border-input bg-background',
                              )}>
                                {cam.selected && !isDisabled && <Check className="size-3 text-primary-foreground" />}
                              </span>
                              <div
                                className="w-11 h-[30px] rounded-md flex-none"
                                style={{
                                  background: cam.alreadyAdded
                                    ? 'oklch(0.9 0.008 145)'
                                    : 'repeating-linear-gradient(135deg,#374151 0,#374151 5px,#4b5563 5px,#4b5563 10px)',
                                }}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-semibold text-foreground truncate">{cam.address}</div>
                                <div className="text-[11px] text-muted-foreground truncate" style={{ fontFamily: "'Space Grotesk', monospace" }}>
                                  {cam.rtsp_url}
                                </div>
                              </div>
                              <span className={cn(
                                'shrink-0 text-[11px] font-semibold',
                                cam.alreadyAdded ? 'text-muted-foreground' :
                                cam.needsPassword ? 'text-amber-600 dark:text-amber-400' :
                                'text-emerald-700 dark:text-emerald-400',
                              )}>
                                {cam.alreadyAdded ? 'Already added' : cam.needsPassword ? 'Needs password' : 'New'}
                              </span>
                            </label>
                          );
                        })}
                    </div>
                  </div>
                </div>
              )}

              {/* Manual entry */}
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">Or add a camera by RTSP URL directly:</p>
                <div className="flex gap-2">
                  <Input
                    id="manual-rtsp-input"
                    placeholder="rtsp://192.168.1.200:554/stream1"
                    value={manualUrl}
                    onChange={e => setManualUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addManual()}
                    className="font-mono text-sm"
                  />
                  <Button variant="outline" onClick={addManual} disabled={!manualUrl.trim()}>
                    <Plus className="size-4" />
                  </Button>
                </div>
              </div>

              {/* Auto-group toggle */}
              {(() => {
                const groupable = detectIpGroups(found.filter(f => f.selected).map(f => ({ key: f.key, address: f.address })));
                if (groupable.length === 0) return null;
                return (
                  <label className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useBulkGroup}
                      onChange={e => setUseBulkGroup(e.target.checked)}
                      className="mt-0.5 accent-primary"
                    />
                    <div className="flex flex-col gap-0.5 text-xs">
                      <span className="font-semibold">Auto-group by IP block of 4</span>
                      <span className="text-muted-foreground">
                        Selected cameras form {groupable.length} contiguous block{groupable.length === 1 ? '' : 's'} of 4 -
                        we'll create {groupable.length} intersection{groupable.length === 1 ? '' : 's'} in one step.
                        Uncheck to import as a single intersection.
                      </span>
                    </div>
                  </label>
                );
              })()}

              {selectedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {selectedCount} camera{selectedCount !== 1 ? 's' : ''} selected - click Next to continue.
                </p>
              )}

              {/* Batch password dialog (T6c) */}
              {showPasswordDialog && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center">
                  <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShowPasswordDialog(false)} />
                  <div className="relative w-[480px] bg-background rounded-2xl border border-border shadow-2xl overflow-hidden">
                    <div className="px-6 pt-6 pb-5">
                      <div className="flex items-start justify-between">
                        <span className="size-10 rounded-xl bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400 flex items-center justify-center font-black text-lg shrink-0">!</span>
                        <button type="button" onClick={() => setShowPasswordDialog(false)} className="text-muted-foreground hover:text-foreground">
                          <X className="size-5" />
                        </button>
                      </div>
                      <h2 className="mt-4 text-xl font-bold tracking-tight">Enter camera login</h2>
                      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                        {found.filter(f => f.needsPassword).length} cameras are password-protected. Most sites use the same login everywhere, so type it once and we will try it on all of them.
                      </p>
                    </div>
                    <div className="px-6 flex flex-col gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs font-semibold">Username</Label>
                        <Input value={batchUsername} onChange={e => setBatchUsername(e.target.value)} className="h-10" />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs font-semibold">Password</Label>
                        <Input type="password" value={batchPassword} onChange={e => setBatchPassword(e.target.value)} className="h-10" />
                      </div>
                      <div className="rounded-xl border border-border overflow-hidden mt-1">
                        <div className="px-3 py-2 bg-muted/40 text-[11px] font-semibold text-muted-foreground">
                          Will be tried on {found.filter(f => f.needsPassword).length} cameras
                        </div>
                        {found.filter(f => f.needsPassword).map(cam => (
                          <div key={cam.key} className="flex items-center gap-3 px-3 py-2.5 border-t border-border">
                            <div className="w-9 h-6 rounded flex-none" style={{ background: 'repeating-linear-gradient(135deg,#374151 0,#374151 5px,#4b5563 5px,#4b5563 10px)' }} />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-semibold text-foreground truncate">{cam.address}</div>
                            </div>
                            <span className="text-[11px] font-semibold text-amber-600">Locked</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 px-6 py-4 mt-3 border-t border-border">
                      <Button variant="outline" onClick={() => setShowPasswordDialog(false)}>Cancel</Button>
                      <div className="flex-1" />
                      <Button
                        onClick={() => {
                          setFound(prev => prev.map(f => f.needsPassword ? { ...f, needsPassword: false, selected: true } : f));
                          setShowPasswordDialog(false);
                          toast.success('Password applied - cameras unlocked');
                        }}
                        disabled={!batchPassword}
                      >
                        Try login on {found.filter(f => f.needsPassword).length} cameras
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Group by IP ─────────────────────────────────────────────────── */}
          {stepId === 'group' && (
            <div className="flex flex-col gap-5">
              <div>
                <h2 className="text-2xl font-semibold">Group cameras into intersections</h2>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                  Each intersection has four approaches. EyeGila already grouped nearby cameras by IP block - just check the names are right and confirm the directions.
                </p>
              </div>

              <div className="flex flex-col gap-4">
                {groups.map((g, gi) => {
                  const cams = g.cameraKeys
                    .map(k => found.find(f => f.key === k))
                    .filter((c): c is FoundCamera => !!c);
                  const directions = GROUP_DIRECTION_ORDER;
                  const APPROACH_COLORS: Record<string, string> = {
                    northbound: 'oklch(0.55 0.14 150)',
                    eastbound:  'oklch(0.68 0.15 70)',
                    southbound: 'oklch(0.65 0.12 200)',
                    westbound:  'oklch(0.62 0.14 280)',
                  };
                  const APPROACH_LABELS: Record<string, string> = {
                    northbound: 'N', eastbound: 'E', southbound: 'S', westbound: 'W',
                  };
                  return (
                    <div key={g.key} className="rounded-xl border border-border bg-card overflow-hidden">
                      {/* Name area */}
                      <div className="px-4 pt-4 pb-3 border-b border-border">
                        <div className="flex items-center gap-2 mb-2.5">
                          {/* New / Assign to existing toggle */}
                          <div className="flex bg-muted/60 rounded-md p-0.5 text-xs">
                            <span className="px-2.5 py-1 rounded bg-background text-foreground font-semibold shadow-sm">New intersection</span>
                            <span className="px-2.5 py-1 text-muted-foreground font-medium">Assign to existing</span>
                          </div>
                          <div className="flex-1" />
                          <button
                            type="button"
                            onClick={() => setGroups(prev => prev.filter((_, i) => i !== gi))}
                            className="text-[11px] text-muted-foreground hover:text-destructive inline-flex items-center gap-1"
                            title="Skip this group"
                          >
                            <X className="size-3" /> Skip
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold text-muted-foreground shrink-0">Name</span>
                          <Input
                            value={g.name}
                            onChange={e => setGroups(prev => prev.map((x, i) => i === gi ? { ...x, name: e.target.value } : x))}
                            placeholder={`Intersection ${gi + 1}`}
                            className="h-8 text-[12.5px] font-semibold flex-1"
                          />
                        </div>
                        <p className="text-[10.5px] text-muted-foreground mt-1.5">
                          Name suggested from IP block. Prefer an intersection you already made? Switch to <strong className="text-primary font-semibold">Assign to existing</strong>.
                        </p>
                      </div>

                      {/* Diagram + approach rows */}
                      <div className="flex gap-4 p-4">
                        {/* Mini intersection diagram */}
                        <div className="shrink-0">
                          <div className="relative size-[100px] rounded-xl overflow-hidden border border-border bg-muted/20">
                            {/* Road lanes */}
                            <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-7 bg-muted/50" />
                            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-7 bg-muted/50" />
                            {/* Approach dots */}
                            <span className="absolute top-2 left-1/2 -translate-x-1/2 size-3 rounded-full border-2 border-white" style={{ background: cams[0] ? APPROACH_COLORS.northbound : 'oklch(0.82 0.012 145)' }} />
                            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 size-3 rounded-full border-2 border-white" style={{ background: cams[1] ? APPROACH_COLORS.southbound : 'oklch(0.82 0.012 145)' }} />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 size-3 rounded-full border-2 border-white" style={{ background: cams[2] ? APPROACH_COLORS.eastbound : 'oklch(0.82 0.012 145)' }} />
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 size-3 rounded-full border-2 border-white" style={{ background: cams[3] ? APPROACH_COLORS.westbound : 'oklch(0.82 0.012 145)' }} />
                          </div>
                        </div>

                        {/* Approach rows */}
                        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                          {directions.map((dir, i) => {
                            const cam = cams[i];
                            const label = APPROACH_LABELS[dir] ?? dir[0].toUpperCase();
                            const color = APPROACH_COLORS[dir] ?? 'oklch(0.65 0.05 200)';
                            const emptyColor = 'oklch(0.88 0.012 145)';
                            return (
                              <div
                                key={dir}
                                className={cn(
                                  'flex items-center gap-2.5 px-3 py-2 rounded-lg border',
                                  cam ? 'border-primary/20 bg-primary/5' : 'border-dashed border-border',
                                )}
                              >
                                <span
                                  className="size-[26px] rounded-lg flex items-center justify-center font-bold text-xs shrink-0"
                                  style={{ background: cam ? color : emptyColor, color: cam ? '#fff' : 'oklch(0.55 0.02 200)' }}
                                >
                                  {label}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className={cn('text-[12px] font-semibold capitalize', cam ? 'text-foreground' : 'text-foreground/70')}>
                                    {dir.replace('bound', 'bound')}
                                  </div>
                                  {cam ? (
                                    <div className="text-[10.5px] text-muted-foreground truncate" style={{ fontFamily: "'Space Grotesk', monospace" }}>{cam.address}</div>
                                  ) : (
                                    <div className="text-[10.5px] text-muted-foreground">Drop a camera here</div>
                                  )}
                                </div>
                                {!cam && (
                                  <span className="text-[11px] font-semibold text-primary shrink-0">+ Assign</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {groups.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No groups to import. Click Back to revisit camera selection.
                </p>
              )}

              {creating && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Creating {groups.length} intersections…
                </div>
              )}
            </div>
          )}

          {/* ── Name ────────────────────────────────────────────────────────── */}
          {stepId === 'name' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Name your intersection</h2>
                <p className="text-muted-foreground mt-2">
                  Give the intersection a name (e.g. "Magugpo Junction") and pin its location
                  on the map so reports are tied to the right place.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inter-name" className="text-sm font-medium">Intersection name</Label>
                <Input
                  id="inter-name"
                  autoFocus
                  autoComplete="off"
                  placeholder="e.g. Magugpo Junction, City Hall…"
                  value={interName}
                  onChange={e => setInterName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !busy && handleNext()}
                  className="text-base h-11"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">
                  Pin the location on the map (optional - click to place):
                </p>
                <div
                  className="rounded-lg overflow-hidden border border-border"
                  style={{ height: 240, isolation: 'isolate' }}
                >
                  <MapContainer
                    center={lat && lng ? [parseFloat(lat), parseFloat(lng)] : TAGUM_CENTER}
                    zoom={14}
                    style={{ height: '100%' }}
                  >
                    <TileLayer
                      attribution="&copy; OpenStreetMap"
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <MapClickPicker onPick={(la, lo) => {
                      setLat(la.toFixed(6));
                      setLng(lo.toFixed(6));
                    }} />
                    {lat && lng && <Marker position={[parseFloat(lat), parseFloat(lng)]} />}
                  </MapContainer>
                </div>
                {lat && lng && (
                  <p className="text-xs text-muted-foreground font-mono">{lat}, {lng}</p>
                )}
              </div>
            </div>
          )}

          {/* ── Assign ──────────────────────────────────────────────────────── */}
          {stepId === 'assign' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Assign approach directions</h2>
                <p className="text-muted-foreground mt-2">
                  Tell the system which direction each camera faces - Northbound, Southbound,
                  Eastbound, or Westbound. This determines how volumes are reported per approach.
                </p>
              </div>

              <div className="flex flex-col gap-3">
                {cameras.map((cam, i) => (
                  <div
                    key={cam.key}
                    className="rounded-lg border border-border bg-muted/20 p-4 flex flex-col gap-3"
                  >
                    <p className="text-xs text-muted-foreground font-mono truncate">{cam.rtsp_url}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs">Camera name</Label>
                        <Input
                          value={cam.name}
                          onChange={e => updateCameraField(cam.key, 'name', e.target.value)}
                          placeholder={`Camera ${i + 1}`}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs">Approach direction</Label>
                        <Select
                          value={cam.direction}
                          onValueChange={v => updateCameraField(cam.key, 'direction', v)}
                        >
                          <SelectTrigger className="h-8 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DIRECTIONS.map(d => (
                              <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {creating && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Creating intersection and cameras…
                </div>
              )}
            </div>
          )}

          {/* ── Regions ─────────────────────────────────────────────────────── */}
          {stepId === 'regions' && !regionsMinimized && (() => {
            const allDone = regionCams.length > 0 && regionCams.every(c => c.hasRegions);
            const pendingCount = regionCams.filter(c => !c.hasRegions).length;
            return (
              <div className="flex flex-col gap-6">
                <div>
                  <h2 className="text-2xl font-semibold">Draw detection regions</h2>
                  <p className="text-muted-foreground mt-2">
                    Open each camera below and draw a counting polygon on the live video frame.
                    Click the first point again (green dot) to close the polygon and save the region.
                    You can skip this step and finish later from the Cameras page.
                  </p>
                </div>

                {allDone ? (
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400 font-medium">
                    All cameras have regions - ready to continue.
                  </div>
                ) : regionCams.length > 0 && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
                    {pendingCount} of {regionCams.length} cameras don't have regions yet.
                    Counts from those will be ignored until you draw one - you can come back to it later.
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {regionLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                      <Loader2 className="size-4 animate-spin" />
                      Loading cameras…
                    </div>
                  ) : regionCams.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4">
                      No cameras found. Go back and complete the camera setup steps.
                    </p>
                  ) : (
                    regionCams.map(cam => (
                      <div
                        key={cam.id}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border p-3',
                          cam.hasRegions
                            ? 'border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20'
                            : 'border-border bg-muted/20',
                        )}
                      >
                        <div
                          className={cn(
                            'size-7 rounded-full flex items-center justify-center shrink-0',
                            cam.hasRegions ? 'bg-emerald-500/20' : 'bg-muted',
                          )}
                        >
                          {cam.hasRegions
                            ? <Check className="size-4 text-emerald-600" />
                            : <span className="text-xs text-muted-foreground">○</span>}
                        </div>
                        <span className={cn(
                          'text-sm flex-1 truncate',
                          cam.hasRegions ? 'text-emerald-700 dark:text-emerald-400 font-medium' : '',
                        )}>
                          {cam.name}
                        </span>
                        <Button size="sm" variant={cam.hasRegions ? 'outline' : 'default'} asChild>
                          <Link to={`/intersections/${createdIntersectionId}/cameras/${cam.id}`}>
                            {cam.hasRegions ? 'Re-draw' : 'Open camera'}
                            <ExternalLink className="size-3 ml-1.5" />
                          </Link>
                        </Button>
                      </div>
                    ))
                  )}
                </div>

                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => regionTargetId != null && loadRegionStatus(regionTargetId)}
                    disabled={regionLoading}
                  >
                    {regionLoading ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="size-3.5 mr-1.5" />}
                    Refresh status
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setRegionsMinimized(true)}>
                    Minimize to corner
                  </Button>
                  {/* Explicit "Skip for now" - dropping this step doesn't
                      block detection, only the counting-polygon filter, so
                      the operator can safely defer it without losing data. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => goTo('collecting')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Skip for now
                    <ArrowRight className="size-3.5 ml-1" />
                  </Button>
                  <span className="ml-auto">
                    Opening a camera leaves the wizard running - come back here to continue.
                  </span>
                </div>
              </div>
            );
          })()}

          {/* ── Collecting ───────────────────────────────────────────────────── */}
          {stepId === 'collecting' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Cameras are collecting data</h2>
                <p className="text-muted-foreground mt-2">
                  Your cameras are now counting vehicles. The system needs at least 8 qualifying
                  hours of data to run a MUTCD warrant analysis and generate timing recommendations.
                </p>
                {/* Bridge for the two skipped steps. Both regions and existing
                    signal timing have new homes; the operator doesn't have to
                    come back to this wizard for either. */}
                <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                  <strong className="text-foreground">Next steps you can take on your own:</strong>
                  <br />
                  · Open the Cameras page to draw counting polygons on any camera you skipped.
                  <br />
                  · Open the intersection and click the Settings cog to enter the existing signal
                  {' '}cycle length and green splits (needed for the &quot;before&quot; comparison).
                </p>
              </div>

              {collectingLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Checking status…
                </div>
              ) : collectingHasRec ? (
                /* Results are ready */
                <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-6 flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <div className="size-10 rounded-full bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center shrink-0">
                      <BarChart3 className="size-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                        Analysis results are ready
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Warrant analysis has been generated for this intersection.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="self-start"
                    onClick={() => {
                      handleClose();
                      navigate('/');
                    }}
                  >
                    View results on Intersections page
                    <ArrowRight className="size-4 ml-2" />
                  </Button>
                </div>
              ) : (
                /* Still collecting */
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/20 p-6 flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <div className="size-10 rounded-full bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center shrink-0 animate-pulse">
                      <Wifi className="size-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300 text-sm">
                        Detection is running in the background
                      </p>
                      {collectingLastDetection ? (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Last detection: {new Date(collectingLastDetection).toLocaleString()}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          No detections recorded yet - check camera feeds are live.
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Come back after 8+ hours of traffic. Then go to the Intersections page
                    and click <strong>Run analysis</strong> to generate warrant results and
                    timing recommendations.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (collectingTargetId != null) {
                          // Re-check status
                          setCollectingLoading(true);
                          Promise.all([
                            recommendationsApi.list(),
                            recommendationsApi.dataHealth(collectingTargetId).catch(() => null),
                          ]).then(([recs, health]) => {
                            setCollectingHasRec(recs.some(r => r.intersection_id === collectingTargetId));
                            setCollectingLastDetection(health?.last_detection_at ?? null);
                          }).catch(() => {}).finally(() => setCollectingLoading(false));
                        }
                      }}
                    >
                      <RefreshCw className="size-3 mr-1.5" />
                      Refresh status
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        handleClose();
                        navigate('/');
                      }}
                    >
                      Go to Intersections
                      <ExternalLink className="size-3 ml-1.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          </div>
        </div>
      </div>

      {/* Footer navigation */}
      <div className="flex items-center justify-between px-8 py-4 border-t border-border shrink-0">
        <Button
          variant="outline"
          // Back skips 'group' when the operator is on the single-intersection
          // path (groups never populated) so they land back at Discover, not
          // an empty group screen.
          onClick={() => {
            if (!canGoBack) return;
            let prev = stepIndex - 1;
            if (WIZARD_STEPS[prev]?.id === 'group' && groups.length === 0) prev -= 1;
            if (prev >= 0) goTo(WIZARD_STEPS[prev].id);
          }}
          disabled={!canGoBack || busy}
        >
          <ArrowLeft className="size-4 mr-2" />
          Back
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {stepId === 'discover' && selectedCount > 0 && (
            <><strong className="text-foreground">{selectedCount}</strong> camera{selectedCount !== 1 ? 's' : ''} selected</>
          )}
        </span>
        {isLast ? (
          <Button onClick={handleClose} disabled={busy}>
            Finish
          </Button>
        ) : stepId === 'discover' && selectedCount > 0 ? (
          <Button onClick={handleNext} disabled={busy}>
            {creating ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
            Add {selectedCount} camera{selectedCount !== 1 ? 's' : ''}
            <ArrowRight className="size-4 ml-2" />
          </Button>
        ) : (
          <Button onClick={handleNext} disabled={busy}>
            {creating ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
            Next
            <ArrowRight className="size-4 ml-2" />
          </Button>
        )}
      </div>
    </div>
  );
}
