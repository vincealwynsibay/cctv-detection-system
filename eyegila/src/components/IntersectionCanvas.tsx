import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Maximize2, Minimize2, Play, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { SimulationChunk } from '@/services/simulation';
import type { TimingChunk } from '@/services/timing';
import type { Street } from '@/types';
import { DEFAULT_TURN_DISTRIBUTION } from '@/lib/traffic-sim';

// Physical arm position → which direction of traffic queues there (right-hand traffic).
// Approach 0 = North arm → SB vehicles; 1 = East arm → WB; 2 = South arm → NB; 3 = West arm → EB.
const ARM_DIR_TO_APPROACH: Record<string, number> = {
  southbound: 0, westbound: 1, northbound: 2, eastbound: 3,
};
// 4-phase plan: each arm runs independently (matches the physical signal controller).
// Order: SB (N-arm) → WB (E-arm) → NB (S-arm) → EB (W-arm).
const PHASE_GROUPS: number[][] = [[0], [1], [2], [3]];

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444'];
const DIR_LABELS = ['N', 'E', 'S', 'W'];
const SPEEDS = [
  { label: '⅒×', sps: 1.5 },
  { label: '¼×', sps: 4 },
  { label: '1×',  sps: 15 },
  { label: '5×',  sps: 75 },
  { label: '10×', sps: 150 },
];
const SIM_DURATION = 3600;
const ARM_UNITS = 118;
const BOX_UNITS = 52;
const MAX_QUEUE = 15;
const MAX_PHYSICS_DT = 0.1;
const GAP_THRESHOLD_S = 6;
const GAP_PHASE_S = 10; // each axis (N-S or E-W) gets this many sim-seconds of priority
// Conflicting approach indices for gap-acceptance (perpendicular pairs)
const CONFLICTS: number[][] = [[1, 3], [0, 2], [1, 3], [0, 2]];

// Lane offset in canvas units (= aw/4 / sc = 72/4). Half-lane from road center.
// PH right-hand traffic. Canvas y grows DOWNWARD (south = +y), so:
//   SB → west lane (x = -LANE_OFF), NB → east (+LANE_OFF)
//   WB → north lane (y = -LANE_OFF), EB → south (+LANE_OFF)
// Prior to this fix the EW lanes were swapped (WB on south, EB on north),
// producing a head-on collision layout for east-west traffic.
const LANE_OFF   = 18;
const AMBER_S    = 3;    // amber transition seconds at end of green
const PED2D_SPD  = 0.035; // fractional crosswalk distance per sim-second

// Box-edge points where each approach's inbound lane meets the intersection box.
// Index = approach: 0 SB, 1 WB, 2 NB, 3 EB.
const ARM_ENTRY_IN: [number, number][] = [
  [-LANE_OFF, -BOX_UNITS],   // SB (west lane, entering from north)
  [ BOX_UNITS, -LANE_OFF],   // WB (north lane, entering from east)
  [ LANE_OFF,  BOX_UNITS],   // NB (east lane, entering from south)
  [-BOX_UNITS,  LANE_OFF],   // EB (south lane, entering from west)
];
// Box-edge points where vehicles exit the intersection into each arm's outbound lane.
// Index = arm: 0 north (NB exit), 1 east (EB exit), 2 south (SB exit), 3 west (WB exit).
const ARM_ENTRY_OUT: [number, number][] = [
  [ LANE_OFF, -BOX_UNITS],   // arm 0 → NB exit (east lane)
  [ BOX_UNITS, LANE_OFF],    // arm 1 → EB exit (south lane)
  [-LANE_OFF,  BOX_UNITS],   // arm 2 → SB exit (west lane)
  [-BOX_UNITS,-LANE_OFF],    // arm 3 → WB exit (north lane)
];
const ARM_EXIT_PT: [number, number][] = [
  [ LANE_OFF, -(BOX_UNITS + ARM_UNITS)],   // arm 0 far end (NB lane)
  [ BOX_UNITS + ARM_UNITS,  LANE_OFF],     // arm 1 far end (EB lane)
  [-LANE_OFF,   BOX_UNITS + ARM_UNITS],    // arm 2 far end (SB lane)
  [-(BOX_UNITS + ARM_UNITS), -LANE_OFF],   // arm 3 far end (WB lane)
];
// Exit arm index per approach: [through, left, right]
const TURN_EXIT: [number, number, number][] = [
  [2, 1, 3], [3, 2, 0], [0, 3, 1], [1, 0, 2],
];

export type VehicleType = 'MC' | 'CAR' | 'JEP' | 'BUS' | 'TRUCK';
export type TypeFractions = Record<VehicleType, number>;

const DEFAULT_TYPE_MIX: TypeFractions = {
  MC: 0.50, CAR: 0.30, JEP: 0.15, BUS: 0.03, TRUCK: 0.02,
};

const VEHICLE_TYPES: VehicleType[] = ['MC', 'CAR', 'JEP', 'BUS', 'TRUCK'];

function sampleType(fractions: TypeFractions): VehicleType {
  const r = Math.random();
  let cum = 0;
  for (const t of VEHICLE_TYPES) {
    cum += fractions[t];
    if (r < cum) return t;
  }
  return 'CAR';
}

interface Vehicle {
  id: number;
  type: VehicleType;
  approach: number;
  distFromStop: number;
  currSpeed: number;
  clearing: boolean;
  turn: 'through' | 'left' | 'right' | null;
  px: number;   // canvas units from center; valid when clearing
  py: number;
  waypoints: { x: number; y: number }[];
  critGap: number;  // stochastic critical gap for gap-acceptance (sim-seconds)
}

const VEHICLE_PARAMS: Record<VehicleType, {
  length: number; width: number; maxSpeed: number; accel: number; decel: number; minGap: number; T: number;
}> = {
  MC:    { length: 14, width: 8,  maxSpeed: 90, accel: 72,  decel: 180, minGap: 8,  T: 0.9 },
  CAR:   { length: 18, width: 10, maxSpeed: 70, accel: 50,  decel: 140, minGap: 12, T: 1.2 },
  JEP:   { length: 22, width: 12, maxSpeed: 55, accel: 36,  decel: 110, minGap: 16, T: 1.5 },
  BUS:   { length: 28, width: 14, maxSpeed: 45, accel: 25,  decel: 90,  minGap: 20, T: 1.8 },
  TRUCK: { length: 28, width: 14, maxSpeed: 45, accel: 25,  decel: 90,  minGap: 20, T: 1.8 },
};

// --- Turn routing ---

// Quadratic Bezier sample
function qBez(t: number, p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number): { x: number; y: number } {
  const mt = 1 - t;
  return { x: mt*mt*p0x + 2*mt*t*p1x + t*t*p2x, y: mt*mt*p0y + 2*mt*t*p1y + t*t*p2y };
}

const ARC_SAMPLES = 10;

// Bezier control point (corner anchor) per approach × turn direction.
// Each entry is [cpX, cpY] in canvas units relative to intersection center.
//
// Both left AND right turns use the entry-aligned LANE intersection:
//   cp.x = entry.x   (initial bezier tangent = pure entry direction)
//   cp.z = exit.z    (final tangent = pure exit direction)
// This makes the vehicle drive forward first and then arc smoothly through
// the inside corner of the turn. The old right-turn BOX-corner anchor had
// the wrong initial tangent - e.g. SB→W started with a pure −X velocity
// even though the entry direction is +Z, producing a visible sideways
// swerve the instant the vehicle cleared the stop line.
// cp.x = entry-invariant x (SB/NB pin x to entry.x; WB/EB pin x to exit.x)
// cp.y = entry-invariant y (WB/EB pin y to entry.y; SB/NB pin y to exit.y)
// Result: initial bezier tangent = entry direction, final = exit direction,
// so vehicles drive straight first and then arc smoothly through the inside
// corner of the turn - no sideways veer on either left or right turns.
const TURN_CP: Record<'left' | 'right', [number, number][]> = {
  left:  [
    [-LANE_OFF, LANE_OFF],   // 0 SB → E (entry x=-LANE, exit y=+LANE)
    [-LANE_OFF,-LANE_OFF],   // 1 WB → S (exit x=-LANE, entry y=-LANE)
    [ LANE_OFF,-LANE_OFF],   // 2 NB → W (entry x=+LANE, exit y=-LANE)
    [ LANE_OFF, LANE_OFF],   // 3 EB → N (exit x=+LANE, entry y=+LANE)
  ],
  right: [
    [-LANE_OFF,-LANE_OFF],   // 0 SB → W (entry x=-LANE, exit y=-LANE)
    [ LANE_OFF,-LANE_OFF],   // 1 WB → N (exit x=+LANE, entry y=-LANE)
    [ LANE_OFF, LANE_OFF],   // 2 NB → E (entry x=+LANE, exit y=+LANE)
    [-LANE_OFF, LANE_OFF],   // 3 EB → S (exit x=-LANE, entry y=+LANE)
  ],
};

