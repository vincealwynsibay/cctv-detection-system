import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { intersectionsApi, type DetectTimingResult } from '@/services/intersections';
import { simulationApi, type SimulationResponse } from '@/services/simulation';
import { selectPeakChunk } from '@/lib/simulation';
import { streetsApi } from '@/services/streets';
import { cctvsApi } from '@/services/cctvs';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import type { Intersection, Street, CCTV, SignalStatus } from '@/types';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Separator } from '@/components/ui/separator';
import {
  Plus, Trash2, WifiOff, RefreshCw, Loader2, ScanSearch, ExternalLink,
  TrendingUp, FileText,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Fix default marker icons broken by Vite's asset pipeline
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const DEFAULT_CENTER: [number, number] = [7.4478, 125.8075];

export const SIGNAL_STATUS_OPTIONS: { value: SignalStatus; label: string }[] = [
  { value: 'unsignalized', label: 'Unsignalized' },
  { value: 'fixed_time',   label: 'Fixed-time signal' },
  { value: 'actuated',     label: 'Actuated signal' },
];

export const DIRECTION_OPTIONS = [
  { value: 'northbound', label: 'Northbound' },
  { value: 'southbound', label: 'Southbound' },
  { value: 'eastbound',  label: 'Eastbound'  },
  { value: 'westbound',  label: 'Westbound'  },
  { value: 'unknown',    label: 'Unknown'     },
];

function ClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: e => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

function FlyToPin({ lat, lng }: { lat: number; lng: number }) {
  const map  = useMap();
  const prev = useRef<[number, number] | null>(null);
  useEffect(() => {
    if (!lat || !lng) return;
    const next: [number, number] = [lat, lng];
    if (!prev.current) { map.setView(next, 16); }
    prev.current = next;
  }, [lat, lng, map]);
  return null;
}

export function LocationPickerMap({ lat, lng, onPick }: { lat: string; lng: string; onPick: (lat: number, lng: number) => void }) {
  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const hasPin    = !isNaN(parsedLat) && !isNaN(parsedLng);
  const center: [number, number] = hasPin ? [parsedLat, parsedLng] : DEFAULT_CENTER;

  return (
    <div className="rounded-lg overflow-hidden border border-border" style={{ height: 200, isolation: 'isolate' }}>
      <MapContainer center={center} zoom={hasPin ? 16 : 14} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickHandler onPick={onPick} />
        {hasPin && (
          <>
            <FlyToPin lat={parsedLat} lng={parsedLng} />
            <Marker position={[parsedLat, parsedLng]} />
          </>
        )}
      </MapContainer>
    </div>
  );
}

export interface SettingsSheetProps {
  inter:    Intersection | null;
  streets:  Street[];
  cameras:  CCTV[];
  rec:      RecommendationResponse | null | undefined;
  open:     boolean;
  onClose:  () => void;
  onRefresh: () => void;
}

export function SettingsSheet({ inter, streets, cameras, rec, open, onClose, onRefresh }: SettingsSheetProps) {
  const [name, setName]   = useState('');
  const [lat, setLat]     = useState('');
  const [lng, setLng]     = useState('');
  const [signalStatus, setSignalStatus]   = useState<SignalStatus>('unsignalized');
  const [cycleLen, setCycleLen]           = useState('');
  const [splits, setSplits]               = useState<Record<number, string>>({});
  const [saving, setSaving]               = useState(false);
  // Auto-detect cycle length from camera feed.
  const [detectingTiming, setDetectingTiming] = useState(false);
  const [detectResult, setDetectResult]   = useState<DetectTimingResult | null>(null);
  // Peak chunk from the latest sim, used to populate the "Use recommendation"
  // shortcut. Fetched on-demand when the sheet opens and signalised.
  const [latestSim, setLatestSim]         = useState<SimulationResponse | null>(null);
  const [stagingDirs, setStagingDirs]   = useState<Record<number, string>>({});
  const [newCamName, setNewCamName]   = useState('');
  const [newCamRtsp, setNewCamRtsp]   = useState('');
  const [addingCam, setAddingCam]     = useState(false);
  const [addingStreet, setAddingStreet] = useState(false);
  const [newStreetName, setNewStreetName] = useState('');
  const [newStreetDir, setNewStreetDir]   = useState<string>('unknown');

  useEffect(() => {
    if (inter) {
      setName(inter.name);
      setLat(String(inter.latitude ?? ''));
      setLng(String(inter.longitude ?? ''));
      setSignalStatus(inter.signal_status ?? 'unsignalized');
      setCycleLen(inter.existing_cycle_length != null ? String(inter.existing_cycle_length) : '');
      // Pre-fill per-approach splits from the saved value (or evenly split
      // the cycle as a starting hint when no value is stored yet).
      const cycle = inter.existing_cycle_length ?? 90;
      const defaultGreen = Math.round(cycle / Math.max(streets.length, 1));
      const initSplits: Record<number, string> = {};
      for (const s of streets) {
        const stored = (inter.existing_green_splits as Record<string, number> | null)?.[String(s.id)];
        initSplits[s.id] = String(stored ?? defaultGreen);
      }
      setSplits(initSplits);
      setStagingDirs({});
      setDetectResult(null);
    }
  }, [inter, streets]);

  // Fetch latest sim once the sheet opens so the "Use recommendation"
  // shortcut has a Webster proposal to copy from. Skipped when the
  // intersection isn't signalised (nothing to apply).
  useEffect(() => {
    if (!inter || !open) return;
    const isSig = inter.signal_status === 'fixed_time' || inter.signal_status === 'actuated';
    if (!isSig) { setLatestSim(null); return; }
    simulationApi.get(inter.id).then(setLatestSim).catch(() => setLatestSim(null));
  }, [inter, open]);

  const hasUnsavedDirs = Object.keys(stagingDirs).length > 0;

  async function saveAll() {
    if (!inter || !name.trim()) return;
    setSaving(true);
    try {
      const dirUpdates = Object.entries(stagingDirs).map(([sid, dir]) =>
        streetsApi.update(Number(sid), { arm_direction: dir as Street['arm_direction'] })
      );
      // Settings is now the single editor for the intersection: metadata,
      // signal type + timing, street directions, and (in its own UI) cameras.
      // Building the splits payload only when signalised keeps the patch
      // small for the common unsignalised case.
      const greenSplits =
        signalStatus !== 'unsignalized' && Object.keys(splits).length > 0
          ? Object.fromEntries(
              Object.entries(splits)
                .map(([sid, v]) => [sid, parseInt(v, 10)])
                .filter(([, v]) => Number.isFinite(v as number) && (v as number) > 0)
            )
          : null;
      await Promise.all([
        intersectionsApi.update(inter.id, {
          name: name.trim(),
          latitude:  parseFloat(lat) || 0,
          longitude: parseFloat(lng) || 0,
        }),
        intersectionsApi.patchTiming(inter.id, {
          signal_status: signalStatus,
          existing_cycle_length: signalStatus !== 'unsignalized' && cycleLen
            ? parseInt(cycleLen, 10)
            : null,
          existing_green_splits: greenSplits,
        }),
        ...dirUpdates,
      ]);
      setStagingDirs({});
      toast.success('Saved');
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function detectTiming() {
    if (!inter) return;
    setDetectingTiming(true);
    try {
      const result = await intersectionsApi.detectTiming(inter.id);
      setDetectResult(result);
      if (result.estimated_cycle_s != null) {
        setCycleLen(String(result.estimated_cycle_s));
        toast.success(`Detected ~${result.estimated_cycle_s}s cycle`);
      } else {
        toast.info('Could not detect a cycle pattern');
      }
    } catch {
      toast.error('Detection failed');
    } finally {
      setDetectingTiming(false);
    }
  }

  function fillFromRecommendation() {
    const peak = selectPeakChunk(latestSim);
    if (!peak || peak.proposed_cycle_s == null || !peak.proposed_splits) {
      toast.error('No recommendation available yet');
      return;
    }
    setCycleLen(String(Math.round(peak.proposed_cycle_s)));
    const next: Record<number, string> = { ...splits };
    for (const s of streets) {
      const v = peak.proposed_splits[String(s.id)];
      if (v != null) next[s.id] = String(Math.round(v as number));
    }
    setSplits(next);
    toast.success(`Loaded Webster proposal (${peak.chunk_name})`);
  }

  async function deleteStreet(street: Street) {
    try { await streetsApi.delete(street.id); onRefresh(); }
    catch { toast.error('Delete failed'); }
  }

  async function addStreet() {
    if (!inter || !newStreetName.trim()) return;
    setAddingStreet(true);
    try {
      await streetsApi.create({ intersection_id: inter.id, name: newStreetName.trim(), arm_direction: newStreetDir as Street['arm_direction'] });
      setNewStreetName(''); setNewStreetDir('unknown');
      onRefresh();
    } catch { toast.error('Failed to add street'); }
    finally { setAddingStreet(false); }
  }

  async function addCamera() {
    if (!inter || !newCamRtsp.trim()) return;
    setAddingCam(true);
    try {
      await cctvsApi.create({ intersection_id: inter.id, name: newCamName || `Camera ${cameras.length + 1}`, rtsp_url: newCamRtsp.trim() });
      setNewCamName(''); setNewCamRtsp('');
      onRefresh();
    } catch { toast.error('Failed to add camera'); }
    finally { setAddingCam(false); }
  }

  async function deleteCamera(cam: CCTV) {
    try { await cctvsApi.delete(cam.id); onRefresh(); }
    catch { toast.error('Delete failed'); }
  }

  async function toggleCameraEnabled(cam: CCTV) {
    try {
      if (cam.enabled) {
        await cctvsApi.disable(cam.id);
        toast.success(`${cam.name} disabled - worker will leave it alone`);
      } else {
        await cctvsApi.enable(cam.id);
        toast.success(`${cam.name} enabled - worker will reclaim shortly`);
      }
      onRefresh();
    } catch { toast.error('Failed to update camera state'); }
  }

  async function deleteIntersection() {
    if (!inter) return;
    try { await intersectionsApi.delete(inter.id); onRefresh(); onClose(); }
    catch { toast.error('Delete failed'); }
  }

  if (!inter) return null;

  // See IntersectionShell.tsx: the warrant bucket is moot for signalized
  // intersections (you can't install a signal where one already exists), so
  // hide that badge here for the same reason. The signal-status badge below
  // already tells the operator that the intersection is signalized.
  const isSignalized =
    inter.signal_status === 'fixed_time' || inter.signal_status === 'actuated';
  const bucket      = rec && !isSignalized ? statusBucket(rec) : null;
  const onlineCount = cameras.filter(c => c.status === 'online').length;

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto flex flex-col gap-0 px-0 pt-0 pb-0">
        {/* Fixed header */}
        <div className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <SheetHeader>
            <SheetTitle className="text-base">{inter.name}</SheetTitle>
          </SheetHeader>
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            {/* signal_status badge dropped - the shell header already shows
                it and the sheet covers the right side of the screen, so the
                two badges sat side by side saying the same thing. The bucket
                badge stays (only shown here, useful warrant context). */}
            {bucket && (
              <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[bucket])}>
                {BUCKET_LABEL[bucket]}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {onlineCount}/{cameras.length} cameras online
            </span>
            {inter.existing_cycle_length && (
              <span className="text-xs text-muted-foreground">
                · {inter.existing_cycle_length}s cycle
              </span>
            )}
          </div>
          {/* Quick-jump shortcuts */}
          <div className="flex gap-2 mt-4">
            <Button asChild size="sm" className="flex-1 h-8 text-xs gap-1.5">
              <Link to={`/intersections/${inter.id}/timing`}>
                <TrendingUp className="size-3.5" />
                Open Signal Timing
              </Link>
            </Button>
            <Button asChild size="sm" variant="secondary" className="flex-1 h-8 text-xs gap-1.5">
              <Link to={`/intersections/${inter.id}/report`}>
                <FileText className="size-3.5" />
                View Report
              </Link>
            </Button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">

          {/* Basic info */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Intersection</p>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Location <span className="text-muted-foreground font-normal">(click map to place pin)</span></Label>
              <LocationPickerMap lat={lat} lng={lng} onPick={(la, lo) => { setLat(la.toFixed(6)); setLng(lo.toFixed(6)); }} />
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Latitude</Label>
                  <Input value={lat} onChange={e => setLat(e.target.value)} className="h-8 text-sm font-mono" placeholder="e.g. 7.4478" />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Longitude</Label>
                  <Input value={lng} onChange={e => setLng(e.target.value)} className="h-8 text-sm font-mono" placeholder="e.g. 125.8075" />
                </div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Signal & timing - the single editor for "what kind of signal
              and how it runs". Replaces the separate Edit timing dialog on
              the Timing tab so there's only one path to change these fields. */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Signal &amp; timing
            </p>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Signal status</Label>
              <Select value={signalStatus} onValueChange={v => setSignalStatus(v as SignalStatus)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SIGNAL_STATUS_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {signalStatus !== 'unsignalized' && (
              <>
                {/* Use-recommendation shortcut - one click to copy the peak
                    chunk's Webster proposal into the form below. Pulls from
                    the latest sim (peak vh-saved chunk). */}
                {(() => {
                  const peak = selectPeakChunk(latestSim);
                  if (!peak || peak.proposed_cycle_s == null || !peak.proposed_splits) return null;
                  return (
                    <button
                      type="button"
                      onClick={fillFromRecommendation}
                      className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-left text-xs hover:bg-emerald-100 transition-colors dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50"
                      title="Copy Webster's proposal for the peak chunk into the form"
                    >
                      <RefreshCw className="size-3.5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-emerald-900 dark:text-emerald-200">
                          Use recommendation · {peak.chunk_name}
                        </p>
                        <p className="mt-0.5 text-[11px] text-emerald-700/80 dark:text-emerald-400/80">
                          {Math.round(peak.proposed_cycle_s)}s cycle, Webster splits
                        </p>
                      </div>
                    </button>
                  );
                })()}

                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs" htmlFor="settings-cycle">Cycle length (seconds)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="settings-cycle"
                      type="number"
                      min={20}
                      max={180}
                      value={cycleLen}
                      onChange={e => setCycleLen(e.target.value)}
                      placeholder="e.g. 90"
                      className="h-8 text-sm flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 px-2 shrink-0"
                      onClick={detectTiming}
                      disabled={detectingTiming || !inter}
                      title="Detect cycle length from camera feed"
                    >
                      {detectingTiming
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : <ScanSearch className="size-3.5" />}
                    </Button>
                  </div>
                  {detectResult && (
                    <p className="text-[11px] text-muted-foreground">
                      {detectResult.confidence} confidence · {detectResult.note}
                    </p>
                  )}
                </div>

                {streets.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <Label className="text-xs">Green time per approach (seconds)</Label>
                    {streets.map(s => (
                      <div key={s.id} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-24 shrink-0 truncate capitalize">
                          {s.arm_direction !== 'unknown' ? s.arm_direction : s.name}
                        </span>
                        <Input
                          type="number"
                          min={5}
                          max={120}
                          value={splits[s.id] ?? ''}
                          onChange={e => setSplits(prev => ({ ...prev, [s.id]: e.target.value }))}
                          placeholder="e.g. 22"
                          className="h-8 text-sm"
                        />
                        <span className="text-xs text-muted-foreground shrink-0">s</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <Separator />

          {/* Cameras */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Cameras ({cameras.length})
            </p>
            {cameras.length === 0 ? (
              <p className="text-xs text-muted-foreground">No cameras added yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {cameras.map(cam => (
                  <div key={cam.id} className="rounded-lg border border-border bg-muted/10 overflow-hidden">
                    <div className="relative h-20 bg-black">
                      {cam.status === 'online' ? (
                        <img
                          src={cctvsApi.snapshotUrl(cam.id)}
                          alt={cam.name}
                          className="w-full h-full object-cover opacity-80"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                          {cam.status === 'reconnecting'
                            ? <RefreshCw className="size-3.5 text-amber-400/60 animate-spin" />
                            : <WifiOff className="size-3.5 text-muted-foreground/30" />}
                          <span className="text-[9px] text-muted-foreground/40">
                            {cam.status === 'reconnecting' ? 'reconnecting' : 'offline'}
                          </span>
                        </div>
                      )}
                      <span className={cn('absolute top-1.5 left-1.5 size-2 rounded-full',
                        cam.status === 'online' ? 'bg-emerald-400' :
                        cam.status === 'reconnecting' ? 'bg-amber-400' : 'bg-red-400',
                      )} />
                    </div>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{cam.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">{cam.rtsp_url}</p>
                      </div>
                      <Link to={`/intersections/${inter.id}/cameras/${cam.id}`} className="shrink-0" title="Draw detection regions">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] gap-1">
                          <ExternalLink className="size-3" />
                          Regions
                        </Button>
                      </Link>
                      <button
                        onClick={() => toggleCameraEnabled(cam)}
                        className={cn(
                          'shrink-0 p-1 transition-colors',
                          cam.enabled
                            ? 'text-muted-foreground hover:text-foreground'
                            : 'text-amber-600 hover:text-amber-700',
                        )}
                        title={cam.enabled
                          ? 'Disable - stop worker from reconnecting'
                          : 'Enable - let the worker claim it again'}
                        aria-label={cam.enabled ? `Disable ${cam.name}` : `Enable ${cam.name}`}
                      >
                        {cam.enabled ? <WifiOff className="size-3.5" /> : <RefreshCw className="size-3.5" />}
                      </button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button className="shrink-0 p-1 text-muted-foreground hover:text-destructive transition-colors" aria-label={`Delete ${cam.name}`}>
                            <Trash2 className="size-3.5" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete {cam.name}?</AlertDialogTitle>
                            <AlertDialogDescription>This will remove the camera and stop detection.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteCamera(cam)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
              <p className="text-xs text-muted-foreground">Add camera</p>
              <Input placeholder="Camera name (optional)" value={newCamName} onChange={e => setNewCamName(e.target.value)} className="h-8 text-sm" />
              <Input placeholder="rtsp://..." value={newCamRtsp} onChange={e => setNewCamRtsp(e.target.value)} className="h-8 text-sm font-mono" />
              <Button size="sm" variant="outline" className="w-fit" onClick={addCamera} disabled={addingCam || !newCamRtsp.trim()}>
                {addingCam ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Plus className="size-3.5 mr-1.5" />}
                Add camera
              </Button>
            </div>
          </div>

          <Separator />

          {/* Approach directions */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Approach directions</p>
              {hasUnsavedDirs && (
                <span className="text-[10px] text-amber-600 font-medium">unsaved changes</span>
              )}
            </div>
            {streets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No approaches configured yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {streets.map(s => {
                  const effectiveDir = stagingDirs[s.id] ?? s.arm_direction;
                  const isDirty = stagingDirs[s.id] !== undefined && stagingDirs[s.id] !== s.arm_direction;
                  return (
                    <div key={s.id} className={cn('flex items-center gap-2 rounded-md border px-3 py-2',
                      isDirty ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/20' : 'border-border',
                    )}>
                      <span className="text-sm flex-1 truncate">{s.name}</span>
                      <Select value={effectiveDir} onValueChange={v => setStagingDirs(prev => ({ ...prev, [s.id]: v }))}>
                        <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {DIRECTION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button className="text-muted-foreground hover:text-destructive transition-colors" aria-label={`Delete ${s.name}`}>
                            <Trash2 className="size-3.5" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader><AlertDialogTitle>Delete "{s.name}"?</AlertDialogTitle></AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteStreet(s)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3">
              <Input placeholder="Street name" value={newStreetName} onChange={e => setNewStreetName(e.target.value)} className="h-7 text-xs flex-1" />
              <Select value={newStreetDir} onValueChange={setNewStreetDir}>
                <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DIRECTION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={addStreet} disabled={addingStreet || !newStreetName.trim()}>
                {addingStreet ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              </Button>
            </div>
          </div>

          <Separator />

          <Button onClick={saveAll} disabled={saving} className="w-full">
            {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
            Save all changes
          </Button>

          <Separator />

          {/* Danger zone */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Danger zone</p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" className="w-fit">
                  <Trash2 className="size-3.5 mr-1.5" />
                  Delete intersection
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {inter.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Permanently deletes all cameras, streets, regions, and detection data for this intersection.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={deleteIntersection} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete everything
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export { recommendationsApi };
