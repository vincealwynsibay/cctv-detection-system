import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { videosApi, type VideoAnalytics } from '@/services/videos';
import { intersectionsApi } from '@/services/intersections';
import type { Video, VideoStatus, Intersection } from '@/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Video as VideoIcon, Upload, Loader2, CheckCircle2, XCircle,
  Clock, Clapperboard, BarChart3, ChevronUp,
} from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, Legend,
} from 'recharts';
import { cn } from '@/lib/utils';

const TYPE_COLORS: Record<string, string> = {
  tricycle:   '#22c55e',
  motorcycle: '#3b82f6',
  car:        '#f59e0b',
  truck:      '#ef4444',
  pedicab:    '#a855f7',
  pedestrian: '#06b6d4',
};
const DEFAULT_COLOR = '#94a3b8';

const PEDESTRIAN_TYPES = new Set(['pedestrian', 'person']);

function colorFor(type: string) {
  return TYPE_COLORS[type] ?? DEFAULT_COLOR;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(
      'text-xs gap-1',
      status === 'completed'  && 'border-emerald-500/40 text-emerald-600 bg-emerald-500/10',
      status === 'processing' && 'border-blue-500/40 text-blue-600 bg-blue-500/10',
      status === 'failed'     && 'border-destructive/40 text-destructive bg-destructive/10',
      status === 'pending'    && 'border-amber-500/40 text-amber-600 bg-amber-500/10',
    )}>
      {status === 'completed'  && <CheckCircle2 className="size-2.5" />}
      {status === 'failed'     && <XCircle className="size-2.5" />}
      {status === 'pending'    && <Clock className="size-2.5" />}
      {status === 'processing' && <Loader2 className="size-2.5 animate-spin" />}
      {status}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Analytics panel
// ---------------------------------------------------------------------------