function buildWaypoints(approach: number, turn: 'through' | 'left' | 'right'): { x: number; y: number }[] {
  const exitArmIdx = TURN_EXIT[approach][turn === 'through' ? 0 : turn === 'left' ? 1 : 2];
  const [p2x, p2y] = ARM_ENTRY_OUT[exitArmIdx];
  const [ex, ey]   = ARM_EXIT_PT[exitArmIdx];

  if (turn === 'through') {
    return [{ x: p2x, y: p2y }, { x: ex, y: ey }];
  }

  // Quadratic Bezier arc from approach entry → corner control point → exit arm entry
  const [p0x, p0y] = ARM_ENTRY_IN[approach];
  const [cpx, cpy] = TURN_CP[turn][approach];
  const pts: { x: number; y: number }[] = [];
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    pts.push(qBez(i / ARC_SAMPLES, p0x, p0y, cpx, cpy, p2x, p2y));
  }
  pts.push({ x: ex, y: ey });
  return pts;
}

function initClearing(v: Vehicle): void {
  // Deterministic-per-vehicle turn pick (id-derived) so a paused/scrubbed
  // canvas always shows the same path. Tracks the central
  // DEFAULT_TURN_DISTRIBUTION (50/25/25) used by the 3D scene so the two
  // views agree on movement mix.
  const r = (v.id * 1337 + 42) % 100;
  const thru = DEFAULT_TURN_DISTRIBUTION.through * 100;
  const left = (DEFAULT_TURN_DISTRIBUTION.through + DEFAULT_TURN_DISTRIBUTION.left) * 100;
  v.turn = r < thru ? 'through' : r < left ? 'left' : 'right';
  [v.px, v.py] = ARM_ENTRY_IN[v.approach];
  v.waypoints = buildWaypoints(v.approach, v.turn);
}

// --- IDM (Intelligent Driver Model - Treiber et al. 2000) ---
// Returns acceleration in canvas units/s² (positive = accelerate, negative = brake).
function idmAccel(
  v: number,     // current speed (cu/s)
  vLead: number, // leader speed; Infinity = no leader
  s: number,     // bumper-to-bumper gap; Infinity = no leader
  p: { maxSpeed: number; accel: number; decel: number; minGap: number; T: number },
): number {
  const dv    = v - (isFinite(vLead) ? vLead : 0);
  const sStar = p.minGap + Math.max(0, v * p.T + v * dv / (2 * Math.sqrt(p.accel * p.decel)));
  const sEff  = isFinite(s) ? Math.max(s, 0.01) : 1e6;
  return p.accel * (1 - Math.pow(Math.max(v, 0) / p.maxSpeed, 4) - Math.pow(sStar / sEff, 2));
}

// --- Gap acceptance ---

// Alternates priority between N-S (approaches 0&2) and E-W (approaches 1&3) every
// GAP_PHASE_S sim-seconds.  Without this, all four approaches stop, nobody blocks
// anyone (speed=0), and all discharge simultaneously through the box.
function conflictingGapOk(approach: number, vehicles: Vehicle[], gapTime: number, critGap: number): boolean {
  // axis 0 = N-S (approach % 2 === 0); axis 1 = E-W (approach % 2 === 1)
  const axisNow = Math.floor(gapTime / GAP_PHASE_S) % 2;
  if (approach % 2 !== axisNow) return false;

  const conflicts = CONFLICTS[approach] ?? [];
  for (const ca of conflicts) {
    // Perpendicular-axis approaches can't proceed right now - their vehicles decelerate
    // to a stop at the line, so they are not a real gap threat (avoids deadlock where
    // both axes block each other indefinitely).
    if (ca % 2 !== axisNow) continue;
    const cvs = vehicles.filter(v => v.approach === ca && !v.clearing);
    if (cvs.length === 0) continue;
    cvs.sort((a, b) => a.distFromStop - b.distFromStop);
    const lead = cvs[0];
    const leadLen = VEHICLE_PARAMS[lead.type].length;
    if (lead.currSpeed > 0 && lead.distFromStop < leadLen) return false;
    if (lead.currSpeed > 0 && lead.distFromStop / lead.currSpeed < critGap) return false;
  }
  return true;
}

// --- Physics ---

function stepPhysics(
  vehicles: Vehicle[],
  dt: number,
  greenFlags: boolean[],
  gapMode: boolean,
  gapTime = 0,
): void {
  // Move clearing vehicles along their waypoint path
  for (const v of vehicles) {
    if (!v.clearing) continue;
    const p = VEHICLE_PARAMS[v.type];
    // Accelerate using IDM free-flow term (no leader)
    v.currSpeed = Math.min(v.currSpeed + p.accel * (1 - Math.pow(Math.max(v.currSpeed,0)/p.maxSpeed, 4)) * dt, p.maxSpeed);
    let rem = v.currSpeed * dt;
    while (rem > 1e-9 && v.waypoints.length > 0) {
      const wp = v.waypoints[0];
      const dx = wp.x - v.px;
      const dy = wp.y - v.py;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) { v.waypoints.shift(); continue; }
      if (rem >= d) {
        v.px = wp.x; v.py = wp.y;
        v.waypoints.shift();
        rem -= d;
      } else {
        v.px += (dx / d) * rem;
        v.py += (dy / d) * rem;
        rem = 0;
      }
    }
  }

  // Remove clearing vehicles that have reached their exit
  for (let i = vehicles.length - 1; i >= 0; i--) {
    if (vehicles[i].clearing && vehicles[i].waypoints.length === 0) vehicles.splice(i, 1);
  }

  // Car-following for queuing vehicles - Intelligent Driver Model (Treiber et al. 2000)
  const byApproach = new Map<number, Vehicle[]>();
  for (const v of vehicles) {
    if (v.clearing) continue;
    let list = byApproach.get(v.approach);
    if (!list) { list = []; byApproach.set(v.approach, list); }
    list.push(v);
  }

  for (const [ap, apVehicles] of byApproach) {
    // Sort ascending by distFromStop: index 0 = lead (closest to stop line)
    const queuing = apVehicles.sort((a, b) => a.distFromStop - b.distFromStop);
    // Use the lead vehicle's personal critical gap for gap-acceptance
    const leadCritGap = queuing[0]?.critGap ?? GAP_THRESHOLD_S;
    const canProceed = gapMode
      ? conflictingGapOk(ap, vehicles, gapTime, leadCritGap)
      : (greenFlags[ap] ?? false);

    for (let k = 0; k < queuing.length; k++) {
      const v = queuing[k];
      const p = VEHICLE_PARAMS[v.type];

      // Determine IDM leader (gap s = bumper-to-bumper, vLead = leader speed)
      // and the hard positional floor that physically prevents overlap.
      let s: number, vLead: number, hardMin: number;
      if (k === 0) {
        if (canProceed) {
          s = Infinity; vLead = Infinity; hardMin = -99999; // free flow
        } else {
          s = Math.max(v.distFromStop, 0.01); vLead = 0; hardMin = 0; // stop at line
        }
      } else {
        const ahead = queuing[k - 1];
        const aheadRear = ahead.distFromStop + VEHICLE_PARAMS[ahead.type].length;
        s       = v.distFromStop - aheadRear;    // bumper-to-bumper gap
        vLead   = ahead.currSpeed;
        hardMin = aheadRear;                     // never let follower pass leader's rear
      }

      const acc = idmAccel(v.currSpeed, vLead, s, p);
      v.currSpeed = Math.max(0, v.currSpeed + acc * dt);

      const rawNext = v.distFromStop - v.currSpeed * dt;
      if (rawNext < hardMin) {
        // Hard constraint hit: pin to leader / stop line and match speed
        v.distFromStop = hardMin;
        v.currSpeed    = k > 0 ? Math.min(v.currSpeed, queuing[k - 1].currSpeed) : 0;
      } else {
        v.distFromStop = rawNext;
      }

      if (k === 0 && canProceed && v.distFromStop < 0) {
        v.clearing = true;
        initClearing(v);
      }
    }
  }
}

// --- Spawn ---

// Interval-driven spawning (Poisson reconstruction from aggregate volume).
function spawnVehicles(
  vehicles: Vehicle[],
  timers: number[],
  nextId: { current: number },
  ids: string[],
  activeApproaches: Set<number>,
  intervals: number[],
  typeMixByApproach: TypeFractions[],
  dtSim: number,
): void {
  for (let i = 0; i < ids.length && i < 4; i++) {
    if (!activeApproaches.has(i)) continue;
    timers[i] += dtSim;

    while (timers[i] >= intervals[i]) {
      timers[i] -= intervals[i];
      if (!trySpawnOne(vehicles, nextId, i, typeMixByApproach)) break;
    }
  }
}

