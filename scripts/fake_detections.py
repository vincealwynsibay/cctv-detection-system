"""
Fake Detection Script
=====================
Inserts realistic fake detection data for testing the aggregation pipeline,
SSE stream, and frontend charts before the real worker is integrated.

Usage
-----
# Seed base data (3 intersections, 4 streets each, 4 CCTVs each, regions)
# Safe to run multiple times -skips intersections that already exist.
python scripts/fake_detections.py --seed

# Fill ALL cameras/regions with 14 days of traffic (default)
python scripts/fake_detections.py --fill

# Seed + fill in one shot (recommended for a clean DB)
python scripts/fake_detections.py --full

# Fill a specific number of days
python scripts/fake_detections.py --fill --days 7

# Fill a specific camera/region (legacy)
python scripts/fake_detections.py --cctv-id 1 --region-id 1 --count 500 --hours 2

# List what's in the database
python scripts/fake_detections.py --list
"""

import argparse
import os
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.append(".")

from common.database import SessionLocal
from common.models import (
    CCTV,
    Detection,
    DetectionInRegion,
    Intersection,
    Region,
    RegionPoint,
    Street,
    TodChunk,
)

_TOD_DEFAULTS = [
    ("Overnight", 0,    360),
    ("AM Rush",   360,  540),
    ("Midday",    540,  720),
    ("PM Rush",   720,  1080),
    ("Evening",   1080, 1440),
]

def seed_tod_chunks(db, intersection_id: int) -> None:
    for name, start, end in _TOD_DEFAULTS:
        db.add(TodChunk(intersection_id=intersection_id, name=name,
                        start_minutes=start, end_minutes=end))

OBJECT_TYPES = ["tricycle", "motorcycle", "car", "truck", "pedicab", "pedestrian"]

DEFAULT_WEIGHTS = {
    "tricycle":   0.35,
    "motorcycle": 0.30,
    "car":        0.15,
    "truck":      0.05,
    "pedicab":    0.10,
    "pedestrian": 0.05,
}

# Car-dominant mix used by the RTSP single-output scenarios so that
# motorcycle+tricycle+pedicab share stays well under W-Local 1's 0.6 threshold
# (combined ≈ 0.30). Used by every RTSP scenario except W-Local 1 and W4.
CAR_HEAVY_WEIGHTS = {
    "car":        0.55,
    "motorcycle": 0.15,
    "tricycle":   0.10,
    "truck":      0.10,
    "pedicab":    0.05,
    "pedestrian": 0.05,
}

# Mix used by the dedicated W-Local 1 scenario - combined motorcycle/tricycle/
# pedicab share ≈ 0.80, comfortably above the 0.6 trigger.
MOTORCYCLE_HEAVY_WEIGHTS = {
    "motorcycle": 0.40,
    "tricycle":   0.25,
    "pedicab":    0.15,
    "car":        0.15,
    "truck":      0.02,
    "pedestrian": 0.03,
}

# ---------------------------------------------------------------------------
# Realistic traffic patterns
# ---------------------------------------------------------------------------

# Fraction of peak-hour volume for each hour of the day (0–23)
HOUR_MULTIPLIERS = {
    0:  0.04,   # midnight -nearly empty
    1:  0.02,
    2:  0.02,
    3:  0.02,
    4:  0.05,   # early market vendors
    5:  0.15,
    6:  0.45,   # morning ramp-up
    7:  0.85,   # AM peak
    8:  1.00,   # AM peak
    9:  0.70,
    10: 0.60,
    11: 0.65,
    12: 0.75,   # lunch
    13: 0.60,
    14: 0.55,
    15: 0.65,
    16: 0.85,   # PM peak starts
    17: 1.00,   # PM peak
    18: 0.90,
    19: 0.70,
    20: 0.50,
    21: 0.35,
    22: 0.20,
    23: 0.10,
}

WEEKDAY_MULTIPLIER = 1.0   # Mon–Fri
WEEKEND_MULTIPLIER = 0.65  # Sat–Sun (lighter traffic)

# Peak-hour base detections per camera per hour.
# With 4 cameras at an intersection summing counts, 360 yields ~1280–1600/hr
# at the intersection level during peak - well over Warrant 1 (300/hr × 8 hrs)
# and dense enough that the "Live load" 1-minute SSE window reads meaningfully
# at mid-day multipliers (~6-12/intersection/min off-peak).
PEAK_DETECTIONS_PER_CAMERA_PER_HOUR = 360

# ---------------------------------------------------------------------------
# Intersections to seed -real Tagum City locations
# ---------------------------------------------------------------------------

# Detect the LAN IP of the host running the seeder so the cameras it creates
# point at the MediaMTX instance on this machine by default. Override either
# with the MEDIAMTX_HOST env var (preferred for prod) or hard-coded fallback.
def _detect_host_ip() -> str:
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # No packet is actually sent - we just ask the kernel which local
            # address it would use to reach a public IP. That picks the
            # primary LAN interface even with VPN / multiple NICs present.
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return "127.0.0.1"


MEDIAMTX_HOST   = os.environ.get("MEDIAMTX_HOST") or _detect_host_ip()
# Default to MediaMTX RTMP port - that's what this stack actually runs the
# physical cameras on (rtmp://<host>:1935/cam1…cam5). Override to 8554 if
# you point at the default RTSP port instead.
MEDIAMTX_PORT   = int(os.environ.get("MEDIAMTX_PORT", "1935"))
MEDIAMTX_SCHEME = os.environ.get("MEDIAMTX_SCHEME", "rtmp")
_STREAM_PREFIX  = f"{MEDIAMTX_SCHEME}://{MEDIAMTX_HOST}:{MEDIAMTX_PORT}"


DEFAULT_RTSP_PORT = "8554"


def _build_rtsp_url(cam_index: int) -> str:
    """Build rtsp://<current-LAN-IP>:8554/cam<N> for direct-camera scenarios.

    Re-detects the IP on every call so re-runs always pick up the host's
    current LAN address (e.g. when the laptop changes WiFi networks).
    Defaults to MediaMTX's RTSP port (8554) - this stack always exposes
    MediaMTX RTSP on 8554, never the IANA-default 554, so omitting the port
    causes the worker to dial :554 and fail with "Connection refused".
    Override host/port via RTSP_HOST / RTSP_PORT env vars; set RTSP_PORT=""
    explicitly to emit a port-less URL.
    """
    host = os.environ.get("RTSP_HOST") or _detect_host_ip()
    port = os.environ.get("RTSP_PORT", DEFAULT_RTSP_PORT)
    host_part = f"{host}:{port}" if port else host
    return f"rtsp://{host_part}/cam{cam_index}"

