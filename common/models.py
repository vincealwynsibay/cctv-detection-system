from sqlalchemy import BigInteger, Column, Integer, String, ForeignKey, DateTime, Float, Boolean, Text, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from common.database import Base


class User(Base):
    __tablename__ = "users"

    id       = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), nullable=False, unique=True)
    hash     = Column(String(255), nullable=False)
    role     = Column(String(50),  nullable=False, default="viewer")
    time     = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    wizard_step        = Column(String(50),  nullable=True)

    sessions           = relationship("UserSession",      back_populates="user", cascade="all, delete")
    uploaded_videos    = relationship("Video",            back_populates="uploader",          foreign_keys="Video.uploaded_by")
    push_subscriptions = relationship("PushSubscription", back_populates="user", cascade="all, delete")


class UserSession(Base):
    __tablename__ = "user_sessions"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    user_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="sessions")


class Log(Base):
    __tablename__ = "logs"

    id      = Column(Integer, primary_key=True, autoincrement=True)
    message = Column(String(255), nullable=False)
    time    = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Intersection(Base):
    __tablename__ = "intersections"

    id                     = Column(Integer, primary_key=True, autoincrement=True)
    name                   = Column(String(255), nullable=False)
    latitude               = Column(Float, nullable=True)
    longitude              = Column(Float, nullable=True)
    signal_status          = Column(String(20), nullable=False, server_default="unsignalized")
    existing_cycle_length  = Column(Integer, nullable=True)
    existing_green_splits  = Column(JSON, nullable=True)
    lost_time_per_phase    = Column(Integer, nullable=False, server_default="4")
    all_red_clearance      = Column(Integer, nullable=False, server_default="3")
    min_cycle_length       = Column(Integer, nullable=False, server_default="40")
    max_cycle_length       = Column(Integer, nullable=False, server_default="120")
    w_local_1_threshold    = Column(Float, nullable=False, server_default="0.6")
    w_local_2_threshold    = Column(Float, nullable=False, server_default="0.7")
    w_local_3_min_pcu      = Column(Float, nullable=False, server_default="30.0")
    crossing_width_m       = Column(Float, nullable=False, server_default="12.0")
    saturation_flow_pcu_hr = Column(Integer, nullable=False, server_default="1400")
    # JSON array of task names the operator has snoozed for this intersection
    # (e.g. ["regions", "timing"]). The Sidebar's Setup Progress popover filters
    # these out of the "pending" count and surfaces them under a Dismissed
    # collapsible. Dismissals persist across browsers - they are a deliberate
    # signal that the intersection doesn't need the task done.
    dismissed_setup_tasks  = Column(JSON, nullable=False, server_default="[]")
    time                   = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    streets                = relationship("Street",              back_populates="intersection", cascade="all, delete", passive_deletes=True)
    cctvs                  = relationship("CCTV",               back_populates="intersection", cascade="all, delete", passive_deletes=True)
    recommendations        = relationship("Recommendation",     back_populates="intersection", cascade="all, delete", passive_deletes=True)
    videos                 = relationship("Video",              back_populates="intersection")
    pce_overrides          = relationship("PceOverride",        back_populates="intersection", cascade="all, delete", passive_deletes=True)
    pce_calibrated_values  = relationship("PceCalibratedValue", back_populates="intersection", cascade="all, delete", passive_deletes=True)
    tod_chunks             = relationship("TodChunk",           back_populates="intersection", cascade="all, delete", passive_deletes=True)
    timing_recommendations = relationship("TimingRecommendation", back_populates="intersection", cascade="all, delete", passive_deletes=True)
    simulation_results     = relationship("SimulationResult",     back_populates="intersection", cascade="all, delete", passive_deletes=True)


class Street(Base):
    __tablename__ = "streets"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    name            = Column(String(255), nullable=False)
    arm_direction   = Column(String(20),  nullable=False, server_default="unknown")
    time            = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection = relationship("Intersection", back_populates="streets")
    regions      = relationship("Region", back_populates="street", cascade="all, delete", passive_deletes=True)


