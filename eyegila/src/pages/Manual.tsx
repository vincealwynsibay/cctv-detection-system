import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  MapPin, Camera, Layers, BarChart3, GitBranch,
  Lightbulb, Info, AlertTriangle, ArrowRight,
} from 'lucide-react';
import { WARRANTS } from '@/lib/warrants';

const MANUAL_TABS = ['quickstart', 'intersections', 'cameras', 'regions', 'monitoring', 'warrants'] as const;
type ManualTab = typeof MANUAL_TABS[number];

function readTabFromSearch(search: string): ManualTab {
  const params = new URLSearchParams(search);
  const v = params.get('tab');
  return MANUAL_TABS.includes(v as ManualTab) ? (v as ManualTab) : 'quickstart';
}

function Sub({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-foreground mt-5 mb-2 first:mt-0">{children}</h3>;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 mb-2.5">
      <span className="flex-shrink-0 flex items-center justify-center size-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold mt-0.5">
        {n}
      </span>
      <p className="text-sm text-muted-foreground leading-relaxed">{children}</p>
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="my-3 border-sky-500/30 bg-sky-500/5">
      <Info className="size-4 text-sky-500" />
      <AlertDescription className="text-xs text-muted-foreground">{children}</AlertDescription>
    </Alert>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="my-3 border-amber-500/30 bg-amber-500/5">
      <AlertTriangle className="size-4 text-amber-500" />
      <AlertDescription className="text-xs text-muted-foreground">{children}</AlertDescription>
    </Alert>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-muted font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

function SectionHead({ Icon, color, children }: {
  Icon: React.ComponentType<{ className?: string }>;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className={`flex items-center justify-center size-8 rounded-lg ${color}`}>
        <Icon className="size-4" />
      </div>
      <h2 className="text-base font-semibold tracking-tight">{children}</h2>
    </div>
  );
}

export function ManualPage() {
  const { search, hash } = useLocation();
  const [tab, setTab] = useState<ManualTab>(() => readTabFromSearch(search));

  useEffect(() => {
    setTab(readTabFromSearch(search));
  }, [search]);

  useEffect(() => {
    if (!hash) return;
    const id = hash.slice(1);
    const t = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => window.clearTimeout(t);
  }, [hash, tab]);

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Manual</h1>
        <p className="text-sm text-muted-foreground mt-1">
          System reference and setup guide for EyeGila
        </p>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as ManualTab)}>
        <TabsList className="flex-wrap h-auto gap-1 mb-2">
          <TabsTrigger value="quickstart">Quick Start</TabsTrigger>
          <TabsTrigger value="intersections">Intersections</TabsTrigger>
          <TabsTrigger value="cameras">Cameras</TabsTrigger>
          <TabsTrigger value="regions">Region Editor</TabsTrigger>
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
          <TabsTrigger value="warrants">Warrants</TabsTrigger>
        </TabsList>

        {/* ── Quick Start ────────────────────────────────────── */}
        <TabsContent value="quickstart">
          <Card>
            <CardContent className="p-6 space-y-0">
              <SectionHead Icon={ArrowRight} color="bg-primary/10 text-primary">
                Quick Start Guide
              </SectionHead>
              <p className="text-sm text-muted-foreground mb-6">
                Follow these 5 steps to go from a fresh install to live traffic monitoring.
              </p>

              {/* Step 1 */}
              <div className="flex items-center gap-2.5 mb-2">
                <div className="size-7 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center">
                  <MapPin className="size-3.5" />
                </div>
                <h3 className="font-semibold text-sm">Step 1 - Create an Intersection</h3>
              </div>
              <div className="ml-10 mb-5">
                <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                  An intersection groups cameras, streets, and detection data under one location.
                </p>
                <Step n={1}>Navigate to <strong>Intersections</strong> in the sidebar.</Step>
                <Step n={2}>Click <strong>Add Intersection</strong> in the top right.</Step>
                <Step n={3}>Enter a descriptive name (e.g. "City Hall Junction").</Step>
                <Step n={4}>Click the map to pin the GPS location, or type coordinates manually.</Step>
                <Step n={5}>Click <strong>Add Intersection</strong> to save.</Step>
              </div>

              <Separator className="my-4" />

              {/* Step 2 */}
              <div className="flex items-center gap-2.5 mb-2">
                <div className="size-7 rounded-lg bg-purple-500/10 text-purple-600 flex items-center justify-center">
                  <GitBranch className="size-3.5" />
                </div>
                <h3 className="font-semibold text-sm">Step 2 - Add Approach Streets</h3>
              </div>
              <div className="ml-10 mb-5">
                <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                  Streets represent approach directions at the intersection. Each becomes a countable zone.
                </p>
                <Step n={1}>Click the intersection name to expand it in the table.</Step>
                <Step n={2}>Click <strong>+ Street</strong> on the right side of the row.</Step>
                <Step n={3}>Enter the approach name (e.g. "Northbound", "Rizal Ave", "Eastbound").</Step>
                <Step n={4}>Repeat for each approach - most intersections have 2 to 4 streets.</Step>
                <Tip>Use clear directional names so operators can match them to camera angles.</Tip>
              </div>

              <Separator className="my-4" />

              {/* Step 3 */}
              <div className="flex items-center gap-2.5 mb-2">
                <div className="size-7 rounded-lg bg-green-500/10 text-green-600 flex items-center justify-center">
                  <Camera className="size-3.5" />
                </div>
                <h3 className="font-semibold text-sm">Step 3 - Add a CCTV Camera</h3>
              </div>
              <div className="ml-10 mb-5">
                <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                  Cameras stream video over RTSP to detection workers. You need the camera's stream URL.
                </p>
                <Step n={1}>Navigate to <strong>Cameras</strong> in the sidebar and click <strong>Add Camera</strong>.</Step>
                <Step n={2}>Enter the camera name and RTSP URL:</Step>
                <div className="ml-8 mb-2.5 flex flex-col gap-1.5">
                  <Code>rtsp://192.168.1.10:554/stream</Code>
                  <Code>rtsp://admin:pass@192.168.1.10:554/ch01/main</Code>
                </div>
                <Step n={3}>Select the intersection this camera covers and click <strong>Add Camera</strong>.</Step>
                <Step n={4}>A worker process will claim and start reading the stream within seconds.</Step>
                <Tip>Use the <strong>Discover Cameras</strong> button to auto-scan the local network for ONVIF-compatible cameras.</Tip>
              </div>

              <Separator className="my-4" />

              {/* Step 4 */}
              <div className="flex items-center gap-2.5 mb-2">
                <div className="size-7 rounded-lg bg-orange-500/10 text-orange-600 flex items-center justify-center">
                  <Layers className="size-3.5" />
                </div>
                <h3 className="font-semibold text-sm">Step 4 - Draw Detection Regions</h3>
              </div>
              <div className="ml-10 mb-5">
                <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                  Regions are polygon zones drawn over the camera frame. The system counts objects passing through each one.
                </p>
                <Step n={1}>Open a camera from the Cameras list.</Step>
                <Step n={2}>Scroll down to the <strong>Region Editor</strong> panel.</Step>
                <Step n={3}>Click <strong>New Region</strong>, select a street approach and direction.</Step>
                <Step n={4}>Click on the live video to place polygon vertices along the lane boundary.</Step>
                <Step n={5}>Click the first vertex again to close the polygon and save the region.</Step>
                <Tip>Draw tight regions that match the physical lane boundaries to avoid counting adjacent traffic.</Tip>
                <Warn>Coordinates are stored as normalized values (0-1). They scale automatically with the video frame.</Warn>
              </div>

              <Separator className="my-4" />

              {/* Step 5 */}
              <div className="flex items-center gap-2.5 mb-2">
                <div className="size-7 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
                  <BarChart3 className="size-3.5" />
                </div>
                <h3 className="font-semibold text-sm">Step 5 - Monitor Live Traffic</h3>
              </div>
              <div className="ml-10">
                <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                  With cameras and regions configured, the system is counting in real time.
                </p>
                <Step n={1}>Open the <strong>Dashboard</strong> to see live counts per intersection.</Step>
                <Step n={2}>Click an intersection card to drill into its per-street breakdown and trend chart.</Step>
                <Step n={3}>Use <strong>Reports</strong> for historical trends by hour, day, or vehicle type.</Step>
                <Step n={4}>Go to <strong>Recommendations</strong> to run MUTCD warrant analysis.</Step>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Intersections ─────────────────────────────────── */}
        <TabsContent value="intersections">
          <Card>
            <CardContent className="p-6">
              <SectionHead Icon={MapPin} color="bg-blue-500/10 text-blue-600">
                Intersections and Streets
              </SectionHead>
              <p className="text-sm text-muted-foreground mb-2">
                Intersections are the top-level grouping unit. Cameras, streets, detection data, and warrant analysis all belong to an intersection.
              </p>

              <Sub>Intersections</Sub>
              <p className="text-sm text-muted-foreground mb-2">
                Each intersection has a name and GPS coordinates that pin it on the Heatmap and Dashboard map view.
              </p>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1 mb-2">
                <li>Deleting an intersection cascades: all streets, cameras, regions, and detections are permanently deleted.</li>
                <li>Use <strong>CSV Import</strong> to bulk-create intersections and cameras from a spreadsheet.</li>
                <li>The map in the modal allows clicking to pin the location instead of typing coordinates.</li>
              </ul>
              <Tip>You can edit an intersection's name or coordinates at any time without losing detection history.</Tip>

              <Sub>Streets (Approach Directions)</Sub>
              <p className="text-sm text-muted-foreground mb-2">
                Streets represent traffic approaches at the intersection. A 4-way intersection typically has 4 streets.
              </p>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1 mb-2">
                <li>Street names appear in Reports, the Dashboard breakdown, and the Region Editor dropdown.</li>
                <li>One camera can cover multiple approaches through multiple polygon regions.</li>
                <li>Use names consistent with how TMO staff refer to each approach direction.</li>
              </ul>
              <Warn>Deleting a street removes all its polygon regions and their associated detection region counts.</Warn>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Cameras ───────────────────────────────────────── */}
        <TabsContent value="cameras">
          <Card>
            <CardContent className="p-6">
              <SectionHead Icon={Camera} color="bg-green-500/10 text-green-600">
                Cameras
              </SectionHead>
              <p className="text-sm text-muted-foreground mb-2">
                Cameras connect to the system via RTSP. Each camera is assigned to an intersection and processed by a detection worker.
              </p>

              <Sub>RTSP URL Format</Sub>
              <p className="text-sm text-muted-foreground mb-2">Common formats supported:</p>
              <div className="flex flex-col gap-1.5 mb-3">
                <Code>rtsp://192.168.1.10:554/stream</Code>
                <Code>rtsp://admin:password@192.168.1.10:554/ch01/main</Code>
                <Code>rtsp://192.168.1.10:554/cam/realmonitor?channel=1&subtype=0</Code>
              </div>
              <Tip>Embed credentials in the URL if your camera requires authentication: <Code>rtsp://user:pass@ip:port/path</Code></Tip>

              <Sub>ONVIF Discovery</Sub>
              <p className="text-sm text-muted-foreground mb-2">
                Click <strong>Discover Cameras</strong> on the Cameras page to auto-scan the local network via WS-Discovery. Discovered cameras show their management URL and an RTSP URL guess. You must confirm the URL before adding.
              </p>

              <Sub>Camera Status</Sub>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1 mb-2">
                <li><strong>Online</strong> - a worker heartbeat was seen in the last 15 seconds. The camera is actively processing frames.</li>
                <li><strong>Offline</strong> - no active heartbeat. The stream may be unreachable or no worker has claimed it yet.</li>
              </ul>
              <Warn>If a camera stays offline after adding it, verify that the RTSP URL is reachable from the server and that a detection worker container is running.</Warn>

              <Sub>Worker Assignment</Sub>
              <p className="text-sm text-muted-foreground">
                Workers use <Code>SELECT FOR UPDATE SKIP LOCKED</Code> to claim cameras exclusively. One camera is processed by exactly one worker at a time. Workers update a heartbeat every 30 seconds. If a worker crashes, another will reclaim the camera after the stale timeout (60 seconds).
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Regions ───────────────────────────────────────── */}
        <TabsContent value="regions">
          <Card>
            <CardContent className="p-6">
              <SectionHead Icon={Layers} color="bg-orange-500/10 text-orange-600">
                Region Editor
              </SectionHead>
              <p className="text-sm text-muted-foreground mb-2">
                Regions are polygon detection zones drawn over the camera frame. Each is linked to one street approach and direction, and counts objects passing through it.
              </p>

              <Sub>Drawing a Region</Sub>
              <Step n={1}>Open a camera from the Cameras list and scroll to the Region Editor panel.</Step>
              <Step n={2}>Click <strong>New Region</strong>. A form appears to select the street and direction.</Step>
              <Step n={3}>Choose the street approach and whether traffic is inbound or outbound.</Step>
              <Step n={4}>Click on the live video to place polygon vertices. Place at least 3 points.</Step>
              <Step n={5}>Click the first vertex (highlighted) to close and save the polygon.</Step>

              <Sub>How Counting Works</Sub>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1 mb-2">
                <li>A detection is counted in a region if its bounding box <strong>center point</strong> falls inside the polygon (ray-casting algorithm).</li>
                <li>Each unique track ID is counted <strong>at most once per region</strong>, even if it stays inside across many frames.</li>
                <li>Multiple regions can be active on the same camera simultaneously.</li>
                <li>Region coordinates are stored as normalized 0-1 values - they scale with the video resolution.</li>
              </ul>
              <Tip>Keep regions tight around the lane to reduce over-counting. Loose regions may capture vehicles in adjacent lanes.</Tip>

              <Sub>Managing Regions</Sub>
              <p className="text-sm text-muted-foreground">
                Existing regions are shown as colored overlays on the camera preview. Click a region in the list to highlight its polygon. Use the delete button to remove a region. Deleting also removes its associated <Code>detections_in_regions</Code> entries but does not affect raw <Code>detections</Code>.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Monitoring ────────────────────────────────────── */}
        <TabsContent value="monitoring">
          <Card>
            <CardContent className="p-6">
              <SectionHead Icon={BarChart3} color="bg-emerald-500/10 text-emerald-600">
                Monitoring and Reports
              </SectionHead>
              <p className="text-sm text-muted-foreground mb-2">
                EyeGila streams live detection data via Server-Sent Events and stores all detections in TimescaleDB for historical analysis.
              </p>

              <Sub>Live Dashboard</Sub>
              <p className="text-sm text-muted-foreground mb-2">
                The Dashboard receives an SSE event every 5 seconds from <Code>/aggregation/stream</Code>. Each event contains day-to-date counts per intersection and street (accumulating from local midnight up to now).
              </p>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1 mb-2">
                <li>The <strong>Live</strong> indicator in the header shows the SSE connection status.</li>
                <li>Counts come from <Code>detection_street_view</Code> aggregated over the current day.</li>
                <li>Click an intersection card to focus on its per-street breakdown and trend chart.</li>
                <li>Switch to <strong>Map view</strong> to see all camera locations on OpenStreetMap.</li>
              </ul>

              <Sub>MJPEG Live Stream</Sub>
              <p className="text-sm text-muted-foreground mb-2">
                On a camera detail page, the live feed is served as MJPEG (<Code>/cctvs/{"{id}"}/stream</Code>). The server overlays bounding boxes and track IDs using OpenCV in real time.
              </p>
              <Tip>The live stream requires the camera to be online and a worker to be publishing detection JSON to Redis.</Tip>

              <Sub>Reports</Sub>
              <p className="text-sm text-muted-foreground mb-2">
                The Reports page queries <Code>aggregation_summaries</Code> for historical counts.
              </p>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1 mb-2">
                <li>Filter by intersection, street, vehicle type, and time range.</li>
                <li>Charts show hourly or daily totals grouped by object type.</li>
              </ul>

              <Sub>Video Processing</Sub>
              <p className="text-sm text-muted-foreground mb-2">
                Upload recorded video files under the <strong>Videos</strong> page to run offline detection. Processing is handled by an RQ background job.
              </p>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
                <li>Status values: <Badge variant="secondary" className="text-[10px]">pending</Badge>, <Badge variant="secondary" className="text-[10px]">processing</Badge>, <Badge variant="secondary" className="text-[10px]">completed</Badge>, <Badge variant="secondary" className="text-[10px]">failed</Badge></li>
                <li>Push notifications are sent when a job finishes (requires browser permission on first use).</li>
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Warrants ──────────────────────────────────────── */}
        <TabsContent value="warrants">
          <Card>
            <CardContent className="p-6">
              <SectionHead Icon={Lightbulb} color="bg-yellow-500/10 text-yellow-600">
                MUTCD Warrant Analysis
              </SectionHead>
              <p className="text-sm text-muted-foreground mb-2">
                EyeGila evaluates MUTCD traffic signal warrants from historical detection data. Go to <strong>Recommendations</strong> to run an analysis.
              </p>

              <Sub>What are MUTCD Warrants?</Sub>
              <p className="text-sm text-muted-foreground mb-3">
                The Manual on Uniform Traffic Control Devices (MUTCD) defines conditions under which a traffic signal is warranted at an intersection. Meeting a warrant means the intersection may benefit from a signal installation.
              </p>

              <Sub>Warrants Evaluated</Sub>
              <p className="text-sm text-muted-foreground mb-3">
                EyeGila checks three national MUTCD warrants plus three local warrants tuned to
                Tagum City traffic. "Met" means the condition is satisfied; at an intersection that
                already has a signal, a met warrant becomes a timing change rather than a new signal.
              </p>
              {(['mutcd', 'local'] as const).map(group => (
                <div key={group} className="mb-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    {group === 'mutcd'
                      ? 'MUTCD warrants (national standard)'
                      : 'Local warrants (Tagum City conditions)'}
                  </h4>
                  <div className="flex flex-col gap-3">
                    {WARRANTS.filter(w => w.group === group).map(w => (
                      <div key={w.code} id={w.anchor} className="scroll-mt-20 rounded-lg border border-border p-4">
                        <div className="flex items-start gap-2 mb-1.5">
                          <Badge variant="outline" className="text-[11px] flex-shrink-0 font-mono">{w.code}</Badge>
                          <h4 className="text-sm font-medium leading-none mt-0.5">{w.name}</h4>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">{w.purpose}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed mt-1.5">
                          <span className="font-medium text-foreground/70">Triggers when: </span>{w.triggersWhen}
                        </p>
                        <p className="text-[11px] text-muted-foreground/80 mt-1">
                          <span className="font-medium">Threshold: </span>{w.threshold}{' '}
                          <span className="opacity-70">({w.ref})</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <Sub><span id="recommendation" className="scroll-mt-20">Running a Recommendation</span></Sub>
              <Step n={1}>Navigate to <strong>Recommendations</strong>.</Step>
              <Step n={2}>Select the intersection to analyze.</Step>
              <Step n={3}>Click <strong>Generate</strong>. The system queries the last 7 days of aggregated data.</Step>
              <Step n={4}>Review the result: each warrant is shown with a met/unmet status and confidence score.</Step>
              <Step n={5}>The final <strong>Recommended</strong> flag is set if any warrant threshold is met.</Step>
              <Tip>Accuracy improves with more historical data. At least 7 days of continuous monitoring is recommended before running analysis.</Tip>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