SEED_INTERSECTIONS = [
    {
        "name": "Tagum City Hall Junction",
        "latitude":  7.4478,
        "longitude": 125.8112,
        "streets": [
            {
                "name": "Northbound -Apokon Road",
                "cam_name": "Cam A1 -Apokon Northbound",
                "stream": f"{_STREAM_PREFIX}/cam1",
                "direction": "northbound",
            },
            {
                "name": "Southbound -Apokon Road",
                "cam_name": "Cam A2 -Apokon Southbound",
                "stream": f"{_STREAM_PREFIX}/cam2",
                "direction": "southbound",
            },
            {
                "name": "Eastbound -Lapu-Lapu Street",
                "cam_name": "Cam A3 -Lapu-Lapu Eastbound",
                "stream": f"{_STREAM_PREFIX}/cam3",
                "direction": "eastbound",
            },
            {
                "name": "Westbound -Lapu-Lapu Street",
                "cam_name": "Cam A4 -Lapu-Lapu Westbound",
                "stream": f"{_STREAM_PREFIX}/cam4",
                "direction": "westbound",
            },
        ],
    },
    {
        "name": "Tagum Public Market Junction",
        "latitude":  7.4453,
        "longitude": 125.8091,
        "streets": [
            {
                "name": "Northbound -Rizal Street",
                "cam_name": "Cam B1 -Rizal Northbound",
                "stream": f"{_STREAM_PREFIX}/cam1",
                "direction": "northbound",
            },
            {
                "name": "Southbound -Rizal Street",
                "cam_name": "Cam B2 -Rizal Southbound",
                "stream": f"{_STREAM_PREFIX}/cam2",
                "direction": "southbound",
            },
            {
                "name": "Eastbound -Coryville Road",
                "cam_name": "Cam B3 -Coryville Eastbound",
                "stream": f"{_STREAM_PREFIX}/cam3",
                "direction": "eastbound",
            },
            {
                "name": "Westbound -Coryville Road",
                "cam_name": "Cam B4 -Coryville Westbound",
                "stream": f"{_STREAM_PREFIX}/cam4",
                "direction": "westbound",
            },
        ],
    },
    {
        "name": "Magugpo Poblacion Junction",
        "latitude":  7.4512,
        "longitude": 125.8155,
        "streets": [
            {
                "name": "Northbound -National Highway",
                "cam_name": "Cam C1 -Highway Northbound",
                "stream": f"{_STREAM_PREFIX}/cam1",
                "direction": "northbound",
            },
            {
                "name": "Southbound -National Highway",
                "cam_name": "Cam C2 -Highway Southbound",
                "stream": f"{_STREAM_PREFIX}/cam2",
                "direction": "southbound",
            },
            {
                "name": "Eastbound -Dahlia Street",
                "cam_name": "Cam C3 -Dahlia Eastbound",
                "stream": f"{_STREAM_PREFIX}/cam3",
                "direction": "eastbound",
            },
            {
                "name": "Westbound -Dahlia Street",
                "cam_name": "Cam C4 -Dahlia Westbound",
                "stream": f"{_STREAM_PREFIX}/cam4",
                "direction": "westbound",
            },
        ],
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_weights(raw: str) -> dict:
    result = {}
    for pair in raw.split(","):
        key, val = pair.strip().split("=")
        result[key.strip()] = float(val.strip())
    total = sum(result.values())
    return {k: v / total for k, v in result.items()}


def random_object_type(weights: dict) -> str:
    types = list(weights.keys())
    probs = [weights[t] for t in types]
    return random.choices(types, weights=probs, k=1)[0]


def random_bounding_box():
    x1 = round(random.uniform(0.1, 0.7), 4)
    y1 = round(random.uniform(0.1, 0.7), 4)
    x2 = round(min(x1 + random.uniform(0.05, 0.2), 1.0), 4)
    y2 = round(min(y1 + random.uniform(0.05, 0.2), 1.0), 4)
    return x1, y1, x2, y2


def detections_for_hour(ts: datetime) -> int:
    """
    Calculate how many detections to generate for a given hour timestamp,
    using time-of-day and day-of-week patterns.
    """
    hour_factor = HOUR_MULTIPLIERS[ts.hour]
    dow_factor  = WEEKEND_MULTIPLIER if ts.weekday() >= 5 else WEEKDAY_MULTIPLIER
    # ±15% jitter so each hour isn't identical
    jitter = random.uniform(0.85, 1.15)
    count = PEAK_DETECTIONS_PER_CAMERA_PER_HOUR * hour_factor * dow_factor * jitter
    return max(0, round(count))


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------

def seed_base_data(db) -> list[tuple]:
    """
    Create intersections, streets, CCTVs, and regions.
    Idempotent: skips intersections whose name already exists.
    Returns list of (cctv_id, region_id) tuples that were created or already existed.
    """
    print("Seeding base data …")
    print(f"  MediaMTX host: {MEDIAMTX_HOST}")
    print()

    camera_region_pairs: list[tuple[int, int]] = []

    for spec in SEED_INTERSECTIONS:
        existing = db.query(Intersection).filter_by(name=spec["name"]).first()
        if existing:
            print(f"  [skip] Intersection '{spec['name']}' already exists (id={existing.id})")
            # Still collect existing camera/region pairs for --fill
            for cctv in existing.cctvs:
                for region in cctv.regions:
                    camera_region_pairs.append((cctv.id, region.id))
            continue

        intersection = Intersection(
            name=spec["name"],
            latitude=spec["latitude"],
            longitude=spec["longitude"],
        )
        db.add(intersection)
        db.flush()
        seed_tod_chunks(db, intersection.id)
        print(f"  Intersection id={intersection.id} '{intersection.name}' "
              f"({intersection.latitude}, {intersection.longitude})")

        for s in spec["streets"]:
            # arm_direction goes on the Street (used by Webster's phase grouping)
            street = Street(
                intersection_id=intersection.id,
                name=s["name"],
                arm_direction=s.get("direction", "unknown"),
            )
            db.add(street)
            db.flush()

            cctv = CCTV(
                intersection_id=intersection.id,
                name=s["cam_name"],
                rtsp_url=s["stream"],
                status="offline",
            )
            db.add(cctv)
            db.flush()

            # region.direction = 'inbound': camera counts vehicles approaching the
            # intersection (used by pcu_flow_per_street to filter the right side)
            region = Region(cctv_id=cctv.id, street_id=street.id, direction="inbound")
            db.add(region)
            db.flush()

            # Full-frame polygon (normalized 0–1)
            for x, y in [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]:
                db.add(RegionPoint(region_id=region.id, x=x, y=y))

            camera_region_pairs.append((cctv.id, region.id))
            print(f"    Street '{street.name}' → CCTV id={cctv.id} → Region id={region.id}")

    db.commit()
    print()
    return camera_region_pairs


# ---------------------------------------------------------------------------
# Fill (bulk insert with traffic patterns)
# ---------------------------------------------------------------------------

def fill_all(db, days: int, weights: dict, future: bool = False):
    """
    Generate `days` days of realistic detections for every camera/region in the DB.
    Skips hours that already have detections to avoid doubling up on re-runs.

    When future=True, fills [now, now + days] instead of [now - days, now].
    """
    from sqlalchemy import text

    # Collect all (cctv_id, region_id) pairs
    pairs = []
    for region in db.query(Region).all():
        pairs.append((region.cctv_id, region.id))

    if not pairs:
        print("No cameras/regions found -run --seed first.")
        return

    anchor = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    if future:
        start = anchor
        now = anchor + timedelta(days=days)
    else:
        now = anchor
        start = now - timedelta(days=days)

    total_inserted = 0

    print(f"Filling {days} days of traffic data for {len(pairs)} camera/region pairs …")
    print(f"  Range: {start.strftime('%Y-%m-%d %H:%M')} → {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print()

    # Single query to find all (cctv_id, hour_bucket) pairs that already have data.
    existing_rows = db.execute(text("""
        SELECT DISTINCT cctv_id,
               DATE_TRUNC('hour', time) AS hr
        FROM detections
        WHERE time >= :start AND time < :now
    """), {"start": start, "now": now}).fetchall()
    existing_hours: set[tuple] = {(r.cctv_id, r.hr.replace(tzinfo=timezone.utc)) for r in existing_rows}

    for pair_idx, (cctv_id, region_id) in enumerate(pairs):
        hour_cursor = start
        pair_inserted = 0

        while hour_cursor < now:
            hour_end = hour_cursor + timedelta(hours=1)

            if (cctv_id, hour_cursor) in existing_hours:
                hour_cursor = hour_end
                continue

            count = detections_for_hour(hour_cursor)
            if count == 0:
                hour_cursor += timedelta(hours=1)
                continue

            detections = []
            for _ in range(count):
                object_type = random_object_type(weights)
                x1, y1, x2, y2 = random_bounding_box()
                offset_secs = random.uniform(0, 3599)
                detected_at = hour_cursor + timedelta(seconds=offset_secs)

                detections.append(Detection(
                    cctv_id=cctv_id,
                    track_id=random.randint(1, 99999),
                    object_type=object_type,
                    confidence=round(random.uniform(0.65, 0.99), 4),
                    x1=x1, y1=y1, x2=x2, y2=y2,
                    time=detected_at,
                ))

            db.add_all(detections)
            db.flush()

            links = [
                DetectionInRegion(region_id=region_id, detection_id=d.id, time=d.time)
                for d in detections
            ]
            db.add_all(links)
            db.flush()

            pair_inserted += len(detections)
            hour_cursor += timedelta(hours=1)

        db.commit()
        total_inserted += pair_inserted
        print(f"  [{pair_idx + 1}/{len(pairs)}] CCTV {cctv_id} / Region {region_id} "
              f"→ {pair_inserted:,} detections")

    print()
    print(f"Done. Total inserted: {total_inserted:,} detections across {len(pairs)} regions.")
    print()
    print("TimescaleDB continuous aggregate refreshes every 1 minute.")
    print("After ~1 minute, query to verify:")
    print("  SELECT * FROM aggregation_summaries ORDER BY window_start DESC LIMIT 20;")


# ---------------------------------------------------------------------------
# Single camera insert (legacy mode)
# ---------------------------------------------------------------------------

def insert_detections(db, cctv_id, region_id, count, hours, weights):
    now = datetime.now(timezone.utc)
    start = now -timedelta(hours=hours)

    detections = []
    for _ in range(count):
        object_type = random_object_type(weights)
        x1, y1, x2, y2 = random_bounding_box()
        offset = random.uniform(0, hours * 3600)
        detected_at = start + timedelta(seconds=offset)

        detections.append(Detection(
            cctv_id=cctv_id,
            track_id=random.randint(1, 9999),
            object_type=object_type,
            confidence=round(random.uniform(0.65, 0.99), 4),
            x1=x1, y1=y1, x2=x2, y2=y2,
            time=detected_at,
        ))

    db.add_all(detections)
    db.flush()

    links = [
        DetectionInRegion(region_id=region_id, detection_id=d.id, time=d.time)
        for d in detections
    ]
    db.add_all(links)
    db.commit()

    return len(detections)


# ---------------------------------------------------------------------------
# Scenario seeding (warranted + borderline demo intersections)
# ---------------------------------------------------------------------------

SCENARIO_INTERSECTIONS = [
    {
        # Heavy 4-way arterial: NS is the dominant axis.
        # Equal-split 4-phase existing timing gives all approaches the same green;
        # Webster redistributes proportionally → NB/SB get ~2× more green than EW.
        # Peaks are calibrated so 4-phase Y ≈ 0.60, producing a ~120s Webster cycle.
        "name": "Visayan Avenue Junction",
        "latitude":  7.4521,
        "longitude": 125.8133,
        "expected": "warranted",
        "streets": [
            {"name": "Northbound - Visayan Ave",  "cam": "Cam V1 - Visayan NB", "peak": 320, "direction": "northbound"},
            {"name": "Southbound - Visayan Ave",  "cam": "Cam V2 - Visayan SB", "peak": 270, "direction": "southbound"},
            {"name": "Eastbound - Digos Road",    "cam": "Cam V3 - Digos EB",   "peak": 100, "direction": "eastbound"},
            {"name": "Westbound - Digos Road",    "cam": "Cam V4 - Digos WB",   "peak":  85, "direction": "westbound"},
        ],
    },
    {
        # Moderate 4-way collector: NS still dominant but EW carries meaningful load.
        # Warrant is borderline - Webster still improves flow but the gain is smaller.
        # Peaks calibrated so 4-phase Y ≈ 0.49, producing a ~100s Webster cycle.
        "name": "Caryving Road Junction",
        "latitude":  7.4498,
        "longitude": 125.8071,
        "expected": "borderline",
        "streets": [
            {"name": "Northbound - Caryving Rd",  "cam": "Cam C1 - Caryving NB", "peak": 250, "direction": "northbound"},
            {"name": "Southbound - Caryving Rd",  "cam": "Cam C2 - Caryving SB", "peak": 210, "direction": "southbound"},
            {"name": "Eastbound - Buhangin St",   "cam": "Cam C3 - Buhangin EB", "peak":  90, "direction": "eastbound"},
            {"name": "Westbound - Buhangin St",   "cam": "Cam C4 - Buhangin WB", "peak":  75, "direction": "westbound"},
        ],
    },
]


def _insert_exact_hour(db, cctv_id: int, region_id: int, hour_start: "datetime", count: int, weights: dict):
    """Insert `count` detections spread uniformly across the 60-minute window."""
    if count == 0:
        return
    detections = []
    for i in range(count):
        object_type = random_object_type(weights)
        x1, y1, x2, y2 = random_bounding_box()
        # Spread evenly + small sub-second noise so each minute gets ~count/60 rows
        offset_secs = (i / count) * 3599 + random.uniform(0, 1)
        detected_at = hour_start + timedelta(seconds=offset_secs)
        detections.append(Detection(
            cctv_id=cctv_id,
            track_id=random.randint(1, 99999),
            object_type=object_type,
            confidence=round(random.uniform(0.65, 0.99), 4),
            x1=x1, y1=y1, x2=x2, y2=y2,
            time=detected_at,
        ))
    db.add_all(detections)
    db.flush()
    links = [
        DetectionInRegion(region_id=region_id, detection_id=d.id, time=d.time)
        for d in detections
    ]
    db.add_all(links)
    db.flush()


def seed_scenarios(db, weights: dict):
    """
    Create (or reuse) two demo intersections and fill a full 7-day detection
    history using time-of-day patterns - so every TOD chunk (AM Peak, Midday,
    PM Peak, etc.) has enough data for the 7-day rolling average used by
    generate_simulation().

    Existing detections for these intersections are wiped first so re-runs
    produce clean, deterministic results.
    """
    from sqlalchemy import text

    FILL_DAYS = 7
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    fill_start = now - timedelta(days=FILL_DAYS)

    print("Seeding scenario intersections …")
    print(f"  Filling {FILL_DAYS} days: {fill_start.strftime('%Y-%m-%d')} → {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print()

    for spec in SCENARIO_INTERSECTIONS:
        existing = db.query(Intersection).filter_by(name=spec["name"]).first()
        if existing:
            intersection = existing
            print(f"  [reuse] '{spec['name']}' id={intersection.id}")
        else:
            intersection = Intersection(
                name=spec["name"],
                latitude=spec["latitude"],
                longitude=spec["longitude"],
            )
            db.add(intersection)
            db.flush()
            seed_tod_chunks(db, intersection.id)
            print(f"  [new]   '{spec['name']}' id={intersection.id}")

        # Wipe all existing detections for this intersection so re-runs are clean
        cctv_ids = [c.id for c in intersection.cctvs]
        if cctv_ids:
            db.execute(text(
                "DELETE FROM detections WHERE cctv_id = ANY(:ids)"
            ), {"ids": cctv_ids})
            db.flush()

        for s in spec["streets"]:
            # Reuse or create street / CCTV / region
            street = db.query(Street).filter_by(
                intersection_id=intersection.id, name=s["name"]
            ).first()
            if not street:
                street = Street(
                    intersection_id=intersection.id,
                    name=s["name"],
                    arm_direction=s.get("direction", "unknown"),
                )
                db.add(street)
                db.flush()
            elif street.arm_direction == "unknown" and s.get("direction"):
                street.arm_direction = s["direction"]
                db.flush()

            cctv = db.query(CCTV).filter_by(
                intersection_id=intersection.id, name=s["cam"]
            ).first()
            if not cctv:
                cctv = CCTV(
                    intersection_id=intersection.id,
                    name=s["cam"],
                    rtsp_url=f"{_STREAM_PREFIX}/scenario",
                    status="offline",
                )
                db.add(cctv)
                db.flush()

            region = db.query(Region).filter_by(cctv_id=cctv.id, street_id=street.id).first()
            if not region:
                region = Region(cctv_id=cctv.id, street_id=street.id, direction="inbound")
                db.add(region)
                db.flush()
                for x, y in [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]:
                    db.add(RegionPoint(region_id=region.id, x=x, y=y))
                db.flush()
            elif region.direction != "inbound":
                region.direction = "inbound"
                db.flush()

            # Fill 7 days × 24 hours with time-of-day patterns
            total_inserted = 0
            cursor = fill_start
            while cursor < now:
                hour_factor = HOUR_MULTIPLIERS[cursor.hour]
                dow_factor  = WEEKEND_MULTIPLIER if cursor.weekday() >= 5 else WEEKDAY_MULTIPLIER
                jitter      = random.uniform(0.90, 1.10)
                count       = max(0, round(s["peak"] * hour_factor * dow_factor * jitter))
                if count > 0:
                    _insert_exact_hour(db, cctv.id, region.id, cursor, count, weights)
                    total_inserted += count
                cursor += timedelta(hours=1)

            print(f"    {s['name']:<38} peak={s['peak']:>4} det/hr  "
                  f"total={total_inserted:>7,} det over {FILL_DAYS}d")

        # Set existing (pre-optimisation) signal timing.
        # 4-phase equal-split: each direction gets the same green time so the
        # dominant NS approach is under-served - Webster then redistributes
        # green time proportionally to produce a clear before/after difference.
        #
        # 4 phases × (lost_time + all_red) = 4 × 7 = 28 s overhead
        # g_per_phase = max((cycle - 28) / 4, ped_min_17s)
        existing_cycle  = 100
        lost_per_phase  = 4 + 3   # lost_time_per_phase + all_red_clearance
        n_phases        = 4
        g_phase = max(
            round((existing_cycle - n_phases * lost_per_phase) / n_phases, 1),
            17.0,  # DPWH pedestrian minimum (12 m crossing at 1.2 m/s + 7 s)
        )

        # Wipe stale timing recommendations so the page shows fresh results
        db.execute(text(
            "DELETE FROM timing_recommendations WHERE intersection_id = :iid"
        ), {"iid": intersection.id})

        # Collect street IDs
        streets_in_db = {
            s_spec["name"]: db.query(Street).filter_by(
                intersection_id=intersection.id, name=s_spec["name"]
            ).first()
            for s_spec in spec["streets"]
        }

        splits: dict[str, float] = {}
        for s_spec in spec["streets"]:
            st = streets_in_db[s_spec["name"]]
            if st:
                splits[str(st.id)] = g_phase

        intersection.signal_status         = "fixed_time"
        intersection.existing_cycle_length = existing_cycle
        intersection.existing_green_splits = splits
        db.flush()

        print(f"  → existing timing: fixed_time  C={existing_cycle}s  "
              f"equal 4-phase splits={g_phase}s each  "
              f"(NS under-served vs Webster optimum)")

        db.commit()
        print(f"  → expected classification: {spec['expected'].upper()}")
        print()

    print("Done. Wait ~60 s for the TimescaleDB continuous aggregate to refresh,")
    print("then run 'Generate all' on the Recommendations page to see results.")
    print()


# ---------------------------------------------------------------------------
# Demo data - two intersections that exercise the warranted + not-warranted
# paths end-to-end, with all six detection classes present.
# ---------------------------------------------------------------------------

# Per-approach peak volume profiles. Tuned so:
#   warranted   → total intersection volume ≫ MUTCD W1 threshold (300/hr × 8h)
#   not_warranted → well under threshold at every hour
DEMO_INTERSECTIONS = [
    {
        "name": "Demo - Warranted Arterial",
        "latitude": 7.4502,
        "longitude": 125.8120,
        "signal_status": "fixed_time",
        # All-class weights - every box the model emits has a realistic share,
        # so dashboard breakdowns aren't dominated by one type.
        "class_weights": {
            "car":        0.30,
            "motorcycle": 0.28,
            "tricycle":   0.22,
            "truck":      0.08,
            "pedicab":    0.08,
            "pedestrian": 0.04,
        },
        # NS dominant (peak 380/hr/approach), EW secondary (130/hr/approach).
        # Equal-split existing timing wastes green on EW → Webster reallocates
        # to NS → ~15–25 s/veh delay reduction at peak.
        "streets": [
            {"name": "Northbound - Demo Ave", "cam": "Cam DW-N", "peak": 380, "direction": "northbound"},
            {"name": "Southbound - Demo Ave", "cam": "Cam DW-S", "peak": 360, "direction": "southbound"},
            {"name": "Eastbound - Demo Rd",   "cam": "Cam DW-E", "peak": 140, "direction": "eastbound"},
            {"name": "Westbound - Demo Rd",   "cam": "Cam DW-W", "peak": 120, "direction": "westbound"},
        ],
    },
    {
        "name": "Demo - Quiet Residential Junction",
        "latitude": 7.4530,
        "longitude": 125.8150,
        "signal_status": "unsignalized",
        "class_weights": {
            "car":        0.20,
            "motorcycle": 0.30,
            "tricycle":   0.20,
            "truck":      0.02,
            "pedicab":    0.13,
            "pedestrian": 0.15,
        },
        # Low volume on every approach - comfortably under every MUTCD warrant
        # threshold so the recommendation cleanly returns "not warranted" and
        # the gating logic in recommendations.py kicks in.
        "streets": [
            {"name": "Northbound - Quiet St", "cam": "Cam DQ-N", "peak": 35, "direction": "northbound"},
            {"name": "Southbound - Quiet St", "cam": "Cam DQ-S", "peak": 30, "direction": "southbound"},
            {"name": "Eastbound - Side Lane", "cam": "Cam DQ-E", "peak": 18, "direction": "eastbound"},
            {"name": "Westbound - Side Lane", "cam": "Cam DQ-W", "peak": 15, "direction": "westbound"},
        ],
    },
]


def seed_demo(db, days: int = 7):
    """Seed two demo intersections covering the warranted and not-warranted paths.

    Re-runnable: existing detections for the demo intersection names are wiped
    first so each run produces a clean before/after for screenshots.
    """
    from sqlalchemy import text

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    fill_start = now - timedelta(days=days)

    print("Seeding demo intersections …")
    print(f"  Range: {fill_start.strftime('%Y-%m-%d %H:%M')} → {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print()

    for spec in DEMO_INTERSECTIONS:
        print(f"─ {spec['name']} ({spec['signal_status']})")

        intersection = db.query(Intersection).filter_by(name=spec["name"]).first()
        if intersection is None:
            intersection = Intersection(
                name=spec["name"],
                latitude=spec["latitude"],
                longitude=spec["longitude"],
            )
            db.add(intersection)
            db.flush()
            seed_tod_chunks(db, intersection.id)
            print(f"    [new] id={intersection.id}")
        else:
            print(f"    [reuse] id={intersection.id}")

        # Drop stale detections + timing rows so re-runs are deterministic.
        cctv_ids = [c.id for c in intersection.cctvs]
        if cctv_ids:
            db.execute(text("DELETE FROM detections WHERE cctv_id = ANY(:ids)"), {"ids": cctv_ids})
        db.execute(text(
            "DELETE FROM timing_recommendations WHERE intersection_id = :iid"
        ), {"iid": intersection.id})
        db.flush()

        # Normalize weights so they sum to 1 for random.choices.
        weights = spec["class_weights"]
        weights_total = sum(weights.values())
        weights = {k: v / weights_total for k, v in weights.items()}

        for s in spec["streets"]:
            street = db.query(Street).filter_by(
                intersection_id=intersection.id, name=s["name"]
            ).first()
            if not street:
                street = Street(
                    intersection_id=intersection.id,
                    name=s["name"],
                    arm_direction=s.get("direction", "unknown"),
                )
                db.add(street)
                db.flush()
            elif street.arm_direction != s.get("direction"):
                street.arm_direction = s["direction"]

            cctv = db.query(CCTV).filter_by(
                intersection_id=intersection.id, name=s["cam"]
            ).first()
            if not cctv:
                cctv = CCTV(
                    intersection_id=intersection.id,
                    name=s["cam"],
                    rtsp_url=f"{_STREAM_PREFIX}/cam1",  # demo data - share the local feed
                    status="offline",
                )
                db.add(cctv)
                db.flush()

            region = db.query(Region).filter_by(cctv_id=cctv.id, street_id=street.id).first()
            if not region:
                region = Region(cctv_id=cctv.id, street_id=street.id, direction="inbound")
                db.add(region)
                db.flush()
                for x, y in [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]:
                    db.add(RegionPoint(region_id=region.id, x=x, y=y))
                db.flush()
            elif region.direction != "inbound":
                region.direction = "inbound"

            total = 0
            cursor = fill_start
            while cursor < now:
                hour_factor = HOUR_MULTIPLIERS[cursor.hour]
                dow_factor  = WEEKEND_MULTIPLIER if cursor.weekday() >= 5 else WEEKDAY_MULTIPLIER
                jitter      = random.uniform(0.92, 1.08)
                count       = max(0, round(s["peak"] * hour_factor * dow_factor * jitter))
                if count > 0:
                    _insert_exact_hour(db, cctv.id, region.id, cursor, count, weights)
                    total += count
                cursor += timedelta(hours=1)
            print(f"    {s['name']:<40} peak={s['peak']:>4}/hr  total={total:>7,}d")

        # Set the right signal_status for the recommendation gating logic.
        if spec["signal_status"] == "fixed_time":
            # Deliberately equal-split existing timing - gives Webster something
            # clear to beat. 4 phases × 7 s overhead = 28 s; remaining 72 s / 4
            # phases = 18 s green per approach.
            streets = list(db.query(Street).filter_by(intersection_id=intersection.id).all())
            existing_cycle = 100
            n_phases = max(len(streets), 1)
            g_phase = max(
                round((existing_cycle - n_phases * (4 + 3)) / n_phases, 1),
                17.0,
            )
            intersection.signal_status         = "fixed_time"
            intersection.existing_cycle_length = existing_cycle
            intersection.existing_green_splits = {str(st.id): g_phase for st in streets}
            print(f"    → fixed_time C=100s, equal {g_phase}s × {n_phases} (Webster will reallocate)")
        else:
            intersection.signal_status         = "unsignalized"
            intersection.existing_cycle_length = None
            intersection.existing_green_splits = None
            print(f"    → unsignalized (recommendation will gate as 'not warranted')")
        db.commit()
        print()

    # Force-refresh the continuous aggregate so the new detections become
    # visible to webster.pcu_flow_per_street immediately, not after the next
    # policy tick.
    print("Refreshing continuous aggregate …")
    try:
        raw = db.connection().engine.raw_connection()
        try:
            raw.autocommit = True
            cur = raw.cursor()
            cur.execute("CALL refresh_continuous_aggregate('aggregation_summaries', NULL, NULL);")
            cur.close()
        finally:
            raw.close()
    except Exception as e:
        print(f"  (skipped: {e}; policy will catch up within ~1 min)")
    print()
    print("Done. Click 'Run all analyses' on the Intersections page. Expect:")
    print(f"  • '{DEMO_INTERSECTIONS[0]['name']}' → warranted, before/after delay reduction visible in /timing/")
    print(f"  • '{DEMO_INTERSECTIONS[1]['name']}' → not warranted, gating note shown instead of timing")


# ---------------------------------------------------------------------------
# CNN scenarios - exercise every warrant + intervention path of the new
# multi-task TemporalWarrantCNN (W1, W2, W3, W4, W-Local 2, W-Local 3 +
# signalize / road_widening / timing_only). Each scenario calibrated to push
# the flow_matrix into a distinctive shape so the model has something to
# discriminate against.
# ---------------------------------------------------------------------------

# Per-hour multiplier overrides. Anything not listed falls back to the default
# HOUR_MULTIPLIERS so we only define the parts that distinguish a scenario.
# Profile floors are tuned so the *current-hour* MLP fallback (~500/hr major
# trip point) triggers W1 on every scenario except _lights_off. Once the
# multi-task CNN is trained these can be relaxed - the CNN consumes the full
# 24-hour shape and is far less sensitive to which UTC hour the user clicks.

def _w3_peak_hour_profile(hour: int) -> float:
    if hour == 17: return 1.00
    if hour == 18: return 0.90
    if hour in (16, 19): return 0.80
    return 0.70  # sustained baseline so peak × floor > MLP trip point

def _w4_pedestrian_school_profile(hour: int) -> float:
    base = HOUR_MULTIPLIERS.get(hour, 0.1)
    return max(base * 0.8, 0.80)

def _lights_off_profile(hour: int) -> float:
    # Intentionally never warranted - validates the "no action" UI path.
    if 22 <= hour or hour <= 4: return 0.05
    if hour in (7, 8): return 0.30
    return 0.12

def _road_widening_profile(hour: int) -> float:
    base = HOUR_MULTIPLIERS.get(hour, 0.1)
    return max(min(base * 1.6, 1.0), 0.90)  # always near-saturation

def _peak_concentration_profile(hour: int) -> float:
    if hour in (7, 8, 9): return 1.00
    return 0.75

def _w1_eight_hour_profile(hour: int) -> float:
    # 12-hour plateau (07-18) at moderate volume so W1's 8-hour minimum
    # vehicular volume curve fires, but no hour spikes enough for W3's
    # peak-hour curve and the daily shape stays too flat for W2's
    # four-hour curve. Shoulders ramp gently.
    if 7 <= hour <= 18: return 0.65
    if hour in (6, 19, 20): return 0.35
    return 0.10

def _w2_four_hour_profile(hour: int) -> float:
    # Concentrated 4-hour AM block (07-10) above W2's four-hour curve,
    # with the rest of the day low enough that the eight-hour W1 minimum
    # is not satisfied. Peaks high but stays under W3's tighter peak-hour
    # threshold.
    if hour in (7, 8, 9, 10): return 0.90
    if hour in (11, 12): return 0.30
    if hour in (16, 17): return 0.40
    return 0.08

CNN_SCENARIOS = [
    {
        # Triggers: W3 (peak hour), likely W1 marginal. Intervention: signalize
        # (unsignalized + warranted).
        "name": "Demo - CNN W3 Peak Hour Spike",
        "latitude":  7.4565,
        "longitude": 125.8190,
        "signal_status": "unsignalized",
        "expected_warrants": ["W3"],
        "expected_intervention": "signalize",
        "hour_profile": _w3_peak_hour_profile,
        "ped_weight": 0.05,
        "streets": [
            {"name": "NB - Stadium Approach", "cam": "Cam SP-N", "peak": 900, "direction": "northbound"},
            {"name": "SB - Stadium Approach", "cam": "Cam SP-S", "peak": 880, "direction": "southbound"},
            {"name": "EB - Cross Street",     "cam": "Cam SP-E", "peak": 220, "direction": "eastbound"},
            {"name": "WB - Cross Street",     "cam": "Cam SP-W", "peak": 200, "direction": "westbound"},
        ],
    },
    {
        # Triggers: W4 (pedestrian volume). Intervention: signalize.
        # Pedestrian channel pushed to 200+ peds/hr at the school-zone peak via
        # a heavy pedestrian weight; vehicle volume kept moderate.
        "name": "Demo - CNN W4 Pedestrian School",
        "latitude":  7.4470,
        "longitude": 125.8095,
        "signal_status": "unsignalized",
        "expected_warrants": ["W4"],
        "expected_intervention": "signalize",
        "hour_profile": _w4_pedestrian_school_profile,
        "ped_weight": 0.55,  # massively pedestrian-skewed
        "streets": [
            {"name": "NB - School Road",     "cam": "Cam SC-N", "peak": 700, "direction": "northbound"},
            {"name": "SB - School Road",     "cam": "Cam SC-S", "peak": 680, "direction": "southbound"},
            {"name": "EB - Campus Entrance", "cam": "Cam SC-E", "peak": 460, "direction": "eastbound"},
            {"name": "WB - Campus Entrance", "cam": "Cam SC-W", "peak": 440, "direction": "westbound"},
        ],
    },
    {
        # Triggers: W-Local 3 (lights-off). Intervention: timing_only (or
        # signal-off recommendation downstream). Volume collapses overnight.
        "name": "Demo - CNN Lights Off Eligible",
        "latitude":  7.4400,
        "longitude": 125.8060,
        "signal_status": "fixed_time",
        "expected_warrants": ["W-Local 3"],
        "expected_intervention": "timing_only",
        "hour_profile": _lights_off_profile,
        "ped_weight": 0.04,
        "streets": [
            {"name": "NB - Sleepy Avenue", "cam": "Cam LO-N", "peak": 80, "direction": "northbound"},
            {"name": "SB - Sleepy Avenue", "cam": "Cam LO-S", "peak": 75, "direction": "southbound"},
            {"name": "EB - Side Lane",     "cam": "Cam LO-E", "peak": 35, "direction": "eastbound"},
            {"name": "WB - Side Lane",     "cam": "Cam LO-W", "peak": 30, "direction": "westbound"},
        ],
    },
    {
        # Triggers: W1+W2+W3 simultaneously. Intervention: road_widening
        # (critical v/c > 0.90 even after Webster's reallocation).
        "name": "Demo - CNN Road Widening Saturated",
        "latitude":  7.4625,
        "longitude": 125.8210,
        "signal_status": "fixed_time",
        "expected_warrants": ["W1", "W2", "W3"],
        "expected_intervention": "road_widening",
        "hour_profile": _road_widening_profile,
        "ped_weight": 0.04,
        "streets": [
            {"name": "NB - Highway Spine", "cam": "Cam RW-N", "peak": 1100, "direction": "northbound"},
            {"name": "SB - Highway Spine", "cam": "Cam RW-S", "peak": 1050, "direction": "southbound"},
            {"name": "EB - Arterial",      "cam": "Cam RW-E", "peak":  720, "direction": "eastbound"},
            {"name": "WB - Arterial",      "cam": "Cam RW-W", "peak":  680, "direction": "westbound"},
        ],
    },
    {
        # Triggers: W-Local 2 (peak concentration >= 70% in top chunks).
        # AM-only spike, deserts otherwise. Intervention: timing_only.
        "name": "Demo - CNN Peak Concentration AM",
        "latitude":  7.4530,
        "longitude": 125.8025,
        "signal_status": "fixed_time",
        "expected_warrants": ["W-Local 2"],
        "expected_intervention": "timing_only",
        "hour_profile": _peak_concentration_profile,
        "ped_weight": 0.06,
        "streets": [
            {"name": "NB - Office Park", "cam": "Cam PC-N", "peak": 880, "direction": "northbound"},
            {"name": "SB - Office Park", "cam": "Cam PC-S", "peak": 840, "direction": "southbound"},
            {"name": "EB - Feeder",      "cam": "Cam PC-E", "peak": 320, "direction": "eastbound"},
            {"name": "WB - Feeder",      "cam": "Cam PC-W", "peak": 300, "direction": "westbound"},
        ],
    },
    {
        # Triggers: W1 (eight-hour vehicular volume). Intervention: signalize.
        # Flat 12-hour plateau, no sharp peaks - hits W1's eight-hour curve
        # without crossing W2 (four-hour) or W3 (peak-hour) thresholds.
        "name": "Demo - CNN W1 Sustained 8hr",
        "latitude":  7.4380,
        "longitude": 125.8165,
        "signal_status": "unsignalized",
        "expected_warrants": ["W1"],
        "expected_intervention": "signalize",
        "hour_profile": _w1_eight_hour_profile,
        "ped_weight": 0.05,
        "streets": [
            {"name": "NB - Market Road",  "cam": "Cam W1-N", "peak": 700, "direction": "northbound"},
            {"name": "SB - Market Road",  "cam": "Cam W1-S", "peak": 680, "direction": "southbound"},
            {"name": "EB - Service Lane", "cam": "Cam W1-E", "peak": 260, "direction": "eastbound"},
            {"name": "WB - Service Lane", "cam": "Cam W1-W", "peak": 240, "direction": "westbound"},
        ],
    },
    {
        # Triggers: W2 (four-hour vehicular volume). Intervention: signalize.
        # AM 4-hour shoulder block above the W2 curve; rest of the day too
        # low to satisfy W1's 8-hour minimum and too flat for W3's peak-hour.
        "name": "Demo - CNN W2 Shoulder Peaks",
        "latitude":  7.4490,
        "longitude": 125.8265,
        "signal_status": "unsignalized",
        "expected_warrants": ["W2"],
        "expected_intervention": "signalize",
        "hour_profile": _w2_four_hour_profile,
        "ped_weight": 0.05,
        "streets": [
            {"name": "NB - Commerce Ave", "cam": "Cam W2-N", "peak": 820, "direction": "northbound"},
            {"name": "SB - Commerce Ave", "cam": "Cam W2-S", "peak": 800, "direction": "southbound"},
            {"name": "EB - Side Road",    "cam": "Cam W2-E", "peak": 280, "direction": "eastbound"},
            {"name": "WB - Side Road",    "cam": "Cam W2-W", "peak": 260, "direction": "westbound"},
        ],
    },
    # NOTE: W-Local 1 (motorcycle/tricycle/pedicab ratio >= 60% of vehicles)
    # already fires on every scenario above, because DEFAULT_WEIGHTS puts the
    # combined motorcycle + tricycle + pedicab share at ~79% of all vehicles.
    # A dedicated W-Local 1 scenario would be redundant; the warrant surfaces
    # on the existing scenarios alongside their primary warrant.
]


def _scenario_weights(ped_weight: float) -> dict:
    """Re-balance the class mix so pedestrian share matches the scenario."""
    remaining = 1.0 - ped_weight
    veh_keys = ["tricycle", "motorcycle", "car", "truck", "pedicab"]
    veh_total = sum(DEFAULT_WEIGHTS[k] for k in veh_keys)
    w = {k: DEFAULT_WEIGHTS[k] / veh_total * remaining for k in veh_keys}
    w["pedestrian"] = ped_weight
    return w


def seed_cnn_scenarios(db, days: int = 7):
    """Seed five intersections that together exercise every CNN warrant +
    intervention path. Re-runnable: wipes detections + timing recs for each
    scenario before refilling.
    """
    from sqlalchemy import text

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    fill_start = now - timedelta(days=days)

    print(f"Seeding CNN warrant + intervention scenarios ({days} days)")
    print(f"  Range: {fill_start.strftime('%Y-%m-%d %H:%M')} → {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print()

    for spec in CNN_SCENARIOS:
        print(f"─ {spec['name']} ({spec['signal_status']})")
        print(f"    expected warrants: {', '.join(spec['expected_warrants'])}  "
              f"intervention: {spec['expected_intervention']}")

        intersection = db.query(Intersection).filter_by(name=spec["name"]).first()
        if intersection is None:
            intersection = Intersection(
                name=spec["name"],
                latitude=spec["latitude"],
                longitude=spec["longitude"],
            )
            db.add(intersection)
            db.flush()
            seed_tod_chunks(db, intersection.id)
            print(f"    [new] id={intersection.id}")
        else:
            print(f"    [reuse] id={intersection.id}")

        cctv_ids = [c.id for c in intersection.cctvs]
        if cctv_ids:
            db.execute(text("DELETE FROM detections WHERE cctv_id = ANY(:ids)"), {"ids": cctv_ids})
        db.execute(text(
            "DELETE FROM timing_recommendations WHERE intersection_id = :iid"
        ), {"iid": intersection.id})
        db.flush()

        weights = _scenario_weights(spec["ped_weight"])
        hour_profile = spec["hour_profile"]

        for s in spec["streets"]:
            street = db.query(Street).filter_by(
                intersection_id=intersection.id, name=s["name"]
            ).first()
            if not street:
                street = Street(
                    intersection_id=intersection.id,
                    name=s["name"],
                    arm_direction=s.get("direction", "unknown"),
                )
                db.add(street)
                db.flush()
            elif street.arm_direction != s.get("direction"):
                street.arm_direction = s["direction"]

            cctv = db.query(CCTV).filter_by(
                intersection_id=intersection.id, name=s["cam"]
            ).first()
            if not cctv:
                cctv = CCTV(
                    intersection_id=intersection.id,
                    name=s["cam"],
                    rtsp_url=f"{_STREAM_PREFIX}/cam1",
                    status="offline",
                )
                db.add(cctv)
                db.flush()

            region = db.query(Region).filter_by(cctv_id=cctv.id, street_id=street.id).first()
            if not region:
                region = Region(cctv_id=cctv.id, street_id=street.id, direction="inbound")
                db.add(region)
                db.flush()
                for x, y in [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]:
                    db.add(RegionPoint(region_id=region.id, x=x, y=y))
                db.flush()
            elif region.direction != "inbound":
                region.direction = "inbound"

            total = 0
            cursor = fill_start
            while cursor < now:
                hour_factor = hour_profile(cursor.hour)
                dow_factor  = WEEKEND_MULTIPLIER if cursor.weekday() >= 5 else WEEKDAY_MULTIPLIER
                jitter      = random.uniform(0.90, 1.10)
                count       = max(0, round(s["peak"] * hour_factor * dow_factor * jitter))
                if count > 0:
                    _insert_exact_hour(db, cctv.id, region.id, cursor, count, weights)
                    total += count
                cursor += timedelta(hours=1)
            print(f"    {s['name']:<32} peak={s['peak']:>4}/hr  total={total:>7,}")

        # Existing timing for signalized scenarios: deliberately equal-split so
        # the CNN sees a real "under-served NS" pattern in flow_matrix.
        if spec["signal_status"] == "fixed_time":
            streets = list(db.query(Street).filter_by(intersection_id=intersection.id).all())
            existing_cycle = 100
            n_phases = max(len(streets), 1)
            g_phase = max(
                round((existing_cycle - n_phases * (4 + 3)) / n_phases, 1),
                17.0,
            )
            intersection.signal_status         = "fixed_time"
            intersection.existing_cycle_length = existing_cycle
            intersection.existing_green_splits = {str(st.id): g_phase for st in streets}
        else:
            intersection.signal_status         = "unsignalized"
            intersection.existing_cycle_length = None
            intersection.existing_green_splits = None
        db.commit()
        print()

    # Refresh continuous aggregate so the CNN immediately sees the new data.
    print("Refreshing continuous aggregate …")
    try:
        raw = db.connection().engine.raw_connection()
        try:
            raw.autocommit = True
            cur = raw.cursor()
            cur.execute("CALL refresh_continuous_aggregate('aggregation_summaries', NULL, NULL);")
            cur.close()
        finally:
            raw.close()
    except Exception as e:
        print(f"  (skipped: {e}; policy will catch up within ~1 min)")
    print()
    print("Done. On the Dashboard, click 'Run all analyses'. Expected outputs:")
    for spec in CNN_SCENARIOS:
        print(f"  • {spec['name']}")
        print(f"      warrants → {', '.join(spec['expected_warrants'])}    "
              f"intervention → {spec['expected_intervention']}")


# ---------------------------------------------------------------------------
# RTSP single-output scenarios - 8 intersections, one warrant per intersection
# (W1, W2, W3, W4, W-Local 1, W-Local 2, W-Local 3) plus a baseline "all clear"
# control. Every camera's rtsp_url is rewritten to rtsp://<current-IP>/cam<N>
# on each run so the URLs follow the host's LAN IP automatically.
# ---------------------------------------------------------------------------

def _w_local_1_flat_profile(hour: int) -> float:
    # Flat moderate profile so overnight PCU/hr/approach stays above the
    # W-Local 3 floor (30 PCU/hr) - otherwise the motorcycle-mix scenario
    # would accidentally also fire W-Local 3.
    return 0.60

def _baseline_flat_profile(hour: int) -> float:
    # Constant moderate profile - high enough every hour to stay above the
    # W-Local 3 floor, low enough total volume that no MUTCD warrant fires.
    return 0.55

# Real Tagum City intersections, sourced from:
#   - Wikipedia "Tagum" (N1 Maharlika Hwy, N74 Apokon Rd, N909 Diversion Rd)
#   - AARoads N1/N74/N909 Philippines highway routings
#   - Wikimapia tagum.wikimapia.org/streets/
#   - JICA Tagum Traffic Situation Assessment (UPNCTS, 2021)
# Each junction is paired with the warrant it would most realistically trigger
# in the wild (e.g. the N1xN74 crossing is the city's heaviest all-day arterial
# corner so it carries the W1 sustained-volume scenario).
RTSP_SCENARIOS = [
    {
        # N74 (Apokon Rd) meets N1 (Daang Maharlika) near Magugpo East - the
        # heaviest all-day arterial intersection in Tagum.
        "name": "Apokon-Maharlika Junction (W1 - sustained 8hr)",
        "latitude":  7.4502,
        "longitude": 125.8095,
        "signal_status": "unsignalized",
        "expected_warrants": ["W1"],
        "hour_profile": _w1_eight_hour_profile,
        "class_weights": CAR_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Apokon Road (toward Davao Oriental)", "direction": "northbound", "peak": 700},
            {"name": "SB - Apokon Road (toward city center)",    "direction": "southbound", "peak": 680},
            {"name": "EB - Daang Maharlika (toward Mati)",       "direction": "eastbound",  "peak": 260},
            {"name": "WB - Daang Maharlika (toward Davao City)", "direction": "westbound",  "peak": 240},
        ],
    },
    {
        # Pioneer Ave x J. Abad Santos - downtown commercial AM commute block.
        "name": "Pioneer Avenue Junction (W2 - 4hr block)",
        "latitude":  7.4470,
        "longitude": 125.8085,
        "signal_status": "unsignalized",
        "expected_warrants": ["W2"],
        "hour_profile": _w2_four_hour_profile,
        "class_weights": CAR_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Pioneer Avenue",     "direction": "northbound", "peak": 820},
            {"name": "SB - Pioneer Avenue",     "direction": "southbound", "peak": 800},
            {"name": "EB - J. Abad Santos St",  "direction": "eastbound",  "peak": 280},
            {"name": "WB - J. Abad Santos St",  "direction": "westbound",  "peak": 260},
        ],
    },
    {
        # Visayan Village corridor on Daang Maharlika - the peak congestion that
        # justified the 1.6 km flyover from CAP Building to Magugpo East.
        "name": "Visayan Village Flyover Approach (W3 - peak hour)",
        "latitude":  7.4540,
        "longitude": 125.8118,
        "signal_status": "unsignalized",
        "expected_warrants": ["W3"],
        "hour_profile": _w3_peak_hour_profile,
        "class_weights": CAR_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Daang Maharlika (toward CAP)",          "direction": "northbound", "peak": 900},
            {"name": "SB - Daang Maharlika (toward Magugpo East)", "direction": "southbound", "peak": 880},
            {"name": "EB - Visayan Village Road",                  "direction": "eastbound",  "peak": 220},
            {"name": "WB - Visayan Village Road",                  "direction": "westbound",  "peak": 200},
        ],
    },
    {
        # Tagum Public Market - high pedestrian density on Rizal x Coryville.
        "name": "Tagum Public Market Junction (W4 - pedestrian)",
        "latitude":  7.4453,
        "longitude": 125.8091,
        "signal_status": "unsignalized",
        "expected_warrants": ["W4"],
        "hour_profile": _w4_pedestrian_school_profile,
        # Pedestrian-heavy. Vehicles car-skewed so combined moto/tri/pedicab
        # stays well below W-Local 1's 0.6 threshold.
        "class_weights": {
            "pedestrian": 0.50,
            "car":        0.30,
            "motorcycle": 0.08,
            "tricycle":   0.05,
            "truck":      0.04,
            "pedicab":    0.03,
        },
        "streets": [
            {"name": "NB - Rizal Street",    "direction": "northbound", "peak": 700},
            {"name": "SB - Rizal Street",    "direction": "southbound", "peak": 680},
            {"name": "EB - Coryville Road",  "direction": "eastbound",  "peak": 460},
            {"name": "WB - Coryville Road",  "direction": "westbound",  "peak": 440},
        ],
    },
    {
        # Mankilam barangay loop - barangay roads with tricycle/motorcycle
        # dominance characteristic of Tagum's inner residential network.
        "name": "Mankilam Barangay Junction (W-Local 1 - motorcycle mix)",
        "latitude":  7.4422,
        "longitude": 125.8228,
        "signal_status": "unsignalized",
        "expected_warrants": ["W-Local 1"],
        "hour_profile": _w_local_1_flat_profile,
        "class_weights": MOTORCYCLE_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Mankilam Road",       "direction": "northbound", "peak": 150},
            {"name": "SB - Mankilam Road",       "direction": "southbound", "peak": 140},
            {"name": "EB - Apokon Side Road",    "direction": "eastbound",  "peak":  90},
            {"name": "WB - Apokon Side Road",    "direction": "westbound",  "peak":  85},
        ],
    },
    {
        # Tagum City Hall Junction (Apokon x Lapu-Lapu) - government district
        # with office-hours peak concentration.
        "name": "Tagum City Hall Junction (W-Local 2 - peak concentration)",
        "latitude":  7.4478,
        "longitude": 125.8112,
        "signal_status": "fixed_time",
        "expected_warrants": ["W-Local 2"],
        "hour_profile": _peak_concentration_profile,
        "class_weights": CAR_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Apokon Road",     "direction": "northbound", "peak": 880},
            {"name": "SB - Apokon Road",     "direction": "southbound", "peak": 840},
            {"name": "EB - Lapu-Lapu Street","direction": "eastbound",  "peak": 320},
            {"name": "WB - Lapu-Lapu Street","direction": "westbound",  "peak": 300},
        ],
    },
    {
        # La Filipina x N909 Tagum Diversion Road - outer ring road; quiet
        # overnight enough that the lights-off recommendation is viable.
        "name": "La Filipina-Diversion Junction (W-Local 3 - lights off)",
        "latitude":  7.4612,
        "longitude": 125.7960,
        "signal_status": "fixed_time",
        "expected_warrants": ["W-Local 3"],
        "hour_profile": _lights_off_profile,
        "class_weights": CAR_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Tagum Diversion Road",  "direction": "northbound", "peak": 80},
            {"name": "SB - Tagum Diversion Road",  "direction": "southbound", "peak": 75},
            {"name": "EB - La Filipina Road",      "direction": "eastbound",  "peak": 35},
            {"name": "WB - La Filipina Road",      "direction": "westbound",  "peak": 30},
        ],
    },
    {
        # Cuambogan residential barangay - the "nothing-to-do" baseline.
        "name": "Cuambogan Residential Junction (baseline - all clear)",
        "latitude":  7.4380,
        "longitude": 125.8268,
        "signal_status": "unsignalized",
        "expected_warrants": [],  # nothing fires
        "hour_profile": _baseline_flat_profile,
        "class_weights": CAR_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Cuambogan Road",      "direction": "northbound", "peak": 80},
            {"name": "SB - Cuambogan Road",      "direction": "southbound", "peak": 75},
            {"name": "EB - San Miguel Side Lane","direction": "eastbound",  "peak": 70},
            {"name": "WB - San Miguel Side Lane","direction": "westbound",  "peak": 65},
        ],
    },
    {
        # Magugpo East at Kar Asia (the corner that triggered the 1.6 km
        # Daang Maharlika flyover in real life). Already signalized, but
        # demand is so high that post-Webster critical v/c stays above 0.90 -
        # the rules engine then escalates from timing_only -> road_widening.
        # Note: this scenario intentionally triggers W1+W2+W3 simultaneously
        # since road_widening is an *intervention* output, not a single
        # warrant. The unique signal here is the intervention class itself.
        "name": "Magugpo East-Kar Asia Junction (widen - over capacity)",
        "latitude":  7.4565,
        "longitude": 125.8210,
        "signal_status": "fixed_time",
        "expected_warrants": ["W1", "W2", "W3"],
        "hour_profile": _road_widening_profile,
        "class_weights": CAR_HEAVY_WEIGHTS,
        "streets": [
            {"name": "NB - Daang Maharlika (toward CAP Building)",      "direction": "northbound", "peak": 1100},
            {"name": "SB - Daang Maharlika (toward Magugpo East)",      "direction": "southbound", "peak": 1050},
            {"name": "EB - Magugpo East Arterial",                      "direction": "eastbound",  "peak":  720},
            {"name": "WB - Magugpo East Arterial",                      "direction": "westbound",  "peak":  680},
        ],
    },
]


