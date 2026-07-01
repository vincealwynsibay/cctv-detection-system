"""Analytical delay simulation tests - unit (delay formulas) + integration."""
import math
import pytest

from tests.conftest import API_URL


# ── Unit tests ───────────────────────────────────────────────────────────────

def test_uniform_delay_typical():
    """Webster's uniform delay produces a plausible value for a typical input.

    Range tightened on 2026-06-30 after a validation-driven fix to
    `compute_uniform_delay` (the denominator used (1-x) instead of (1-λ·x);
    closed-form expected values are now exercised in
    `tests/test_simulation_validation.py`).
    """
    from server.simulation import compute_uniform_delay

    # C=90s, g=30s (λ=1/3), q=400 PCU/hr, s=1400
    # cap = 1400 * 0.333 = 466.7,  x = 400/466.7 = 0.857
    # d = 90 * (1-0.333)² / (2 * (1 - 0.333 * 0.857))
    #   = 90 * 0.444 / (2 * 0.714)
    #   ≈ 28.0 s/veh   (HCM Level of Service C territory)
    d = compute_uniform_delay(C=90, g=30, q_pcu_hr=400)
    assert 25 < d < 35


def test_uniform_delay_zero_flow():
    from server.simulation import compute_uniform_delay
    assert compute_uniform_delay(C=90, g=30, q_pcu_hr=0) == 0.0


def test_uniform_delay_zero_green():
    from server.simulation import compute_uniform_delay
    assert compute_uniform_delay(C=90, g=0, q_pcu_hr=400) == 0.0


def test_uniform_delay_near_saturation():
    """Near-saturated demand should be capped, not infinite."""
    from server.simulation import compute_uniform_delay
    d = compute_uniform_delay(C=90, g=30, q_pcu_hr=1700)
    assert math.isfinite(d)
    assert d > 0


def test_uniform_delay_longer_green_reduces_delay():
    """More green time → less delay (all else equal)."""
    from server.simulation import compute_uniform_delay
    d_short = compute_uniform_delay(C=90, g=20, q_pcu_hr=300)
    d_long  = compute_uniform_delay(C=90, g=50, q_pcu_hr=300)
    assert d_short > d_long


def test_hcm_gap_delay_no_major():
    """Zero major-street flow → minimal delay."""
    from server.simulation import compute_hcm_gap_delay
    d = compute_hcm_gap_delay(q_major_pcu_hr=0, q_minor_pcu_hr=100)
    assert d == 5.0


def test_hcm_gap_delay_heavy_major():
    """Heavy major-street flow → more delay than zero-major case."""
    from server.simulation import compute_hcm_gap_delay
    d_heavy = compute_hcm_gap_delay(q_major_pcu_hr=800, q_minor_pcu_hr=100)
    d_none  = compute_hcm_gap_delay(q_major_pcu_hr=0,   q_minor_pcu_hr=100)
    assert d_heavy > d_none


def test_hcm_gap_delay_finite():
    """Should never return infinity."""
    from server.simulation import compute_hcm_gap_delay
    d = compute_hcm_gap_delay(q_major_pcu_hr=1200, q_minor_pcu_hr=200)
    assert math.isfinite(d)


def test_queue_series_signalized_length():
    """Queue series has exactly 60 values (one per minute)."""
    from server.simulation import _queue_series_signalized
    series = _queue_series_signalized(q_pcu_hr=400, C=90, g=30)
    assert len(series) == 60


def test_queue_series_signalized_nonnegative():
    from server.simulation import _queue_series_signalized
    series = _queue_series_signalized(q_pcu_hr=300, C=60, g=25)
    assert all(v >= 0 for v in series)


def test_queue_series_unsignalized_stable():
    """When capacity > arrival the queue stays at 0."""
    from server.simulation import _queue_series_unsignalized
    series = _queue_series_unsignalized(q_pcu_hr=100, capacity_pcu_hr=600)
    assert all(v == 0.0 for v in series)


def test_delay_to_los_signalized_all_grades():
    """Every HCM signalized LOS threshold boundary maps to the correct grade."""
    from server.simulation import delay_to_los
    assert delay_to_los(0.0,  signalized=True) == "A"
    assert delay_to_los(10.0, signalized=True) == "A"  # boundary: ≤10 → A
    assert delay_to_los(10.1, signalized=True) == "B"
    assert delay_to_los(20.0, signalized=True) == "B"  # boundary: ≤20 → B
    assert delay_to_los(20.1, signalized=True) == "C"
    assert delay_to_los(35.0, signalized=True) == "C"  # boundary: ≤35 → C
    assert delay_to_los(35.1, signalized=True) == "D"
    assert delay_to_los(55.0, signalized=True) == "D"  # boundary: ≤55 → D
    assert delay_to_los(55.1, signalized=True) == "E"
    assert delay_to_los(80.0, signalized=True) == "E"  # boundary: ≤80 → E
    assert delay_to_los(80.1, signalized=True) == "F"
    assert delay_to_los(999,  signalized=True) == "F"


