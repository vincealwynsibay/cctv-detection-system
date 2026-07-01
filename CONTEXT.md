# EyeGila - CCTV-Based Traffic Signal Recommendation System

## What This System Is

EyeGila is a **traffic signal warrant analysis and signal timing recommendation system** built for traffic engineers. It ingests continuous CCTV camera streams (RTSP), detects and counts vehicles using YOLOv8, feeds the resulting traffic flow timeseries through a hybrid ML pipeline (rule-based MUTCD warrants + a custom 1D-CNN), and outputs whether an intersection needs to be:

- **Signalized** - install new traffic signals
- **Timing optimized** - adjust splits on existing signals
- **Widened** - add road capacity (lane widening)

All of this is wrapped in a React dashboard designed for the Philippine context (Tagum City, DPWH mixed-traffic defaults, Philippine low-speed warrant thresholds).

---

## Repository Layout

```
/server         FastAPI REST API, ML inference, Webster's timing engine
/worker         Live RTSP stream processor (YOLOv8 + ByteTrack)
/eyegila        React + Vite TypeScript frontend
/common         Shared SQLAlchemy ORM models and DB connection utilities
/scripts        CLI tools: model training, data generation, admin setup
/tests          Full test suite (unit, integration, E2E, load)
/alembic        16 DB migration versions
/k3s            Kubernetes manifests (production)
/rq-worker      Redis Queue worker for async video processing
/seeder         Database seeding utilities
/configs        App configuration files
/docs           Architecture guides
/runs           ML training output directories
/uploads        User-uploaded video storage
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Database | PostgreSQL 16 + TimescaleDB hypertables, pgbouncer (transaction mode) |
| Backend | Python 3.11+, FastAPI, SQLAlchemy ORM, Pydantic, SlowAPI |
| ML / Detection | PyTorch, Ultralytics YOLOv8, scikit-learn, numpy |
| Async Jobs | RQ (Redis Queue), Redis 7 |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui, Recharts, Three.js |
| Maps | React Leaflet |
| Real-time | Server-Sent Events (SSE), WebSockets |
| Video | OpenCV, MJPEG, H.264 (optional), RTSP |
| Containers | Docker Compose (13 services), Nginx, k3s (optional) |
| Testing | pytest, Playwright (E2E), Vitest (frontend), k6 (load) |
| Monitoring | Prometheus, prometheus-fastapi-instrumentator |
| Push Notifications | Web Push (VAPID protocol), pywebpush |

---

## End-to-End Data Pipeline

### Stage 1: Live Detection (Worker Service)

`/worker/main.py` processes one or more RTSP camera streams concurrently.

```
RTSP Camera Stream
  -> Reader thread (frame queue, reconnect logic)
  -> YOLOv8 inference every Nth frame (INFERENCE_EVERY_N env)
  -> ByteTrack persistence across frames
  -> Ray-casting polygon check (point-in-polygon per region)
  -> Batch flush every 0.3s
  -> TimescaleDB:
       detections (x1, y1, x2, y2, confidence, object_type, cctv_id)
       detections_in_regions (region_id, detection_id)
       worker_heartbeats (fps, claim_version, status)
```

Each camera is claimed by exactly one worker process using DB-level optimistic locking (`/worker/claim.py`). The claim version is tracked and a heartbeat thread renews it every 15 seconds. If the worker crashes the claim is auto-released.

For Mac/CPU development: `Dockerfile.mac` (onnxruntime).
For production GPU: `Dockerfile` (TensorRT NVIDIA).

### Stage 2: Real-time Aggregation (Server SSE)

`/server/routers/aggregation.py` runs a background task that every 5 seconds queries the `detection_street_view` continuous aggregate (15-minute bucketing), groups by (intersection, street, object_type), and fans out JSON payloads to all SSE subscribers. The React frontend holds an `EventSource` connection and updates charts in real-time.

### Stage 3: Warrant Analysis (Hybrid ML)

`POST /recommendations/generate/{intersection_id}` triggers the full warrant pipeline:

```
Query detections (last 24h)
  -> Aggregate into (5, 96) flow matrix
     - 4 vehicle approaches (N/S/E/W) x 96 quarter-hour slots
     - 1 pedestrian channel
  -> Load intersection metadata (major_lanes, minor_lanes, posted_speed_kph, is_signalized, n_approaches)

  -> MUTCD warrant rules (pure functions, /server/warrant_rules.py):
       W1  8-hour vehicle volume
       W2  4-hour vehicle volume (peak consecutive hours)
       W4  Pedestrian crossing volume
       W-Local-1/2/3  Philippine-specific local warrants

  -> TemporalWarrantCNN (/server/ml/temporal_warrant.py):
       forward(flow_matrix, metadata)
       -> warrant_probs: 6 sigmoid probabilities [W1, W2, W3, W4, W-Local-2, W-Local-3]
       -> intervention: softmax class + confidence (signalize / road_widening / timing_only)

  -> Write Recommendation row + TimingRecommendation rows (per TOD chunk)