class CCTV(Base):
    __tablename__ = "cctvs"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    name            = Column(String(255), nullable=False)
    rtsp_url        = Column(String(255), nullable=False)
    status          = Column(String(50),  nullable=False, default="offline")
    is_being_viewed = Column(Boolean,     nullable=False, default=False)
    enabled         = Column(Boolean,     nullable=False, server_default="true")
    time            = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    intersection = relationship("Intersection", back_populates="cctvs")
    detections   = relationship("Detection",       back_populates="cctv",  cascade="all, delete", passive_deletes=True)
    regions      = relationship("Region",          back_populates="cctv",  cascade="all, delete", passive_deletes=True)
    heartbeat    = relationship("WorkerHeartbeat", back_populates="cctv",  uselist=False, cascade="all, delete", passive_deletes=True)


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"

    id                = Column(Integer, primary_key=True, autoincrement=True)
    cctv_id           = Column(Integer, ForeignKey("cctvs.id", ondelete="CASCADE"), nullable=False, unique=True)
    worker_pid        = Column(Integer, nullable=False)
    last_seen         = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    claimed_at        = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    claim_version     = Column(Integer, nullable=False, default=0)
    status            = Column(String(50), nullable=False, default="running")
    frames_per_second = Column(Float, nullable=True)
    last_error        = Column(String(500), nullable=True)
    cctv = relationship("CCTV", back_populates="heartbeat")


class Region(Base):
    __tablename__ = "regions"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    cctv_id   = Column(Integer, ForeignKey("cctvs.id",   ondelete="CASCADE"), nullable=False)
    street_id = Column(Integer, ForeignKey("streets.id", ondelete="CASCADE"), nullable=False)
    direction = Column(String(10), nullable=False, default="unknown")
    time      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    cctv                  = relationship("CCTV",   back_populates="regions")
    street                = relationship("Street", back_populates="regions")
    region_points         = relationship("RegionPoint",       back_populates="region", cascade="all, delete", passive_deletes=True)
    detections_in_regions = relationship("DetectionInRegion", back_populates="region", cascade="all, delete", passive_deletes=True)


class RegionPoint(Base):
    __tablename__ = "region_points"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    region_id = Column(Integer, ForeignKey("regions.id", ondelete="CASCADE"), nullable=False)
    x         = Column(Float, nullable=False)  # normalized 0-1, NOT pixel coordinates
    y         = Column(Float, nullable=False)  # normalized 0-1, NOT pixel coordinates
    time      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    region = relationship("Region", back_populates="region_points")


class Detection(Base):
    __tablename__ = "detections"

    id          = Column(BigInteger, primary_key=True, autoincrement=True)
    cctv_id     = Column(Integer, ForeignKey("cctvs.id",  ondelete="CASCADE"),  nullable=True)
    video_id    = Column(Integer, ForeignKey("videos.id", ondelete="SET NULL"), nullable=True)
    track_id    = Column(Integer,    nullable=True)
    object_type = Column(String(50), nullable=False)
    confidence  = Column(Float,      nullable=False)
    x1          = Column(Float,      nullable=False)
    y1          = Column(Float,      nullable=False)
    x2          = Column(Float,      nullable=False)
    y2          = Column(Float,      nullable=False)
    time        = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    cctv                  = relationship("CCTV",  back_populates="detections")
    video                 = relationship("Video", back_populates="detections")
    detections_in_regions = relationship(
        "DetectionInRegion",
        back_populates="detection",
        cascade="all, delete",
        passive_deletes=True,
        primaryjoin="Detection.id == DetectionInRegion.detection_id",
        foreign_keys="[DetectionInRegion.detection_id]",
    )


