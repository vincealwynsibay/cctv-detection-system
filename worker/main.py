import argparse
import json as _json
import os
import queue
import signal
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Set

import cv2
import numpy as np
import redis as redis_lib
from sqlalchemy import text
from sqlalchemy.orm import Session
from ultralytics import YOLO

from common import models
from common.database import Base, SessionLocal, engine
from common.durable import emit_enforcement_event
from common.geometry import is_point_in_polygon
from common.overlay import draw_boxes as overlay_draw_boxes
from worker.claim import try_claim_camera, release_camera, verify_claim
from worker.heartbeat import HeartbeatThread
from worker.stream import open_stream, reconnect_stream, resolve_rtsp_url, _stream_is_live

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
_redis = redis_lib.from_url(REDIS_URL)

CAMERAS_PER_WORKER    = int(os.getenv("CAMERAS_PER_WORKER", "16"))
INFERENCE_EVERY_N     = int(os.getenv("INFERENCE_EVERY_N", "1"))   # process 1-in-N frames for DB writes
READER_MAX_FPS        = float(os.getenv("READER_MAX_FPS", "0"))    # 0 = unlimited (cap reader thread rate)
# When enabled, this worker also publishes the annotated JPEG of each
# processed frame to Redis, so the server's WS endpoint can just relay
# them instead of opening its own RTSP capture per camera. Eliminates
# duplicate decode + the box/frame timestamp matching dance.
PUBLISH_FRAMES        = os.getenv("WORKER_PUBLISHES_FRAMES", "0") == "1"
FRAME_JPEG_QUALITY    = int(os.getenv("WORKER_FRAME_JPEG_QUALITY", "75"))
# When 1, emit a durable enforcement-event to the Redis Stream on each new
# vehicle track (drained to enforcement_events by sink/sink.py). Default 0 =
# off, so the existing detection path is completely unchanged. This is the seam
# future plate-OCR / violation classifiers plug into.
EMIT_ENFORCEMENT      = os.getenv("DURABLE_ENFORCEMENT", "0") == "1"
ENFORCEMENT_CLASSES   = {"car", "motorcycle", "truck", "bus", "jeepney"}
PRUNE_INTERVAL_SEC    = 10
TRACK_MAX_AGE_SEC     = 30
FPS_SAMPLE_INTERVAL   = 30
FLUSH_INTERVAL_SEC    = 0.3
MAX_BUFFER_SIZE       = 1000
CLAIM_CHECK_FRAMES    = 100
CLAIM_CHECK_INTERVAL  = 15.0  # time-based verify_claim - catches reconnecting slots
RECLAIM_INTERVAL      = 5.0   # seconds between slot-fill attempts
REGION_REFRESH_SEC    = 60.0  # re-read regions from DB in case polygons changed

_DUMMY_FRAME = np.zeros((480, 854, 3), dtype=np.uint8)


@dataclass
class TrackState:
    track_id: int
    cls_name: str
    db_detection_id: Optional[int] = None
    regions_entered: Set[int] = field(default_factory=set)
    last_seen_ts: float = field(default_factory=time.time)


@dataclass
class CameraSlot:
    cctv_id: int
    claim_version: int
    rtsp_url: str
    regions: list
    track_states: dict = field(default_factory=dict)
    dir_buffer: deque = field(default_factory=deque)
    frame_q: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=1))
    fps_ref: list = field(default_factory=lambda: [0.0])
    heartbeat: Optional[HeartbeatThread] = None
    reader_thread: Optional[threading.Thread] = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    frame_count: int = 0
    last_flush_ts: float = field(default_factory=time.time)
    last_prune_ts: float = field(default_factory=time.time)
    fps_timer_start: float = field(default_factory=time.time)
    claim_lost: bool = False
    last_frame: Optional[np.ndarray] = None
    last_region_refresh_ts: float = field(default_factory=time.time)
    last_claim_check_ts: float = field(default_factory=time.time)