function AnalyticsPanel({ videoId }: { videoId: number }) {
  const [data, setData] = useState<VideoAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    videosApi.getAnalytics(videoId)
      .then(setData)
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false));
  }, [videoId]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!data || data.by_type.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground text-center">
        No detections recorded for this video yet.
      </div>
    );
  }

  const total = data.by_type.reduce((s, r) => s + r.count, 0);
  const vehicles   = data.by_type.filter(r => !PEDESTRIAN_TYPES.has(r.object_type)).reduce((s, r) => s + r.count, 0);
  const pedestrians = data.by_type.filter(r =>  PEDESTRIAN_TYPES.has(r.object_type)).reduce((s, r) => s + r.count, 0);

  // Build time-series: pivot to { bucket, tricycle, motorcycle, ... }
  const bucketMap = new Map<string, Record<string, number>>();
  for (const row of data.time_series) {
    const label = new Date(row.bucket).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    const entry = bucketMap.get(label) ?? {};
    entry[row.object_type] = (entry[row.object_type] ?? 0) + row.count;
    bucketMap.set(label, entry);
  }
  const timeData = Array.from(bucketMap.entries()).map(([t, counts]) => ({ t, ...counts }));
  const objectTypes = [...new Set(data.time_series.map(r => r.object_type))];

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* KPI strip */}
      <div className="flex gap-6 text-sm">
        <div>
          <span className="text-2xl font-black tabular-nums text-green-700">{vehicles}</span>
          <div className="text-xs text-muted-foreground mt-0.5">vehicles</div>
        </div>
        <div className="w-px bg-border self-stretch" />
        <div>
          <span className="text-2xl font-black tabular-nums text-cyan-700">{pedestrians}</span>
          <div className="text-xs text-muted-foreground mt-0.5">pedestrians</div>
        </div>
        <div className="w-px bg-border self-stretch" />
        <div>
          <span className="text-2xl font-black tabular-nums">{total}</span>
          <div className="text-xs text-muted-foreground mt-0.5">total detections</div>
        </div>
        {data.recorded_at && (
          <>
            <div className="w-px bg-border self-stretch" />
            <div>
              <span className="text-sm font-medium">
                {new Date(data.recorded_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              <div className="text-xs text-muted-foreground mt-0.5">recorded at</div>
            </div>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_200px]">
        {/* Time series */}
        {timeData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Detections over time</p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={timeData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {objectTypes.map(type => (
                  <Line
                    key={type}
                    type="monotone"
                    dataKey={type}
                    stroke={colorFor(type)}
                    dot={false}
                    strokeWidth={1.5}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* By type bar */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">By type</p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart
              data={data.by_type}
              layout="vertical"
              margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
            >
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="object_type" tick={{ fontSize: 10 }} width={72} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                {data.by_type.map(r => (
                  <Cell key={r.object_type} fill={colorFor(r.object_type)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function VideosPage() {
  const { id: videoIdFromUrl } = useParams<{ id?: string }>();
  const [videos, setVideos] = useState<Video[]>([]);
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadIntersection, setUploadIntersection] = useState('');
  const [recordedAt, setRecordedAt] = useState('');
  const [uploading, setUploading] = useState(false);
  const [statuses, setStatuses] = useState<Record<number, VideoStatus>>({});
  const [expandedId, setExpandedId] = useState<number | null>(
    videoIdFromUrl ? Number(videoIdFromUrl) : null
  );
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const [vids, ints] = await Promise.all([videosApi.list(), intersectionsApi.list()]);
      setVideos(vids);
      setIntersections(ints);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const inProgress = videos.filter(v => v.status === 'pending' || v.status === 'processing');
    if (pollingRef.current) clearInterval(pollingRef.current);
    if (!inProgress.length) return;
    pollingRef.current = setInterval(async () => {
      const results = await Promise.allSettled(inProgress.map(v => videosApi.getStatus(v.video_id)));
      const next = { ...statuses };
      let refresh = false;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          next[inProgress[i].video_id] = r.value;
          if (r.value.status === 'completed' || r.value.status === 'failed') refresh = true;
        }
      });
      setStatuses(next);
      if (refresh) load();
    }, 3_000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [videos]);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      const res = await videosApi.upload(
        file,
        (uploadIntersection && uploadIntersection !== 'none') ? Number(uploadIntersection) : null,
        recordedAt || undefined,
      );
      toast.success(`Video #${res.video_id} queued for processing`);
      setFile(null);
      setRecordedAt('');
      setUploadIntersection('');
      setShowUpload(false);
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  const highlightedId = videoIdFromUrl ? Number(videoIdFromUrl) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Videos</h1>
          <p className="text-sm text-muted-foreground mt-0.5 print:hidden">
            Upload archived footage to backfill counts when a camera was offline.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowUpload(v => !v)}>
          <Upload className="size-3.5 mr-1.5" />
          Upload Video
        </Button>
      </div>

      {/* Upload form */}
      {showUpload && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Clapperboard className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Upload for Processing</CardTitle>
            </div>
            <CardDescription>
              Video will be processed by the RQ worker. You can close the browser - a push notification will arrive on completion.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="video-file">Video File</Label>
                <Input id="video-file" name="video-file" type="file" accept="video/*" onChange={e => setFile(e.target.files?.[0] ?? null)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>
                  Intersection
                  <span className="ml-1.5 text-xs text-muted-foreground font-normal">(optional - links detections to a location)</span>
                </Label>
                <Select value={uploadIntersection} onValueChange={setUploadIntersection}>
                  <SelectTrigger><SelectValue placeholder="No intersection - standalone analysis" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No intersection - standalone analysis</SelectItem>
                    {intersections.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Recording Date/Time <span className="text-muted-foreground">(optional)</span></Label>
                <Input id="recorded-at" name="recorded-at" type="datetime-local" value={recordedAt} onChange={e => setRecordedAt(e.target.value)} />
                <p className="text-xs text-muted-foreground">Aligns detected_at timestamps with real recording time.</p>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowUpload(false)}>Cancel</Button>
                <Button onClick={handleUpload} disabled={uploading || !file}>
                  {uploading && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
                  {uploading ? 'Uploading…' : 'Upload & Process'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Video list */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex flex-col gap-2 p-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : videos.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <VideoIcon className="size-10 opacity-30" />
              <p className="text-sm">No videos uploaded yet</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {videos.map(v => {
                  const live    = statuses[v.video_id];
                  const status  = live?.status ?? v.status;
                  const percent = live?.percent ?? (v.total_frames ? Math.round((v.processed_frames / v.total_frames) * 100) : 0);
                  const isExpanded = expandedId === v.video_id;
                  const canExpand  = status === 'completed';

                  return (
                    <>
                      <TableRow
                        key={v.video_id}
                        className={cn(
                          highlightedId === v.video_id && 'bg-primary/5 ring-1 ring-primary/20',
                          canExpand && 'cursor-pointer hover:bg-muted/40',
                        )}
                        onClick={() => canExpand && setExpandedId(isExpanded ? null : v.video_id)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{v.filename}</span>
                            <Badge variant="outline" className="text-[10px] font-mono">#{v.video_id}</Badge>
                          </div>
                        </TableCell>
                        <TableCell><StatusBadge status={status} /></TableCell>
                        <TableCell className="min-w-32">
                          {(status === 'processing' || status === 'pending') ? (
                            <div className="flex flex-col gap-1">
                              <Progress value={percent} className="h-1.5" />
                              <span className="text-xs text-muted-foreground tabular-nums">{percent}%</span>
                            </div>
                          ) : status === 'completed' ? (
                            <span className="text-xs text-muted-foreground">done</span>
                          ) : <span className="text-xs text-muted-foreground">-</span>}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v.uploaded_at))}
                        </TableCell>
                        <TableCell>
                          {canExpand && (
                            <Button variant="ghost" size="icon" className="size-7" aria-label={isExpanded ? 'Collapse analytics' : 'View analytics'}>
                              {isExpanded
                                ? <ChevronUp className="size-3.5" aria-hidden="true" />
                                : <BarChart3 className="size-3.5" aria-hidden="true" />
                              }
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>

                      {/* Inline analytics panel */}
                      {isExpanded && (
                        <TableRow key={`analytics-${v.video_id}`} className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={5} className="p-0">
                            <div className="border-t border-border">
                              <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                                <BarChart3 className="size-3.5 text-muted-foreground" />
                                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                  Detection Analytics - {v.filename}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6 ml-auto"
                                  aria-label="Close analytics"
                                  onClick={() => setExpandedId(null)}
                                >
                                  <ChevronUp className="size-3" aria-hidden="true" />
                                </Button>
                              </div>
                              <Separator />
                              <AnalyticsPanel videoId={v.video_id} />
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