// Schedule-driven spawning. Replays per-second vehicle counts from real
// detections so the playback matches when traffic actually arrived. Falls
// back gracefully when an approach has no schedule entry.
function spawnFromArrivals(
  vehicles: Vehicle[],
  nextId: { current: number },
  ids: string[],
  activeApproaches: Set<number>,
  arrivalsByApproach: (number[] | undefined)[],
  carries: number[],
  lastSecRef: { current: number },
  typeMixByApproach: TypeFractions[],
  simT: number,
): void {
  const curSec = Math.floor(simT);
  while (lastSecRef.current < curSec) {
    lastSecRef.current += 1;
    for (let i = 0; i < 4; i++) {
      const arr = arrivalsByApproach[i];
      if (!arr || arr.length === 0) continue;
      carries[i] += arr[lastSecRef.current % arr.length] ?? 0;
    }
  }
  for (let i = 0; i < ids.length && i < 4; i++) {
    if (!activeApproaches.has(i)) continue;
    while (carries[i] >= 1) {
      if (!trySpawnOne(vehicles, nextId, i, typeMixByApproach)) break;
      carries[i] -= 1;
    }
  }
}

function trySpawnOne(
  vehicles: Vehicle[],
  nextId: { current: number },
  i: number,
  typeMixByApproach: TypeFractions[],
): boolean {
  const apVehicles = vehicles.filter(v => v.approach === i && !v.clearing);
  if (apVehicles.length >= MAX_QUEUE) return false;

  const type = sampleType(typeMixByApproach[i] ?? DEFAULT_TYPE_MIX);
  const p = VEHICLE_PARAMS[type];
  const spawnDist = ARM_UNITS - p.length;

  if (apVehicles.length > 0) {
    const maxBack = Math.max(...apVehicles.map(v => v.distFromStop + VEHICLE_PARAMS[v.type].length));
    if (spawnDist - maxBack < p.minGap) return false;
  }

  // Sample critical gap from a uniform distribution [5.0, 8.5] s - driver heterogeneity
  const critGap = 5.0 + Math.random() * 3.5;
  vehicles.push({
    id: nextId.current++, type, approach: i,
    distFromStop: spawnDist, currSpeed: 0, clearing: false,
    turn: null, px: 0, py: 0, waypoints: [],
    critGap,
  });
  return true;
}

// --- Signal ---

function computeGreenState(
  ids: string[],
  cycleLength: number,
  splits: Record<string, number>,
  simTime: number,
  phaseGroups?: number[][],
): boolean[] {
  return computeGreenStateExt(ids, cycleLength, splits, simTime, phaseGroups).flags;
}

type SignalState = 'green' | 'amber' | 'red';

// Extended green-state: returns per-approach signal states and physics flags.
// phaseGroups: approach indices that run concurrently (e.g. [[0,2],[1,3]] for N-S / E-W).
// Amber phase = last AMBER_S seconds of green; amber counts as red for physics.
function computeGreenStateExt(
  ids: string[], cycleLength: number, splits: Record<string, number>, simTime: number,
  phaseGroups?: number[][],
): { states: SignalState[]; flags: boolean[]; remaining: number } {
  const n = ids.length;
  const redAll = (): { states: SignalState[]; flags: boolean[]; remaining: number } => ({
    states: new Array<SignalState>(n).fill('red'),
    flags:  new Array<boolean>(n).fill(false),
    remaining: 0,
  });
  if (n === 0) return { states: [], flags: [], remaining: 0 };

  // Use provided phase groups, or fall back to one approach per phase.
  const groups = phaseGroups ?? ids.map((_, i) => [i]);

  // Green time per phase = max split among members (or equal share if no split data).
  const phaseGreen = groups.map(group =>
    Math.max(...group.map(i => Math.max(splits[ids[i]] ?? cycleLength / groups.length, 0)), 0),
  );
  const total = phaseGreen.reduce((a, b) => a + b, 0) || cycleLength;
  const normG  = phaseGreen.map(g => (g / total) * cycleLength);

  const tInCycle = simTime % cycleLength;
  const states: SignalState[] = new Array<SignalState>(n).fill('red');
  let elapsed = 0;

  for (let pi = 0; pi < groups.length; pi++) {
    const end = pi === groups.length - 1 ? cycleLength : elapsed + normG[pi];
    if (tInCycle >= elapsed && tInCycle < end) {
      const remaining = end - tInCycle;
      const signalState: SignalState = (remaining <= AMBER_S && normG[pi] > AMBER_S) ? 'amber' : 'green';
      for (const i of groups[pi]) {
        if (i < n) states[i] = signalState;
      }
      const flags = states.map(s => s === 'green');
      return { states, flags, remaining };
    }
    elapsed += normG[pi];
  }
  return redAll();
}

// --- Draw ---