```

Low-speed threshold: if `posted_speed_kph <= 40`, MUTCD thresholds are multiplied by 0.70 (per Section 4C.01).

### Stage 4: Signal Timing - Webster's Formula

`/server/webster.py` computes optimized signal splits:

```
Input: hourly PCU flows per approach, intersection geometry

K-means clustering -> 4 TOD regimes:
  AM Rush | Midday | PM Rush | Off-Peak

Per TOD chunk:
  Phase grouping: opposing directions run together (N+S, E+W) -> 2-phase standard
  Saturation flow S = 1400 PCU/hr/lane (Philippine default, calibratable)
  Critical flow ratio per phase: y_i = q_i / S
  Sum: Y = sum(y_i across phases)
  Webster: C_opt = (1.5L + 5) / (1 - Y)
    where L = lost time (4s/phase * 4 phases + 3s all-red clearance)
  Clamp to [min_cycle, max_cycle]
  Green splits: g_i = eff_green * (y_i / Y)

PCE Resolution (3-tier):
  1. Admin override (pce_overrides table)
  2. Calibrated from 7-day data (pce_calibrated_values table)
  3. DPWH defaults (motorcycle 0.33, jeepney 1.5, etc.)
```

### Stage 5: Simulation and Delay Analysis

`/server/simulation.py` and `/server/stochastic_simulation.py` compute the benefit of the proposal:

```
Analytical (always):
  Before: existing timing OR TWSC gap-acceptance model (if unsignalized)
  After:  Webster's proposed timing from TimingRecommendation rows
  Webster uniform delay: d = C(1-lambda)^2 / (2(1-lambda*x))
  v/c ratio: x = q*C / (s*g), capped at 0.98
  HCM LOS thresholds (A-F)
  VH saved = (delay_before - delay_after) * vehicles / 60

Stochastic confidence (Monte Carlo):
  100 runs per approach
  95% CI on vehicle-hours saved
  Redis cache (1-hour TTL)
  Labels: marginal / moderate / high confidence
```

### Stage 6: Video Upload Processing (Async)

Users can upload MP4 files for offline analysis. Flow:

```
POST /videos/upload
  -> store in /uploads/
  -> enqueue RQ job

RQ Worker (/worker/video_job.py):
  -> cv2.VideoCapture frame-by-frame
  -> YOLOv8 inference per frame
  -> Write Detection rows (video_id set, cctv_id nullable)
  -> Ray-casting -> DetectionInRegion rows
  -> Progress: videos.processed_frames
  -> Web Push notification on completion/failure (VAPID)
```

---

## Machine Learning Components

### YOLOv8 Object Detector

- Checkpoint: `eyegila_v4.pt` (22.5 MB)
- Classes: motorcycle, pedicab, tricycle, car, bus, truck, pedestrian
- Used by: worker (live) and rq-worker (video uploads)
- GPU: TensorRT, CPU: onnxruntime

### TemporalWarrantCNN (Thesis Centerpiece)

`/server/ml/temporal_warrant.py`

Architecture:
```
Temporal branch (flow_matrix: [B, 5, 96]):
  Conv1d(5->32, k=5) -> BN -> ReLU -> MaxPool(2)
  Conv1d(32->64, k=5) -> BN -> ReLU -> MaxPool(2)
  Conv1d(64->128, k=5) -> BN -> ReLU -> AdaptiveAvgPool(1)
  -> Flatten -> Linear(128, 128) -> ReLU

Metadata branch (metadata: [B, 5]):
  Linear(5, 16) -> ReLU

