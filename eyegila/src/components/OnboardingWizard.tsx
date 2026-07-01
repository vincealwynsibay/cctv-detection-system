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
  X, ArrowRight, ArrowLeft, Check,
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
  { id: 'welcome',    label: 'Preview'       },
  { id: 'discover',  label: 'Find cameras'  },
  { id: 'group',     label: 'Group by IP'   },
  { id: 'name',      label: 'Name & pin'    },
  { id: 'assign',    label: 'Directions'    },
  { id: 'regions',   label: 'Draw regions'  },
  { id: 'timing',    label: 'Enter timing'  },
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
        const runLen = i - runStart;
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
  const [stepId, setStepId]   = useState<WizardStepId>('welcome');
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
  const [timingTargetId, setTimingTargetId]       = useState<number | null>(null);
  const [timingApproaches, setTimingApproaches]   = useState<string[]>([]);
  const [timingStatus, setTimingStatus]           = useState<'unsignalized' | 'fixed_time' | 'actuated'>('fixed_time');
  const [timingCycle, setTimingCycle]             = useState('90');
  const [timingGreenSplits, setTimingGreenSplits] = useState<Record<string, string>>({});
  const [timingLoading, setTimingLoading]         = useState(false);

  // ── Collecting step state ──────────────────────────────────────────────────
  const [collectingTargetId, setCollectingTargetId]         = useState<number | null>(null);
  const [collectingHasRec, setCollectingHasRec]             = useState(false);
  const [collectingLastDetection, setCollectingLastDetection] = useState<string | null>(null);
  const [collectingLoading, setCollectingLoading]           = useState(false);

  useEffect(() => {
    if (open) {
      setStepId(isValidStepId(initialStep) ? initialStep : 'welcome');
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

  // Initialise timing step when entering it
  useEffect(() => {
    if (!open || stepId !== 'timing') return;

    async function initTiming() {
      setTimingLoading(true);
      try {
        let targetId = createdIntersectionId;
        if (targetId == null) {
          const inters = await intersectionsApi.list();
          if (inters.length > 0) {
            targetId = inters.sort((a, b) => b.time.localeCompare(a.time))[0].id;
          }
        }
        if (targetId == null) return;
        setTimingTargetId(targetId);

        const [inter, streets] = await Promise.all([
          intersectionsApi.get(targetId),
          streetsApi.list(),
        ]);

        const approachDirs = streets
          .filter(s => s.intersection_id === targetId && s.arm_direction !== 'unknown')
          .map(s => s.arm_direction);
        const approaches = [...new Set(approachDirs)];
        setTimingApproaches(approaches);

        if (inter.signal_status) setTimingStatus(inter.signal_status);
        const cycle = inter.existing_cycle_length ?? 90;
        setTimingCycle(String(cycle));

        const defaultGreen = Math.round(cycle / Math.max(approaches.length, 1));
        const splits: Record<string, string> = {};
        for (const dir of approaches) {
          splits[dir] = inter.existing_green_splits?.[dir] != null
            ? String(inter.existing_green_splits[dir])
            : String(defaultGreen);
        }
        setTimingGreenSplits(splits);
      } catch {
        toast.error('Failed to load intersection data');
      } finally {
        setTimingLoading(false);
      }
    }

    initTiming();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepId]);

  // Initialise collecting step when entering it
  useEffect(() => {
    if (!open || stepId !== 'collecting') return;

    async function initCollecting() {
      setCollectingLoading(true);
      try {
        let targetId = createdIntersectionId ?? timingTargetId ?? regionTargetId;
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
          .filter(r => !existingKeys.has(r.address) && !existingRtsp.has(r.rtsp_url ?? ''))
          .map((r, i) => ({
            key:      `onvif-${r.address}-${i}`,
            address:  r.address,
            rtsp_url: r.rtsp_url ?? `rtsp://${r.address}:554/stream1`,
            selected: true,
          }));
        if (fresh.length === 0 && results.length > 0) {
          toast.info('All discovered cameras are already in the system.');
        } else if (fresh.length > 0) {
          toast.success(`Found ${fresh.length} new camera${fresh.length === 1 ? '' : 's'}`);
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

  function updateRtsp(key: string, url: string) {
    setFound(prev => prev.map(f => f.key === key ? { ...f, rtsp_url: url } : f));
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
      const selected = found.filter(f => f.selected);
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
      const selected = found.filter(f => f.selected);
      setCameras(selected.map((f, i) => ({
        key:       f.key,
        rtsp_url:  f.rtsp_url,
        name:      `Camera ${i + 1}`,
        direction: DEFAULT_DIR_ORDER[i] ?? 'unknown',
      })));
      await goTo(nextStep);
    } else if (stepId === 'assign') {
      await createIntersectionAndAdvance();
    } else if (stepId === 'timing') {
      if (timingTargetId == null) { toast.error('No intersection found'); return; }
      const cycle = timingStatus !== 'unsignalized' ? parseInt(timingCycle) || null : null;
      const splits: Record<string, number> | null =
        timingStatus !== 'unsignalized' && cycle != null
          ? Object.fromEntries(
              Object.entries(timingGreenSplits).map(([k, v]) => [k, parseInt(v) || 0]),
            )
          : null;
      setCreating(true);
      try {
        await intersectionsApi.patchTiming(timingTargetId, {
          signal_status: timingStatus,
          existing_cycle_length: cycle,
          existing_green_splits: splits,
        });
        await goTo(nextStep);
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : 'Failed to save timing');
      } finally {
        setCreating(false);
      }
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

        {/* Step pill */}
        <div className="px-4 pt-3 pb-0">
          <span className="text-[11px] text-muted-foreground font-medium">Step {stepIndex + 1} of {WIZARD_STEPS.length}</span>
        </div>

        {/* Instructions */}
        <p className="px-4 py-2 text-xs text-muted-foreground leading-relaxed">
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
            {regionCams.filter(c => !c.hasRegions).length} of {regionCams.length} cameras don’t have regions yet -
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
  const selectedCount = found.filter(f => f.selected).length;
  const busy         = saving || creating;

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="EyeGila" className="size-7 rounded-md object-contain" />
          <span className="font-bold text-lg tracking-tight">EyeGila Setup</span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Close wizard - progress is saved"
        >
          <X className="size-5" />
        </button>
      </div>

      {/* Step indicators.
          'group' is hidden from the indicator unless the operator is actually
          on the bulk track - single-intersection users shouldn't see a step
          they will never visit. */}
      <div className="flex items-center justify-center gap-0.5 px-8 py-3 border-b border-border overflow-x-auto shrink-0">
        {WIZARD_STEPS.filter(s => s.id !== 'group' || stepId === 'group' || stepId === 'collecting' && groups.length > 0).map((step, idx, visible) => {
          const isCurrent = step.id === stepId;
          const isDone    = WIZARD_STEPS.findIndex(s => s.id === step.id) < stepIndex;
          return (
            <div key={step.id} className="flex items-center shrink-0">
              <div className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all select-none',
                isCurrent && 'bg-primary text-primary-foreground',
                isDone    && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
                !isCurrent && !isDone && 'text-muted-foreground',
              )}>
                <span className={cn(
                  'flex items-center justify-center size-4 rounded-full text-[10px] font-bold shrink-0',
                  isCurrent && 'bg-white/20',
                  isDone    && 'bg-emerald-500/20',
                  !isCurrent && !isDone && 'bg-muted/60',
                )}>
                  {isDone ? <Check className="size-2.5" /> : idx + 1}
                </span>
                <span className="hidden sm:inline">{step.label}</span>
              </div>
              {idx < visible.length - 1 && (
                <div className={cn('h-px w-3 shrink-0', isDone ? 'bg-emerald-400/40' : 'bg-border')} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-10">

          {/* ── Welcome ─────────────────────────────────────────────────────── */}
          {stepId === 'welcome' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Welcome to EyeGila</h2>
                <p className="text-muted-foreground mt-2">
                  This wizard guides you through setting up traffic monitoring. Below is a preview
                  of the warrant evidence chart, timing comparison, and simulation you'll see once
                  your cameras are collecting data.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-muted/30 p-12 flex flex-col items-center gap-4 text-center">
                <p className="text-sm text-muted-foreground">
                  Demo preview will appear here once warrant chart (Issue #7), timing comparison
                  (Issue #8), and simulation (Issue #9) are implemented.
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                Click <strong>Next</strong> to start connecting your cameras.
              </p>
            </div>
          )}

          {/* ── Discover ─────────────────────────────────────────────────────── */}
          {stepId === 'discover' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Find your cameras</h2>
                <p className="text-muted-foreground mt-2 inline-flex items-center gap-1 flex-wrap">
                  Scan the local network for <span className="inline-flex items-center gap-0.5">ONVIF<JargonTip term="onvif" /></span>
                  cameras, query an <span className="inline-flex items-center gap-0.5">NVR/DVR<JargonTip term="nvr" /></span>,
                  or add a camera by pasting its <span className="inline-flex items-center gap-0.5">RTSP URL<JargonTip term="rtsp" /></span> directly.
                </p>
              </div>

              {/* ONVIF scan */}
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Scan the local network for ONVIF cameras (takes ~3 seconds).
                </p>
                <Button
                  onClick={scanNetwork}
                  disabled={scanning}
                  className="w-full sm:w-auto"
                  size="lg"
                >
                  {scanning
                    ? <Loader2 className="size-4 mr-2 animate-spin" />
                    : <ScanSearch className="size-4 mr-2" />}
                  {scanning ? 'Scanning network…' : 'Scan Network'}
                </Button>
                {scanning && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                    <span className="inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    {scanStatus}
                  </div>
                )}
              </div>

              {/* NVR scan toggle */}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
                  onClick={() => setShowNvr(v => !v)}
                >
                  <Server className="size-3.5" />
                  {showNvr ? 'Hide NVR form' : 'Scan NVR / DVR instead'}
                </button>
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
                    <Button
                      size="sm"
                      onClick={scanNvr}
                      disabled={nvrScanning || !nvrHost}
                      className="w-fit"
                    >
                      {nvrScanning
                        ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        : <Server className="size-3.5 mr-1.5" />}
                      Scan NVR
                    </Button>
                  </div>
                )}
              </div>

              {/* Found cameras list */}
              {found.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {found.length} camera{found.length !== 1 ? 's' : ''} found - select which to add
                  </p>
                  <div className="flex flex-col gap-2">
                    {found.map(cam => (
                      <label
                        key={cam.key}
                        className={cn(
                          'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                          cam.selected
                            ? 'border-primary/60 bg-primary/5'
                            : 'border-border bg-muted/20',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={cam.selected}
                          onChange={() => toggleCamera(cam.key)}
                          className="mt-0.5 accent-primary"
                        />
                        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                          <div className="flex items-center gap-2">
                            <Wifi className="size-3.5 text-emerald-500 shrink-0" />
                            <span className="text-sm font-medium truncate">{cam.address}</span>
                          </div>
                          <Input
                            value={cam.rtsp_url}
                            onChange={e => updateRtsp(cam.key, e.target.value)}
                            onClick={e => e.stopPropagation()}
                            placeholder="rtsp://..."
                            className="h-7 text-xs font-mono"
                          />
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Manual entry */}
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">Or add a camera by RTSP URL directly:</p>
                <div className="flex gap-2">
                  <Input
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

              {/* Auto-group toggle - only meaningful when the scan returned
                  enough cameras to form at least one block of 4 in IP order.
                  Defaults on; the operator can turn it off for a single-
                  intersection import. */}
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
                      <span className="font-semibold">
                        Auto-group by IP block of 4
                      </span>
                      <span className="text-muted-foreground">
                        Selected cameras form {groupable.length} contiguous block{groupable.length === 1 ? '' : 's'} of 4 -
                        we’ll create {groupable.length} intersection{groupable.length === 1 ? '' : 's'} in one step.
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
            </div>
          )}

          {/* ── Group by IP ─────────────────────────────────────────────────── */}
          {stepId === 'group' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Confirm intersection groups</h2>
                <p className="text-muted-foreground mt-2">
                  We grouped your {found.filter(f => f.selected).length} cameras into{' '}
                  <strong>{groups.length} intersections</strong> by IP block of four
                  (e.g. .31/.32/.33/.34). Edit the names below if you like -
                  directions are pre-filled N → S → E → W in IP order. Drawing detection
                  regions and entering signal timing can be done afterwards from the
                  sidebar Setup Progress popover.
                </p>
              </div>

              <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-800 dark:text-amber-300">
                Already-imported cameras were filtered out on scan, so re-running this
                step is safe - only new groups will be created.
              </div>

              <div className="flex flex-col gap-3">
                {groups.map((g, gi) => {
                  const cams = g.cameraKeys
                    .map(k => found.find(f => f.key === k))
                    .filter((c): c is FoundCamera => !!c);
                  return (
                    <div key={g.key} className="rounded-lg border border-border bg-muted/20 p-4 flex flex-col gap-3">
                      <div className="flex items-center gap-3">
                        <span className="size-6 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center shrink-0">
                          {gi + 1}
                        </span>
                        <Input
                          value={g.name}
                          onChange={e => setGroups(prev => prev.map((x, i) => i === gi ? { ...x, name: e.target.value } : x))}
                          placeholder={`Intersection ${gi + 1}`}
                          className="h-8 text-sm flex-1"
                        />
                        <button
                          type="button"
                          onClick={() => setGroups(prev => prev.filter((_, i) => i !== gi))}
                          className="text-[11px] text-muted-foreground hover:text-destructive inline-flex items-center gap-1"
                          title="Skip this group (cameras stay in scan)"
                        >
                          <X className="size-3" /> Skip
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {cams.map((c, i) => (
                          <div key={c.key} className="rounded border border-border bg-background px-2 py-1.5 text-[11px]">
                            <div className="font-mono text-foreground">{c.address}</div>
                            <div className="text-muted-foreground uppercase tracking-wide text-[10px] mt-0.5">
                              {GROUP_DIRECTION_ORDER[i].replace('bound', '')}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {groups.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No groups left to import. Click Back to revisit Discover.
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
                    {pendingCount} of {regionCams.length} cameras don’t have regions yet.
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

                <div className="flex items-center gap-3 text-xs text-muted-foreground">
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
                  <span className="ml-auto">
                    Opening a camera leaves the wizard running - come back here to continue.
                  </span>
                </div>
              </div>
            );
          })()}

          {/* ── Timing ───────────────────────────────────────────────────── */}
          {stepId === 'timing' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Enter current signal timing</h2>
                <p className="text-muted-foreground mt-2">
                  Enter the existing signal cycle length and green time per approach.
                  The phase diagram updates live as you type.
                </p>
              </div>

              {timingLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <Loader2 className="size-4 animate-spin" />
                  Loading intersection data…
                </div>
              ) : (
                <>
                  {/* Signal status toggle */}
                  <div className="flex flex-col gap-2">
                    <Label className="inline-flex items-center gap-1">
                      Signal status <JargonTip term="signal_status" />
                    </Label>
                    <div className="flex gap-2 flex-wrap">
                      {(['unsignalized', 'fixed_time', 'actuated'] as const).map(s => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setTimingStatus(s)}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-sm border transition-colors',
                            timingStatus === s
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'border-border bg-background hover:bg-muted text-muted-foreground',
                          )}
                        >
                          {s === 'unsignalized' ? 'Unsignalized' : s === 'fixed_time' ? 'Fixed time' : 'Actuated'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {timingStatus !== 'unsignalized' && (
                    <>
                      {/* Cycle length */}
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="timing-cycle" className="inline-flex items-center gap-1">
                          Cycle length <JargonTip term="cycle_length" />
                        </Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id="timing-cycle"
                            type="number"
                            min={30}
                            max={300}
                            value={timingCycle}
                            onChange={e => setTimingCycle(e.target.value)}
                            className="w-28"
                          />
                          <span className="text-sm text-muted-foreground">seconds</span>
                        </div>
                      </div>

                      {/* Green splits table */}
                      {timingApproaches.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <Label className="inline-flex items-center gap-1">
                            Green time per approach <JargonTip term="green_split" />
                          </Label>
                          <div className="rounded-lg border border-border overflow-hidden">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="bg-muted/40 border-b border-border">
                                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Approach</th>
                                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Green (s)</th>
                                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">% of cycle</th>
                                </tr>
                              </thead>
                              <tbody>
                                {timingApproaches.map(dir => {
                                  const cycleN = parseInt(timingCycle) || 90;
                                  const green  = parseInt(timingGreenSplits[dir] ?? '0') || 0;
                                  const pct    = cycleN > 0 ? Math.round((green / cycleN) * 100) : 0;
                                  return (
                                    <tr key={dir} className="border-b border-border last:border-0">
                                      <td className="px-4 py-2 font-medium capitalize">
                                        {dir.replace('bound', '')}
                                      </td>
                                      <td className="px-4 py-2">
                                        <Input
                                          type="number"
                                          min={1}
                                          max={Math.max(1, (parseInt(timingCycle) || 90) - 3)}
                                          value={timingGreenSplits[dir] ?? ''}
                                          onChange={e => setTimingGreenSplits(prev => ({
                                            ...prev, [dir]: e.target.value,
                                          }))}
                                          className="h-7 w-20"
                                        />
                                      </td>
                                      <td className="px-4 py-2 text-muted-foreground tabular-nums">
                                        {pct}%
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* Live Gantt phase diagram */}
                      {timingApproaches.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <Label>Phase diagram</Label>
                          <div className="rounded-lg border border-border bg-muted/10 p-4 flex flex-col gap-2">
                            {timingApproaches.map(dir => {
                              const cycleN  = parseInt(timingCycle) || 90;
                              const yellowS = 3;
                              const greenS  = Math.min(
                                Math.max(0, parseInt(timingGreenSplits[dir] ?? '0') || 0),
                                cycleN - yellowS,
                              );
                              const redS    = Math.max(0, cycleN - greenS - yellowS);
                              const gPct    = (greenS  / cycleN) * 100;
                              const yPct    = (yellowS / cycleN) * 100;
                              const rPct    = (redS    / cycleN) * 100;
                              return (
                                <div key={dir} className="flex items-center gap-3">
                                  <span className="w-16 text-xs text-muted-foreground capitalize shrink-0 text-right">
                                    {dir.replace('bound', '')}
                                  </span>
                                  <div className="flex-1 flex h-7 rounded overflow-hidden text-[10px] font-medium">
                                    <div
                                      style={{ width: `${gPct}%` }}
                                      className="bg-emerald-500 flex items-center justify-center text-white shrink-0"
                                    >
                                      {greenS > 6 ? `${greenS}s` : ''}
                                    </div>
                                    <div
                                      style={{ width: `${yPct}%` }}
                                      className="bg-amber-400 shrink-0"
                                    />
                                    <div
                                      style={{ width: `${rPct}%` }}
                                      className="bg-rose-500/70 flex items-center justify-center text-white shrink-0"
                                    >
                                      {redS > 6 ? `${redS}s` : ''}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                            <div className="flex items-center gap-4 mt-1 pt-2 border-t border-border/50">
                              <div className="w-16 shrink-0" />
                              <div className="flex gap-4 text-[10px] text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <span className="inline-block size-2.5 rounded-sm bg-emerald-500" />Green
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="inline-block size-2.5 rounded-sm bg-amber-400" />Yellow (3s)
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="inline-block size-2.5 rounded-sm bg-rose-500/70" />Red
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {timingApproaches.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No approaches found. Complete the camera direction step first.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Collecting ───────────────────────────────────────────────────── */}
          {stepId === 'collecting' && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-2xl font-semibold">Cameras are collecting data</h2>
                <p className="text-muted-foreground mt-2">
                  Your cameras are now counting vehicles. The system needs at least 8 qualifying
                  hours of data to run a MUTCD warrant analysis and generate timing recommendations.
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
        <span className="text-xs text-muted-foreground">
          Step {stepIndex + 1} of {WIZARD_STEPS.length}
        </span>
        {isLast ? (
          <Button onClick={handleClose} disabled={busy}>
            Finish
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
