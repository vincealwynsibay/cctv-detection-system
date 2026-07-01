from server.schemas import IntersectionCreate, IntersectionUpdate, IntersectionResponse, SignalTimingUpdate, LocalWarrantConfigUpdate
from server.utils import log_and_commit, get_current_user
from server.tod import seed_tod_chunks
from server.cycle_detection import estimate_signal_timing
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from pydantic import BaseModel
from common.models import User, Intersection, CCTV
from common.database import get_db
from sqlalchemy.orm import Session
from typing import Annotated, Optional
import csv
import io


router = APIRouter(
    prefix="/intersections",
    tags=["Intersections"]
)


@router.post("/", response_model=IntersectionResponse)
def create_intersection(
    intersection: IntersectionCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    db_intersection = Intersection(name=intersection.name, latitude=intersection.latitude, longitude=intersection.longitude)
    db.add(db_intersection)
    db.flush()
    seed_tod_chunks(db, db_intersection.id)
    log_and_commit(f"User {user.username} created intersection {db_intersection.name}", db)
    db.refresh(db_intersection)
    return db_intersection


@router.get("/", response_model=list[IntersectionResponse])
def get_intersections(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[IntersectionResponse]:
    return db.query(Intersection).all()


@router.get("/{intersection_id}", response_model=IntersectionResponse)
def get_intersection(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> IntersectionResponse:
    intersection = db.get(Intersection, intersection_id)

    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    
    return intersection


@router.put("/{intersection_id}", response_model=IntersectionResponse)
def update_intersection(
    intersection_id: int,
    intersection: IntersectionUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    db_intersection = db.get(Intersection, intersection_id)

    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    
    message = f"User {user.username} updated intersection {db_intersection.name}"

    if intersection.name:
        old_name = db_intersection.name
        db_intersection.name = intersection.name
        message = f"User {user.username} updated intersection {old_name} to {db_intersection.name}"
    
    if intersection.latitude is not None:
        db_intersection.latitude = intersection.latitude

    if intersection.longitude is not None:
        db_intersection.longitude = intersection.longitude

    if intersection.crossing_width_m is not None:
        db_intersection.crossing_width_m = intersection.crossing_width_m

    if intersection.saturation_flow_pcu_hr is not None:
        db_intersection.saturation_flow_pcu_hr = intersection.saturation_flow_pcu_hr

    log_and_commit(message, db)
    db.refresh(db_intersection)
    return db_intersection


@router.patch("/{intersection_id}", response_model=IntersectionResponse)
def patch_intersection(
    intersection_id: int,
    intersection: IntersectionUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    db_intersection = db.get(Intersection, intersection_id)
    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    data = intersection.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(db_intersection, field, value)
    log_and_commit(f"User {user.username} patched intersection {db_intersection.name}", db)
    db.refresh(db_intersection)
    return db_intersection


@router.post("/import")
async def import_csv(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Bulk-import intersections and cameras from a CSV file.

    Required columns: intersection_name, latitude, longitude, camera_name, rtsp_url
    Intersections are matched by name - existing ones are reused, not duplicated.
    """
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")  # strip BOM if present
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded")

    reader = csv.DictReader(io.StringIO(text))
    required = {"intersection_name", "latitude", "longitude", "camera_name", "rtsp_url"}
    if not reader.fieldnames or not required.issubset(set(f.strip() for f in reader.fieldnames)):
        missing = required - set(f.strip() for f in (reader.fieldnames or []))
        raise HTTPException(status_code=400, detail=f"Missing columns: {', '.join(sorted(missing))}")

    inter_cache: dict[str, Intersection] = {}
    created_intersections: list[str] = []
    created_cameras: list[str] = []
    errors: list[str] = []

    rows = list(reader)
    if len(rows) > 500:
        raise HTTPException(status_code=400, detail=f"CSV exceeds 500-row limit ({len(rows)} rows). Split into smaller files.")
    for i, row in enumerate(rows, start=2):  # row 1 is header
        row = {k.strip(): v.strip() for k, v in row.items()}
        name = row.get("intersection_name", "")
        cam_name = row.get("camera_name", "")
        rtsp_url = row.get("rtsp_url", "")

        if not name or not cam_name or not rtsp_url:
            errors.append(f"Row {i}: missing required field")
            continue

        try:
            lat = float(row.get("latitude") or 0)
            lng = float(row.get("longitude") or 0)
        except ValueError:
            errors.append(f"Row {i}: invalid latitude/longitude")
            continue

        # reuse or create intersection
        if name not in inter_cache:
            existing = db.query(Intersection).filter(Intersection.name == name).first()
            if existing:
                inter_cache[name] = existing
            else:
                inter = Intersection(name=name, latitude=lat, longitude=lng)
                db.add(inter)
                db.flush()
                inter_cache[name] = inter
                created_intersections.append(name)

        intersection = inter_cache[name]

        # skip duplicate cameras (same name + intersection)
        dup = db.query(CCTV).filter(
            CCTV.intersection_id == intersection.id,
            CCTV.name == cam_name,
        ).first()
        if dup:
            errors.append(f"Row {i}: camera '{cam_name}' already exists at '{name}' (skipped)")
            continue

        cam = CCTV(name=cam_name, intersection_id=intersection.id, rtsp_url=rtsp_url)
        db.add(cam)
        created_cameras.append(cam_name)

    log_and_commit(
        f"User {user.username} bulk-imported {len(created_intersections)} intersections "
        f"and {len(created_cameras)} cameras via CSV",
        db,
    )

    return {
        "created_intersections": created_intersections,
        "created_cameras": created_cameras,
        "errors": errors,
    }


@router.patch("/{intersection_id}/timing", response_model=IntersectionResponse)
def update_signal_timing(
    intersection_id: int,
    timing: SignalTimingUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    db_intersection = db.get(Intersection, intersection_id)

    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    db_intersection.signal_status = timing.signal_status
    db_intersection.existing_cycle_length = timing.existing_cycle_length
    db_intersection.existing_green_splits = timing.existing_green_splits

    log_and_commit(
        f"User {user.username} updated signal timing for {db_intersection.name} "
        f"(status={timing.signal_status}, cycle={timing.existing_cycle_length}s)",
        db,
    )
    db.refresh(db_intersection)
    return db_intersection


@router.patch("/{intersection_id}/local-warrant-config", response_model=IntersectionResponse)
def update_local_warrant_config(
    intersection_id: int,
    config: LocalWarrantConfigUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    db_intersection = db.get(Intersection, intersection_id)
    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    if config.w_local_1_threshold is not None:
        db_intersection.w_local_1_threshold = config.w_local_1_threshold
    if config.w_local_2_threshold is not None:
        db_intersection.w_local_2_threshold = config.w_local_2_threshold
    if config.w_local_3_min_pcu is not None:
        db_intersection.w_local_3_min_pcu = config.w_local_3_min_pcu

    log_and_commit(
        f"User {user.username} updated local warrant config for {db_intersection.name}",
        db,
    )
    db.refresh(db_intersection)
    return db_intersection


class DetectTimingResponse(BaseModel):
    intersection_id:   int
    estimated_cycle_s: Optional[int]
    confidence:        str
    note:              str
    dispersion_index:  Optional[float]
    best_lag_min:      Optional[int]
    best_autocorr:     Optional[float]


@router.get("/{intersection_id}/detect-timing", response_model=DetectTimingResponse)
def detect_signal_timing(
    intersection_id: int,
    db:   Annotated[Session, Depends(get_db)],
    user: Annotated[User,    Depends(get_current_user)],
) -> DetectTimingResponse:
    """Estimate the existing signal cycle length from camera detection patterns.

    Uses autocorrelation of minute-level vehicle counts to detect periodicity
    consistent with signal phase cycles.  Results are labelled low / medium /
    high confidence; low-confidence results should not be saved without first
    reading the controller box directly.
    """
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")

    result = estimate_signal_timing(db, intersection_id)
    return DetectTimingResponse(intersection_id=intersection_id, **result)


class SetupTaskMutation(BaseModel):
    task: str


# Vocabulary kept loose on purpose - the frontend owns the set of task names
# (regions/timing/first_analysis/...) and may evolve them without a schema
# change. Server only persists the strings.
ALLOWED_DISMISS_TASKS = {
    "cameras", "regions", "timing", "first_analysis",
}


@router.post("/{intersection_id}/dismiss-setup-task", response_model=IntersectionResponse)
def dismiss_setup_task(
    intersection_id: int,
    body: SetupTaskMutation,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    """Snooze one onboarding task for an intersection.

    Used by the sidebar Setup Progress popover. Dismissals are permanent
    (until the operator restores them) - that matches the way operators
    actually use the popover: "yes, I know this intersection doesn't need
    regions, stop nagging me."
    """
    if body.task not in ALLOWED_DISMISS_TASKS:
        raise HTTPException(status_code=422, detail=f"Unknown task: {body.task}")
    db_intersection = db.get(Intersection, intersection_id)
    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    current = list(db_intersection.dismissed_setup_tasks or [])
    if body.task not in current:
        current.append(body.task)
        db_intersection.dismissed_setup_tasks = current
    log_and_commit(
        f"User {user.username} dismissed setup task '{body.task}' on {db_intersection.name}",
        db,
    )
    db.refresh(db_intersection)
    return db_intersection


@router.post("/{intersection_id}/restore-setup-task", response_model=IntersectionResponse)
def restore_setup_task(
    intersection_id: int,
    body: SetupTaskMutation,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    """Un-dismiss a previously snoozed onboarding task."""
    db_intersection = db.get(Intersection, intersection_id)
    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    current = [t for t in (db_intersection.dismissed_setup_tasks or []) if t != body.task]
    db_intersection.dismissed_setup_tasks = current
    log_and_commit(
        f"User {user.username} restored setup task '{body.task}' on {db_intersection.name}",
        db,
    )
    db.refresh(db_intersection)
    return db_intersection


@router.delete("/{intersection_id}", status_code=204)
def delete_intersection(
    intersection_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    db_intersection = db.get(Intersection, intersection_id)

    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    db.delete(db_intersection)
    log_and_commit(f"User {user.username} deleted intersection {db_intersection.name}", db)
    return Response(status_code=204)