def seed_rtsp_scenarios(db, days: int = 7):
    """Seed 8 intersections - one per warrant output + 1 baseline - with
    rtsp://<current-LAN-IP>/cam{1..4} URLs.

    Re-runnable (option b): on every call, every scenario intersection has its
    detections and timing recommendations wiped, then refilled with `days`
    of TOD-patterned traffic. Every camera's rtsp_url is rewritten to the
    freshly-detected LAN IP so URLs always follow the host.
    """
    from sqlalchemy import text

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    fill_start = now - timedelta(days=days)
    # Fill 48 hours past "now" so demos remain valid for a full day even
    # without a re-seed. The analyzer reads the "previous complete hour"
    # window, which shifts forward as the wall clock ticks; without this
    # buffer, _compute_features returns zeros within an hour of seeding and
    # _analyze bails out with _empty_analysis -> recommended=False everywhere.
    # Pair with a periodic reseed (see scripts/reseed-rtsp.sh) so the buffer
    # never actually expires in practice.
    fill_end = now + timedelta(hours=48)

    sample_url = _build_rtsp_url(1)
    print(f"Seeding RTSP single-output scenarios ({days} days + 48h buffer)")
    print(f"  RTSP URL template: {sample_url[:sample_url.rfind('/')]}/cam{{1..4}}")
    print(f"  Range: {fill_start.strftime('%Y-%m-%d %H:%M')} → {fill_end.strftime('%Y-%m-%d %H:%M')} UTC")
    print()

    for spec in RTSP_SCENARIOS:
        warrants_label = ", ".join(spec["expected_warrants"]) if spec["expected_warrants"] else "(none - baseline)"
        print(f"─ {spec['name']} ({spec['signal_status']})")
        print(f"    expected warrant: {warrants_label}")

        intersection = db.query(Intersection).filter_by(name=spec["name"]).first()
        if intersection is None:
            intersection = Intersection(
                name=spec["name"],
                latitude=spec["latitude"],
                longitude=spec["longitude"],
            )
            db.add(intersection)
            db.flush()
            seed_tod_chunks(db, intersection.id)
            print(f"    [new] id={intersection.id}")
        else:
            print(f"    [reuse] id={intersection.id}")

        # Option-(b) idempotency: wipe detections and timing recs every run.
        cctv_ids = [c.id for c in intersection.cctvs]
        if cctv_ids:
            db.execute(text("DELETE FROM detections WHERE cctv_id = ANY(:ids)"), {"ids": cctv_ids})
        db.execute(text(
            "DELETE FROM timing_recommendations WHERE intersection_id = :iid"
        ), {"iid": intersection.id})
        db.flush()

        # Normalize class weights for random.choices.
        raw_weights = spec["class_weights"]
        weights_total = sum(raw_weights.values())
        weights = {k: v / weights_total for k, v in raw_weights.items()}
        hour_profile = spec["hour_profile"]

        for cam_idx, s in enumerate(spec["streets"], start=1):
            cam_name = f"{spec['name']} - cam{cam_idx}"
            rtsp_url = _build_rtsp_url(cam_idx)

            street = db.query(Street).filter_by(
                intersection_id=intersection.id, name=s["name"]
            ).first()
            if not street:
                street = Street(
                    intersection_id=intersection.id,
                    name=s["name"],
                    arm_direction=s.get("direction", "unknown"),
                )
                db.add(street)
                db.flush()
            elif street.arm_direction != s.get("direction"):
                street.arm_direction = s["direction"]

            cctv = db.query(CCTV).filter_by(
                intersection_id=intersection.id, name=cam_name
            ).first()
            if cctv is None:
                cctv = CCTV(
                    intersection_id=intersection.id,
                    name=cam_name,
                    rtsp_url=rtsp_url,
                    status="offline",
                )
                db.add(cctv)
                db.flush()
            else:
                # Always rewrite to current LAN IP so URLs follow the host.
                cctv.rtsp_url = rtsp_url

            region = db.query(Region).filter_by(cctv_id=cctv.id, street_id=street.id).first()
            if region is None:
                region = Region(cctv_id=cctv.id, street_id=street.id, direction="inbound")
                db.add(region)
                db.flush()
                for x, y in [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]:
                    db.add(RegionPoint(region_id=region.id, x=x, y=y))
                db.flush()
            elif region.direction != "inbound":
                region.direction = "inbound"

            total = 0
            cursor = fill_start
            while cursor < fill_end:
                hour_factor = hour_profile(cursor.hour)
                dow_factor  = WEEKEND_MULTIPLIER if cursor.weekday() >= 5 else WEEKDAY_MULTIPLIER
                jitter      = random.uniform(0.90, 1.10)
                count       = max(0, round(s["peak"] * hour_factor * dow_factor * jitter))
                if count > 0:
                    _insert_exact_hour(db, cctv.id, region.id, cursor, count, weights)
                    total += count
                cursor += timedelta(hours=1)
            print(f"    {s['name']:<28} peak={s['peak']:>4}/hr  rtsp_url={rtsp_url}  total={total:>7,}")

        # Match the existing scenario timing setup so Webster has something to
        # propose against on the fixed_time scenarios.
        if spec["signal_status"] == "fixed_time":
            streets = list(db.query(Street).filter_by(intersection_id=intersection.id).all())
            existing_cycle = 100
            n_phases = max(len(streets), 1)
            g_phase = max(
                round((existing_cycle - n_phases * (4 + 3)) / n_phases, 1),
                17.0,
            )
            intersection.signal_status         = "fixed_time"
            intersection.existing_cycle_length = existing_cycle
            intersection.existing_green_splits = {str(st.id): g_phase for st in streets}
        else:
            intersection.signal_status         = "unsignalized"
            intersection.existing_cycle_length = None
            intersection.existing_green_splits = None
        db.commit()
        print()

    # Force-refresh the TimescaleDB continuous aggregate so the new detections
    # are immediately visible to Webster / the recommendation pipeline.
    print("Refreshing continuous aggregate …")
    try:
        raw = db.connection().engine.raw_connection()
        try:
            raw.autocommit = True
            cur = raw.cursor()
            cur.execute("CALL refresh_continuous_aggregate('aggregation_summaries', NULL, NULL);")
            cur.close()
        finally:
            raw.close()
    except Exception as e:
        print(f"  (skipped: {e}; policy will catch up within ~1 min)")
    print()
    print("Done. Expected outputs after 'Run all analyses':")
    for spec in RTSP_SCENARIOS:
        wl = ", ".join(spec["expected_warrants"]) if spec["expected_warrants"] else "no warrants - baseline"
        print(f"  • {spec['name']}  →  {wl}")


