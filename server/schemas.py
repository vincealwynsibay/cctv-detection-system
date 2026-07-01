from pydantic import BaseModel, ConfigDict, model_validator, field_validator
from datetime import datetime
from typing import Any, Literal, Optional


class UserBase(BaseModel):
    username: str
    password: str


class UserCreate(UserBase):
    pass


class UserUpdate(BaseModel):
    password: Optional[str] = None


class UserResponse(BaseModel):
    id: int
    username: str
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class IntersectionBase(BaseModel):
    name: str
    latitude: float
    longitude: float


class IntersectionCreate(IntersectionBase):
    pass


class IntersectionUpdate(BaseModel):
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    crossing_width_m: Optional[float] = None
    saturation_flow_pcu_hr: Optional[int] = None


class SignalTimingUpdate(BaseModel):
    signal_status: Literal["unsignalized", "fixed_time", "actuated"]
    existing_cycle_length: Optional[int] = None
    existing_green_splits: Optional[dict[str, Any]] = None


class LocalWarrantConfigUpdate(BaseModel):
    w_local_1_threshold: Optional[float] = None
    w_local_2_threshold: Optional[float] = None
    w_local_3_min_pcu: Optional[float] = None


class IntersectionResponse(IntersectionBase):
    id: int
    signal_status: str = "unsignalized"
    existing_cycle_length: Optional[int] = None
    existing_green_splits: Optional[dict[str, Any]] = None
    effective_green_splits: Optional[dict[str, Any]] = None
    w_local_1_threshold: float = 0.6
    w_local_2_threshold: float = 0.7
    w_local_3_min_pcu: float = 30.0
    crossing_width_m: float = 12.0
    saturation_flow_pcu_hr: int = 1400
    dismissed_setup_tasks: list[str] = []
    time: datetime
    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="after")
    def compute_effective_green_splits(self) -> "IntersectionResponse":
        if self.existing_green_splits:
            self.effective_green_splits = self.existing_green_splits
        elif self.existing_cycle_length:
            split = round(self.existing_cycle_length / 4)
            self.effective_green_splits = {str(i): split for i in range(1, 5)}
        return self


class StreetBase(BaseModel):
    intersection_id: int
    name: str


ARM_DIRECTIONS = Literal["northbound", "southbound", "eastbound", "westbound", "unknown"]


class StreetCreate(StreetBase):
    arm_direction: ARM_DIRECTIONS = "unknown"


class StreetUpdate(BaseModel):
    name: Optional[str] = None
    arm_direction: Optional[ARM_DIRECTIONS] = None


class StreetResponse(StreetBase):
    id: int
    arm_direction: str = "unknown"
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class CCTVBase(BaseModel):
    intersection_id: int
    name: str
    rtsp_url: str


class CCTVCreate(CCTVBase):
    pass


class CCTVUpdate(BaseModel):
    name: Optional[str] = None
    rtsp_url: Optional[str] = None
    intersection_id: Optional[int] = None


class CCTVResponse(CCTVBase):
    id: int
    status: str
    last_error: str | None = None
    is_being_viewed: bool
    enabled: bool
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class DetectionBase(BaseModel):
    cctv_id: Optional[int] = None  # nullable - video detections have no cctv
    object_type: str


class DetectionResponse(DetectionBase):
    id: int
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class RegionPointBase(BaseModel):
    x: float
    y: float

    @field_validator('x', 'y')
    @classmethod
    def must_be_normalized(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError('must be between 0 and 1 (normalized coordinate)')
        return v


class RegionBase(BaseModel):
    cctv_id: int
    street_id: int
    direction: str = 'unknown'
    region_points: list[RegionPointBase]


class RegionCreate(RegionBase):
    pass


class RegionUpdate(BaseModel):
    cctv_id: Optional[int] = None
    street_id: Optional[int] = None
    direction: Optional[str] = None
    region_points: Optional[list[RegionPointBase]] = None


class RegionResponse(RegionBase):
    id: int
    time: datetime
    model_config = ConfigDict(from_attributes=True)
