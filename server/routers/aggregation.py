import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from common import models
from common.database import SessionLocal
from server.aggregation_source import build_history_query
from server.utils import get_bearer_token, get_current_user, get_user_from_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aggregation", tags=["Aggregation"])

_TZ = os.getenv("TZ", "Asia/Manila")

# holds all active SSE connections
connected_clients: list[asyncio.Queue] = []

async def aggregation_pusher():
    """Background task - queries live detection_street_view every 5s and fans out to all clients.

    Hardened against the death-spiral mode we hit during the demo:
      * Skips entirely when no SSE clients are connected - the aggregation
        is a fan-out, so there's no reason to run the heavy GROUP BY for
        nobody. An idle dashboard now does zero work here.
      * Re-entry guard - the loop won't start a new iteration while the
        previous one is still running. Without this, every 5 s tick stacks
        another concurrent query when the DB is slow, eventually exhausting
        the pgbouncer pool and wedging the entire API.
      * 30 s statement_timeout caps any pathological hang (autovacuum, lock
        contention) without being so tight it cancels every healthy
        execution. Combined with the re-entry guard, attempts cannot pile up.
    """
    in_flight = False
    while True:
        await asyncio.sleep(5)
        if not connected_clients or in_flight:
            continue
        in_flight = True
        db = SessionLocal()
        try:
            db.execute(text("SET LOCAL statement_timeout = '30s'"))
            # Per the consumer contract in eyegila/src/pages/Manual.tsx:
            #   "the latest 1-minute bucket counts per intersection and street"
            # Bounds: the half-open current-minute window
            #   [start-of-current-minute, start-of-next-minute).
            # The lower bound prevents scanning today's ~600k rows every tick.
            # The upper bound caps to exactly one minute - without it, the
            # seeder's future-dated rows (used for warrant analyses) would all
            # match and explode the row count (475k+) into a statement timeout.
            rows = db.execute(text("""
                SELECT
                    intersection_id,
                    intersection_name,
                    street_id,
                    direction,
                    object_type,
                    DATE_TRUNC('minute', NOW() AT TIME ZONE :tz) AS window_start,
                    COUNT(*)::int                                 AS count
                FROM detection_street_view
                WHERE time >= DATE_TRUNC('minute', NOW() AT TIME ZONE :tz) AT TIME ZONE :tz
                  AND time <  DATE_TRUNC('minute', NOW() AT TIME ZONE :tz) AT TIME ZONE :tz + INTERVAL '1 minute'
                GROUP BY intersection_id, intersection_name, street_id, direction, object_type
                ORDER BY intersection_id, street_id, direction, object_type
            """), {"tz": _TZ}).fetchall()

            payload = json.dumps([
                {
                    "intersection_id": r.intersection_id,
                    "intersection_name": r.intersection_name,
                    "street_id": r.street_id,
                    "direction": r.direction,
                    "object_type": r.object_type,
                    "window_start": r.window_start.isoformat(),
                    "count": r.count,
                }
                for r in rows
            ])

            for queue in list(connected_clients):
                await queue.put(payload)

        except Exception as e:
            logger.error("SSE aggregation query failed: %s", e)
        finally:
            db.close()
            in_flight = False


async def _stream_token(
    request: Request,
    token: str = Query(default=""),
) -> str:
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        resolved = auth_header[7:]
    elif token:
        resolved = token
    else:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not get_user_from_token(resolved):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return resolved


@router.get("/stream")
async def stream_aggregation(
    token: Annotated[str, Depends(_stream_token)],
):
    queue: asyncio.Queue = asyncio.Queue()
    connected_clients.append(queue)

    async def event_generator():
        ticks = 0
        try:
            while True:
                data = await queue.get()
                ticks += 1
                # Re-validate session every 60 ticks (~5 min at 5 s poll interval)
                if ticks % 60 == 0 and not get_user_from_token(token):
                    break
                yield f"data: {data}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            try:
                connected_clients.remove(queue)
            except ValueError:
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/history")
def get_history(
    start: datetime,
    end: datetime,
    intersection_id: Optional[int] = None,
    street_id: Optional[int] = None,
    direction: Optional[Literal["inbound", "outbound", "unknown"]] = None,
    bucket: Literal["hour", "day", "week"] = "day",
    user: models.User = Depends(get_current_user),
):
    """Return aggregation history for a date range, bucketed by hour/day/week.

    Source (live view vs continuous aggregate) is picked by
    server.aggregation_source.
    """
    sql, params, _source = build_history_query(
        start=start,
        end=end,
        bucket=bucket,
        intersection_id=intersection_id,
        street_id=street_id,
        direction=direction,
    )

    db = SessionLocal()
    try:
        rows = db.execute(text(sql), params).fetchall()
        return [
            {
                "intersection_id": r.intersection_id,
                "intersection_name": r.intersection_name,
                "street_id": r.street_id,
                "direction": r.direction,
                "object_type": r.object_type,
                "window_start": r.window_start.isoformat(),
                "count": r.count,
            }
            for r in rows
        ]
    finally:
        db.close()