# ---------------------------------------------------------------------------
# Signalize one existing intersection (apply scenario treatment in-place)
# ---------------------------------------------------------------------------

def signalize_intersection(db, intersection_id: int, peak: int, weights: dict, days: int = 7):
    """Make an existing intersection a `fixed_time` signalized scenario.

    Wipes its detection history, fills `days` days of TOD-patterned traffic
    against its existing cameras/regions, and sets a deliberately suboptimal
    equal-split existing timing so Webster's proposal has something to beat.

    Use this when you want to demo the retune flow on an intersection that
    already exists (with its real-world name / streets), instead of adding
    yet another demo intersection like seed_scenarios() does.
    """
    from sqlalchemy import text

    intersection = db.get(Intersection, intersection_id)
    if intersection is None:
        print(f"Error: intersection id={intersection_id} not found")
        return

    print(f"Signalizing '{intersection.name}' (id={intersection.id}) …")
    print(f"  Peak: {peak} det/hr/camera at busiest hour")

    cctv_ids = [c.id for c in intersection.cctvs]
    if not cctv_ids:
        print("  No cameras under this intersection - run --seed first or add cameras.")
        return

    # Wipe old detection rows so the new TOD pattern isn't muddied by stale data.
    db.execute(text(
        "DELETE FROM detections WHERE cctv_id = ANY(:ids)"
    ), {"ids": cctv_ids})
    # Also drop stale timing recommendations so the page shows the fresh plan.
    db.execute(text(
        "DELETE FROM timing_recommendations WHERE intersection_id = :iid"
    ), {"iid": intersection.id})
    db.flush()

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    fill_start = now - timedelta(days=days)
    print(f"  Range: {fill_start.strftime('%Y-%m-%d %H:%M')} → {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print()

    # Fill every (cctv, region) pair under this intersection with TOD pattern.
    pairs: list[tuple[int, int]] = []
    for cctv in intersection.cctvs:
        for region in cctv.regions:
            pairs.append((cctv.id, region.id))

    for cctv_id, region_id in pairs:
        total = 0
        cursor = fill_start
        while cursor < now:
            hour_factor = HOUR_MULTIPLIERS[cursor.hour]
            dow_factor  = WEEKEND_MULTIPLIER if cursor.weekday() >= 5 else WEEKDAY_MULTIPLIER
            jitter      = random.uniform(0.90, 1.10)
            count       = max(0, round(peak * hour_factor * dow_factor * jitter))
            if count > 0:
                _insert_exact_hour(db, cctv_id, region_id, cursor, count, weights)
                total += count
            cursor += timedelta(hours=1)
        print(f"    CCTV {cctv_id} / Region {region_id} → {total:>7,} detections")

    # Existing timing: 4-phase equal-split at C=100s. Deliberately suboptimal
    # so Webster's per-approach reallocation produces a visible improvement.
    existing_cycle = 100
    lost_per_phase = 4 + 3  # lost_time_per_phase + all_red_clearance
    streets = list(db.query(Street).filter_by(intersection_id=intersection.id).all())
    n_phases = max(len(streets), 1)
    g_phase = max(
        round((existing_cycle - n_phases * lost_per_phase) / n_phases, 1),
        17.0,  # DPWH pedestrian minimum
    )
    splits = {str(st.id): g_phase for st in streets}

    intersection.signal_status         = "fixed_time"
    intersection.existing_cycle_length = existing_cycle
    intersection.existing_green_splits = splits
    db.commit()

    # Force-refresh the continuous aggregate. Webster's pcu_flow_per_street
    # queries `aggregation_summaries` exclusively, so without this the freshly
    # inserted detections look invisible until the policy refresh runs (~1 min).
    print()
    print("  Refreshing continuous aggregate so Webster sees the new data …")
    try:
        # CALL must run outside the SQLAlchemy transaction TimescaleDB rejects
        # nested ones. AUTOCOMMIT isolation level handles this cleanly.
        raw = db.connection().engine.raw_connection()
        try:
            raw.autocommit = True
            cur = raw.cursor()
            cur.execute("CALL refresh_continuous_aggregate('aggregation_summaries', NULL, NULL);")
            cur.close()
        finally:
            raw.close()
    except Exception as e:
        print(f"  (refresh skipped: {e}; the policy refresh will pick it up within ~1 min)")

    print()
    print(f"  → signal_status = fixed_time")
    print(f"  → existing_cycle_length = {existing_cycle}s")
    print(f"  → existing_green_splits = {g_phase}s/phase × {n_phases} streets (equal split)")
    print()
    print("Done. Run 'Generate' on the recommendations page now to see Webster vs existing.")


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------

def list_data(db):
    from sqlalchemy import text

    intersections = db.query(Intersection).all()
    if not intersections:
        print("No data found. Run --seed first.")
        return

    counts_rows = db.execute(text(
        "SELECT cctv_id, COUNT(*) AS cnt FROM detections GROUP BY cctv_id"
    )).fetchall()
    det_counts: dict[int, int] = {r.cctv_id: r.cnt for r in counts_rows}

    for i in intersections:
        print(f"\nIntersection id={i.id} '{i.name}' ({i.latitude}, {i.longitude})")
        for cctv in i.cctvs:
            det_count = det_counts.get(cctv.id, 0)
            print(f"  CCTV id={cctv.id} '{cctv.name}' status={cctv.status} "
                  f"detections={det_count:,}")
            for region in cctv.regions:
                print(f"    Region id={region.id} street='{region.street.name}' "
                      f"points={len(region.region_points)}")

    total_det = db.execute(text("SELECT COUNT(*) FROM detections")).scalar()
    total_agg = db.execute(text("SELECT COUNT(*) FROM aggregation_summaries")).scalar()
    print(f"\nTotals: {total_det:,} detections · {total_agg:,} aggregation buckets")

    recs = db.execute(text(
        "SELECT COUNT(*) FROM recommendations WHERE recommended = TRUE"
    )).scalar()
    print(f"Recommendations: {recs} intersections warranted")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Fake detection data tool")

    parser.add_argument("--seed",      action="store_true",
                        help="Seed intersections, streets, CCTVs, regions (idempotent)")
    parser.add_argument("--fill", "--fill-all", action="store_true",
                        help="Bulk-fill all cameras/regions with realistic traffic data")
    parser.add_argument("--full",      action="store_true",
                        help="--seed then --fill (recommended for a clean DB)")
    parser.add_argument("--scenarios", "--scenario", action="store_true",
                        help="Seed 'Visayan Ave' (warranted) + 'Caryving Rd' (borderline) demo intersections")
    parser.add_argument("--signalize", type=int, default=None, metavar="INT_ID",
                        help="Convert an existing intersection (by id) into a fixed-time "
                             "signalized scenario: wipes its detections, fills 7 days of "
                             "TOD-patterned traffic, sets suboptimal equal-split timing so "
                             "Webster's proposal has something to beat")
    parser.add_argument("--demo", action="store_true",
                        help="Seed two clean demo intersections - one warranted+signalized "
                             "with clear Webster improvement, one not-warranted+unsignalized "
                             "that exercises the gating logic. All six detection classes "
                             "present, 7 days of TOD-patterned traffic. Re-runnable.")
    parser.add_argument("--cnn", action="store_true",
                        help="Seed five CNN-targeted scenarios that together exercise every "
                             "warrant (W1-W4, W-Local 2, W-Local 3) and intervention class "
                             "(signalize, road_widening, timing_only). Re-runnable.")
    parser.add_argument("--rtsp", action="store_true",
                        help="Seed 8 single-output intersections (one per warrant W1/W2/W3/W4/"
                             "W-Local 1/W-Local 2/W-Local 3 + 1 baseline) with rtsp_url set to "
                             "rtsp://<current-LAN-IP>/cam{1..4}. Re-runnable: detections wiped + "
                             "refilled and every rtsp_url rewritten to current IP each run. "
                             "Override host/port via RTSP_HOST / RTSP_PORT env vars.")
    parser.add_argument("--peak", type=int, default=280,
                        help="Peak detections/hour at busiest hour for --signalize (default: 280)")
    parser.add_argument("--list",      action="store_true",
                        help="List existing data and counts")

    parser.add_argument("--days",      type=int,   default=14,
                        help="Days of history to generate with --fill (default: 14)")
    parser.add_argument("--future",    action="store_true",
                        help="With --fill, generate detections going forward from now "
                             "instead of backward (default: backward)")

    # Legacy single-camera mode
    parser.add_argument("--cctv-id",   type=int,   default=None)
    parser.add_argument("--region-id", type=int,   default=None)
    parser.add_argument("--count",     type=int,   default=500,
                        help="Number of detections (legacy --cctv-id mode)")
    parser.add_argument("--hours",     type=float, default=2.0,
                        help="Time range in hours (legacy --cctv-id mode)")
    parser.add_argument("--weights",   type=str,   default=None,
                        help="Object type weights e.g. tricycle=0.35,motorcycle=0.30,…")

    args = parser.parse_args()

    weights = parse_weights(args.weights) if args.weights else DEFAULT_WEIGHTS

    db = SessionLocal()
    try:
        if args.full:
            seed_base_data(db)
            fill_all(db, args.days, weights, future=args.future)
            return

        if args.seed:
            seed_base_data(db)
            return

        if args.scenarios:
            seed_scenarios(db, weights)
            return

        if args.signalize is not None:
            signalize_intersection(db, args.signalize, args.peak, weights)
            return

        if args.demo:
            seed_demo(db)
            return

        if args.cnn:
            seed_cnn_scenarios(db, days=args.days if args.days != 14 else 7)
            return

        if args.rtsp:
            seed_rtsp_scenarios(db, days=args.days if args.days != 14 else 7)
            return

        if args.fill:
            fill_all(db, args.days, weights, future=args.future)
            return

        if args.list:
            list_data(db)
            return

        # Legacy single-camera mode
        if not args.cctv_id or not args.region_id:
            print("Error: provide --cctv-id and --region-id, or use --seed / --fill / --full")
            sys.exit(1)

        print(f"Inserting {args.count} detections over {args.hours} hours …")
        print(f"  CCTV:    {args.cctv_id}")
        print(f"  Region:  {args.region_id}")
        print(f"  Weights: {weights}")
        print()

        inserted = insert_detections(
            db, args.cctv_id, args.region_id, args.count, args.hours, weights
        )
        print(f"Done. Inserted {inserted} detections.")
        print()
        print("Wait ~1 minute for aggregation_summaries to refresh, then check:")
        print("  SELECT * FROM aggregation_summaries ORDER BY window_start DESC LIMIT 20;")

    finally:
        db.close()


if __name__ == "__main__":
    main()
