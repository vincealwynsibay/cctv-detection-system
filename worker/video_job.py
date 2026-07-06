"""
Video Processing Job
====================
Plain Python function enqueued by RQ. Reads a video file frame by frame,
runs YOLOv8 inference, writes detections and detections_in_regions, tracks
progress, and sends a Web Push notification to the uploader on completion
or failure.

No special decorators - RQ calls this function directly.
"""

import json
import os
import traceback
from datetime import datetime, timedelta, timezone

import cv2
from pywebpush import WebPushException, webpush
from sqlalchemy.orm import Session
from ultralytics import YOLO

from common.database import SessionLocal
from common import models
from common.geometry import is_point_in_polygon

VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "")
VAPID_CLAIMS = {"sub": "mailto:admin@eyegila.local"}

PROGRESS_INTERVAL = 10  # update processed_frames every N frames


# ---------------------------------------------------------------------------
# Push notification helper
# ---------------------------------------------------------------------------

def send_push(subscription: models.PushSubscription, payload: dict, db: Session) -> None:
    """
    Send a Web Push notification to a single subscription.
    Expired or invalid subscriptions are deleted and skipped - never crash the job.
    """
    try:
        webpush(
            subscription_info={
                "endpoint": subscription.endpoint,
                "keys": {
                    "p256dh": subscription.p256dh,
                    "auth":   subscription.auth,
                },
            },
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=VAPID_CLAIMS,
        )
    except WebPushException as e:
        status = e.response.status_code if e.response else None
        print(f"[push] delivery failed endpoint={subscription.endpoint[:40]}... "
              f"status={status}")
        # 404 / 410 means the subscription is expired - clean it up
        if status in (404, 410):
            try:
                db.delete(subscription)
                db.commit()
                print(f"[push] removed expired subscription id={subscription.id}")
            except Exception as cleanup_err:
                print(f"[push] cleanup failed: {cleanup_err}")
                db.rollback()
    except Exception as e:
        print(f"[push] unexpected error: {e}")


def notify_uploader(video: models.Video, payload: dict, db: Session) -> None:
    """
    Send push notification to all subscriptions belonging to the video uploader.
    Silently skips if uploader has no subscriptions or push is not configured.
    """
    if not VAPID_PRIVATE_KEY:
        print("[push] VAPID_PRIVATE_KEY not set, skipping push notification")
        return

    if video.uploaded_by is None:
        return

    subscriptions = (
        db.query(models.PushSubscription)
        .filter(models.PushSubscription.user_id == video.uploaded_by)
        .all()
    )

    if not subscriptions:
        return

    for sub in subscriptions:
        send_push(sub, payload, db)


# ---------------------------------------------------------------------------
# Region helpers (mirrors worker/main.py)
# ---------------------------------------------------------------------------

def load_regions(db: Session, cctv_id: int) -> list[dict]:
    regions = []
    for r in db.query(models.Region).filter(models.Region.cctv_id == cctv_id).all():
        regions.append({
            "id":           r.id,
            "street_id":    r.street_id,
            "region_points": [{"x": p.x, "y": p.y} for p in r.region_points],
        })
    return regions


# ---------------------------------------------------------------------------
# Main job function
# ---------------------------------------------------------------------------

