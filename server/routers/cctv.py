import socket
import uuid
import select
import re
import os
from urllib.parse import quote
from server.schemas import CCTVBase, CCTVCreate, CCTVUpdate, CCTVResponse
from server.utils import log_and_commit, get_current_user
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from common.models import User, CCTV
from common.database import get_db
from server.rate_limit import limiter
from sqlalchemy.orm import Session
from typing import Annotated
from pydantic import BaseModel, Field

_REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
try:
    import redis as _redis_lib
    _redis = _redis_lib.from_url(_REDIS_URL)
except Exception:
    _redis = None


router = APIRouter(
    prefix="/cctvs",
    tags=["CCTVs"]
)

def _camera_statuses(db: Session) -> dict[int, dict]:
    """Returns {cctv_id: {status, last_error}} for cameras with a recent heartbeat."""
    from sqlalchemy import text as _text
    rows = db.execute(_text(
        "SELECT cctv_id, status, last_error FROM worker_heartbeats "
        "WHERE last_seen > NOW() - INTERVAL '15 seconds'"
    )).fetchall()
    return {
        row[0]: {
            "status": 'reconnecting' if row[1] == 'reconnecting' else 'online',
            "last_error": row[2],
        }
        for row in rows
    }

# ---------------------------------------------------------------------------
# ONVIF WS-Discovery
# ---------------------------------------------------------------------------

_WS_DISCOVERY_ADDR = ("239.255.255.250", 3702)
_WS_DISCOVERY_TIMEOUT = 3.0

_PROBE_TEMPLATE = """\
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope
  xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>
    <a:MessageID>uuid:{msg_id}</a:MessageID>
    <a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>
  </s:Header>
  <s:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </s:Body>
</s:Envelope>"""


class DiscoveredCamera(BaseModel):
    address: str
    rtsp_url: str | None = None
    xaddrs: list[str] = []


def _parse_xaddrs(xml_text: str) -> list[str]:
    """Extract XAddrs from a WS-Discovery ProbeMatch response."""
    matches = re.findall(r'<[^:>]*:?XAddrs[^>]*>(.*?)</[^:>]*:?XAddrs>', xml_text, re.DOTALL)
    addrs: list[str] = []
    for m in matches:
        for addr in m.strip().split():
            addr = addr.strip()
            if addr:
                addrs.append(addr)
    return addrs


def _parse_address(xml_text: str) -> str | None:
    """Extract device address from EndpointReference/Address."""
    m = re.search(r'<[^:>]*:?Address[^>]*>(.*?)</[^:>]*:?Address>', xml_text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return None


def _discover_onvif_cameras() -> list[DiscoveredCamera]:
    """
    Send a WS-Discovery Probe over UDP multicast and collect ProbeMatch responses.
    Returns a list of discovered cameras with their XAddrs (HTTP management URLs).
    """
    msg_id = str(uuid.uuid4())
    probe = _PROBE_TEMPLATE.format(msg_id=msg_id).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 4)
    sock.settimeout(_WS_DISCOVERY_TIMEOUT)

    seen: set[str] = set()
    found: list[DiscoveredCamera] = []

    try:
        sock.sendto(probe, _WS_DISCOVERY_ADDR)

        import time
        deadline = time.monotonic() + _WS_DISCOVERY_TIMEOUT
        while time.monotonic() < deadline:
            remaining = deadline -time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([sock], [], [], remaining)
            if not ready:
                break
            try:
                data, (src_ip, _) = sock.recvfrom(65536)
            except socket.timeout:
                break

            if src_ip in seen:
                continue
            seen.add(src_ip)

            text = data.decode("utf-8", errors="replace")
            xaddrs = _parse_xaddrs(text)

            # Build a default RTSP URL guess from the IP
            rtsp_guess = f"rtsp://{src_ip}:554/cam/realmonitor?channel=1&subtype=0"

            found.append(DiscoveredCamera(
                address=src_ip,
                rtsp_url=rtsp_guess,
                xaddrs=xaddrs,
            ))

    except OSError:
        pass
    finally:
        sock.close()

    return found


# ---------------------------------------------------------------------------
# NVR channel scan
# ---------------------------------------------------------------------------

class NVRScanRequest(BaseModel):
    host: str
    username: str = "admin"
    password: str = ""
    max_channels: int = Field(default=16, ge=1, le=64)
    subtype: int = Field(default=1, ge=0, le=1)