def _camera_reader(
    rtsp_url: str,
    cctv_id: int,
    frame_q: queue.Queue,
    stop_event: threading.Event,
    args: argparse.Namespace,
) -> None:
    """Read frames from one RTSP stream, always keeping the queue fresh."""
    db = SessionLocal()
    cap = open_stream(rtsp_url, args.debug)
    if not _stream_is_live(cap):
        cap.release()
        cap = reconnect_stream(rtsp_url, args.debug, db, cctv_id)

    min_frame_interval = (1.0 / READER_MAX_FPS) if READER_MAX_FPS > 0 else 0.0
    last_frame_ts = 0.0

    try:
        while not stop_event.is_set():
            ret, frame = cap.read()
            # drain extra buffered frames to stay current
            for _ in range(2):
                ok, fresh = cap.read()
                if ok:
                    frame = fresh

            if not ret:
                cap.release()
                if stop_event.is_set():
                    break
                cap = reconnect_stream(rtsp_url, args.debug, db, cctv_id)
                continue

            # rate cap: drop frames that arrive faster than READER_MAX_FPS
            if min_frame_interval > 0:
                now = time.time()
                elapsed = now - last_frame_ts
                if elapsed < min_frame_interval:
                    continue
                last_frame_ts = now

            # replace stale frame in queue with latest
            try:
                frame_q.get_nowait()
            except queue.Empty:
                pass
            try:
                frame_q.put_nowait(frame)
            except queue.Full:
                pass
    finally:
        cap.release()
        db.close()


def _start_slot(cctv: models.CCTV, claim_version: int, args: argparse.Namespace, db: Session) -> CameraSlot:
    rtsp_url = resolve_rtsp_url(cctv, args)
    slot = CameraSlot(
        cctv_id=cctv.id,
        claim_version=claim_version,
        rtsp_url=rtsp_url,
        regions=initialize_regions(db, cctv.id),
    )
    slot.reader_thread = threading.Thread(
        target=_camera_reader,
        args=(rtsp_url, cctv.id, slot.frame_q, slot.stop_event, args),
        daemon=True,
        name=f"reader-cam{cctv.id}",
    )
    slot.reader_thread.start()
    slot.heartbeat = HeartbeatThread(cctv_id=cctv.id, fps_ref=slot.fps_ref, reader_thread=slot.reader_thread)
    slot.heartbeat.start()
    print(f"[worker] slot started cctv={cctv.id} name='{cctv.name}'")
    return slot