Late fusion:
  Concat -> Linear(144, 64) -> ReLU -> Dropout(0.3)

Warrant head: Linear(64, 6) -> sigmoid  (6 warrant probabilities)
Intervention head: Linear(64, 3) -> softmax  (signalize, road_widening, timing_only)
```

~62,633 parameters. Checkpoint: `temporal_cnn_model.pt` (~264 KB).

Training script: `scripts/train_multitask_cnn.py` with intersection-stratified GroupShuffleSplit on synthetic data (30 intersections x 90 days). Hyperparameter search via Optuna: `scripts/tune_multitask_cnn.py`.

Loss functions (`/server/ml/multitask_loss.py`):
- BCEWithLogitsLoss for 6-dim warrant head (multilabel)
- CrossEntropyLoss (class-weighted inverse-frequency) for intervention head
- UncertaintyWeightedLoss or EqualWeightedLoss compose both heads

### WarrantMLP Baseline

`/server/ml/model.py` + `inference.py` - scalar-feature MLP retained as comparison baseline. Inputs: 5-8 scalar features. Checkpoint: `warrant_model.pt` + `warrant_scaler.pkl`.

---
`
## Database Schema

Primary DB: PostgreSQL 16 + TimescaleDB. Connection through pgbouncer (transaction mode, max 100 clients).

```
Intersection
  |- streets (N/S/E/W arms)
  |    |- regions (detection polygons)
  |    |    |- region_points (polygon vertices)
  |    |    +- detections_in_regions (junction table)
  |    +- tod_chunks
  |
  |- cctvs
  |    |- detections (x1, y1, x2, y2, confidence, object_type)
  |    |    +- detections_in_regions
  |    |- worker_heartbeats
  |    +- regions
  |
  |- recommendations
  |    |- timing_recommendations (per TOD chunk)
  |    +- simulation_results (before/after per approach)
  |
  |- pce_overrides
  +- pce_calibrated_values

User
  |- user_sessions (bearer tokens)
  |- videos (uploads)
  |    +- detections (video_id set)
  +- push_subscriptions
```

Key time-series tables use TimescaleDB hypertables. Continuous aggregates roll detections into 1-minute and 15-minute buckets. The `detection_street_view` view is the primary aggregation source for the SSE fan-out and warrant input matrix.

---

## API Routes

`/server/routers/` contains 17 routers:

| Router | Key Endpoints |
|---|---|
| `recommendations.py` | `POST /recommendations/generate/{id}` |
| `aggregation.py` | `GET /aggregation/stream` (SSE, 5s fan-out) |
| `timing.py` | `GET /timing-recommendations/{id}` |
| `simulation.py` | `POST /simulation/run` |
| `intersection.py` | CRUD `/intersections` |
| `cctv.py` | CRUD `/cctvs` |
| `camera_ws.py` | WebSocket `/cameras/{id}/live` (MJPEG/H.264) |
| `videos.py` | CRUD + `POST /videos/upload` |
| `region.py` | CRUD `/regions` |
| `street.py` | CRUD `/streets` |
| `tod.py` | CRUD `/tod-chunks` |
| `pce.py` | `GET /pce/{id}` |
| `onboarding.py` | `GET /onboarding/status` |
| `detection.py` | Query by time range |
| `login.py` | `POST/DELETE /login` |
| `user.py` | CRUD `/users` (admin) |
| `mjpeg.py` | `GET /mjpeg/{id}` (legacy) |

Auth: bearer token. Rate limiting: SlowAPI with Redis-backed store. Prometheus metrics via `prometheus-fastapi-instrumentator`.

---

## Frontend Pages

`/eyegila/src/pages/`

| Page | Purpose |
|---|---|
| `Intersections.tsx` | Map view, live aggregated counts, intersection status overview |
| `IntersectionDetail.tsx` | Single intersection dashboard, camera grid, detection timeline |
| `SignalTiming.tsx` | Webster's proposal per TOD, before/after delay/LOS table, simulation confidence |
| `IntersectionReport.tsx` | Printable recommendation summary |
| `Reports.tsx` | Historical recommendations (paginated, filterable) |
| `Cameras.tsx` | Camera management, RTSP config, live preview |
| `Videos.tsx` | Upload MP4, processing progress |
| `Users.tsx` | User management (admin) |
| `Login.tsx` | Session auth |