class NVRChannel(BaseModel):
    channel: int
    rtsp_url: str


class NVRScanResult(BaseModel):
    reachable: bool
    channels: list[NVRChannel]


def _probe_rtsp(host: str, port: int = 554, timeout: float = 3.0) -> bool:
    """TCP connect + RTSP OPTIONS to confirm the host is an RTSP server."""
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            req = (
                f"OPTIONS rtsp://{host}:{port}/ RTSP/1.0\r\n"
                f"CSeq: 1\r\n"
                f"User-Agent: NVRScanner/1.0\r\n"
                f"\r\n"
            )
            sock.sendall(req.encode())
            resp = sock.recv(256).decode("utf-8", errors="replace")
            return resp.startswith("RTSP/")
    except OSError:
        return False


@router.post("/scan-nvr", response_model=NVRScanResult)
@limiter.limit("10/minute")
def scan_nvr(
    request: Request,
    body: NVRScanRequest,
    user: Annotated[User, Depends(get_current_user)],
) -> NVRScanResult:
    """
    Probe an NVR's RTSP port and return channel URLs for channels 1..max_channels.
    Does not verify individual channels - the worker validates on connect.
    """
    if not _probe_rtsp(body.host):
        return NVRScanResult(reachable=False, channels=[])

    u = quote(body.username, safe="")
    p = quote(body.password, safe="")
    channels = [
        NVRChannel(
            channel=ch,
            rtsp_url=f"rtsp://{u}:{p}@{body.host}:554/cam/realmonitor?channel={ch}&subtype={body.subtype}",
        )
        for ch in range(1, body.max_channels + 1)
    ]
    return NVRScanResult(reachable=True, channels=channels)


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------

