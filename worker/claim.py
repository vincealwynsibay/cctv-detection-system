from sqlalchemy.orm import Session
from sqlalchemy import text
from common import models
import time
import os

# Longer TTL protects an existing claim across DB-outage windows: while the DB
# is unreachable the worker cannot refresh its heartbeat, but the row it wrote
# on the last successful heartbeat remains fresh enough that no other worker
# will steal the camera for CLAIM_EXPIRY_SEC. Tradeoff: real worker deaths take
# up to that same window to be reclaimed by a surviving peer.
CLAIM_EXPIRY_SEC = int(os.getenv("CLAIM_EXPIRY_SEC", "300"))
POLL_INTERVAL_SEC = 5

def try_claim_camera(db: Session) -> tuple[models.CCTV, int] | None:
    """
    Single non-blocking attempt to claim one unclaimed or abandoned camera.
    Returns (cctv, claim_version) on success, None if no camera is available.
    """
    worker_pid = os.getpid()
    try:
        db.execute(text("BEGIN"))

        result = db.execute(text("""
            SELECT id FROM cctvs
            WHERE enabled = TRUE
              AND id NOT IN (
                SELECT cctv_id FROM worker_heartbeats
                WHERE last_seen > NOW() - (:expiry * INTERVAL '1 second')
            )
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        """), {"expiry": CLAIM_EXPIRY_SEC}).fetchone()

        if result is None:
            db.execute(text("ROLLBACK"))
            return None

        cctv_id: int = int(result[0])

        row = db.execute(text("""
            INSERT INTO worker_heartbeats
                (cctv_id, worker_pid, last_seen, claimed_at, claim_version, status)
            VALUES
                (:cctv_id, :pid, NOW(), NOW(), 1, 'running')
            ON CONFLICT (cctv_id) DO UPDATE SET
                worker_pid    = EXCLUDED.worker_pid,
                last_seen     = NOW(),
                claimed_at    = NOW(),
                claim_version = worker_heartbeats.claim_version + 1,
                status        = 'running'
            RETURNING claim_version
        """), {"cctv_id": cctv_id, "pid": worker_pid}).fetchone()

        if row is None:
            db.execute(text("ROLLBACK"))
            return None

        claim_version: int = int(row[0])
        db.execute(text("UPDATE cctvs SET status = 'online' WHERE id = :id"), {"id": cctv_id})
        db.execute(text("COMMIT"))

    except Exception as e:
        print(f"[worker pid={worker_pid}] claim attempt failed: {e}")
        try:
            db.execute(text("ROLLBACK"))
        except Exception:
            pass
        return None

    cctv = db.query(models.CCTV).filter(models.CCTV.id == cctv_id).first()
    if cctv is None:
        raise RuntimeError(f"[worker pid={worker_pid}] claimed cctv_id={cctv_id} but row not found")

    print(f"[worker pid={worker_pid}] claimed camera id={cctv_id} "
          f"name='{cctv.name}' claim_version={claim_version}")
    return cctv, claim_version


def claim_camera(db: Session) -> tuple[models.CCTV, int]:
    """
    Blocking version of try_claim_camera. Polls every POLL_INTERVAL_SEC
    until a camera becomes available.
    """
    worker_pid = os.getpid()
    print(f"[worker pid={worker_pid}] scanning for unclaimed camera...")
    while True:
        result = try_claim_camera(db)
        if result is not None:
            return result
        print(f"[worker pid={worker_pid}] no camera available, "
              f"retrying in {POLL_INTERVAL_SEC}s...")
        time.sleep(POLL_INTERVAL_SEC)




def release_camera(db: Session, cctv_id: int) -> None:
    """
    Delete the heartbeat row and mark the camera offline on clean exit.
    Another worker can claim it immediately after.
    """
    try:
        db.execute(text(
            "DELETE FROM worker_heartbeats WHERE cctv_id = :id"
        ), {"id": cctv_id})
        db.execute(text(
            "UPDATE cctvs SET status = 'offline' WHERE id = :id"
        ), {"id": cctv_id})
        db.commit()
        print(f"[worker] released camera id={cctv_id}")
    except Exception as e:
        print(f"[worker] release failed: {e}")
        db.rollback()


def verify_claim(db: Session, cctv_id: int, expected_version: int) -> bool:
    """
    Return True if this worker still holds the claim for cctv_id.

    If another worker stole the claim while the database was slow,
    claim_version will have been incremented and this returns False.

    Returns True on transient database errors to avoid exiting the
    inference loop on a momentary hiccup.
    """
    try:
        row = db.execute(text(
            "SELECT claim_version FROM worker_heartbeats WHERE cctv_id = :id"
        ), {"id": cctv_id}).fetchone()
    except Exception as e:
        print(f"[worker] verify_claim failed: {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return True

    if row is None or row[0] != expected_version:
        print(f"[worker] lost claim on cctv={cctv_id} "
              f"(expected version {expected_version}, got {row[0] if row else 'none'})")
        return False

    return True