Key components:
- `OnboardingWizard.tsx` - 6-step setup (intersection, streets, cameras, regions, timing params)
- `IntersectionVerdictBanner.tsx` - Signalize / timing_only / road_widening verdict
- `IntersectionScene3D.tsx` - Three.js 3D traffic simulation view
- `signal-timing-viz.tsx` - Signal phase/timing diagram
- `ConfidenceBadge.tsx` - Warrant and intervention confidence indicators
- `JargonTip.tsx` - Hover tooltips for MUTCD, v/c ratio, PCE, LOS, etc.

State management: React context + local component state. Real-time: `EventSource` for SSE aggregation. Maps: React Leaflet. Charts: Recharts.

---

## Environment Variables

`.env.example` documents all variables. Key ones:

```bash
# Security
SUPER_KEY=                          # Admin API key
FERNET_KEY=                         # RTSP URL encryption at rest
VAPID_PUBLIC_KEY=                   # Web Push
VAPID_PRIVATE_KEY=

# Database
DATABASE_URL=postgresql://postgres:postgres@pgbouncer:5432/traffic
PGBOUNCER_MAX_CLIENT_CONN=100
PGBOUNCER_DEFAULT_POOL_SIZE=10

# Redis
REDIS_URL=redis://redis:6379

# CORS and session
CORS_ORIGINS=http://localhost:5173
SESSION_TTL_HOURS=24
MAX_UPLOAD_MB=500
TZ=Asia/Manila

# Worker tuning
CAMERAS_PER_WORKER=16
INFERENCE_EVERY_N=1
READER_MAX_FPS=0
WORKER_PUBLISHES_FRAMES=0
WORKER_FRAME_JPEG_QUALITY=75

# Server
OVERLAY_DELAY_SEC=0.2
LIVE_PREVIEW_FPS=10
ANALYSIS_INTERVAL_MINUTES=0        # 0 = manual only

# ML
MODEL_VERSION=eyegila_v4
```

---

## Database Migrations

16 Alembic versions in `/alembic/versions/`:

```
0001  Core schema (users, intersections, streets, cctvs, regions)
0002  Add direction to regions
0003  Regionless detections (cctv_id nullable for video uploads)
0004  User sessions (bearer token auth)
0005  Signal status field on intersection
0006  PCE tables (overrides + calibrated values)
0007  TOD chunks (time-of-day clustering)
0008  Timing recommendations (Webster's proposal storage)
0009  Local warrants (W-Local-1/2/3 fields)
0010  Simulation results (delay analysis rows)
0011  Recommendations metrics and history
0012  Simulation v/c ratio field
0013  Street arm direction
0014  Intersection crossing width
0015  User onboarding wizard step
0016  Rename TOD chunks
```

---

## Key Files

| Path | Purpose |
|---|---|
| `server/main.py` | FastAPI app setup, lifespan (ML model loading), router registration |
| `worker/main.py` | Camera processor: claim, reader thread, YOLO, ByteTrack, region check, DB flush |
| `server/routers/recommendations.py` | Warrant + CNN inference, timing generation |
| `server/routers/simulation.py` | Analytical delay + Monte Carlo stochastic confidence |
| `server/ml/temporal_warrant.py` | CNN architecture |
| `server/ml/temporal_inference.py` | CNN inference wrapper |
| `server/ml/synthetic_traffic.py` | Training data generator (ground-truth regimes) |
| `server/warrant_rules.py` | MUTCD W1, W2, W4 pure-function evaluators |
| `server/local_warrants.py` | Philippine-specific local warrant rules |
| `server/webster.py` | Webster's formula, PCE resolution, phase grouping |
| `server/simulation.py` | Analytical delay formula (uniform delay, HCM LOS) |
| `server/stochastic_simulation.py` | Monte Carlo microsim (100 runs, 95% CI) |
| `common/models.py` | All SQLAlchemy ORM model definitions |
| `worker/video_job.py` | RQ job: YOLO per frame, progress tracking, Web Push |
| `worker/claim.py` | DB-level camera claiming and heartbeat |
| `worker/stream.py` | RTSP reader thread, reconnect logic |
| `eyegila/src/pages/Intersections.tsx` | Main map view, SSE aggregation consumer |
| `eyegila/src/pages/SignalTiming.tsx` | Webster timing UI, simulation results |
| `eyegila/src/lib/intersectionAction.ts` | Frontend API client actions |