def _stop_slot(slot: CameraSlot, db: Session, release: bool) -> None:
    slot.stop_event.set()
    slot.heartbeat.stop()
    slot.heartbeat.join(timeout=5)
    flush_detection_buffer(db, slot.dir_buffer)
    if release:
        release_camera(db, slot.cctv_id)
    print(f"[worker] slot stopped cctv={slot.cctv_id} release={release}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default="admin")
    parser.add_argument("--port",    type=int, default=554)
    parser.add_argument("--channel", type=int, default=1)
    parser.add_argument("--subtype", action="store_true")
    parser.add_argument("--debug",   action="store_true")
    parser.add_argument("--show",    action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    print(f"[worker] ── config ──────────────────────────────")
    print(f"[worker]   DATABASE_URL       = {os.getenv('DATABASE_URL', '(default)')}")
    print(f"[worker]   REDIS_URL          = {os.getenv('REDIS_URL', '(default)')}")
    print(f"[worker]   MODEL_VERSION      = {os.getenv('MODEL_VERSION', 'eyegila_v4')}")
    print(f"[worker]   MODEL_PATH         = {os.getenv('MODEL_PATH', '/app/model.pt')}")
    print(f"[worker]   CAMERAS_PER_WORKER = {CAMERAS_PER_WORKER}")
    print(f"[worker]   INFERENCE_EVERY_N  = {INFERENCE_EVERY_N}")
    print(f"[worker]   READER_MAX_FPS     = {READER_MAX_FPS if READER_MAX_FPS > 0 else 'unlimited'}")
    print(f"[worker]   PUBLISH_FRAMES     = {PUBLISH_FRAMES} (jpeg q={FRAME_JPEG_QUALITY})")
    print(f"[worker]   FERNET_KEY         = {'set' if os.getenv('FERNET_KEY') else 'NOT SET'}")
    print(f"[worker] ────────────────────────────────────────")

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    # Guard the DDL with an existence check so ALTER TABLE (which acquires
    # AccessExclusiveLock even with IF NOT EXISTS) is never run after the
    # initial migration - the hot-restart path stays completely lock-free.
    try:
        needs_col = not db.execute(text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'worker_heartbeats' AND column_name = 'last_error'"
        )).scalar()
        if needs_col:
            db.execute(text(
                "ALTER TABLE worker_heartbeats ADD COLUMN last_error VARCHAR(500)"
            ))
        db.commit()
    except Exception:
        db.rollback()
    model = _load_model()

    # warm up GPU kernels so first real frame isn't slow
    _dummy = np.zeros((480, 854, 3), dtype=np.uint8)
    model([_dummy], verbose=False)
    print(f"[worker] model warmed up, claiming up to {CAMERAS_PER_WORKER} cameras")

    slots: list[CameraSlot] = []

    _shutdown = threading.Event()
    def _sigterm(sig, frame):
        print("[worker] SIGTERM received, shutting down...")
        _shutdown.set()
    signal.signal(signal.SIGTERM, _sigterm)

    # claim initial batch of cameras
    while len(slots) < CAMERAS_PER_WORKER:
        result = try_claim_camera(db)
        if result is None:
            break
        cctv, version = result
        slots.append(_start_slot(cctv, version, args, db))

    last_claim_attempt = time.time()
    prev_slot_ids: list = []

    try:
        while not _shutdown.is_set():
            now = time.time()

            # fill any open slots
            if len(slots) < CAMERAS_PER_WORKER and now - last_claim_attempt >= RECLAIM_INTERVAL:
                result = try_claim_camera(db)
                if result is not None:
                    cctv, version = result
                    slots.append(_start_slot(cctv, version, args, db))
                last_claim_attempt = now

            target_h, target_w = _DUMMY_FRAME.shape[:2]

            # When slot composition changes, reset trackers so tracker[i] always
            # corresponds to slots[i] - prevents track ID bleed after a camera
            # is added or removed.
            slot_ids = [s.cctv_id for s in slots]
            if slot_ids != prev_slot_ids:
                predictor = getattr(model, 'predictor', None)
                if predictor is not None and hasattr(predictor, 'trackers'):
                    del predictor.trackers
                prev_slot_ids = slot_ids

            # Collect one frame per slot. Slots without a new frame reuse their
            # last-known frame so the batch size stays constant and tracker[i]
            # keeps mapping to slots[i] across cycles.
            frames: list = []
            new_mask: list = []
            for slot in slots:
                try:
                    frame = slot.frame_q.get_nowait()
                    slot.last_frame = frame
                    new_mask.append(True)
                except queue.Empty:
                    frame = slot.last_frame
                    new_mask.append(False)
                if frame is None:
                    frame = _DUMMY_FRAME
                elif frame.shape[:2] != (target_h, target_w):
                    frame = cv2.resize(frame, (target_w, target_h))
                frames.append(frame)

            any_new = any(new_mask)

            if any_new:
                Path("/tmp/worker-alive").touch()

                # Single batched GPU call for all cameras
                batch_results = model.track(frames, persist=True, verbose=args.verbose)

                for slot, result, is_new in zip(slots, batch_results, new_mask):
                    if not is_new:
                        continue

                    slot.frame_count += 1
                    frame_h, frame_w = result.orig_img.shape[:2]

                    # publish bounding boxes to Redis for camera_ws overlay (every frame)
                    # Include all detections regardless of track ID so the live
                    # overlay shows boxes even before BoT-SORT confirms a track.
                    try:
                        boxes_payload = []
                        for box in result.boxes:
                            bx1, by1, bx2, by2 = box.xyxy[0].tolist()
                            boxes_payload.append({
                                "track_id":    int(box.id[0]) if box.id is not None else -1,
                                "object_type": model.names[int(box.cls[0])],
                                "confidence":  round(float(box.conf[0]), 3),
                                "x1": round(bx1 / frame_w, 4),
                                "y1": round(by1 / frame_h, 4),
                                "x2": round(bx2 / frame_w, 4),
                                "y2": round(by2 / frame_h, 4),
                            })
                        payload = _json.dumps({
                            "v":     1,
                            "ts":    now,
                            "boxes": boxes_payload,
                        })
                        _redis.setex(f"cam:{slot.cctv_id}:detections", 5, payload)
                        _redis.publish(f"cam:{slot.cctv_id}:detections:ch", payload)
                    except Exception:
                        pass

                    # Publish annotated JPEG so the server's WS can relay it
                    # straight to the browser, instead of opening its own RTSP
                    # capture. Doing the encode here once is cheaper than
                    # doing it twice (here for archival + on the server for
                    # the live preview), and the boxes are guaranteed to be
                    # on the right frame because they came from the same
                    # inference call.
                    if PUBLISH_FRAMES:
                        try:
                            annotated = result.orig_img.copy()
                            overlay_draw_boxes(annotated, boxes_payload)
                            ok, jpeg = cv2.imencode(
                                ".jpg", annotated,
                                [cv2.IMWRITE_JPEG_QUALITY, FRAME_JPEG_QUALITY],
                            )
                            if ok:
                                jb = jpeg.tobytes()
                                _redis.setex(f"cam:{slot.cctv_id}:frame", 5, jb)
                                _redis.publish(f"cam:{slot.cctv_id}:frame:ch", jb)
                        except Exception:
                            pass

                    # frame skipping: skip DB writes on non-sampled frames
                    if INFERENCE_EVERY_N > 1 and slot.frame_count % INFERENCE_EVERY_N != 0:
                        if args.show:
                            cv2.imshow(f"cctv-{slot.cctv_id}", result.orig_img)
                        continue

                    # per-detection DB processing
                    for box in result.boxes:
                        if box.id is None:
                            continue
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        process_detection(
                            db, slot.regions, slot.track_states,
                            int(box.id[0]),
                            model.names[int(box.cls[0])],
                            float(box.conf[0]),
                            (x1, y1, x2, y2),
                            slot.cctv_id, frame_w, frame_h,
                            slot.dir_buffer,
                        )

                    if args.show:
                        annotated = result.plot()
                        annotated = draw_regions(annotated, slot.regions, frame_w, frame_h)
                        cv2.imshow(f"cctv-{slot.cctv_id}", annotated)

                    # FPS sample
                    if slot.frame_count % FPS_SAMPLE_INTERVAL == 0:
                        elapsed = now - slot.fps_timer_start
                        slot.fps_ref[0] = round(FPS_SAMPLE_INTERVAL / elapsed if elapsed > 0 else 0, 1)
                        slot.fps_timer_start = now

                    # flush detection buffer
                    if now - slot.last_flush_ts >= FLUSH_INTERVAL_SEC:
                        flush_detection_buffer(db, slot.dir_buffer)
                        slot.last_flush_ts = now

                    # prune stale tracks
                    if now - slot.last_prune_ts >= PRUNE_INTERVAL_SEC:
                        prune_tracks(slot.track_states)
                        slot.last_prune_ts = now

                    # refresh region polygons in case they changed in the DB
                    if now - slot.last_region_refresh_ts >= REGION_REFRESH_SEC:
                        _rdb = SessionLocal()
                        try:
                            slot.regions = initialize_regions(_rdb, slot.cctv_id)
                        finally:
                            _rdb.close()
                        slot.last_region_refresh_ts = now

                    # verify claim fencing token
                    if slot.frame_count % CLAIM_CHECK_FRAMES == 0:
                        if not verify_claim(db, slot.cctv_id, slot.claim_version):
                            slot.claim_lost = True

            if not any_new:
                time.sleep(0.01)

            if args.show and cv2.waitKey(1) & 0xFF == ord("q"):
                break

            # time-based claim check - runs even when no frames arrive (reconnecting cameras)
            for slot in slots:
                if not slot.claim_lost and now - slot.last_claim_check_ts >= CLAIM_CHECK_INTERVAL:
                    if not verify_claim(db, slot.cctv_id, slot.claim_version):
                        print(f"[worker] time-based verify_claim lost cctv={slot.cctv_id}, evicting")
                        slot.claim_lost = True
                    slot.last_claim_check_ts = now

            # evict slots that lost their claim
            lost = [s for s in slots if s.claim_lost]
            for slot in lost:
                slots.remove(slot)
                _stop_slot(slot, db, release=False)

    finally:
        if args.show:
            cv2.destroyAllWindows()
        for slot in slots:
            _stop_slot(slot, db, release=True)
        db.close()


# ── helpers ────────────────────────────────────────────────────────────────────

def _load_model() -> YOLO:
    model_ver    = os.getenv("MODEL_VERSION", "eyegila_v4")
    trt_cache    = os.getenv("TRT_CACHE_DIR", "/app/trt_cache")
    engine_path  = Path(trt_cache) / f"{model_ver}.engine"
    weights_path = Path(os.getenv("MODEL_PATH", "/app/model.pt"))

    if engine_path.exists():
        if CAMERAS_PER_WORKER > 1:
            print(
                f"[worker] NOTE: TRT engine loaded with CAMERAS_PER_WORKER={CAMERAS_PER_WORKER}. "
                f"Ensure the engine was exported with dynamic=True for true batching. "
                f"Export once with: model.export(format='engine', dynamic=True, device=0)"
            )
        print(f"[worker] loading TensorRT FP16 engine: {engine_path}")
        return YOLO(str(engine_path), task="detect")

    if not weights_path.exists():
        raise FileNotFoundError(
            f"Model not found at '{weights_path}'. "
            f"Check that {model_ver}.pt exists in the project root and that the "
            f"docker-compose volume mount is correct "
            f"(expects ./{model_ver}.pt → /app/model.pt)."
        )

    # CPU / Mac path: no TRT engine available; run PyTorch weights on CPU.
    # This is normal and expected on machines without an NVIDIA GPU.
    print(f"[worker] running CPU inference from {weights_path} (no TRT engine)")
    return YOLO(str(weights_path))


def initialize_regions(db: Session, cctv_id: int) -> list[dict]:
    regions = []
    for db_region in db.query(models.Region).filter(models.Region.cctv_id == cctv_id).all():
        regions.append({
            "id": db_region.id,
            "street_id": db_region.street_id,
            "region_points": [{"id": pt.id, "x": pt.x, "y": pt.y}
                               for pt in db_region.region_points],
        })
    return regions


def process_detection(
    db: Session,
    regions: list[dict],
    track_states: dict,
    track_id: int,
    cls_name: str,
    confidence: float,
    bounding_box: tuple,
    cctv_id: int,
    frame_w: int,
    frame_h: int,
    dir_buffer: deque,
) -> None:
    x1, y1, x2, y2 = bounding_box
    cx = ((x1 + x2) / 2) / frame_w
    cy = ((y1 + y2) / 2) / frame_h
    center = (cx, cy)

    if track_id not in track_states:
        track_states[track_id] = TrackState(track_id=track_id, cls_name=cls_name)

    state = track_states[track_id]
    state.last_seen_ts = time.time()

    if state.db_detection_id is None:
        detection = models.Detection(
            cctv_id=cctv_id,
            track_id=track_id,
            object_type=cls_name,
            confidence=round(confidence, 4),
            x1=round(x1 / frame_w, 4),
            y1=round(y1 / frame_h, 4),
            x2=round(x2 / frame_w, 4),
            y2=round(y2 / frame_h, 4),
        )
        try:
            db.add(detection)
            db.flush()
        except Exception as e:
            print(f"[worker] detection write failed: {e}")
            db.rollback()
            return

        state.db_detection_id = int(detection.id)  # type: ignore

        # Durable enforcement-event seam (opt-in via DURABLE_ENFORCEMENT=1).
        # A new vehicle track becomes an enforcement candidate; plate OCR /
        # violation rules will fill in `plate` / `event_type` later. Emission is
        # best-effort and never blocks or crashes the detection loop.
        if EMIT_ENFORCEMENT and cls_name in ENFORCEMENT_CLASSES:
            emit_enforcement_event(
                cctv_id=cctv_id,
                track_id=track_id,
                vehicle_type=cls_name,
                confidence=confidence,
            )

        for region in regions:
            if is_point_in_polygon(center, [(p["x"], p["y"]) for p in region["region_points"]]):
                state.regions_entered.add(region["id"])
                if len(dir_buffer) >= MAX_BUFFER_SIZE:
                    dir_buffer.popleft()
                dir_buffer.append({"region_id": region["id"], "detection_id": state.db_detection_id})
        return

    for region in regions:
        region_id = region["id"]
        if (is_point_in_polygon(center, [(p["x"], p["y"]) for p in region["region_points"]])
                and region_id not in state.regions_entered):
            state.regions_entered.add(region_id)
            if len(dir_buffer) >= MAX_BUFFER_SIZE:
                dir_buffer.popleft()
            dir_buffer.append({"region_id": region_id, "detection_id": state.db_detection_id})


def flush_detection_buffer(db: Session, dir_buffer: deque) -> None:
    items = list(dir_buffer)
    dir_buffer.clear()
    try:
        if items:
            db.bulk_insert_mappings(models.DetectionInRegion, items)  # type: ignore
        db.commit()
    except Exception:
        db.rollback()
        bad_regions: set[int] = set()
        for item in items:
            try:
                db.execute(
                    text("INSERT INTO detections_in_regions (region_id, detection_id) VALUES (:r, :d)"),
                    {"r": item["region_id"], "d": item["detection_id"]},
                )
                db.commit()
            except Exception:
                db.rollback()
                bad_regions.add(item["region_id"])
        if bad_regions:
            print(f"[worker] skipped stale region_ids {bad_regions}")


def prune_tracks(track_states: dict, max_age_seconds: float = TRACK_MAX_AGE_SEC) -> None:
    now = time.time()
    stale = [tid for tid, s in track_states.items() if now - s.last_seen_ts > max_age_seconds]
    for tid in stale:
        del track_states[tid]


def draw_regions(frame: np.ndarray, regions: list, frame_w: int, frame_h: int) -> np.ndarray:
    colors = [(0, 255, 0), (255, 0, 0), (0, 165, 255), (0, 0, 255), (255, 0, 255)]
    for i, region in enumerate(regions):
        color = colors[i % len(colors)]
        points = region["region_points"]
        if len(points) < 3:
            continue
        pixel_pts = [(int(p["x"] * frame_w), int(p["y"] * frame_h)) for p in points]
        pts = np.array(pixel_pts, dtype=np.int32)
        cv2.polylines(frame, [pts], isClosed=True, color=color, thickness=2)
        cx = int(sum(p[0] for p in pixel_pts) / len(pixel_pts))
        cy = int(sum(p[1] for p in pixel_pts) / len(pixel_pts))
        cv2.putText(frame, f"region {region['id']} (street {region['street_id']})",
                    (cx, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
    return frame


if __name__ == "__main__":
    main()