@router.post("/", response_model=CCTVResponse)
def create_cctv(
    cctv: CCTVCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> CCTVResponse:
    db_cctv = CCTV(name=cctv.name, intersection_id=cctv.intersection_id, rtsp_url=cctv.rtsp_url)
    db.add(db_cctv)
    log_and_commit(f"User {user.username} created cctv {db_cctv.name}", db)
    db.refresh(db_cctv)
    return db_cctv


@router.get("/", response_model=list[CCTVResponse])
def get_cctvs(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[CCTVResponse]:
    cctvs = db.query(CCTV).all()
    statuses = _camera_statuses(db)
    for c in cctvs:
        info = statuses.get(c.id)
        c.status = info["status"] if info else 'offline'
        c.last_error = info["last_error"] if info else None
    return cctvs


def _simulated_onvif_scan(count: int, db: Session) -> list[DiscoveredCamera]:
    """Prototype-only synthetic scan: `count` cameras starting at .31.

    Returns the same IP layout a real city deployment uses - contiguous
    blocks of four (one block per intersection). 20 cameras = 5
    intersections; the operator can request more with `?count=`.

    Picks the first 192.168.S.* subnet whose 31..30+count range is free
    in the DB, so demo re-runs always surface fresh cameras instead of
    showing "All discovered cameras are already in the system."

    Sleeps ~2 seconds to mimic the time a real WS-Discovery multicast
    probe takes - without it the spinner pops and disappears before the
    operator can read it, which makes the demo feel fake.
    """
    import time
    time.sleep(2.0)

    ip_re = re.compile(r"rtsp://192\.168\.(\d+)\.(\d+)")
    taken: dict[int, set[int]] = {}
    for (url,) in db.query(CCTV.rtsp_url).all():
        if not url:
            continue
        m = ip_re.match(url)
        if m:
            taken.setdefault(int(m.group(1)), set()).add(int(m.group(2)))

    hosts = range(31, 31 + count)
    subnet = next(
        (s for s in range(1, 255) if not (taken.get(s, set()) & set(hosts))),
        1,
    )
    return [
        DiscoveredCamera(
            address=f"192.168.{subnet}.{i}",
            rtsp_url=f"rtsp://192.168.{subnet}.{i}:554/stream1",
        )
        for i in hosts
    ]


@router.get("/discover", response_model=list[DiscoveredCamera])
@limiter.limit("6/minute")
def discover_cameras(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    simulate: bool = False,
    count: int = 20,
):
    """
    WS-Discovery scan for ONVIF cameras on the local network.
    Sends a UDP multicast probe and collects responses for 3 seconds.

    When ``simulate=true`` (prototype demo path), bypasses the multicast
    probe and returns a deterministic synthetic deployment instead.
    Default 20 cameras (5 intersections of 4). Capped at 60.
    """
    if simulate:
        return _simulated_onvif_scan(max(4, min(count, 60)), db)
    return _discover_onvif_cameras()


@router.get("/{cctv_id}", response_model=CCTVResponse)
def get_cctv(
    cctv_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> CCTVResponse:
    from sqlalchemy import text as _text
    cctv = db.get(CCTV, cctv_id)

    if not cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    row = db.execute(_text(
        "SELECT status, last_error FROM worker_heartbeats "
        "WHERE cctv_id = :id AND last_seen > NOW() - INTERVAL '15 seconds'"
    ), {"id": cctv_id}).fetchone()
    cctv.status = ('reconnecting' if row[0] == 'reconnecting' else 'online') if row else 'offline'
    cctv.last_error = row[1] if row else None
    return cctv


@router.put("/{cctv_id}", response_model=CCTVResponse)
def update_cctv(
    cctv_id: int,
    cctv: CCTVUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> CCTVResponse:
    db_cctv = db.get(CCTV, cctv_id)

    if not db_cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    old_name = db_cctv.name
    if cctv.name is not None:
        db_cctv.name = cctv.name
    if cctv.rtsp_url is not None:
        db_cctv.rtsp_url = cctv.rtsp_url
    if cctv.intersection_id is not None:
        db_cctv.intersection_id = cctv.intersection_id
    log_and_commit(f"User {user.username} updated cctv {old_name} to {db_cctv.name}", db)
    db.refresh(db_cctv)
    return db_cctv


@router.delete("/{cctv_id}", status_code=204)
def delete_cctv(
    cctv_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    db_cctv = db.get(CCTV, cctv_id)

    if not db_cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    db.delete(db_cctv)
    log_and_commit(f"User {user.username} deleted cctv {db_cctv.name}", db)
    return Response(status_code=204)


@router.post("/{cctv_id}/retry", status_code=204)
def retry_camera(
    cctv_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Signal the worker to immediately retry the RTSP connection for this camera.

    Returns 409 if no worker currently holds this camera - the Redis signal
    only wakes an in-flight reconnect backoff, so a retry against an
    unclaimed camera would silently do nothing. Surface that to the caller
    instead of returning 204 and lying via the toast.
    """
    from sqlalchemy import text as _text
    cctv = db.get(CCTV, cctv_id)
    if not cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    has_worker = db.execute(_text(
        "SELECT 1 FROM worker_heartbeats "
        "WHERE cctv_id = :id AND last_seen > NOW() - INTERVAL '15 seconds'"
    ), {"id": cctv_id}).fetchone() is not None
    if not has_worker:
        raise HTTPException(
            status_code=409,
            detail="No worker is currently assigned to this camera - scale up workers or enable the camera before retrying.",
        )

    if _redis is not None:
        try:
            _redis.setex(f"cam:{cctv_id}:retry_now", 60, "1")
        except Exception:
            pass
    return Response(status_code=204)


@router.post("/{cctv_id}/disable", status_code=204)
def disable_camera(
    cctv_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """
    Mark the camera as disabled so the worker stops trying to connect.
    Deletes any existing heartbeat row so the slot is evicted immediately,
    and the camera will not be reclaimed until it is re-enabled.
    """
    from sqlalchemy import text as _text
    cctv = db.get(CCTV, cctv_id)
    if not cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")
    cctv.enabled = False
    db.execute(_text("DELETE FROM worker_heartbeats WHERE cctv_id = :id"), {"id": cctv_id})
    db.execute(_text("UPDATE cctvs SET status = 'offline' WHERE id = :id"), {"id": cctv_id})
    log_and_commit(f"User {user.username} disabled cctv {cctv.name}", db)
    if _redis is not None:
        try:
            _redis.setex(f"cam:{cctv_id}:retry_now", 10, "1")
        except Exception:
            pass
    return Response(status_code=204)


@router.post("/{cctv_id}/enable", status_code=204)
def enable_camera(
    cctv_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Re-enable a disabled camera so the worker will pick it up on next claim."""
    cctv = db.get(CCTV, cctv_id)
    if not cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")
    cctv.enabled = True
    log_and_commit(f"User {user.username} enabled cctv {cctv.name}", db)
    return Response(status_code=204)