def test_delay_to_los_unsignalized_all_grades():
    """HCM TWSC LOS thresholds (tighter than signalized) map correctly."""
    from server.simulation import delay_to_los
    assert delay_to_los(10.0, signalized=False) == "A"
    assert delay_to_los(10.1, signalized=False) == "B"
    assert delay_to_los(15.0, signalized=False) == "B"
    assert delay_to_los(15.1, signalized=False) == "C"
    assert delay_to_los(25.0, signalized=False) == "C"
    assert delay_to_los(25.1, signalized=False) == "D"
    assert delay_to_los(35.0, signalized=False) == "D"
    assert delay_to_los(35.1, signalized=False) == "E"
    assert delay_to_los(50.0, signalized=False) == "E"
    assert delay_to_los(50.1, signalized=False) == "F"


def test_delay_to_los_defaults_to_signalized():
    """Calling without signalized kwarg uses signalized thresholds."""
    from server.simulation import delay_to_los
    # 40s → LOS D under signalized (≤55), LOS E under unsignalized (>35)
    assert delay_to_los(40.0) == "D"


def test_compute_vc_ratio_typical():
    from server.simulation import compute_vc_ratio
    # x = q*C/(S*g) = 350*90/(1400*45) = 31500/63000 = 0.5
    assert compute_vc_ratio(C=90, g=45, q_pcu_hr=350) == pytest.approx(0.5, rel=0.01)


def test_compute_vc_ratio_capped_at_one():
    """Oversaturated approaches are capped at 1.0, not returned as >1."""
    from server.simulation import compute_vc_ratio
    assert compute_vc_ratio(C=90, g=45, q_pcu_hr=9999) == 1.0


def test_compute_vc_ratio_zero_cycle():
    from server.simulation import compute_vc_ratio
    assert compute_vc_ratio(C=0, g=45, q_pcu_hr=400) == 0.0


def test_compute_vc_ratio_zero_green():
    from server.simulation import compute_vc_ratio
    assert compute_vc_ratio(C=90, g=0, q_pcu_hr=400) == 0.0


def test_compute_vc_ratio_proportional():
    """Doubling flow doubles v/c (below cap)."""
    from server.simulation import compute_vc_ratio
    vc_low  = compute_vc_ratio(C=90, g=45, q_pcu_hr=200)
    vc_high = compute_vc_ratio(C=90, g=45, q_pcu_hr=400)
    assert vc_high == pytest.approx(vc_low * 2, rel=0.01)


# ── Integration tests ────────────────────────────────────────────────────────

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_sim_test_inter", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_generate_creates_simulation_rows(auth, intersection):
    """Generating a recommendation triggers simulation row creation, fetchable via GET."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    r = auth.get(f"{API_URL}/simulation/{iid}")
    assert r.status_code == 200
    body = r.json()
    assert body["intersection_id"] == iid
    assert "chunks" in body
    assert "daily_summary" in body


def test_simulation_chunk_fields(auth, intersection):
    """Each simulation chunk has the required numeric fields and LOS grades."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    body = auth.get(f"{API_URL}/simulation/{iid}").json()
    for chunk in body["chunks"]:
        assert "delay_before" in chunk
        assert "delay_after"  in chunk
        assert chunk["delay_before"] >= 0
        assert chunk["delay_after"]  >= 0
        assert chunk["los_before"] in ("A", "B", "C", "D", "E", "F")
        assert chunk["los_after"]  in ("A", "B", "C", "D", "E", "F")
        assert "vc_ratio_before" in chunk
        assert "vc_ratio_after"  in chunk


def test_simulation_queue_series_present(auth, intersection):
    """Queue series JSON is present (may be null when no flow data exists)."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    body = auth.get(f"{API_URL}/simulation/{iid}").json()
    # fields must exist in each chunk (value may be null when no flow data)
    for chunk in body["chunks"]:
        assert "queue_series_before" in chunk
        assert "queue_series_after"  in chunk


def test_simulation_daily_summary(auth, intersection):
    """daily_summary has all required fields including LOS grades."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    body = auth.get(f"{API_URL}/simulation/{iid}").json()
    ds = body["daily_summary"]
    assert "total_vehicle_hours_saved" in ds
    assert "avg_delay_before"          in ds
    assert "avg_delay_after"           in ds
    assert "total_volume_pcu_hr"       in ds
    assert ds["los_before"] in ("A", "B", "C", "D", "E", "F")
    assert ds["los_after"]  in ("A", "B", "C", "D", "E", "F")


def test_simulation_404_no_recommendation(auth):
    """Returns 404 when intersection has no recommendations."""
    r = auth.get(f"{API_URL}/simulation/999999")
    assert r.status_code == 404


def test_generate_all_creates_simulation_rows(auth, intersection):
    """generate-all endpoint also produces simulation rows."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate-all")

    r = auth.get(f"{API_URL}/simulation/{iid}")
    assert r.status_code == 200