function paint(
  canvas: HTMLCanvasElement,
  timing: TimingChunk | null,
  mode: 'before' | 'after',
  simTime: number,
  ids: string[],
  vehicles: Vehicle[],
  chunkName = '',
  phaseGroups?: number[][],
  existingCycleS?: number | null,
  existingGreenSplits?: Record<string, number> | null,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const sc = Math.min(W / 460, H / 340);

  const box = BOX_UNITS * sc;
  const arm = ARM_UNITS * sc;
  const aw  = 72 * sc;

  const isNight = /night|midnight|pre.?dawn|early.?morning/i.test(chunkName);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isNight ? '#030508' : '#0f172a';
  ctx.fillRect(0, 0, W, H);

  const hasExistingTiming = existingCycleS != null && existingGreenSplits != null;
  const showCycles = (mode === 'after' && timing != null) || (mode === 'before' && hasExistingTiming);
  let gs: boolean[];
  let phaseStates: SignalState[];
  let phaseRemaining = 0;
  if (showCycles) {
    let ext: ReturnType<typeof computeGreenStateExt>;
    if (mode === 'after' && timing) {
      ext = computeGreenStateExt(ids, timing.cycle_length, timing.green_splits, simTime, phaseGroups);
    } else {
      ext = computeGreenStateExt(ids, existingCycleS!, existingGreenSplits!, simTime, phaseGroups);
    }
    gs = ext.flags;
    phaseStates = ext.states;
    phaseRemaining = ext.remaining;
  } else {
    gs = ids.map(() => false);
    phaseStates = ids.map(() => 'red' as SignalState);
  }

  // Roads
  ctx.fillStyle = isNight ? '#0c111c' : '#1e293b';
  ctx.fillRect(cx - aw/2, cy - box - arm, aw, arm);
  ctx.fillRect(cx - aw/2, cy + box,       aw, arm);
  ctx.fillRect(cx + box,  cy - aw/2,      arm, aw);
  ctx.fillRect(cx - box - arm, cy - aw/2, arm, aw);
  ctx.fillRect(cx - box, cy - box, box*2, box*2);

  // Lane edges
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.strokeRect(cx - aw/2, cy - box - arm, aw, arm);
  ctx.beginPath(); ctx.strokeRect(cx - aw/2, cy + box, aw, arm);
  ctx.beginPath(); ctx.strokeRect(cx + box, cy - aw/2, arm, aw);
  ctx.beginPath(); ctx.strokeRect(cx - box - arm, cy - aw/2, arm, aw);
  ctx.stroke();

  // White road-edge dashes along each arm
  ctx.setLineDash([6 * sc, 5 * sc]);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = sc;
  const edgeOff = aw / 2;
  for (const [x1, y1, x2, y2] of [
    // N arm edges
    [cx - edgeOff, cy - box, cx - edgeOff, cy - box - arm],
    [cx + edgeOff, cy - box, cx + edgeOff, cy - box - arm],
    // S arm edges
    [cx - edgeOff, cy + box, cx - edgeOff, cy + box + arm],
    [cx + edgeOff, cy + box, cx + edgeOff, cy + box + arm],
    // E arm edges
    [cx + box, cy - edgeOff, cx + box + arm, cy - edgeOff],
    [cx + box, cy + edgeOff, cx + box + arm, cy + edgeOff],
    // W arm edges
    [cx - box, cy - edgeOff, cx - box - arm, cy - edgeOff],
    [cx - box, cy + edgeOff, cx - box - arm, cy + edgeOff],
  ] as [number, number, number, number][]) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Double yellow center dividers - solid, no-overtaking lane separator
  const yOffset = 2 * sc;
  ctx.strokeStyle = '#ca8a04';
  ctx.lineWidth = 1.5 * sc;
  for (const [x1, y1, x2, y2, horiz] of [
    [cx, cy - box,    cx, cy - box - arm,  false],
    [cx, cy + box,    cx, cy + box + arm,  false],
    [cx + box, cy,    cx + box + arm, cy,  true],
    [cx - box, cy,    cx - box - arm, cy,  true],
  ] as [number, number, number, number, boolean][]) {
    for (const off of [-yOffset, yOffset]) {
      ctx.beginPath();
      if (horiz) {
        ctx.moveTo(x1, y1 + off); ctx.lineTo(x2, y2 + off);
      } else {
        ctx.moveTo(x1 + off, y1); ctx.lineTo(x2 + off, y2);
      }
      ctx.stroke();
    }
  }

  // Stop lines
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2 * sc;
  for (const [x1, y1, x2, y2] of [
    [cx - aw/2, cy - box,  cx + aw/2, cy - box],
    [cx - aw/2, cy + box,  cx + aw/2, cy + box],
    [cx + box,  cy - aw/2, cx + box,  cy + aw/2],
    [cx - box,  cy - aw/2, cx - box,  cy + aw/2],
  ] as [number, number, number, number][]) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // Zebra crosswalk stripes (4 stripes per arm, just outside the stop line)
  const zW = aw / 8;
  const zH = 3.5 * sc;
  ctx.fillStyle = 'rgba(226,232,240,0.28)';
  // N arm: horizontal stripes just above stop line
  for (let s = 0; s < 4; s++) {
    if (s % 2 === 0) ctx.fillRect(cx - aw/2 + s * zW, cy - box - zH, zW, zH);
  }
  // S arm: just below stop line
  for (let s = 0; s < 4; s++) {
    if (s % 2 === 0) ctx.fillRect(cx - aw/2 + s * zW, cy + box, zW, zH);
  }
  // E arm: vertical stripes just right of stop line
  for (let s = 0; s < 4; s++) {
    if (s % 2 === 0) ctx.fillRect(cx + box, cy - aw/2 + s * zW, zH, zW);
  }
  // W arm: just left of stop line
  for (let s = 0; s < 4; s++) {
    if (s % 2 === 0) ctx.fillRect(cx - box - zH, cy - aw/2 + s * zW, zH, zW);
  }

  // Pedestrian crossing dots - animated with simTime
  // Signalised: peds walk when their crosswalk direction has a red vehicle phase.
  // Before mode (gap acceptance): alternate by gap-phase axis - peds cross on the
  // perpendicular axis to whichever vehicle stream currently has priority.
  const gapAxis = Math.floor(simTime / GAP_PHASE_S) % 2;
  const nsBlocked = showCycles
    ? (phaseStates[0] !== 'red' || phaseStates[2] !== 'red')
    : gapAxis === 0; // axis-0 = N-S vehicles move → N-S peds wait
  const ewBlocked = showCycles
    ? (phaseStates[1] !== 'red' || phaseStates[3] !== 'red')
    : gapAxis === 1; // axis-1 = E-W vehicles move → E-W peds wait
  const pedR = 2 * sc;
  const NUM_PEDS = 2;
  for (let p = 0; p < NUM_PEDS; p++) {
    const prog = ((simTime * PED2D_SPD + p * 0.5) % 1.0);
    // N arm crosswalk (cross x direction)
    {
      const walkX = nsBlocked ? (p * 0.6 * aw) : (prog * aw);
      const px = cx - aw/2 + walkX;
      const py = cy - box - zH / 2;
      ctx.beginPath(); ctx.arc(px, py, pedR, 0, Math.PI * 2);
      ctx.fillStyle = nsBlocked ? '#fca5a5' : '#a7f3d0';
      ctx.fill();
    }
    // S arm crosswalk
    {
      const walkX = nsBlocked ? (p * 0.6 * aw) : (prog * aw);
      const px = cx + aw/2 - walkX;
      const py = cy + box + zH / 2;
      ctx.beginPath(); ctx.arc(px, py, pedR, 0, Math.PI * 2);
      ctx.fillStyle = nsBlocked ? '#fca5a5' : '#a7f3d0';
      ctx.fill();
    }
    // E arm crosswalk (cross y direction)
    {
      const walkY = ewBlocked ? (p * 0.6 * aw) : (prog * aw);
      const px = cx + box + zH / 2;
      const py = cy - aw/2 + walkY;
      ctx.beginPath(); ctx.arc(px, py, pedR, 0, Math.PI * 2);
      ctx.fillStyle = ewBlocked ? '#fca5a5' : '#a7f3d0';
      ctx.fill();
    }
    // W arm crosswalk
    {
      const walkY = ewBlocked ? (p * 0.6 * aw) : (prog * aw);
      const px = cx - box - zH / 2;
      const py = cy + aw/2 - walkY;
      ctx.beginPath(); ctx.arc(px, py, pedR, 0, Math.PI * 2);
      ctx.fillStyle = ewBlocked ? '#fca5a5' : '#a7f3d0';
      ctx.fill();
    }
  }

  // Queuing vehicles (approach-aligned rects)
  for (const v of vehicles) {
    if (v.clearing) continue;
    const p = VEHICLE_PARAMS[v.type];
    const d = v.distFromStop;
    let x = 0, y = 0, w = 0, h = 0;
    const loff = aw / 4; // half-lane offset in pixels (right-hand traffic lane discipline)
    switch (v.approach) {
      case 0: x = cx - loff - (p.width*sc)/2; y = cy - box - (d + p.length)*sc; w = p.width*sc; h = p.length*sc; break; // SB → west lane
      case 1: x = cx + box + d*sc;            y = cy - loff - (p.width*sc)/2;   w = p.length*sc; h = p.width*sc; break; // WB → north lane
      case 2: x = cx + loff - (p.width*sc)/2; y = cy + box + d*sc;              w = p.width*sc; h = p.length*sc; break; // NB → east lane
      case 3: x = cx - box - (d + p.length)*sc; y = cy + loff - (p.width*sc)/2; w = p.length*sc; h = p.width*sc; break; // EB → south lane
      default: continue;
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = COLORS[v.approach % COLORS.length];
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x, y, w, h);
    // Night headlights - small bright ellipses at the front (stop-line side) of the vehicle
    if (isNight) {
      const hlR = 2 * sc;
      const hlOffsets: [number, number][] =
        v.approach === 0 ? [[-aw/4 * 0.45, -h + hlR], [aw/4 * 0.45, -h + hlR]] :
        v.approach === 1 ? [[w - hlR, -w/4 * 0.45], [w - hlR, w/4 * 0.45]] :
        v.approach === 2 ? [[-aw/4 * 0.45, h - hlR], [aw/4 * 0.45, h - hlR]] :
                           [[hlR - w, -h/4 * 0.45], [hlR - w, h/4 * 0.45]];
      ctx.save();
      ctx.shadowBlur = 6 * sc;
      ctx.shadowColor = '#fef9c3';
      for (const [hx2, hy2] of hlOffsets) {
        const grad = ctx.createRadialGradient(x + w/2 + hx2, y + h/2 + hy2, 0, x + w/2 + hx2, y + h/2 + hy2, hlR * 2.5);
        grad.addColorStop(0, 'rgba(255,253,220,0.9)');
        grad.addColorStop(1, 'rgba(255,253,220,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x + w/2 + hx2, y + h/2 + hy2, hlR * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    const minDim = Math.min(w, h);
    if (minDim >= 8) {
      ctx.font = `bold ${Math.max(minDim * 0.5, 5)}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.type, x + w / 2, y + h / 2);
    }
  }

  // Clearing (in-transit) vehicles - oriented toward next waypoint
  const AP_ANGLE = [Math.PI / 2, Math.PI, -Math.PI / 2, 0];
  for (const v of vehicles) {
    if (!v.clearing || v.waypoints.length === 0) continue;
    const p = VEHICLE_PARAMS[v.type];
    const wx = cx + v.px * sc;
    const wy = cy + v.py * sc;
    const wp = v.waypoints[0];
    const hdx = wp.x - v.px;
    const hdy = wp.y - v.py;
    const hlen = Math.sqrt(hdx * hdx + hdy * hdy);
    const angle = hlen > 1e-6 ? Math.atan2(hdy, hdx) : (AP_ANGLE[v.approach] ?? 0);
    ctx.save();
    ctx.translate(wx, wy);
    ctx.rotate(angle);
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = COLORS[v.approach % COLORS.length];
    ctx.fillRect(-p.length * sc / 2, -p.width * sc / 2, p.length * sc, p.width * sc);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(-p.length * sc / 2, -p.width * sc / 2, p.length * sc, p.width * sc);
    const minDim = Math.min(p.length, p.width) * sc;
    if (minDim >= 8) {
      ctx.font = `bold ${Math.max(minDim * 0.5, 5)}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.type, 0, 0);
    }
    // Turn blinkers - amber flash on front corner of turning vehicles
    if (v.turn !== 'through' && Math.floor(simTime * 4) % 2 === 0) {
      const bx2 = p.length * sc * 0.42;
      const by2 = (v.turn === 'right' ? 1 : -1) * p.width * sc * 0.38;
      ctx.save();
      ctx.shadowBlur = 5 * sc;
      ctx.shadowColor = '#f59e0b';
      ctx.fillStyle = '#f59e0b';
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.arc(bx2, by2, 2.2 * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // Traffic light indicators - 3-circle housing (R/Y/G) + phase countdown
  ids.slice(0, 4).forEach((_id, i) => {
    const state: SignalState = phaseStates[i] ?? 'red';
    const lR   = 5 * sc;
    const lGap = lR * 2 + 4 * sc;
    const hW   = lR * 2 + 10 * sc;
    const hH   = lGap * 2 + lR * 2 + 8 * sc;

    let hx = 0, hy = 0;
    switch (i) {
      case 0: hx = cx - aw / 2 + sc;           hy = cy - box - hH - 6 * sc; break;
      case 1: hx = cx + box + 4 * sc;           hy = cy - aw / 2 + sc;      break;
      case 2: hx = cx + aw / 2 - hW - sc;      hy = cy + box + 6 * sc;     break;
      case 3: hx = cx - box - hW - 4 * sc;     hy = cy + aw / 2 - hH - sc; break;
    }

    if (showCycles) {
      // Housing - glow on active signal in night mode
      ctx.fillStyle = '#111827';
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = sc;
      if (isNight) {
        ctx.shadowBlur = 18 * sc;
        ctx.shadowColor = state === 'green' ? '#22c55e' : state === 'amber' ? '#f59e0b' : '#ef4444';
      }
      ctx.beginPath();
      ctx.roundRect(hx, hy, hW, hH, 3 * sc);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      const lensX = hx + hW / 2;
      const lensColors = ['#ef4444', '#f59e0b', '#22c55e'];
      const lensDark   = ['#7f1d1d', '#78350f', '#14532d'];
      for (let li = 0; li < 3; li++) {
        const ly = hy + 4 * sc + lR + li * lGap;
        const active = li === 0 ? state === 'red' : li === 1 ? state === 'amber' : state === 'green';
        if (active) {
          ctx.shadowBlur = isNight ? 18 * sc : 10 * sc;
          ctx.shadowColor = lensColors[li];
        }
        ctx.beginPath();
        ctx.arc(lensX, ly, lR, 0, Math.PI * 2);
        ctx.fillStyle = active ? lensColors[li] : lensDark[li];
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Phase countdown
      if (phaseRemaining > 0) {
        const secs = Math.ceil(phaseRemaining);
        ctx.font = `bold ${Math.max(9 * sc, 7)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = state === 'green' ? '#22c55e' : state === 'amber' ? '#f59e0b' : '#ef4444';
        ctx.fillText(`${secs}s`, lensX, hy + hH + 2 * sc);
      }
    }

    // Direction label at far end of arm (always shown)
    let lx = 0, ly2 = 0;
    switch (i) {
      case 0: lx = cx;                     ly2 = cy - box - arm * 0.82; break;
      case 1: lx = cx + box + arm * 0.82;  ly2 = cy;                    break;
      case 2: lx = cx;                     ly2 = cy + box + arm * 0.82; break;
      case 3: lx = cx - box - arm * 0.82;  ly2 = cy;                    break;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${14 * sc}px sans-serif`;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(DIR_LABELS[i] ?? `A${i}`, lx, ly2);
  });

  // HUD
  const mm = String(Math.floor(simTime / 60)).padStart(2, '0');
  const ss = String(Math.floor(simTime % 60)).padStart(2, '0');
  ctx.font = `${11 * sc}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#475569';
  ctx.fillText(`${mm}:${ss} / 60:00`, 10 * sc, 10 * sc);
  if (timing) {
    const phase = Math.floor(simTime % timing.cycle_length);
    const greenIdx = gs.indexOf(true);
    const greenLabel = greenIdx >= 0 ? `  green: ${DIR_LABELS[greenIdx] ?? `A${greenIdx}`}` : '';
    ctx.fillText(`cycle ${timing.cycle_length}s · ${phase}s${greenLabel}`, 10 * sc, 24 * sc);
  }

  // Per-approach queue depth
  const qCounts = ids.slice(0, 4).map((_, i) =>
    vehicles.filter(v => v.approach === i && !v.clearing).length,
  );
  const qLabel = ids.slice(0, 4).map((_, i) =>
    `${DIR_LABELS[i] ?? `A${i}`}:${qCounts[i]}`,
  ).join('  ');
  ctx.fillText(qLabel, 10 * sc, 38 * sc);

  ctx.textAlign = 'right';
  ctx.font = `bold ${11 * sc}px sans-serif`;
  ctx.fillStyle = mode === 'after' ? '#22c55e' : '#94a3b8';
  ctx.fillText(mode.toUpperCase(), W - 10 * sc, 10 * sc);

  // Total vehicle count bottom-right
  ctx.font = `${11 * sc}px monospace`;
  ctx.fillStyle = '#475569';
  ctx.fillText(`${vehicles.length} vehicles`, W - 10 * sc, 24 * sc);
}

// --- Component ---

export function IntersectionCanvas({
  chunk,
  timing,
  signalStatus: _signalStatus,
  typeMix = {},
  streets = [],
  existingCycleS = null,
  existingGreenSplits = null,
}: {
  chunk: SimulationChunk;
  timing: TimingChunk | null;
  signalStatus: string;
  typeMix?: Record<string, TypeFractions>;
  streets?: Street[];
  existingCycleS?: number | null;
  existingGreenSplits?: Record<string, number> | null;
}) {
  const wrapperRef   = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number>(0);
  const lastRtRef    = useRef<number>(0);

  const playingRef      = useRef(false);
  const spsRef          = useRef(1.5);
  const modeRef         = useRef<'before' | 'after'>('after');
  const simTRef         = useRef(0);
  const pausePaintedRef = useRef(false);

  const timingRef              = useRef(timing);
  const idsRef                 = useRef<string[]>([]);
  const typeMixRef             = useRef<Record<string, TypeFractions>>(typeMix);
  const chunkNameRef           = useRef(chunk.chunk_name);
  const existingCycleSRef      = useRef(existingCycleS);
  const existingGreenSplitsRef = useRef(existingGreenSplits);

  timingRef.current              = timing;
  typeMixRef.current             = typeMix;
  chunkNameRef.current           = chunk.chunk_name;
  existingCycleSRef.current      = existingCycleS;
  existingGreenSplitsRef.current = existingGreenSplits;

  // Physics state
  const vehiclesRef          = useRef<Vehicle[]>([]);
  const spawnTimersRef       = useRef<number[]>([0, 0, 0, 0]);
  const nextVehicleIdRef     = useRef(0);
  const spawnIntervalsRef    = useRef<number[]>([Infinity, Infinity, Infinity, Infinity]);
  const activeApproachesRef  = useRef<Set<number>>(new Set());

  // Arrival-driven spawn state. Populated only when `chunk.arrivals_per_second`
  // is supplied (i.e. on-demand window endpoint). Each approach gets its own
  // per-second count list aligned to ARM_DIR_TO_APPROACH.
  const arrivalsByApproachRef = useRef<(number[] | undefined)[]>([undefined, undefined, undefined, undefined]);
  const arrivalCarryRef       = useRef<number[]>([0, 0, 0, 0]);
  const lastArrivalSecRef     = useRef<number>(-1);

  const ids = useMemo(() => {
    const s = chunk.queue_series_after ?? chunk.queue_series_before;
    const hasSeries = s && Object.keys(s).length > 0;
    // Order by physical arm position (N=0, E=1, S=2, W=3) using street directions.
    // When series data is missing fall back to arm directions alone so the
    // static intersection still renders instead of a blank canvas.
    const ordered = Array<string | null>(4).fill(null);
    let placed = 0;
    for (const st of streets) {
      const ap = ARM_DIR_TO_APPROACH[st.arm_direction];
      if (ap === undefined) continue;
      if (!hasSeries || s![String(st.id)] !== undefined) {
        ordered[ap] = String(st.id);
        placed++;
      }
    }
    if (placed > 0) return ordered.filter((id): id is string => id !== null);
    return hasSeries ? Object.keys(s!).sort() : [];
  }, [chunk, streets]);

  idsRef.current = ids;

  const [playing, setPlaying] = useState(false);
  const [sps, setSps] = useState(1.5);
  const [mode, setMode] = useState<'before' | 'after'>('after');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Recompute spawn intervals when chunk/ids change
  useEffect(() => {
    const series = (chunk.queue_series_after ?? chunk.queue_series_before) ?? {};
    const active = new Set<number>();
    ids.forEach((id, i) => {
      if (i < 4) {
        const s = series[id] ?? [];
        if (s.some(v => v > 0)) active.add(i);
      }
    });
    activeApproachesRef.current = active;
    const numActive = Math.max(active.size, 1);
    const perApproachVolume = chunk.volume_pcu_hr / numActive;
    // Cap at 30 sim-s so low-volume intersections still show visible traffic.
    const interval = Math.min(3600 / Math.max(perApproachVolume, 0.1), 30);
    spawnIntervalsRef.current = [interval, interval, interval, interval];

    const arr = chunk.arrivals_per_second ?? null;
    arrivalsByApproachRef.current = ids
      .slice(0, 4)
      .map(id => (arr ? arr[id] : undefined));
    // An approach with a real arrival schedule is always "active" — even if
    // its queue_series is flat (e.g. low-volume side street) we still want to
    // spawn the few vehicles that actually showed up.
    if (arr) {
      ids.slice(0, 4).forEach((id, i) => {
        if ((arr[id]?.length ?? 0) > 0) activeApproachesRef.current.add(i);
      });
    }
  }, [chunk, ids]);

  // Reset vehicle state and sim clock when chunk changes
  useEffect(() => {
    vehiclesRef.current       = [];
    spawnTimersRef.current    = [0, 0, 0, 0];
    nextVehicleIdRef.current  = 0;
    simTRef.current           = 0;
    arrivalCarryRef.current   = [0, 0, 0, 0];
    lastArrivalSecRef.current = -1;
    playingRef.current        = false;
    pausePaintedRef.current   = false;
    setPlaying(false);
  }, [chunk.chunk_name]);

  // Responsive canvas sizing - multiply by devicePixelRatio for sharp rendering
  useEffect(() => {
    const container = containerRef.current;
    const canvas    = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      const dpr  = window.devicePixelRatio || 1;
      const full = !!document.fullscreenElement;
      const w    = full ? container.clientWidth  : Math.min(container.clientWidth, 560);
      const h    = full ? container.clientHeight : Math.round(w * 0.72);
      if (w > 0 && h > 0) {
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width  = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Sync fullscreen state and trigger a resize when entering/exiting
  useEffect(() => {
    const onFsChange = () => {
      const full = !!document.fullscreenElement;
      setIsFullscreen(full);
      // ResizeObserver fires automatically when the container resizes, but
      // trigger an explicit recalc for the devicePixelRatio path.
      const container = containerRef.current;
      const canvas    = canvasRef.current;
      if (!container || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w   = full ? container.clientWidth  : Math.min(container.clientWidth, 560);
      const h   = full ? container.clientHeight : Math.round(w * 0.72);
      if (w > 0 && h > 0) {
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width  = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // RAF loop - permanent; all state from refs
  useEffect(() => {
    const loop = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        if (playingRef.current) {
          const dt = lastRtRef.current > 0 ? (now - lastRtRef.current) / 1000 : 0;
          const dtSim = Math.min(dt * spsRef.current, 1.0);

          let remaining = dtSim;
          let subT = simTRef.current;
          while (remaining > 0) {
            const step = Math.min(remaining, MAX_PHYSICS_DT);
            const t = timingRef.current;
            const pg = idsRef.current.length === 4 ? PHASE_GROUPS : undefined;
            const exCycle  = existingCycleSRef.current;
            const exSplits = existingGreenSplitsRef.current;
            const hasExisting = exCycle != null && exSplits != null;
            const isBeforeMode = modeRef.current === 'before';
            const useGapMode = isBeforeMode ? !hasExisting : (!t || t.signal_off);
            const greenFlags = !useGapMode
              ? (isBeforeMode
                  ? computeGreenState(idsRef.current, exCycle!, exSplits!, subT, pg)
                  : computeGreenState(idsRef.current, t!.cycle_length, t!.green_splits, subT, pg))
              : new Array(idsRef.current.length).fill(false);

            const mixPerApproach = idsRef.current.map(
              sid => typeMixRef.current[sid] ?? DEFAULT_TYPE_MIX,
            );
            const hasSchedule = arrivalsByApproachRef.current.some(a => a && a.length > 0);
            if (hasSchedule) {
              spawnFromArrivals(
                vehiclesRef.current,
                nextVehicleIdRef,
                idsRef.current,
                activeApproachesRef.current,
                arrivalsByApproachRef.current,
                arrivalCarryRef.current,
                lastArrivalSecRef,
                mixPerApproach,
                subT + step,
              );
            } else {
              spawnVehicles(
                vehiclesRef.current,
                spawnTimersRef.current,
                nextVehicleIdRef,
                idsRef.current,
                activeApproachesRef.current,
                spawnIntervalsRef.current,
                mixPerApproach,
                step,
              );
            }
            stepPhysics(vehiclesRef.current, step, greenFlags, useGapMode, subT);

            subT += step;
            remaining -= step;
          }

          simTRef.current = Math.min(simTRef.current + dtSim, SIM_DURATION);
          if (simTRef.current >= SIM_DURATION) {
            playingRef.current = false;
            setPlaying(false);
          }
          pausePaintedRef.current = false;
        }
        lastRtRef.current = now;
        if (idsRef.current.length > 0 && (playingRef.current || !pausePaintedRef.current)) {
          const pg = idsRef.current.length === 4 ? PHASE_GROUPS : undefined;
          paint(
            canvas,
            timingRef.current,
            modeRef.current,
            simTRef.current,
            idsRef.current,
            vehiclesRef.current,
            chunkNameRef.current,
            pg,
            existingCycleSRef.current,
            existingGreenSplitsRef.current,
          );
          if (!playingRef.current) pausePaintedRef.current = true;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    lastRtRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetState = () => {
    vehiclesRef.current       = [];
    spawnTimersRef.current    = [0, 0, 0, 0];
    nextVehicleIdRef.current  = 0;
    simTRef.current           = 0;
    arrivalCarryRef.current   = [0, 0, 0, 0];
    lastArrivalSecRef.current = -1;
    playingRef.current        = false;
    pausePaintedRef.current   = false;
    setPlaying(false);
  };

  const handlePlay  = () => {
    if (simTRef.current >= SIM_DURATION) resetState();
    lastRtRef.current  = performance.now();
    playingRef.current = true;
    setPlaying(true);
  };
  const handlePause      = () => { playingRef.current = false; setPlaying(false); };
  const handleReset      = resetState;
  const handleSpeed      = (v: number) => { spsRef.current = v; setSps(v); };
  const handleMode       = (m: 'before' | 'after') => { modeRef.current = m; pausePaintedRef.current = false; setMode(m); };
  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      wrapperRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={cn(
        'space-y-3',
        isFullscreen && 'bg-[#0f172a] flex flex-col p-4 h-full',
      )}
    >
      <div
        ref={containerRef}
        className={cn('rounded-md overflow-hidden', isFullscreen ? 'flex-1 w-full' : 'w-full')}
      >
        <canvas ref={canvasRef} className="block" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {playing ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={handlePause}>
            <Pause className="size-3.5" /> Pause
          </Button>
        ) : (
          <Button size="sm" className="h-8 gap-1.5" onClick={handlePlay}>
            <Play className="size-3.5" /> Play
          </Button>
        )}
        <Button size="sm" variant="ghost" className="size-8 p-0" title="Reset" onClick={handleReset}>
          <RotateCcw className="size-3.5" />
        </Button>

        <div className="h-5 w-px bg-border mx-0.5" />

        {SPEEDS.map(sp => (
          <Button
            key={sp.label}
            size="sm"
            variant={sps === sp.sps ? 'default' : 'outline'}
            className="h-8 px-2.5 text-xs"
            onClick={() => handleSpeed(sp.sps)}
          >
            {sp.label}
          </Button>
        ))}

        <div className="h-5 w-px bg-border mx-0.5" />

        <Button
          size="sm"
          variant={mode === 'before' ? 'default' : 'outline'}
          className="h-8 text-xs"
          onClick={() => handleMode('before')}
        >
          Before
        </Button>
        <Button
          size="sm"
          variant={mode === 'after' ? 'default' : 'outline'}
          className="h-8 text-xs"
          onClick={() => handleMode('after')}
        >
          After
        </Button>

        <div className="h-5 w-px bg-border mx-0.5" />

        <Button
          size="sm"
          variant="ghost"
          className="size-8 p-0"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={handleFullscreen}
        >
          {isFullscreen
            ? <Minimize2 className="size-3.5" />
            : <Maximize2 className="size-3.5" />}
        </Button>
      </div>

      {!isFullscreen && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            After: Webster signal cycles · Before / signal-off: gap-acceptance (6 s) · toggle live
          </p>
          <p className="text-[10px] text-amber-500/90">
            Indicative playback. Queues are reconstructed from Webster's average delay, not a forecast of real arrivals.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Dual simulation ---

function createSimState() {
  return {
    vehicles: [] as Vehicle[],
    timers:   [0, 0, 0, 0] as number[],
    nextId:   { current: 0 },
  };
}

function applyCanvasSize(container: HTMLDivElement, canvas: HTMLCanvasElement, fullscreen: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const w   = container.clientWidth;
  const h   = fullscreen ? container.clientHeight : Math.round(w * 0.72);
  if (w > 0 && h > 0) {
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;
  }
}

export function DualIntersectionCanvas({
  chunk,
  timing,
  signalStatus: _signalStatus,
  typeMix = {},
  paused = false,
  speed = 1,
  streets = [],
  existingCycleS = null,
  existingGreenSplits = null,
  lockedViewMode = null,
}: {
  chunk: SimulationChunk;
  timing: TimingChunk | null;
  signalStatus: string;
  typeMix?: Record<string, TypeFractions>;
  paused?: boolean;
  speed?: 1 | 4 | 8 | 16 | 32 | 64;
  streets?: Street[];
  existingCycleS?: number | null;
  existingGreenSplits?: Record<string, number> | null;
  // When set, pins the canvas to one view (e.g. 'before' for "current state
  // only", 'dual' for the side-by-side) and hides the manual toggle.
  // Callers like IntersectionStory use this so each story step has a
  // distinct visual; null = the original interactive behaviour.
  lockedViewMode?: 'before' | 'dual' | 'after' | null;
}) {
  const wrapperRef        = useRef<HTMLDivElement>(null);
  const canvasBeforeRef   = useRef<HTMLCanvasElement>(null);
  const ctnBeforeRef      = useRef<HTMLDivElement>(null);
  const canvasAfterRef    = useRef<HTMLCanvasElement>(null);
  const ctnAfterRef       = useRef<HTMLDivElement>(null);

  const beforeSim = useRef(createSimState());
  const afterSim  = useRef(createSimState());

  const rafRef          = useRef<number>(0);
  const lastRtRef       = useRef<number>(0);
  const playingRef      = useRef(false);
  const spsRef          = useRef(3);
  const simTRef         = useRef(0);
  const frameRef        = useRef(0);
  const pausePaintedRef = useRef(false);

  const timingRef             = useRef(timing);
  const idsRef                = useRef<string[]>([]);
  const typeMixRef            = useRef<Record<string, TypeFractions>>(typeMix);
  const chunkNameRef          = useRef(chunk.chunk_name);
  const existingCycleSRef     = useRef(existingCycleS);
  const existingGreenSplitsRef = useRef(existingGreenSplits);
  timingRef.current            = timing;
  typeMixRef.current           = typeMix;
  chunkNameRef.current         = chunk.chunk_name;
  existingCycleSRef.current    = existingCycleS;
  existingGreenSplitsRef.current = existingGreenSplits;

  const spawnIntervalsRef   = useRef<number[]>([Infinity, Infinity, Infinity, Infinity]);
  const activeApproachesRef = useRef<Set<number>>(new Set());

  // Arrival-driven spawn state. One pair of carry/lastSec refs per side so the
  // before/after sims walk through the same real schedule independently.
  const arrivalsByApproachRef = useRef<(number[] | undefined)[]>([undefined, undefined, undefined, undefined]);
  const beforeCarryRef        = useRef<number[]>([0, 0, 0, 0]);
  const afterCarryRef         = useRef<number[]>([0, 0, 0, 0]);
  const beforeLastSecRef      = useRef<number>(-1);
  const afterLastSecRef       = useRef<number>(-1);

  const ids = useMemo(() => {
    const s = chunk.queue_series_after ?? chunk.queue_series_before;
    const hasSeries = s && Object.keys(s).length > 0;
    const ordered = Array<string | null>(4).fill(null);
    let placed = 0;
    // Place each known street into its arm slot. When series data exists we
    // require it to mention the street (so we don't draw approaches the
    // simulator hasn't modelled); when there's no series data we fall back to
    // arm directions alone so the static intersection still renders instead of
    // an empty canvas.
    for (const st of streets) {
      const ap = ARM_DIR_TO_APPROACH[st.arm_direction];
      if (ap === undefined) continue;
      if (!hasSeries || s![String(st.id)] !== undefined) {
        ordered[ap] = String(st.id);
        placed++;
      }
    }
    if (placed > 0) return ordered.filter((id): id is string => id !== null);
    return hasSeries ? Object.keys(s!).sort() : [];
  }, [chunk, streets]);
  idsRef.current = ids;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [liveQ, setLiveQ]             = useState({ before: 0, after: 0 });
  const [viewModeState, setViewMode]  = useState<'before' | 'dual' | 'after'>('dual');
  // When lockedViewMode is set by the parent, ignore internal state. Story
  // steps drive this so Step 1 always shows "before" only and Step 3
  // always shows the dual side-by-side.
  const viewMode = lockedViewMode ?? viewModeState;

  type CycleRecord = { cycle: number; peakBefore: number; peakAfter: number };
  const [cycleHistory, setCycleHistory] = useState<CycleRecord[]>([]);
  const prevCycleRef    = useRef(-1);
  const peakBeforeRef   = useRef(0);
  const peakAfterRef    = useRef(0);

  // Sync external paused / speed props into refs used by the RAF loop
  useEffect(() => { playingRef.current = !paused; }, [paused]);
  // speed=1 → real time (1 sim-second per real-second). Anchored to match
  // the 3D scene; see IntersectionScene3D animate() for the same change.
  useEffect(() => { spsRef.current = speed; }, [speed]);

  useEffect(() => {
    const series = (chunk.queue_series_after ?? chunk.queue_series_before) ?? {};
    const active = new Set<number>();
    ids.forEach((id, i) => {
      if (i < 4) {
        const s = series[id] ?? [];
        if (s.some(v => v > 0)) active.add(i);
      }
    });
    activeApproachesRef.current = active;
    const numActive = Math.max(active.size, 1);
    const perVol    = chunk.volume_pcu_hr / numActive;
    spawnIntervalsRef.current = Array(4).fill(Math.min(3600 / Math.max(perVol, 0.1), 30));

    const arr = chunk.arrivals_per_second ?? null;
    arrivalsByApproachRef.current = ids
      .slice(0, 4)
      .map(id => (arr ? arr[id] : undefined));
    if (arr) {
      ids.slice(0, 4).forEach((id, i) => {
        if ((arr[id]?.length ?? 0) > 0) activeApproachesRef.current.add(i);
      });
    }
  }, [chunk, ids]);

  useEffect(() => {
    beforeSim.current     = createSimState();
    afterSim.current      = createSimState();
    simTRef.current       = 0;
    frameRef.current      = 0;
    playingRef.current    = !paused;
    pausePaintedRef.current = false;
    prevCycleRef.current  = -1;
    peakBeforeRef.current = 0;
    peakAfterRef.current  = 0;
    beforeCarryRef.current = [0, 0, 0, 0];
    afterCarryRef.current  = [0, 0, 0, 0];
    beforeLastSecRef.current = -1;
    afterLastSecRef.current  = -1;
    setLiveQ({ before: 0, after: 0 });
    setCycleHistory([]);
  }, [chunk.chunk_name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Canvas sizing - observe mounted containers; re-run when viewMode changes so
  // observers reconnect after conditional rendering swaps a canvas in or out.
  useEffect(() => {
    const pairs: [React.RefObject<HTMLDivElement | null>, React.RefObject<HTMLCanvasElement | null>][] = [
      [ctnBeforeRef, canvasBeforeRef],
      [ctnAfterRef,  canvasAfterRef],
    ];
    const observers: ResizeObserver[] = [];
    for (const [cRef, cvRef] of pairs) {
      const container = cRef.current;
      const canvas    = cvRef.current;
      if (!container || !canvas) continue;
      const resize = () => applyCanvasSize(container, canvas, !!document.fullscreenElement);
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      observers.push(ro);
    }
    return () => observers.forEach(ro => ro.disconnect());
  }, [viewMode]);

  useEffect(() => {
    const onFsChange = () => {
      const full = !!document.fullscreenElement;
      setIsFullscreen(full);
      const pairs: [React.RefObject<HTMLDivElement | null>, React.RefObject<HTMLCanvasElement | null>][] = [
        [ctnBeforeRef, canvasBeforeRef],
        [ctnAfterRef,  canvasAfterRef],
      ];
      for (const [cRef, cvRef] of pairs) {
        const container = cRef.current;
        const canvas    = cvRef.current;
        if (container && canvas) applyCanvasSize(container, canvas, full);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    const loop = (now: number) => {
      // Physics always runs when playing - independent of which canvases are mounted.
      // This allows "Before" / "After" single-view modes to keep physics alive even
      // when one of the two canvases is unmounted.
      if (playingRef.current) {
        const dt    = lastRtRef.current > 0 ? (now - lastRtRef.current) / 1000 : 0;
        const dtSim = Math.min(dt * spsRef.current, 1.0);
        let remaining = dtSim;
        let subT      = simTRef.current;
        while (remaining > 0) {
          const step    = Math.min(remaining, MAX_PHYSICS_DT);
          const t       = timingRef.current;
          const gapAfter = !t || t.signal_off;
          const pg      = idsRef.current.length === 4 ? PHASE_GROUPS : undefined;
          const greenA  = !gapAfter
            ? computeGreenState(idsRef.current, t!.cycle_length, t!.green_splits, subT, pg)
            : new Array(idsRef.current.length).fill(false);
          // Before: use existing timing if available, else fall back to gap-acceptance
          const exCycle  = existingCycleSRef.current;
          const exSplits = existingGreenSplitsRef.current;
          const hasExisting = exCycle != null && exSplits != null;
          const greenB  = hasExisting
            ? computeGreenState(idsRef.current, exCycle!, exSplits!, subT, pg)
            : new Array(idsRef.current.length).fill(false);
          const mix     = idsRef.current.map(sid => typeMixRef.current[sid] ?? DEFAULT_TYPE_MIX);

          const hasSchedule = arrivalsByApproachRef.current.some(a => a && a.length > 0);
          if (hasSchedule) {
            spawnFromArrivals(beforeSim.current.vehicles, beforeSim.current.nextId,
              idsRef.current, activeApproachesRef.current,
              arrivalsByApproachRef.current, beforeCarryRef.current, beforeLastSecRef,
              mix, subT + step);
            spawnFromArrivals(afterSim.current.vehicles, afterSim.current.nextId,
              idsRef.current, activeApproachesRef.current,
              arrivalsByApproachRef.current, afterCarryRef.current, afterLastSecRef,
              mix, subT + step);
          } else {
            spawnVehicles(beforeSim.current.vehicles, beforeSim.current.timers,
              beforeSim.current.nextId, idsRef.current,
              activeApproachesRef.current, spawnIntervalsRef.current, mix, step);
            spawnVehicles(afterSim.current.vehicles, afterSim.current.timers,
              afterSim.current.nextId, idsRef.current,
              activeApproachesRef.current, spawnIntervalsRef.current, mix, step);
          }

          stepPhysics(beforeSim.current.vehicles, step, greenB, !hasExisting, subT);
          stepPhysics(afterSim.current.vehicles,  step, greenA, gapAfter,     subT);

          subT      += step;
          remaining -= step;
        }
        simTRef.current = Math.min(simTRef.current + dtSim, SIM_DURATION);
        if (simTRef.current >= SIM_DURATION) { playingRef.current = false; }
        pausePaintedRef.current = false;
      }
      lastRtRef.current = now;
      if (idsRef.current.length > 0 && (playingRef.current || !pausePaintedRef.current)) {
        const cvB = canvasBeforeRef.current;
        const cvA = canvasAfterRef.current;
        const pg2 = idsRef.current.length === 4 ? PHASE_GROUPS : undefined;
        if (cvB && cvB.width > 0 && cvB.height > 0) {
          paint(cvB, timingRef.current, 'before', simTRef.current, idsRef.current, beforeSim.current.vehicles, chunkNameRef.current, pg2, existingCycleSRef.current, existingGreenSplitsRef.current);
        }
        if (cvA && cvA.width > 0 && cvA.height > 0) {
          paint(cvA, timingRef.current, 'after',  simTRef.current, idsRef.current, afterSim.current.vehicles, chunkNameRef.current, pg2);
        }
        if (!playingRef.current) pausePaintedRef.current = true;
        frameRef.current++;
        if (frameRef.current % 30 === 0) {
          const qB = beforeSim.current.vehicles.filter(v => !v.clearing).length;
          const qA = afterSim.current.vehicles.filter(v  => !v.clearing).length;
          setLiveQ({ before: qB, after: qA });

          // Per-cycle peak tracking
          peakBeforeRef.current = Math.max(peakBeforeRef.current, qB);
          peakAfterRef.current  = Math.max(peakAfterRef.current,  qA);

          const tNow = timingRef.current;
          if (tNow && tNow.cycle_length > 0) {
            const curCycle = Math.floor(simTRef.current / tNow.cycle_length);
            if (curCycle !== prevCycleRef.current && curCycle > 0) {
              const rec: CycleRecord = {
                cycle:       curCycle,
                peakBefore:  peakBeforeRef.current,
                peakAfter:   peakAfterRef.current,
              };
              setCycleHistory(prev => [...prev.slice(-4), rec]);
              peakBeforeRef.current = 0;
              peakAfterRef.current  = 0;
              prevCycleRef.current  = curCycle;
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    lastRtRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetState = () => {
    beforeSim.current  = createSimState();
    afterSim.current   = createSimState();
    simTRef.current    = 0;
    frameRef.current   = 0;
    playingRef.current = !paused;
    beforeCarryRef.current = [0, 0, 0, 0];
    afterCarryRef.current  = [0, 0, 0, 0];
    beforeLastSecRef.current = -1;
    afterLastSecRef.current  = -1;
    setLiveQ({ before: 0, after: 0 });
  };

  const handleFullscreen = () => {
    if (!document.fullscreenElement) wrapperRef.current?.requestFullscreen();
    else document.exitFullscreen();
  };

  const delayDiff = chunk.delay_before - chunk.delay_after;
  const qDiff     = liveQ.before - liveQ.after;

  return (
    <div
      ref={wrapperRef}
      className={cn('space-y-3', isFullscreen && 'bg-[#0f172a] flex flex-col p-4 h-full')}
    >
      {/* Canvases - dual side-by-side or single before/after */}
      <div className={cn(
        'grid gap-2',
        viewMode === 'dual' ? 'grid-cols-2' : 'grid-cols-1',
        isFullscreen && 'flex-1',
      )}>
        {viewMode !== 'after' && (
          <div className={cn('flex flex-col', isFullscreen && 'flex-1')}>
            <p className="text-[10px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">
              Before - gap acceptance
            </p>
            <div ref={ctnBeforeRef} className="rounded-md overflow-hidden w-full">
              <canvas ref={canvasBeforeRef} className="block" />
            </div>
          </div>
        )}
        {viewMode !== 'before' && (
          <div className={cn('flex flex-col', isFullscreen && 'flex-1')}>
            <p className="text-[10px] font-medium text-green-500 mb-1 uppercase tracking-wide">
              After - Webster's signal
            </p>
            <div ref={ctnAfterRef} className="rounded-md overflow-hidden w-full">
              <canvas ref={canvasAfterRef} className="block" />
            </div>
          </div>
        )}
      </div>

      {/* Live queue comparison */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Before queue</p>
          <p className="text-2xl font-semibold tabular-nums mt-0.5">{liveQ.before}</p>
        </div>
        <div className="rounded-md border border-green-500/30 bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">After queue</p>
          <p className="text-2xl font-semibold tabular-nums mt-0.5 text-green-500">{liveQ.after}</p>
        </div>
        <div className={cn(
          'rounded-md border px-3 py-2',
          qDiff > 0 ? 'border-green-500/40 bg-green-950/20'
          : qDiff < 0 ? 'border-red-500/40 bg-red-950/20' : 'border-border bg-card',
        )}>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Live diff</p>
          <p className={cn(
            'text-2xl font-semibold tabular-nums mt-0.5',
            qDiff > 0 ? 'text-green-500' : qDiff < 0 ? 'text-red-400' : 'text-muted-foreground',
          )}>
            {qDiff > 0 ? `−${qDiff}` : qDiff < 0 ? `+${Math.abs(qDiff)}` : '0'}
          </p>
        </div>
      </div>

      {/* Per-cycle peak queue history */}
      {cycleHistory.length > 0 && (
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
            Cycle peak queue - before → after
          </p>
          <div className="space-y-1.5">
            {cycleHistory.map(r => {
              const diff = r.peakBefore - r.peakAfter;
              return (
                <div key={r.cycle} className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground tabular-nums w-10">C#{r.cycle}</span>
                  <span className="tabular-nums font-medium w-5 text-right text-slate-400">{r.peakBefore}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className={cn(
                    'tabular-nums font-medium w-5 text-right',
                    diff > 0 ? 'text-green-400' : diff < 0 ? 'text-red-400' : 'text-slate-400',
                  )}>{r.peakAfter}</span>
                  {diff !== 0 && (
                    <span className={cn(
                      'font-bold tabular-nums ml-1',
                      diff > 0 ? 'text-green-400' : 'text-red-400',
                    )}>
                      {diff > 0 ? `−${diff}` : `+${Math.abs(diff)}`}
                    </span>
                  )}
                  <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all', diff > 0 ? 'bg-green-500' : 'bg-red-500')}
                      style={{ width: `${Math.min(100, Math.abs(diff) / Math.max(r.peakBefore, 1) * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Savings strip */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border bg-card px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Delay saved</p>
          <p className="text-xl font-semibold tabular-nums mt-0.5">
            {delayDiff > 0 ? `−${delayDiff.toFixed(0)}s` : '-'}
          </p>
          <p className="text-[10px] text-muted-foreground">per vehicle</p>
        </div>
        <div className="rounded-md border border-border bg-card px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Veh-hrs saved</p>
          <p className="text-xl font-semibold tabular-nums mt-0.5">{chunk.vehicle_hours_saved.toFixed(2)}</p>
          <p className="text-[10px] text-muted-foreground">this chunk</p>
        </div>
      </div>

      {/* Controls: view toggle + reset + fullscreen.
          The view toggle hides when the parent has locked the view (e.g.
          inside the story tab) so each step has one canonical visual. */}
      <div className="flex items-center gap-2 flex-wrap">
        {lockedViewMode === null && (
          <>
            <div className="flex rounded-md border border-border overflow-hidden">
              {(['before', 'dual', 'after'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={cn(
                    'px-2.5 py-1 text-xs font-medium transition-colors border-l first:border-l-0 border-border',
                    viewMode === m
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {m === 'dual' ? 'Both' : m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
            <div className="h-5 w-px bg-border" />
          </>
        )}

        <Button size="sm" variant="ghost" className="size-8 p-0" title="Reset simulation" onClick={resetState}>
          <RotateCcw className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="size-8 p-0"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={handleFullscreen}
        >
          {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>

      {!isFullscreen && (
        <p className="text-[10px] text-amber-500/90">
          Indicative playback. Queues are reconstructed from Webster's average delay, not a forecast of real arrivals.
        </p>
      )}
    </div>
  );
}