---

## Scripts and Tools

`/scripts/`:

| Script | Purpose |
|---|---|
| `train_multitask_cnn.py` | Train TemporalWarrantCNN on synthetic data |
| `tune_multitask_cnn.py` | Optuna hyperparameter search |
| `evaluate_multitask_cnn.py` | Eval (AUC, F1, confusion matrix, saliency maps) |
| `fake_detections.py` | Synthetic detection data generator (14-day default) |
| `train_on_real.py` | Fine-tune on real measured traffic |
| `eval_on_real.py` | Evaluate CNN on real Tagum data |
| `load_real_traffic.py` | Import captured detections from video into DB |
| `run_stochastic_microsim.py` | Monte Carlo simulation standalone evaluation |
| `setup_admin.py` | Create initial admin user |
| `onvif_discover.py` | Auto-discover ONVIF cameras on network |
| `demo.py` | Standalone CNN inference demo |
| `load_test.py` | Concurrent API load testing |

---

## Development and Deployment

**Local (Mac/CPU):**
```bash
cp .env.example .env
make dev-mac          # Full stack, CPU workers
make test             # All tests (~60s)
make test-unit        # Fast offline (~5s)
```

**Production (GPU):**
```bash
docker compose up -d  # Requires NVIDIA Container Toolkit
```

**Docker services:** timescaledb, pgbouncer, redis, server (FastAPI), rq-worker, worker (live), worker-gpu (alternate), frontend (Nginx).

**Monitoring:** Prometheus metrics on port 9090. Worker health via `worker_heartbeats` table. API logs in server container.

---

## Design Decisions and Rationale

### Why TimescaleDB instead of plain PostgreSQL

Every detection from every camera writes a row to the database. Across multiple cameras this adds up fast. TimescaleDB automatically partitions the detections table by time so queries like "how many vehicles passed in the last 24 hours?" stay quick. It also lets us define pre-computed summaries (1-minute and 15-minute rollups) so the dashboard and the warrant engine read from those instead of scanning millions of raw rows every time. pgbouncer sits in front to cap the number of database connections, since each camera worker opens its own connection and they add up.

### Why a separate worker process for live detection

Running object detection on a video frame takes 10-80ms. If that happened inside the web server, every API call would have to wait. The worker is a completely separate process that does nothing but read camera streams and detect vehicles. It writes results to the database and the web server reads from there. The claim system ensures that if you run multiple worker instances, each camera is processed by exactly one of them - no duplicates.

### Why YOLOv8 and ByteTrack

YOLOv8 is the off-the-shelf vehicle detector - not a thesis contribution. It was picked because the same model weights run on a GPU (fast, for production) or a CPU (slower, for dev laptops) with just a flag change. ByteTrack is the tracker that links detections across frames so a single car passing through a zone is counted once, not once per frame it appears in.

### Why rules and CNN together

The MUTCD warrant rules are the legal standard - a traffic engineer can open the manual and verify the threshold. The CNN is layered on top to add pattern recognition: it sees the full 24-hour flow shape, not just a peak-hour total, so it can tell the difference between a genuine sustained peak and a short spike that happens to exceed the threshold. The CNN does not replace the rules; it adds a confidence signal. The intervention output (signalize vs widen vs retime) is CNN-only because there is no codified rule for that decision.

### Why a 1D-CNN and not an LSTM or Transformer

The traffic flow input is 96 quarter-hour slots across 5 channels (4 road directions + pedestrian). A 1D-CNN slides filters along the time axis to detect local patterns like morning peaks and evening peaks. LSTMs would work but are harder to train and overkill for a fixed 96-step sequence. Transformers are even heavier. The CNN reaches the same accuracy at about 62K parameters, loads on CPU, and runs in 0.2ms per intersection. Saliency maps also let you see which hours of the day the model is reacting to.

### Why synthetic training data to start

There was no labeled traffic dataset for Tagum at the start of the project. Real video can be collected but labeling it (does this intersection meet Warrant 1?) requires the same warrant rules that are being tested. The synthetic generator builds realistic 24-hour traffic profiles with morning and evening peaks, applies the warrant rules to get correct labels, and produces enough data to train and validate the architecture. The tradeoff is that the model learns from simulated traffic rather than real traffic.