def process_video(video_id: int) -> None:
    """
    RQ job entry point. Called by the rq-worker container.

    :param video_id: Primary key of the videos row to process.
    """
    db = SessionLocal()
    video = None

    try:
        video = db.query(models.Video).filter(models.Video.id == video_id).first()
        if video is None:
            raise ValueError(f"Video id={video_id} not found")

        # ── mark as processing ──────────────────────────────────────────────
        video.status = "processing"
        db.commit()
        print(f"[video job] starting video_id={video_id} file={video.filepath}")

        # ── open video ─────────────────────────────────────────────────────
        cap = cv2.VideoCapture(video.filepath)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video file: {video.filepath}")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        video.total_frames = total_frames
        db.commit()
        print(f"[video job] total_frames={total_frames} fps={fps:.1f}")

        # ── base timestamp ─────────────────────────────────────────────────
        # Use recorded_at if set, otherwise fall back to uploaded_at so
        # detected_at timestamps reflect when the footage was actually recorded.
        base_ts: datetime = video.recorded_at or video.uploaded_at
        if base_ts.tzinfo is None:
            base_ts = base_ts.replace(tzinfo=timezone.utc)

        # ── load model and regions ─────────────────────────────────────────
        # MODEL_PATH is set by docker-compose to /app/model.pt (the canonical
        # mount path). Never use a bare filename here - the CWD is not the
        # project root inside the container.
        model = YOLO(os.getenv("MODEL_PATH", "/app/model.pt"))

        # For a video upload we need a cctv_id to load regions.
        # Use the first CCTV belonging to the video's intersection, or skip regions.
        cctv_id = None
        regions: list[dict] = []
        if video.intersection_id:
            first_cctv = (
                db.query(models.CCTV)
                .filter(models.CCTV.intersection_id == video.intersection_id)
                .first()
            )
            if first_cctv:
                cctv_id = int(first_cctv.id)  # type: ignore
                regions = load_regions(db, cctv_id)

        if not cctv_id:
            # No cctv/regions - still run inference but detections won't be
            # linked to regions or counted in aggregation_summaries.
            print("[video job] no cctv/regions found, detections will not be region-linked")

        # ── frame loop ─────────────────────────────────────────────────────
        frame_index = 0
        dir_buffer: list[dict] = []

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            frame_index += 1
            frame_h, frame_w = frame.shape[:2]

            # Timestamp for this frame based on position in the video
            frame_offset = timedelta(seconds=(frame_index - 1) / fps)
            detected_at  = base_ts + frame_offset

            results = model.predict(frame, verbose=False)
            if not results:
                continue

            for box in results[0].boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cls_id   = int(box.cls[0])
                cls_name = model.names[cls_id]
                conf     = float(box.conf[0])
                track_id = None

                cx = ((x1 + x2) / 2) / frame_w
                cy = ((y1 + y2) / 2) / frame_h
                center = (cx, cy)

                # Regions are optional: they only *attribute* a detection to a
                # street/direction, they don't gate whether it's counted. Every
                # detection is inserted; in-region ones additionally get linked
                # to their region(s). This mirrors the live worker
                # (worker/main.py:process_detection), which never drops
                # out-of-region detections.
                matching_regions: list[dict] = []
                if cctv_id is not None and regions:
                    matching_regions = [
                        r for r in regions
                        if is_point_in_polygon(center, [(p["x"], p["y"]) for p in r["region_points"]])
                    ]

                detection = models.Detection(  # type: ignore[call-arg]
                    cctv_id=cctv_id,
                    video_id=video_id,
                    track_id=track_id,
                    object_type=cls_name,
                    confidence=round(conf, 4),
                    x1=round(x1 / frame_w, 4),
                    y1=round(y1 / frame_h, 4),
                    x2=round(x2 / frame_w, 4),
                    y2=round(y2 / frame_h, 4),
                    time=detected_at,
                )
                db.add(detection)
                db.flush()  # get id back

                for region in matching_regions:
                    dir_buffer.append({
                        "region_id":    region["id"],
                        "detection_id": int(detection.id),  # type: ignore
                        "time":         detected_at,
                    })

            # ── progress update every 100 frames ───────────────────────────
            if frame_index % PROGRESS_INTERVAL == 0:
                if dir_buffer:
                    db.bulk_insert_mappings(models.DetectionInRegion, dir_buffer)
                    dir_buffer.clear()
                video.processed_frames = frame_index
                db.commit()
                pct = round(frame_index / total_frames * 100, 1) if total_frames else 0
                print(f"[video job] progress {frame_index}/{total_frames} ({pct}%)")

        # ── flush remaining buffer ──────────────────────────────────────────
        if dir_buffer:
            db.bulk_insert_mappings(models.DetectionInRegion, dir_buffer)
            dir_buffer.clear()

        cap.release()

        # ── mark completed ──────────────────────────────────────────────────
        video.status           = "completed"
        video.processed_frames = frame_index
        video.processed_at     = datetime.now(timezone.utc)
        db.commit()
        print(f"[video job] completed video_id={video_id} frames={frame_index}")

        # ── success push notification ───────────────────────────────────────
        intersection_name = video.intersection.name if video.intersection else "Unknown"
        notify_uploader(video, {
            "title":    "Video processed",
            "body":     f"{intersection_name} analysis is ready",
            "video_id": video_id,
        }, db)

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[video job] FAILED video_id={video_id}: {e}\n{tb}")

        if video is not None:
            try:
                video.status = "failed"
                db.commit()
            except Exception:
                db.rollback()

            # failure push notification
            try:
                notify_uploader(video, {
                    "title":    "Video processing failed",
                    "body":     f"Processing failed for video {video_id}. Please try again.",
                    "video_id": video_id,
                }, db)
            except Exception as push_err:
                print(f"[video job] failure push notification error: {push_err}")

        # re-raise so RQ marks the job as failed
        raise

    finally:
        db.close()