class DetectionInRegion(Base):
    __tablename__ = "detections_in_regions"

    id           = Column(Integer,    primary_key=True, autoincrement=True)
    region_id    = Column(Integer,    ForeignKey("regions.id", ondelete="CASCADE"), nullable=False)
    detection_id = Column(BigInteger, nullable=False)
    time         = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    region    = relationship("Region",    back_populates="detections_in_regions")
    detection = relationship(
        "Detection",
        back_populates="detections_in_regions",
        primaryjoin="DetectionInRegion.detection_id == Detection.id",
        foreign_keys="DetectionInRegion.detection_id",
    )


class Video(Base):
    __tablename__ = "videos"

    id               = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id  = Column(Integer, ForeignKey("intersections.id", ondelete="SET NULL"), nullable=True)
    uploaded_by      = Column(Integer, ForeignKey("users.id",         ondelete="SET NULL"), nullable=True)
    filename         = Column(String(255), nullable=False)
    filepath         = Column(String(255), nullable=False)
    recorded_at      = Column(DateTime(timezone=True), nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    total_frames     = Column(Integer, nullable=True)
    processed_frames = Column(Integer, nullable=False, default=0)
    status           = Column(String(50), nullable=False, default="pending")
    uploaded_at      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    processed_at     = Column(DateTime(timezone=True), nullable=True)

    intersection = relationship("Intersection", back_populates="videos")
    uploader     = relationship("User",         back_populates="uploaded_videos", foreign_keys=[uploaded_by])
    detections   = relationship("Detection",    back_populates="video")


class Recommendation(Base):
    __tablename__ = "recommendations"

    id                     = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id        = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    warrant_1_met          = Column(Boolean, nullable=False, default=False)
    warrant_1_confidence   = Column(Float,   nullable=False, default=0.0)
    warrant_2_met          = Column(Boolean, nullable=False, default=False)
    warrant_2_confidence   = Column(Float,   nullable=False, default=0.0)
    warrant_4_met          = Column(Boolean, nullable=False, default=False)
    warrant_4_confidence   = Column(Float,   nullable=False, default=0.0)
    recommended            = Column(Boolean, nullable=False, default=False)
    recommended_confidence = Column(Float,   nullable=True)
    major_volume           = Column(Integer, nullable=True)
    minor_volume           = Column(Integer, nullable=True)
    peds                   = Column(Integer, nullable=True)
    vpm                    = Column(Integer, nullable=True)
    phf                    = Column(Float,   nullable=True)
    hour_start             = Column(DateTime(timezone=True), nullable=True)
    notes                  = Column(Text,    nullable=True)
    generated_at           = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    w_local_1_met          = Column(Boolean, nullable=True)
    w_local_1_confidence   = Column(Float,   nullable=True)
    w_local_2_met          = Column(Boolean, nullable=True)
    w_local_2_confidence   = Column(Float,   nullable=True)
    w_local_3_met          = Column(Boolean, nullable=True)
    w_local_3_confidence   = Column(Float,   nullable=True)
    # True when Webster's proposal did not beat the existing timing on any TOD
    # chunk. The timing + simulation rows are kept so the UI can render them as
    # an informational "current vs proposed" comparison instead of as a plan.
    proposal_is_no_op      = Column(Boolean, nullable=False, server_default="false", default=False)

    intersection           = relationship("Intersection",         back_populates="recommendations")
    timing_recommendations = relationship("TimingRecommendation", back_populates="recommendation", cascade="all, delete", passive_deletes=True)
    simulation_results     = relationship("SimulationResult",     back_populates="recommendation", cascade="all, delete", passive_deletes=True)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    user_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    endpoint   = Column(Text,    nullable=False, unique=True)
    p256dh     = Column(Text,    nullable=False)
    auth       = Column(Text,    nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="push_subscriptions")


class TodChunk(Base):
    __tablename__ = "tod_chunks"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    name            = Column(String(50), nullable=False)
    start_minutes   = Column(Integer, nullable=False)
    end_minutes     = Column(Integer, nullable=False)
    created_at      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection = relationship("Intersection", back_populates="tod_chunks")


class PceOverride(Base):
    __tablename__ = "pce_overrides"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    vehicle_type    = Column(String(50), nullable=False)
    pce_value       = Column(Float, nullable=False)
    created_at      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection = relationship("Intersection", back_populates="pce_overrides")


class PceCalibratedValue(Base):
    __tablename__ = "pce_calibrated_values"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    vehicle_type    = Column(String(50), nullable=False)
    pce_value       = Column(Float, nullable=False)
    calibrated_at   = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection = relationship("Intersection", back_populates="pce_calibrated_values")


class TimingRecommendation(Base):
    __tablename__ = "timing_recommendations"

    id               = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id  = Column(Integer, ForeignKey("intersections.id",  ondelete="CASCADE"), nullable=False)
    recommendation_id = Column(Integer, ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False)
    chunk_name       = Column(String(50), nullable=False)
    cycle_length     = Column(Integer, nullable=False)
    green_splits     = Column(JSON, nullable=False)
    effective_date   = Column(DateTime(timezone=True), nullable=False)
    pce_tier_used    = Column(String(20), nullable=False)
    signal_off       = Column(Boolean, nullable=False, server_default="false")
    generated_at     = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection   = relationship("Intersection",  back_populates="timing_recommendations")
    recommendation = relationship("Recommendation", back_populates="timing_recommendations")


class SimulationResult(Base):
    __tablename__ = "simulation_results"

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id     = Column(Integer, ForeignKey("intersections.id",  ondelete="CASCADE"), nullable=False)
    recommendation_id   = Column(Integer, ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False)
    chunk_name          = Column(String(50), nullable=False)
    delay_before        = Column(Float, nullable=False)
    delay_after         = Column(Float, nullable=False)
    vc_ratio_before     = Column(Float, nullable=True)
    vc_ratio_after      = Column(Float, nullable=True)
    volume_pcu_hr       = Column(Float, nullable=False, server_default="0")
    vehicle_hours_saved = Column(Float, nullable=False, server_default="0")
    queue_series_before = Column(JSON, nullable=True)
    queue_series_after  = Column(JSON, nullable=True)
    generated_at        = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection  = relationship("Intersection",  back_populates="simulation_results")
    recommendation = relationship("Recommendation", back_populates="simulation_results")


class AggregationSummary(Base):
    __tablename__ = "aggregation_summaries"
    __table_args__ = {"info": {"is_view": True}}

    intersection_id = Column(Integer,    primary_key=True)
    street_id       = Column(Integer,    primary_key=True)
    direction       = Column(String(10), primary_key=True)
    object_type     = Column(String(50), primary_key=True)
    window_start    = Column(DateTime(timezone=True), primary_key=True)
    count           = Column(Integer,    nullable=False)


class EnforcementEvent(Base):
    """Retained enforcement events (plate reads, violations) drained from the
    Redis Stream by sink/sink.py. Unlike `detections` (a 72h-retention Timescale
    hypertable), these are kept; `event_id` is the idempotency key that makes
    the sink's at-least-once replay effectively-once. See migration 0020 and
    experiments/durable-sink/ for the failure-mode rationale."""
    __tablename__ = "enforcement_events"

    id           = Column(BigInteger, primary_key=True, autoincrement=True)
    event_id     = Column(Text,        nullable=False, unique=True)
    event_type   = Column(String(40),  nullable=False)
    cctv_id      = Column(Integer,     nullable=True)  # plain int, no write-time FK (see migration 0020)
    track_id     = Column(Integer,     nullable=True)
    plate        = Column(String(16),  nullable=True)
    vehicle_type = Column(String(50),  nullable=True)
    confidence   = Column(Float,       nullable=True)
    captured_at  = Column(DateTime(timezone=True), nullable=False)
    meta         = Column(JSON,        nullable=True)
    stored_at    = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)