### Why Toronto for retraining

The thesis panel flagged that training only on synthetic data could introduce bias. To address this, the CNN was retrained on real traffic data. The dataset needed to have:

- Vehicle counts broken down by road direction, at 15-minute intervals
- Real pedestrian counts
- Hundreds of intersections for a proper train/test split
- A free, direct download with no sign-up

The City of Toronto Open Data Multimodal Turning Movement Count dataset is the only public dataset that checks all four boxes. Boston and DVRPC TMC data are not available as a single direct-download CSV. UTD19 needs significant manual mapping. Toronto provides one 84 MB CSV with 617 intersections and real per-direction pedestrian counts under an open licence.

The workflow: `scripts/load_real_traffic.py` reads the CSV, applies the warrant rules to produce labels, and builds the tensors. `scripts/train_on_real.py` retrains the same model architecture on those tensors. The result: macro-AUC on a real held-out test set went from 0.732 (synthetic-trained) to 0.956 (Toronto-trained), closing a 24.5-point gap down to 2.1 points.

### Why the Toronto model has 4 warrant heads instead of 6

The original synthetic model had 6 warrant heads (w1, w2, w3, w4, w_local_2, w_local_3). Two were dropped for the Toronto retrain:

- `w_local_2` produced zero positives in the synthetic test set - it was never actually predicting anything useful.
- `w_local_3` (a low-volume nighttime criterion) needs overnight data to be meaningful. Toronto's traffic studies only cover 8-14 hours during the day, so the overnight slots are all zeros. Training on all-zero night data produces an unreliable head. The rule-based version in `server/local_warrants.py` still runs - only the CNN head was removed.

Both checkpoints (synthetic 6-head and Toronto 4-head) can be loaded without any code change via the `TEMPORAL_CNN_MODEL_PATH` environment variable. The dashboard shows a small badge indicating which one is active.

### Why Webster's formula for signal timing

Webster (1958) is the formula DPWH and Philippine traffic engineering programs use. Outputting a Webster cycle length means an engineer can verify the math by hand. Numerical optimization was considered but produces cycle lengths that look like black-box outputs - hard to defend to a panel or regulator. Webster keeps the output grounded in a known standard while the three-tier PCE system (admin override > calibrated from real data > DPWH defaults) adjusts for the actual vehicle mix observed at each intersection.

### Why K-means for time-of-day clustering instead of fixed bins

Fixed time bins (e.g. AM 6-9, PM 15-19) assume all intersections peak at the same hours. They do not. An intersection near a school peaks at different hours than one near a wet market. K-means on the observed hourly flow data finds the actual peak structure of each intersection and produces timing proposals that match what the cameras actually see.

### Why video uploads go through a job queue

Processing a 10-minute video at 30 frames per second means running the detector on roughly 18,000 frames, which takes several minutes. Running that in a web request handler would time out. The upload endpoint queues the job in Redis, returns immediately with a job ID, and a separate worker processes the video in the background. A web push notification tells the user when it is done.

### Why Server-Sent Events for the live dashboard feed

The live aggregation stream is one-directional: the server pushes vehicle counts to the browser every 5 seconds, the browser only listens. Server-Sent Events (a plain HTTP stream) is the simplest tool for this. WebSocket was considered but it adds bidirectional protocol overhead for what is essentially a read-only data feed. WebSocket is used where two-way communication is actually needed: the live camera view where the browser can send ROI drawing commands.

### Why PCE has three override levels

Philippine traffic includes jeepneys, tricycles, motorcycles, and pedicabs alongside cars and trucks. These vehicles behave very differently from cars - a jeepney counts as 1.5 car equivalents, a motorcycle as 0.33. Applying standard car-based volume thresholds without this correction produces wrong phase splits. The three levels (engineer manual override, calibrated from 7 days of observed data, DPWH hardcoded national defaults) let an engineer start from the standard, refine with local measurements, and override specific intersections that behave differently.

### Why the Monte Carlo simulation is optional and cached

The analytical delay formula gives an instant result. The Monte Carlo version runs 100 simulations per approach to produce a confidence interval - more informative but it takes several seconds. Making it a separate "run" action keeps the default page load fast. The result is cached in Redis for an hour so repeated views of the same intersection do not rerun the simulations.
