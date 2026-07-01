/**
 * 3D intersection simulation - vehicles + pedestrian crossings.
 *
 * Coordinate system (Three.js, Y-up):
 *   +X = East   –X = West
 *   +Z = South  –Z = North
 *
 * Approach mapping (right-hand PH traffic, vehicles entering from outside):
 *   0 = southbound  (enters from –Z)
 *   1 = westbound   (enters from +X)
 *   2 = northbound  (enters from +Z)
 *   3 = eastbound   (enters from –X)
 *
 * Pedestrian crossings (4 crosswalks, one per arm):
 *   N arm (z = –XWALK): peds walk E–W; WALK when NS vehicles are RED
 *   S arm (z = +XWALK): peds walk W–E; WALK when NS vehicles are RED
 *   E arm (x = +XWALK): peds walk N–S; WALK when EW vehicles are RED
 *   W arm (x = –XWALK): peds walk S–N; WALK when EW vehicles are RED
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { TimingChunk } from '@/services/timing';
import type { SimulationChunk } from '@/services/simulation';
import type { Street } from '@/types';
import type { VehicleType, TypeFractions } from './IntersectionCanvas';
import {
  ALL_RED,
  type SignalPhase, type GreenTimes,
  approachPhase, approachRemaining, pedCanWalk,
  VPARAMS, VEH_TYPES, DEFAULT_MIX, sampleType,
  idmAcceleration, nextPoissonInterval,
  sampleTurn,
} from '@/lib/traffic-sim';

// ─── Layout constants ─────────────────────────────────────────────────────────

const BOX          = 7.5;   // half-width of intersection box (m)
const ARM          = 48;    // arm length from box edge (m)
const ROAD_W       = 20;    // total road width (two lanes bi-directional)
const LANE         = ROAD_W / 4;
const XWALK_OFFSET = 5.0;   // m past stop line where crosswalk is centred
const PED_SPEED    = 1.2;   // m/s (DPWH pedestrian walking speed)
const PED_SCALE       = 1.0;   // Quaternius models export at ~1:1 m scale


// ─── Approach ↔ direction mapping ────────────────────────────────────────────

const DIR_TO_APP: Record<string, number> = {
  southbound: 0, westbound: 1, northbound: 2, eastbound: 3,
};

// ─── Crosswalk definitions ────────────────────────────────────────────────────

interface CwDef {
  startX: number; startZ: number;  // position at road edge where peds begin
  dx: number;     dz: number;      // unit direction of travel
  rotY: number;                    // Y-rotation to face direction of travel
  blockedApp: number;              // vehicle approach that blocks this crossing (0=NS, 1=EW)
}

const XWALK_POS = BOX + XWALK_OFFSET;  // 10.0 m from centre

const CW_DEFS: CwDef[] = [
  // N arm - peds walk east (+X); model default faces -Z, so +π/2 turns it to face +X
  { startX: -ROAD_W / 2, startZ: -XWALK_POS, dx:  1, dz:  0, rotY:  Math.PI / 2, blockedApp: 0 },
  // S arm - peds walk west (-X); -π/2 faces -X
  { startX:  ROAD_W / 2, startZ:  XWALK_POS, dx: -1, dz:  0, rotY: -Math.PI / 2, blockedApp: 0 },
  // E arm - peds walk south (+Z); π faces +Z
  { startX:  XWALK_POS, startZ: -ROAD_W / 2, dx:  0, dz:  1, rotY:  Math.PI,     blockedApp: 1 },
  // W arm - peds walk north (-Z); 0 = default -Z facing
  { startX: -XWALK_POS, startZ:  ROAD_W / 2, dx:  0, dz: -1, rotY:  0,           blockedApp: 1 },
];

// ─── Shared geometry helpers ──────────────────────────────────────────────────

function makeMat(color: number, emissive = 0, emInt = 0.0, opacity = 1): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emInt,
    transparent: opacity < 1, opacity });
}

function bx(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function addBox(
  g: THREE.Group, w: number, h: number, d: number,
  px: number, py: number, pz: number,
  color: number, emissive = 0, emInt = 0.0,
): void {
  const m = mesh(bx(w, h, d), makeMat(color, emissive, emInt));
  m.position.set(px, py, pz);
  g.add(m);
}

function addCyl(
  g: THREE.Group, rTop: number, rBot: number, h: number, segs: number,
  px: number, py: number, pz: number,
  color: number, rotZ = 0,
): void {
  const m = mesh(new THREE.CylinderGeometry(rTop, rBot, h, segs), makeMat(color));
  m.position.set(px, py, pz);
  if (rotZ) m.rotation.z = rotZ;
  g.add(m);
}

function addSphere(
  g: THREE.Group, r: number, segs: number,
  px: number, py: number, pz: number,
  color: number, emissive = 0, emInt = 0.0,
): void {
  const m = mesh(new THREE.SphereGeometry(r, segs, Math.ceil(segs * 0.7)), makeMat(color, emissive, emInt));
  m.position.set(px, py, pz);
  g.add(m);
}

// ─── Vehicle box models ───────────────────────────────────────────────────────
// All models face local +X. Origin at ground-centre of vehicle.

function makeMotorcycle(color = 0x1e293b): THREE.Group {
  const g = new THREE.Group();
  const c = color, grey = 0x374151, black = 0x0f172a, chrome = 0x94a3b8, amber = 0xfef3c7;
  addBox(g, 1.6, 0.38, 0.5,  0, 0.48, 0, c);
  addBox(g, 0.9, 0.38, 0.52, 0.1, 0.8, 0, c);
  addBox(g, 0.7, 0.28, 0.48, 0.05, 1.0, 0, c);
  addBox(g, 0.88, 0.10, 0.45, -0.18, 1.08, 0, 0x0f172a);
  addBox(g, 0.22, 0.52, 0.50, 0.82, 0.80, 0, grey);
  addBox(g, 0.40, 0.10, 0.38, 0.76, 0.55, 0, grey);
  addBox(g, 0.08, 0.07, 0.80, 0.62, 1.14, 0, chrome);
  addBox(g, 0.10, 0.18, 0.28, 0.96, 0.92, 0, amber, amber, 0.6);
  addBox(g, 0.08, 0.12, 0.22, -0.96, 0.88, 0, 0xdc2626, 0xdc2626, 0.4);
  const wGeo = new THREE.CylinderGeometry(0.30, 0.30, 0.14, 12);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  const hGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.16, 8);
  for (const [x, z] of [[0.68, 0.33], [0.68, -0.33], [-0.68, 0.33], [-0.68, -0.33]]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.30, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.30, z); g.add(h);
  }
  return g;
}

function makeCar(color = 0x1d4ed8): THREE.Group {
  const g = new THREE.Group();
  const chrome = 0xb0b8c8, black = 0x0f172a, glass = 0x1e3a5f;
  addBox(g, 4.1, 0.80, 1.68, 0, 0.60, 0, color);
  addBox(g, 4.1, 0.25, 1.62, 0, 1.05, 0, color);
  addBox(g, 2.10, 0.70, 1.54, -0.22, 1.47, 0, color);
  addBox(g, 0.08, 0.60, 1.42, 0.82, 1.42, 0, glass);
  addBox(g, 0.08, 0.55, 1.36, -1.26, 1.40, 0, glass);
  for (const z of [0.78, -0.78]) addBox(g, 1.80, 0.50, 0.04, -0.22, 1.46, z, glass);
  addBox(g, 0.22, 0.50, 1.65, 2.16, 0.38, 0, chrome);
  addBox(g, 0.22, 0.48, 1.65, -2.16, 0.36, 0, chrome);
  addBox(g, 0.08, 0.28, 1.40, 2.18, 0.70, 0, black);
  for (const z of [0.68, -0.68]) addBox(g, 0.12, 0.20, 0.38, 2.14, 0.82, z, 0xfef9c3, 0xfef9c3, 0.5);
  for (const z of [0.68, -0.68]) addBox(g, 0.10, 0.18, 0.34, -2.14, 0.82, z, 0xdc2626, 0xdc2626, 0.4);
  const wGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.20, 14);
  const hGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.22, 8);
  const wMat = makeMat(black); const hMat = makeMat(0x94a3b8);
  for (const [x, z] of [[1.28, 0.88], [1.28, -0.88], [-1.28, 0.88], [-1.28, -0.88]]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.32, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.32, z); g.add(h);
  }
  return g;
}

function makeJeepney(color = 0xf1f5f9): THREE.Group {
  const g = new THREE.Group();
  const chrome = 0xc8d0dc, black = 0x0f172a, glass = 0x172554;
  addBox(g, 5.80, 1.20, 1.98, -0.30, 0.80, 0, color);
  addBox(g, 1.10, 0.65, 1.92, 2.65, 1.73, 0, color);
  addBox(g, 5.60, 0.75, 1.90, -0.30, 1.60, 0, 0xe8ecf0);
  addBox(g, 5.60, 0.14, 2.36, -0.40, 2.10, 0, 0xd0d4dc);
  addBox(g, 0.20, 1.10, 1.96, 3.10, 0.96, 0, chrome);
  for (const y of [0.55, 0.78, 1.01, 1.24]) addBox(g, 0.22, 0.06, 1.90, 3.10, y, 0, 0x6b7280);
  for (const z of [-0.65, 0, 0.65]) addBox(g, 0.22, 0.95, 0.06, 3.10, 0.78, z, 0x6b7280);
  addBox(g, 0.16, 0.30, 2.25, 3.22, 0.30, 0, chrome);
  for (const z of [-0.72, 0, 0.72]) addBox(g, 0.22, 0.28, 0.06, 3.14, 0.30, z, 0x94a3b8);
  addCyl(g, 0.06, 0.04, 0.28, 6, 3.22, 0.60, 0, chrome);
  addSphere(g, 0.13, 8, 3.22, 0.80, 0, chrome);
  for (const z of [1.01, -1.01]) {
    addBox(g, 4.80, 0.40, 0.04, -0.30, 0.82, z, 0xdc2626);
    addBox(g, 4.80, 0.16, 0.04, -0.30, 0.54, z, 0xf59e0b);
    for (const x of [-1.0, 1.0]) addBox(g, 0.38, 0.28, 0.04, x, 1.50, z, 0x1e40af);
  }
  addBox(g, 0.08, 0.56, 1.82, 3.16, 1.72, 0, glass);
  for (const z of [0.96, -0.96]) {
    for (const x of [-1.8, -0.6, 0.6]) addBox(g, 0.80, 0.55, 0.04, x, 1.60, z, glass);
  }
  for (const z of [0.68, -0.68]) {
    addBox(g, 0.12, 0.20, 0.22, 3.24, 1.05, z, 0xfef9c3, 0xfef9c3, 0.7);
    addCyl(g, 0.14, 0.14, 0.02, 10, 3.24, 1.05, z, chrome);
  }
  for (const z of [0.68, -0.68]) addBox(g, 0.10, 0.22, 0.28, -3.18, 0.88, z, 0xdc2626, 0xdc2626, 0.5);
  addBox(g, 0.16, 0.28, 2.10, -3.20, 0.30, 0, chrome);
  const wGeo = new THREE.CylinderGeometry(0.41, 0.41, 0.22, 14);
  const hGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.24, 8);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  for (const [x, y, z] of [
    [2.10, 0.41,  1.08], [2.10, 0.41, -1.08],
    [-1.65, 0.41,  1.18], [-1.65, 0.41, -1.18],
    [-1.65, 0.41,  0.70], [-1.65, 0.41, -0.70],
  ] as [number, number, number][]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, y, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, y, z); g.add(h);
  }
  return g;
}

function makeBus(color = 0xffd700): THREE.Group {
  const g = new THREE.Group();
  const black = 0x0f172a, glass = 0x172554, chrome = 0x94a3b8;
  addBox(g, 10.6, 2.80, 2.48, -0.20, 1.58, 0, color);
  addBox(g, 10.4, 0.22, 2.52, -0.20, 3.08, 0, 0x166534);
  addBox(g, 0.24, 2.60, 2.44, 5.34, 1.68, 0, 0x14532d);
  addBox(g, 0.10, 1.50, 2.20, 5.36, 2.42, 0, glass);
  addBox(g, 0.10, 0.50, 1.90, 5.36, 3.28, 0, 0xfef3c7, 0xfef3c7, 0.4);
  addBox(g, 0.28, 0.50, 2.55, 5.50, 0.40, 0, chrome);
  addBox(g, 0.20, 2.60, 2.44, -5.50, 1.68, 0, 0x14532d);
  addBox(g, 0.10, 1.20, 2.10, -5.52, 2.60, 0, glass);
  for (let i = 0; i < 7; i++) {
    for (const z of [1.26, -1.26]) addBox(g, 1.05, 0.80, 0.04, 3.80 - i * 1.32, 2.40, z, glass);
  }
  for (const z of [1.26, -1.26]) {
    addBox(g, 9.80, 0.32, 0.04, -0.20, 0.70, z, 0xfbbf24);
    addBox(g, 9.80, 0.12, 0.04, -0.20, 0.44, z, 0xfef08a);
  }
  for (const z of [0.82, -0.82]) addBox(g, 0.12, 0.22, 0.38, 5.50, 1.20, z, 0xfef9c3, 0xfef9c3, 0.6);
  for (const z of [0.82, -0.82]) addBox(g, 0.12, 0.36, 0.36, -5.52, 1.28, z, 0xdc2626, 0xdc2626, 0.5);
  const wGeo = new THREE.CylinderGeometry(0.54, 0.54, 0.28, 14);
  const hGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.30, 8);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  for (const [x, z] of [
    [4.20, 1.32], [4.20, -1.32],
    [-3.60, 1.44], [-3.60, -1.44], [-3.60, 0.84], [-3.60, -0.84],
  ]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.54, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.54, z); g.add(h);
  }
  return g;
}

function makeTruck(color = 0x92400e): THREE.Group {
  const g = new THREE.Group();
  const black = 0x0f172a, glass = 0x172554, chrome = 0x94a3b8;
  addBox(g, 5.20, 2.50, 2.18, -1.45, 1.50, 0, 0xe8ecf0);
  addBox(g, 5.18, 0.12, 2.20, -1.45, 2.78, 0, 0xd1d5db);
  for (const z of [1.10, -1.10]) addBox(g, 5.10, 2.30, 0.04, -1.45, 1.50, z, 0xf8fafc);
  addBox(g, 0.10, 2.50, 2.10, -4.08, 1.50, 0, 0xd1d5db);
  addBox(g, 2.60, 2.00, 2.14, 1.85, 1.15, 0, color);
  addBox(g, 2.58, 0.18, 2.16, 1.85, 2.22, 0, 0x78350f);
  addBox(g, 0.10, 1.20, 1.92, 3.13, 1.72, 0, glass);
  for (const z of [1.08, -1.08]) addBox(g, 1.80, 0.90, 0.04, 1.50, 1.62, z, glass);
  addBox(g, 0.24, 0.52, 2.20, 3.24, 0.46, 0, chrome);
  addBox(g, 0.10, 0.60, 1.88, 3.20, 1.10, 0, black);
  for (let i = 0; i < 4; i++) addBox(g, 0.12, 0.06, 1.85, 3.22, 0.82 + i * 0.16, 0, 0x4b5563);
  for (const z of [0.80, -0.80]) addBox(g, 0.12, 0.22, 0.36, 3.28, 1.26, z, 0xfef9c3, 0xfef9c3, 0.6);
  for (const z of [0.80, -0.80]) addBox(g, 0.12, 0.30, 0.32, -4.12, 1.30, z, 0xdc2626, 0xdc2626, 0.5);
  const wGeo = new THREE.CylinderGeometry(0.50, 0.50, 0.26, 12);
  const hGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.28, 8);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  for (const [x, z] of [
    [2.50, 1.16], [2.50, -1.16],
    [-2.60, 1.26], [-2.60, -1.26], [-2.60, 0.74], [-2.60, -0.74],
  ]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.50, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.50, z); g.add(h);
  }
  return g;
}

const VEHICLE_MAKERS: Record<VehicleType, (c: number) => THREE.Group> = {
  MC:    makeMotorcycle,
  CAR:   makeCar,
  JEP:   makeJeepney,
  BUS:   makeBus,
  TRUCK: makeTruck,
};

const VEH_COLORS: Record<VehicleType, number[]> = {
  MC:    [0xf97316, 0x7c3aed, 0xdc2626, 0x0ea5e9, 0xeab308, 0x22c55e],
  CAR:   [0x1d4ed8, 0xdc2626, 0xffffff, 0x166534, 0x374151, 0x92400e, 0x6d28d9],
  JEP:   [0xf1f5f9, 0xfef3c7, 0xfcfcfc, 0xe0e7ef],
  BUS:   [0xffd700, 0x15803d, 0xff8c00, 0xfff8dc],
  TRUCK: [0x92400e, 0x374151, 0xfef3c7, 0x0f172a, 0x166534],
};

function pickColor(type: VehicleType): number {
  const list = VEH_COLORS[type];
  return list[Math.floor(Math.random() * list.length)];
}

// ─── Traffic-light pole ───────────────────────────────────────────────────────

interface TLRefs {
  group: THREE.Group;
  matR: THREE.MeshLambertMaterial;
  matA: THREE.MeshLambertMaterial;
  matG: THREE.MeshLambertMaterial;
  ptR: THREE.PointLight;
  ptA: THREE.PointLight;
  ptG: THREE.PointLight;
  countdownCtx: CanvasRenderingContext2D;
  countdownTex: THREE.CanvasTexture;
}

// Countdown sprites use a shared canvas drawn each second to show phase seconds remaining
function makeTrafficLight(): TLRefs {
  const S = 1.5; // uniform scale-up multiplier for pole/housing
  const g = new THREE.Group();
  const darkMat = makeMat(0x1a1f2e);
  const poleMat = makeMat(0x4b5563);

  // Base plate + taller pole for better visibility
  addBox(g, 1.2*S, 0.20, 1.2*S, 0, 0.10, 0, 0x374151);
  addCyl(g, 0.22*S, 0.26*S, 9.0, 8, 0, 4.56, 0, 0x374151);

  const armMesh = mesh(new THREE.CylinderGeometry(0.13*S, 0.13*S, 4.0*S, 6), poleMat);
  armMesh.rotation.z = Math.PI / 2; armMesh.position.set(-2.0*S, 9.20, 0); g.add(armMesh);

  // Housing - scale up 1.5× for visibility
  const HX = -4.0*S;
  const housing = mesh(bx(1.10*S, 3.60*S, 1.10*S), darkMat);
  housing.position.set(HX, 9.20, 0); g.add(housing);

  addBox(g, 1.30*S, 0.18*S, 1.20*S, HX, 11.10, 0, 0x111827);
  for (const y of [9.90, 9.05]) addBox(g, 1.10*S, 0.12*S, 1.10*S, HX, y, 0, 0x111827);

  // Lenses - bigger (0.60 radius) for clear visibility at camera distance
  const lensGeo = new THREE.SphereGeometry(0.60*S, 14, 10);
  const matR = makeMat(0x7f1d1d, 0, 0, 0.90);
  const matA = makeMat(0x78350f, 0, 0, 0.90);
  const matG = makeMat(0x14532d, 0, 0, 0.90);

  for (const zOff of [0.55*S, -0.55*S]) {
    const lR = mesh(lensGeo, matR); lR.position.set(HX, 10.60, zOff); lR.scale.z = 0.55; g.add(lR);
    const lA = mesh(lensGeo, matA); lA.position.set(HX,  9.70, zOff); lA.scale.z = 0.55; g.add(lA);
    const lG = mesh(lensGeo, matG); lG.position.set(HX,  8.80, zOff); lG.scale.z = 0.55; g.add(lG);
  }

  // Point lights
  const ptR = new THREE.PointLight(0xef4444, 0, 40, 2); ptR.position.set(HX, 10.60, 1.4); g.add(ptR);
  const ptA = new THREE.PointLight(0xf59e0b, 0, 40, 2); ptA.position.set(HX,  9.70, 1.4); g.add(ptA);
  const ptG = new THREE.PointLight(0x22c55e, 0, 40, 2); ptG.position.set(HX,  8.80, 1.4); g.add(ptG);

  // Countdown sprite - canvas texture always facing camera
  const cdCanvas = document.createElement('canvas');
  cdCanvas.width = 128; cdCanvas.height = 128;
  const cdCtx = cdCanvas.getContext('2d')!;
  const countdownTex = new THREE.CanvasTexture(cdCanvas);
  const cdMat = new THREE.SpriteMaterial({ map: countdownTex, transparent: true, depthTest: false });
  const cdSprite = new THREE.Sprite(cdMat);
  cdSprite.scale.set(4.5, 4.5, 1);
  cdSprite.position.set(HX, 13.0, 0); // above housing
  g.add(cdSprite);

  return { group: g, matR, matA, matG, ptR, ptA, ptG, countdownCtx: cdCtx, countdownTex };
}

function setTLPhase(tl: TLRefs, phase: SignalPhase, blink = false, remaining = 0): void {
  const showAmber = phase === 'amber' || (phase === 'red' && blink);
  const isRed   = phase === 'red' && !blink;
  const isGreen = phase === 'green';

  tl.matR.color.setHex(isRed ? 0xef4444 : 0x7f1d1d);
  tl.matR.emissive.setHex(isRed ? 0xef4444 : 0x000000);
  tl.matR.emissiveIntensity = isRed ? 4.0 : 0;

  tl.matA.color.setHex(showAmber ? 0xf59e0b : 0x78350f);
  tl.matA.emissive.setHex(showAmber ? 0xf59e0b : 0x000000);
  tl.matA.emissiveIntensity = showAmber ? 4.0 : 0;

  tl.matG.color.setHex(isGreen ? 0x22c55e : 0x14532d);
  tl.matG.emissive.setHex(isGreen ? 0x22c55e : 0x000000);
  tl.matG.emissiveIntensity = isGreen ? 4.0 : 0;

  tl.ptR.intensity = isRed ? 10.0 : 0;
  tl.ptA.intensity = showAmber ? 8.0 : 0;
  tl.ptG.intensity = isGreen ? 12.0 : 0;

  // Update countdown sprite (only when remaining changes by whole second to avoid spam)
  const secs = Math.ceil(remaining);
  const color = isGreen ? '#4ade80' : showAmber ? '#fbbf24' : '#f87171';
  const label = phase === 'red' && !blink ? 'WAIT' : `${secs > 0 ? secs : ''}`;
  const cdCtx = tl.countdownCtx;
  cdCtx.clearRect(0, 0, 128, 128);
  cdCtx.fillStyle = 'rgba(0,0,0,0.75)';
  cdCtx.beginPath();
  cdCtx.roundRect(6, 6, 116, 116, 20);
  cdCtx.fill();
  cdCtx.font = secs >= 10 ? 'bold 56px monospace' : 'bold 68px monospace';
  cdCtx.fillStyle = color;
  cdCtx.textAlign = 'center';
  cdCtx.textBaseline = 'middle';
  cdCtx.fillText(label, 64, 64);
  tl.countdownTex.needsUpdate = true;
}

// ─── Phase / crosswalk binding (resolves cwId → conflicting approach pair) ───

/** Map a crosswalk index to its conflicting approach pair. NS crosswalks
 *  (blockedApp=0) → [SB, NB]; EW crosswalks (blockedApp=1) → [WB, EB]. */
function pedCanWalkAt(cwId: number, t: number, gTimes: GreenTimes, signalOff: boolean): boolean {
  const conflicting = CW_DEFS[cwId].blockedApp === 0 ? [0, 2] : [1, 3];
  return pedCanWalk(conflicting, t, gTimes, signalOff);
}

// ─── Road scene ───────────────────────────────────────────────────────────────

function buildRoadScene(scene: THREE.Scene): void {
  // Ground
  const ground = mesh(new THREE.PlaneGeometry(200, 200), makeMat(0x111827));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  // NS road
  const nsRoad = mesh(new THREE.PlaneGeometry(ROAD_W, ARM * 2 + BOX * 2), makeMat(0x1e2433));
  nsRoad.rotation.x = -Math.PI / 2; nsRoad.position.y = 0.01; scene.add(nsRoad);

  // EW road
  const ewRoad = mesh(new THREE.PlaneGeometry(ARM * 2 + BOX * 2, ROAD_W), makeMat(0x1e2433));
  ewRoad.rotation.x = -Math.PI / 2; ewRoad.position.y = 0.01; scene.add(ewRoad);

  // Intersection box overlay
  const box3d = mesh(new THREE.PlaneGeometry(ROAD_W, ROAD_W), makeMat(0x1e2d3d));
  box3d.rotation.x = -Math.PI / 2; box3d.position.y = 0.015; scene.add(box3d);

  // Lane dashes
  addDashes(scene, 0, 0.02, -(BOX + ARM / 2), 0, 1, 0.15, ARM / 2, 2.8, 1.4, 0x374151);
  addDashes(scene, 0, 0.02,  (BOX + ARM / 2), 0, 1, 0.15, ARM / 2, 2.8, 1.4, 0x374151);
  addDashes(scene, -(BOX + ARM / 2), 0.02, 0, 1, 0, 0.15, ARM / 2, 2.8, 1.4, 0x374151);
  addDashes(scene,  (BOX + ARM / 2), 0.02, 0, 1, 0, 0.15, ARM / 2, 2.8, 1.4, 0x374151);

  // Stop lines
  const slMat = makeMat(0xe5e7eb);
  for (const [x, z, w, h, d] of [
    [0, -(BOX + 0.2), ROAD_W * 0.45, 0.25, 0.1],
    [ (BOX + 0.2), 0,  0.1, 0.25, ROAD_W * 0.45],
    [0,  (BOX + 0.2), ROAD_W * 0.45, 0.25, 0.1],
    [-(BOX + 0.2), 0,  0.1, 0.25, ROAD_W * 0.45],
  ] as [number, number, number, number, number][]) {
    const sl = mesh(new THREE.BoxGeometry(w, h, d), slMat);
    sl.position.set(x, 0.02, z);
    scene.add(sl);
  }

  // Road edge lines
  const edgeMat = makeMat(0xfbbf24);
  for (const [x, z, w, d] of [
    [ ROAD_W / 2, 0, 0.12, ARM * 2 + BOX * 2],
    [-ROAD_W / 2, 0, 0.12, ARM * 2 + BOX * 2],
    [0,  ROAD_W / 2, ARM * 2 + BOX * 2, 0.12],
    [0, -ROAD_W / 2, ARM * 2 + BOX * 2, 0.12],
  ] as [number, number, number, number][]) {
    const edge = mesh(new THREE.BoxGeometry(w, 0.06, d), edgeMat);
    edge.position.set(x, 0.04, z);
    scene.add(edge);
  }

  // Sidewalk corners
  const swMat = makeMat(0x374151);
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const corner = mesh(new THREE.BoxGeometry(8, 0.15, 8), swMat);
    corner.position.set(x * (BOX + 4), 0.07, z * (BOX + 4));
    scene.add(corner);
  }

  // Zebra crosswalk markings (4 arms)
  // Stripes run perpendicular to the pedestrian's walking direction.
  // NS arm crossings (peds walk E–W): stripes run N–S (along Z), spaced in X.
  // EW arm crossings (peds walk N–S): stripes run E–W (along X), spaced in Z.
  const xwMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0.88 });
  const stripeCount = Math.floor(ROAD_W / 0.85);
  const startOff = -((stripeCount - 1) / 2) * 0.85;
  for (let i = 0; i < stripeCount; i++) {
    const off = startOff + i * 0.85;

    // N arm (z = –XWALK_POS): stripes along Z, spaced in X
    const sN = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.04, 3.2), xwMat);
    sN.position.set(off, 0.026, -XWALK_POS); scene.add(sN);

    // S arm
    const sS = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.04, 3.2), xwMat);
    sS.position.set(off, 0.026,  XWALK_POS); scene.add(sS);

    // E arm (x = +XWALK_POS): stripes along X, spaced in Z
    const sE = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.04, 0.52), xwMat);
    sE.position.set( XWALK_POS, 0.026, off); scene.add(sE);

    // W arm
    const sW = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.04, 0.52), xwMat);
    sW.position.set(-XWALK_POS, 0.026, off); scene.add(sW);
  }
}

function addDashes(
  scene: THREE.Scene,
  cx: number, cy: number, cz: number,
  dx: number, _dy: number, dz: number,
  totalLength: number, dashLen: number, gapLen: number,
  color: number,
): void {
  const period = dashLen + gapLen;
  const count  = Math.floor(totalLength / period);
  const mat    = makeMat(color);
  for (let i = 0; i < count; i++) {
    const offset = -totalLength / 2 + i * period + dashLen / 2;
    const m = mesh(new THREE.BoxGeometry(
      0.14 + Math.abs(dz) * dashLen,
      0.06,
      0.14 + Math.abs(dx) * dashLen,
    ), mat);
    m.position.set(cx + dx * offset, cy, cz + dz * offset);
    scene.add(m);
  }
}

// ─── Simulation state types ───────────────────────────────────────────────────

interface Veh {
  id: number;
  type: VehicleType;
  app: number;
  dist: number;       // distance ahead of stop line (positive = queued, ≤0 = cleared)
  speed: number;
  obj: THREE.Group;
  // Intersection traversal (active once vehicle crosses stop line)
  turn: 'through' | 'left' | 'right' | null;
  waypoints: THREE.Vector3[];
  wpIdx: number;
  rotOffset: number;  // extra Y-rotation for Z-elongated GLB models
  yOffset: number;    // Y-lift so GLB model base sits on road surface
  // Audio event tracking
  stoppedFor: number; // seconds spent below threshold speed in the current queue
  honked: boolean;    // already triggered a horn during this stop
}

interface Ped {
  id: number;
  cwId: number;       // crosswalk index (0–3)
  progress: number;   // 0 = start edge, 1 = far edge
  obj: THREE.Group;
  mixer: THREE.AnimationMixer;
  walkAction: THREE.AnimationAction | null;
}

const APP_ROT: number[] = [
  -Math.PI / 2,   // 0 southbound
   Math.PI,       // 1 westbound
   Math.PI / 2,   // 2 northbound
   0,             // 3 eastbound
];

function placeVehicle(v: Veh): void {
  const p = VPARAMS[v.type];
  const d = v.dist + p.len / 2;
  const y = v.yOffset;
  // Lane choice per right-hand-traffic (PH/US): driver's right-hand side of
  // the road relative to direction of travel. SB(+Z)→west(-X); NB(-Z)→east(+X);
  // WB(-X)→north(-Z); EB(+X)→south(+Z). Previously SB and NB were on the
  // wrong (head-on) side of the NS road.
  switch (v.app) {
    case 0: v.obj.position.set(-LANE, y, -(BOX + d)); break;
    case 1: v.obj.position.set( BOX + d, y, -LANE);   break;
    case 2: v.obj.position.set( LANE, y,  BOX + d);   break;
    case 3: v.obj.position.set(-(BOX + d), y,  LANE); break;
  }
}

function placePed(p: Ped): void {
  const cw = CW_DEFS[p.cwId];
  p.obj.position.set(
    cw.startX + cw.dx * p.progress * ROAD_W,
    0,
    cw.startZ + cw.dz * p.progress * ROAD_W,
  );
}

// ─── Intersection traversal geometry ─────────────────────────────────────────
//
// Coordinate system: +X = East, +Z = South.  Right-hand traffic (PH).
// Per-approach stop-line positions (vehicle front bumper at dist = 0):
//   App 0 southbound  (+Z): (LANE, 0, -BOX)
//   App 1 westbound   (-X): (BOX,  0, -LANE)
//   App 2 northbound  (-Z): (-LANE, 0, BOX)
//   App 3 eastbound   (+X): (-BOX, 0,  LANE)
// Lane convention (consistent with placeVehicle):
//   Southbound / Northbound: x = ±LANE
//   Westbound / Eastbound:   z = ±LANE

// Right-hand traffic: each approach enters on the driver's right-hand
// lane of its road, so NS lanes mirror EW lanes around the centerline.
const APP_ENTRY_XZ: [number, number][] = [
  [-LANE, -BOX],   // 0 southbound (west lane of NS road)
  [ BOX,  -LANE],  // 1 westbound  (north lane of EW road)
  [ LANE,  BOX],   // 2 northbound (east lane of NS road)
  [-BOX,   LANE],  // 3 eastbound  (south lane of EW road)
];

// Per-approach turn arc data: [cpX, cpZ, p2X, p2Z, farX, farZ]
//   cp  = Bezier control point (corner anchor)
//   p2  = Bezier end = box edge where vehicle enters the exit arm
//   far = far end of exit arm (removal boundary)
//
// Right turns: control point at the NEAR outside BOX corner - tight inside
// arc matches real geometry.
//
// Left turns: control point at the entry-aligned LANE intersection:
//   cp.x = entry.x   (so the initial bezier tangent is the pure entry dir)
//   cp.z = exit.z    (so the final tangent is the pure exit dir)
// This makes the vehicle drive forward first and then arc smoothly through
// the inside corner of the turn. Earlier attempts at the far BOX corner or
// the far-diagonal LANE intersection put the midpoint in roughly the right
// place but gave the wrong tangents, so vehicles visibly veered sideways
// the instant they cleared the stop line ("looks weird coming from north").
type ArcRow = [number, number, number, number, number, number];
const ARC_DATA: Record<number, { left: ArcRow; right: ArcRow; throughFar: [number, number] }> = {
  0: { // southbound: stop at (-LANE, -BOX), traveling +Z (SB lane = west)
    throughFar: [-LANE,       BOX + ARM],
    left:       [-LANE,  LANE,  BOX,  LANE,  BOX + ARM,     LANE],   // → east (EB lane = south)
    right:      [-LANE, -LANE, -BOX, -LANE, -(BOX + ARM),  -LANE],   // → west (WB lane = north)
  },
  1: { // westbound: stop at (BOX, -LANE), traveling -X (WB lane = north)
    throughFar: [-(BOX + ARM), -LANE],
    left:       [-LANE, -LANE, -LANE,  BOX,  -LANE,      BOX + ARM],  // → south (SB lane = west)
    right:      [ LANE, -LANE,  LANE, -BOX,   LANE,    -(BOX + ARM)], // → north (NB lane = east)
  },
  2: { // northbound: stop at (LANE, BOX), traveling -Z (NB lane = east)
    throughFar: [ LANE, -(BOX + ARM)],
    left:       [ LANE, -LANE, -BOX, -LANE, -(BOX + ARM),  -LANE],   // → west (WB lane = north)
    right:      [ LANE,  LANE,  BOX,  LANE,   BOX + ARM,    LANE],   // → east (EB lane = south)
  },
  3: { // eastbound: stop at (-BOX, LANE), traveling +X (EB lane = south)
    throughFar: [BOX + ARM, LANE],
    left:       [ LANE,  LANE,  LANE, -BOX,   LANE,    -(BOX + ARM)], // → north (NB lane = east)
    right:      [-LANE,  LANE, -LANE,  BOX,  -LANE,      BOX + ARM],  // → south (SB lane = west)
  },
};

const ARC_N = 12; // Bezier sample count per arc

function buildPath3D(app: number, turn: 'through' | 'left' | 'right'): THREE.Vector3[] {
  const data = ARC_DATA[app];
  const [p0x, p0z] = APP_ENTRY_XZ[app];

  if (turn === 'through') {
    const [fx, fz] = data.throughFar;
    return [new THREE.Vector3(fx, 0, fz)];
  }

  const [cpx, cpz, p2x, p2z, farx, farz] = turn === 'left' ? data.left : data.right;
  const pts: THREE.Vector3[] = [];
  for (let i = 1; i <= ARC_N; i++) {
    const t = i / ARC_N, mt = 1 - t;
    pts.push(new THREE.Vector3(
      mt*mt*p0x + 2*mt*t*cpx + t*t*p2x,
      0,
      mt*mt*p0z + 2*mt*t*cpz + t*t*p2z,
    ));
  }
  pts.push(new THREE.Vector3(farx, 0, farz));
  return pts;
}

// ─── GLB model helpers ───────────────────────────────────────────────────────

function cloneGLBWithColor(gltf: GLTF, hexColor: number): THREE.Group {
  // skeletonClone handles SkinnedMesh correctly; plain .clone(true) breaks skinned rigs
  const obj = skeletonClone(gltf.scene) as THREE.Group;
  obj.traverse((child) => {
    child.visible = true;
    const m = child as THREE.Mesh;
    if (!m.isMesh) return;
    // Replace each material with a flat-colored MeshStandardMaterial.
    // We cannot just set .color because the original texture (map) multiplies
    // against it - a dark baked texture would make even a bright .color invisible.
    const matCount = Array.isArray(m.material) ? m.material.length : 1;
    const flat = new THREE.MeshStandardMaterial({
      color: hexColor,
      roughness: 0.65,
      metalness: 0.20,
    });
    m.material = matCount > 1 ? Array(matCount).fill(flat) : flat;
    m.castShadow = true;
  });
  return obj;
}

// ─── 3D HUD overlay ──────────────────────────────────────────────────────────

function buildHudHTML(vehicles: Veh[], sim: SimulationChunk | null | undefined, showBefore: boolean): string {
  const LABELS = ['SB', 'WB', 'NB', 'EB'];
  const queues = LABELS.map((_, i) =>
    vehicles.filter(v => v.app === i && v.waypoints.length === 0).length,
  );

  const card = 'background:rgba(0,0,0,0.72);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:8px 12px;backdrop-filter:blur(6px)';
  const label = 'font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px';

  const qTiles = LABELS.map((l, i) =>
    `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;min-width:34px">
      <span style="font-size:15px;font-weight:700;color:#f1f5f9;line-height:1">${queues[i]}</span>
      <span style="font-size:9px;color:#64748b">${l}</span>
    </span>`,
  ).join('');

  let html = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start">
    <div style="${card}">
      <div style="${label}">Live Queue</div>
      <div style="display:flex;gap:8px">${qTiles}</div>
    </div>`;

  if (sim) {
    const saved   = sim.delay_before - sim.delay_after;
    const pctSave = sim.delay_before > 0 ? (saved / sim.delay_before) * 100 : 0;

    if (!showBefore) {
      html += `<div style="${card}">
        <div style="${label}">Webster vs Current</div>
        <div style="display:flex;gap:6px;align-items:baseline;flex-wrap:wrap">
          <span style="font-size:9px;color:#64748b">Before</span>
          <span style="font-size:14px;font-weight:600;color:#94a3b8">${sim.delay_before.toFixed(1)}s</span>
          <span style="font-size:10px;color:#475569">→</span>
          <span style="font-size:9px;color:#64748b">After</span>
          <span style="font-size:14px;font-weight:600;color:#10b981">${sim.delay_after.toFixed(1)}s</span>
          <span style="font-size:11px;font-weight:600;color:#34d399">−${saved.toFixed(1)}s (${pctSave.toFixed(0)}%)</span>
        </div>
        <div style="margin-top:4px;font-size:11px;color:#34d399">${sim.vehicle_hours_saved.toFixed(1)} veh-hr saved</div>
      </div>`;
    } else {
      html += `<div style="${card}">
        <div style="${label}">Current Timing</div>
        <div style="font-size:14px;font-weight:600;color:#94a3b8">${sim.delay_before.toFixed(1)} s/veh · LOS ${sim.los_before}</div>
        <div style="margin-top:2px;font-size:10px;color:#64748b">Webster would save ${saved.toFixed(1)}s/veh (${pctSave.toFixed(0)}%)</div>
      </div>`;
    }
  }

  html += '</div>';
  return html;
}

// ─── React component ──────────────────────────────────────────────────────────

export interface IntersectionScene3DProps {
  timing: TimingChunk;
  streets: Street[];
  signalOff: boolean;
  volumePcuHr: number;
  typeMix: Record<string, TypeFractions>;
  showBefore?: boolean;
  signalStatus?: string;
  existingCycleS?: number | null;
  existingGreenSplits?: Record<string, number> | null;
  paused?: boolean;
  speed?: number;
  height?: number;
  sim?: SimulationChunk | null;
}

export function IntersectionScene3D({
  timing, streets, signalOff, volumePcuHr, typeMix,
  showBefore = false, signalStatus, existingCycleS, existingGreenSplits,
  paused = false, speed = 1, height = 480, sim,
}: IntersectionScene3DProps) {
  const mountRef   = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Refs let us change pause/speed/volume/typeMix without tearing down the whole WebGL scene
  const pausedRef  = useRef(false);
  const speedRef   = useRef(1);
  const volumeRef  = useRef(volumePcuHr);
  const typeMixRef = useRef(typeMix);
  useEffect(() => { pausedRef.current  = paused;     }, [paused]);
  useEffect(() => { speedRef.current   = speed;      }, [speed]);
  useEffect(() => { volumeRef.current  = volumePcuHr; }, [volumePcuHr]);
  useEffect(() => { typeMixRef.current = typeMix;    }, [typeMix]);

  // Real per-second arrival schedule (only set by on-demand window endpoint).
  // When populated, update() spawns vehicles from this schedule instead of
  // resampling Poisson from `volumePcuHr`.
  const arrivalsByAppRef  = useRef<(number[] | undefined)[]>([undefined, undefined, undefined, undefined]);
  const arrivalCarryRef   = useRef<number[]>([0, 0, 0, 0]);
  const lastArrivalSecRef = useRef<number>(-1);
  useEffect(() => {
    const arr = sim?.arrivals_per_second ?? null;
    const byApp: (number[] | undefined)[] = [undefined, undefined, undefined, undefined];
    if (arr) {
      for (const s of streets) {
        const ai = DIR_TO_APP[s.arm_direction];
        if (ai !== undefined) byApp[ai] = arr[String(s.id)];
      }
    }
    arrivalsByAppRef.current  = byApp;
    arrivalCarryRef.current   = [0, 0, 0, 0];
    lastArrivalSecRef.current = -1;
  }, [sim, streets]);

  // ── Audio ─────────────────────────────────────────────────────────────
  // Synthesized via Web Audio so no external MP3 assets are required.
  // - Ambient: brown-noise through low-pass = constant city rumble
  // - Horn:    two stacked oscillators with a short envelope
  // - Brake:   white-noise burst through a band-pass with quick decay
  // Default muted - browser autoplay policies block sound until a user gesture,
  // and an analyst opening this page likely doesn't want a horn blast.
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0.5);
  const audioEnabledRef = useRef(false);
  const audioVolumeRef = useRef(0.5);
  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);
  useEffect(() => { audioVolumeRef.current = audioVolume; }, [audioVolume]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const ambientSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const ambientGainRef = useRef<GainNode | null>(null);
  const lastHornAtRef = useRef(0);
  const lastBrakeAtRef = useRef(0);
  // The run() loop reads from this ref to fire event sounds.
  const triggersRef = useRef<{ horn: () => void; brake: () => void }>({
    horn: () => {},
    brake: () => {},
  });

  // Lazily create the AudioContext + ambient loop the first time the user enables
  // sound (browsers require a user gesture to start an AudioContext).
  function ensureAudioContext(): AudioContext | null {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    audioCtxRef.current = ctx;

    // Master gain controlled by the volume slider.
    const master = ctx.createGain();
    master.gain.value = audioVolumeRef.current;
    master.connect(ctx.destination);
    masterGainRef.current = master;

    // Ambient: 2 seconds of brown noise looped through a low-pass filter.
    const sampleRate = ctx.sampleRate;
    const ambientBuf = ctx.createBuffer(1, sampleRate * 2, sampleRate);
    const ch = ambientBuf.getChannelData(0);
    let lastSample = 0;
    for (let i = 0; i < ch.length; i++) {
      const white = Math.random() * 2 - 1;
      // Brown noise is an integrated random walk; the 3.5 multiplier keeps it
      // peaking near +-1 without clipping after the low-pass filter below.
      lastSample = (lastSample + 0.02 * white) / 1.02;
      ch[i] = lastSample * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = ambientBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    lp.Q.value = 0.7;
    const ambientGain = ctx.createGain();
    ambientGain.gain.value = 0.0;  // muted until enabled
    src.connect(lp);
    lp.connect(ambientGain);
    ambientGain.connect(master);
    src.start();
    ambientSourceRef.current = src;
    ambientGainRef.current = ambientGain;

    return ctx;
  }

  // Event sound generators - created on demand, auto-disposed when the envelope
  // completes. Throttled at the trigger call site to avoid pile-ups.
  function playHorn() {
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    // Two-tone honk: 320 Hz + 440 Hz square waves.
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'square';
    osc2.type = 'square';
    osc1.frequency.value = 320;
    osc2.frequency.value = 440;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.02);
    g.gain.setValueAtTime(0.18, now + 0.35);
    g.gain.linearRampToValueAtTime(0, now + 0.45);
    osc1.connect(g);
    osc2.connect(g);
    g.connect(master);
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.5);
    osc2.stop(now + 0.5);
  }

  function playBrake() {
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    const len = 0.3;
    const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Band-pass around 2.5 kHz gives the characteristic squeal/skid timbre.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500;
    bp.Q.value = 8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.25, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + len);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(now);
    src.stop(now + len);
  }

  // Wire triggers once - they read from refs so state changes don't recreate them.
  useEffect(() => {
    triggersRef.current = {
      horn: () => {
        if (!audioEnabledRef.current) return;
        const now = performance.now();
        if (now - lastHornAtRef.current < 2000) return;
        lastHornAtRef.current = now;
        playHorn();
      },
      brake: () => {
        if (!audioEnabledRef.current) return;
        const now = performance.now();
        if (now - lastBrakeAtRef.current < 400) return;
        lastBrakeAtRef.current = now;
        playBrake();
      },
    };
  }, []);

  // Enable/volume changes: open the AudioContext lazily, then ramp ambient gain.
  useEffect(() => {
    if (audioEnabled) {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
    const master = masterGainRef.current;
    const ambientGain = ambientGainRef.current;
    if (master) master.gain.value = audioVolume;
    if (ambientGain) {
      // Ambient layered at ~35% of master so it sits beneath event sounds.
      ambientGain.gain.value = audioEnabled ? 0.35 : 0.0;
    }
  }, [audioEnabled, audioVolume]);

  // Tear down the AudioContext on unmount.
  useEffect(() => {
    return () => {
      const ctx = audioCtxRef.current;
      try { ambientSourceRef.current?.stop(); } catch { /* already stopped */ }
      ctx?.close().catch(() => {});
      audioCtxRef.current = null;
      masterGainRef.current = null;
      ambientSourceRef.current = null;
      ambientGainRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    let disposed  = false;
    let cleanupFn: (() => void) | undefined;

    // Load all GLB models concurrently; simulation starts once every request settles.
    const loader = new GLTFLoader();
    type MKey = 'car' | 'car2' | 'suv' | 'taxi' | 'sportsCar' | 'sportsCar2' | 'policeCar'
              | 'truck' | 'scooter' | 'tricycle'
              | 'man' | 'man2' | 'manSleeves' | 'manSuit';
    const MODEL_URLS: Record<MKey, string> = {
      car:        '/models/Car.glb',
      car2:       '/models/Car-unqqkULtRU.glb',
      suv:        '/models/SUV.glb',
      taxi:       '/models/Taxi.glb',
      sportsCar:  '/models/Sports%20Car.glb',
      sportsCar2: '/models/Sports%20Car-1mkmFkAz5v.glb',
      policeCar:  '/models/Police%20Car.glb',
      truck:      '/models/Truck.glb',
      scooter:    '/models/Scooter.glb',
      tricycle:   '/models/philippine_tricycle.glb',
      man:        '/models/Man.glb',
      man2:       '/models/Man-fjHyMd5Wxw.glb',
      manSleeves: '/models/Man%20in%20Long%20Sleeves.glb',
      manSuit:    '/models/Man%20in%20Suit.glb',
    };
    const gltfs: Partial<Record<MKey, GLTF>> = {};
    const TOTAL = Object.keys(MODEL_URLS).length;
    let loadedCount = 0;

    function tryStart() {
      loadedCount++;
      if (loadedCount >= TOTAL && !disposed) cleanupFn = run(el!, gltfs);
    }

    for (const [key, url] of Object.entries(MODEL_URLS) as [MKey, string][]) {
      loader.load(url,
        (g) => { gltfs[key] = g; tryStart(); },
        undefined,
        () => tryStart(),
      );
    }

    return () => {
      disposed = true;
      cleanupFn?.();
    };

    // ── Inner setup (runs once all GLTFs are settled) ────────────────────────
    function run(container: HTMLDivElement, gltfs: Partial<Record<string, GLTF>>): () => void {
      // Renderer
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // ACES gives a proper LDR curve so the bright daytime ambient + sun
      // don't crush to black on the screen, and exposure > 1 lifts the scene
      // out of the "everything is a dark blue silhouette" look.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.8;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0x0a0f1a);
      container.appendChild(renderer.domElement);

      const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 800);
      let theta = Math.PI * 0.35, phi = Math.PI * 0.30, radius = 130;

      function updateCamera() {
        camera.position.set(
          radius * Math.sin(phi) * Math.sin(theta),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.cos(theta),
        );
        camera.lookAt(0, 2, 0);
      }
      updateCamera();

      const resize = () => {
        const w = container.clientWidth, h = container.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      resize();

      // Mouse orbit
      let dragging = false, lastMX = 0, lastMY = 0;
      const onMouseDown = (e: MouseEvent) => { dragging = true; lastMX = e.clientX; lastMY = e.clientY; };
      const onMouseUp   = () => { dragging = false; };
      const onMouseMove = (e: MouseEvent) => {
        if (!dragging) return;
        theta -= (e.clientX - lastMX) * 0.008;
        phi    = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, phi - (e.clientY - lastMY) * 0.006));
        lastMX = e.clientX; lastMY = e.clientY;
        updateCamera();
      };
      const onWheel = (e: WheelEvent) => {
        radius = Math.max(50, Math.min(220, radius + e.deltaY * 0.08));
        updateCamera();
        e.preventDefault();
      };
      renderer.domElement.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('mousemove', onMouseMove);
      renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

      // Touch orbit + pinch zoom
      let touchX = 0, touchY = 0, lastPinch = 0;
      const onTouchStart = (e: TouchEvent) => {
        lastPinch = 0;
        if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }
      };
      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        if (e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (lastPinch > 0) { radius = Math.max(50, Math.min(220, radius - (dist - lastPinch) * 0.4)); updateCamera(); }
          lastPinch = dist;
          return;
        }
        lastPinch = 0;
        if (e.touches.length !== 1) return;
        const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
        theta -= (cx - touchX) * 0.008;
        phi    = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, phi - (cy - touchY) * 0.006));
        touchX = cx; touchY = cy;
        updateCamera();
      };
      renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: true });
      renderer.domElement.addEventListener('touchmove',  onTouchMove,  { passive: false });

      // Scene - time-of-day ambient based on chunk name
      const chunkN = timing.chunk_name ?? '';
      const isNightChunk = /night|midnight|pre.?dawn/i.test(chunkN);
      const isDuskDawn   = /dusk|dawn|evening|early.?morning/i.test(chunkN);

      const fogColor    = isNightChunk ? 0x2a3550 : isDuskDawn ? 0x6e4858 : 0xb8d2ee;
      const ambColor    = isNightChunk ? 0x4a5a78 : isDuskDawn ? 0xb88090 : 0xe0e8f4;
      const ambInt      = isNightChunk ? 2.8      : isDuskDawn ? 3.6      : 4.8;
      const skyColor    = isNightChunk ? 0x4a5a78 : isDuskDawn ? 0xffb0a0 : 0xd0e4ff;
      const groundColor = isNightChunk ? 0x1a2030 : isDuskDawn ? 0x5a3040 : 0x6a7280;
      const hemiInt     = isNightChunk ? 2.0      : isDuskDawn ? 2.8      : 3.8;
      const sunColor    = isNightChunk ? 0x80a0d0 : isDuskDawn ? 0xffa060 : 0xfff8e0;
      const sunInt      = isNightChunk ? 1.6      : isDuskDawn ? 3.2      : 5.5;
      const fillInt     = isNightChunk ? 1.2      : isDuskDawn ? 1.8      : 2.4;
      // Bounce / rim light from the opposite side, color-shifted to contrast.
      const rimColor    = isNightChunk ? 0x6090c0 : isDuskDawn ? 0xa090ff : 0xfff0c8;
      const rimInt      = isNightChunk ? 0.9      : isDuskDawn ? 1.4      : 2.0;
      const sunPos: [number, number, number] = isNightChunk
        ? [-20, 40, 10]   // moon-like back-overhead
        : isDuskDawn
          ? [80, 15, -20] // low angle sun at horizon
          : [40, 80, 30]; // midday high sun

      const scene = new THREE.Scene();
      // Very thin fog - just enough to soften the far horizon without crushing
      // distant geometry into the clear color.
      scene.fog = new THREE.FogExp2(fogColor, 0.0015);
      scene.add(new THREE.AmbientLight(ambColor, ambInt));
      // Hemisphere light gives a natural sky-down / ground-up gradient - keeps
      // rooftops bright and undersides softly lit at the same time.
      scene.add(new THREE.HemisphereLight(skyColor, groundColor, hemiInt));
      const sun = new THREE.DirectionalLight(sunColor, sunInt);
      sun.position.set(...sunPos);
      sun.castShadow = true;
      sun.shadow.mapSize.setScalar(2048);
      sun.shadow.camera.near = 1; sun.shadow.camera.far = 300;
      // Soften shadows so they don't read as black holes against the brighter scene.
      sun.shadow.radius = 4;
      sun.shadow.bias = -0.0003;
      const sc = 90; Object.assign(sun.shadow.camera, { left: -sc, right: sc, top: sc, bottom: -sc });
      scene.add(sun);
      // Cool fill from the opposite quadrant - kills the pure-black shadow side.
      const fillLight = new THREE.DirectionalLight(0xa8c4f0, fillInt);
      fillLight.position.set(-30, 40, -40);
      scene.add(fillLight);
      // Warm rim from above-behind - silhouettes the geometry against the sky.
      const rimLight = new THREE.DirectionalLight(rimColor, rimInt);
      rimLight.position.set(-40, 60, 30);
      scene.add(rimLight);
      // Underside bounce - fakes ground-bounced light hitting truck/car undercarriages.
      const bounceLight = new THREE.DirectionalLight(0xfff0d8, isNightChunk ? 0.3 : 0.8);
      bounceLight.position.set(0, -20, 0);
      scene.add(bounceLight);
      // Match the sky to the fog so the horizon doesn't show a hard seam.
      renderer.setClearColor(fogColor);

      buildRoadScene(scene);

      // Traffic lights - curb-mounted on the driver's right, arm extends over the approaching lane.
      // Lenses face toward approaching vehicles; back-face lenses (same material) face away - both visible.
      //   rotY = 0:      arm → -X (west),  lenses → +Z (south) - for SB traffic
      //   rotY = π/2:    arm → +Z (south), lenses → +X (east)  - for WB traffic
      //   rotY = π:      arm → +X (east),  lenses → -Z (north) - for NB traffic
      //   rotY = -π/2:   arm → -Z (north), lenses → -X (west)  - for EB traffic
      const tlConfigs = [
        { x:  ROAD_W / 2 + 0.8, z: -(BOX + 1.5),   rotY: 0             },  // SB - east curb of N arm
        { x:  BOX + 1.5,        z: -(ROAD_W / 2 + 0.8), rotY: Math.PI / 2 }, // WB - north curb of E arm
        { x: -(ROAD_W / 2 + 0.8), z: BOX + 1.5,    rotY: Math.PI       },  // NB - west curb of S arm
        { x: -(BOX + 1.5),      z:  ROAD_W / 2 + 0.8, rotY: -Math.PI / 2 }, // EB - south curb of W arm
      ];
      const tls: TLRefs[] = tlConfigs.map(cfg => {
        const tl = makeTrafficLight();
        tl.group.position.set(cfg.x, 0, cfg.z);
        tl.group.rotation.y = cfg.rotY;
        scene.add(tl.group);
        return tl;
      });

      // Signal-off flag: before-state uses intersection signal_status;
      // after-state (Webster timing) uses the signalOff prop from the timing chunk.
      const effectiveSignalOff = showBefore
        ? (signalStatus !== 'fixed_time' && signalStatus !== 'actuated')
        : signalOff;

      // Phase green times - before mode uses existing splits, after uses Webster splits
      const approachGreen: (number | undefined)[] = [undefined, undefined, undefined, undefined];
      const splits = showBefore ? (existingGreenSplits ?? null) : timing.green_splits;
      if (splits) {
        for (const s of streets) {
          const ai = DIR_TO_APP[s.arm_direction];
          if (ai !== undefined) {
            const g = splits[String(s.id)];
            if (g !== undefined) approachGreen[ai] = g;
          }
        }
      }
      const effectiveCycle = (showBefore ? existingCycleS : null) ?? timing.cycle_length ?? 90;
      const fallbackG = Math.max((effectiveCycle - 4 * ALL_RED) / 4, 5);
      const gTimes: GreenTimes = [0, 1, 2, 3].map(ai => {
        const raw = approachGreen[ai];
        return Math.max(raw != null && isFinite(raw) ? raw : fallbackG, 5);
      }) as GreenTimes;

      // Vehicle pool
      const vehicles: Veh[] = [];
      let nextVehId = 0;
      const nextSpawn: number[] = [0, 0, 0, 0].map(() => 0);

      function getAvgMix(): TypeFractions {
        const mix: TypeFractions = { ...DEFAULT_MIX };
        const vals = Object.values(typeMixRef.current);
        if (vals.length > 0) {
          for (const t of VEH_TYPES) mix[t] = vals.reduce((s, m) => s + (m[t] ?? 0), 0) / vals.length;
        }
        return mix;
      }

      // Pedestrian pool
      const peds: Ped[] = [];
      let nextPedId = 0;
      // Track whether each crosswalk was walkable last tick (to detect phase transitions)
      const cwWalkablePrev: boolean[] = [false, false, false, false];
      // Per-crosswalk queue of remaining delay times for staged ped spawns
      const pedSpawnQueue: number[][] = [[], [], [], []];

      // Pedestrian model pool - pick randomly from available man GLBs
      const pedGLTFs = (['man', 'man2', 'manSleeves', 'manSuit'] as const)
        .map(k => gltfs[k]).filter(Boolean) as GLTF[];

      function spawnPed(cwId: number): void {
        if (pedGLTFs.length === 0) return;
        const src = pedGLTFs[Math.floor(Math.random() * pedGLTFs.length)];
        const obj = skeletonClone(src.scene) as THREE.Group;
        obj.scale.setScalar(PED_SCALE);
        // atan2(dx, dz) gives the Y rotation that aligns local +Z with movement direction
        const cw = CW_DEFS[cwId];
        obj.rotation.y = Math.atan2(cw.dx, cw.dz);

        const mixer = new THREE.AnimationMixer(obj);
        const clip = src.animations.find(a => /walk/i.test(a.name)) ?? src.animations[0] ?? null;
        let walkAction: THREE.AnimationAction | null = null;
        if (clip) { walkAction = mixer.clipAction(clip); walkAction.play(); }

        const ped: Ped = { id: nextPedId++, cwId, progress: 0, obj, mixer, walkAction };
        placePed(ped);
        scene.add(obj);
        peds.push(ped);
      }

      // ── Vehicle GLB pool with per-model scale + facing correction ──────────────
      // GLB models export at varying scales and can face +X or +Z.
      // We measure each model's bounding box, normalise to target length, and
      // detect the facing axis: Z-elongated → faces +Z → needs +π/2 offset so
      // the model aligns with APP_ROT (which was designed for +X-facing models).
      const GLB_TARGET_LEN: Partial<Record<string, number>> = {
        car: 4.4, car2: 4.4, suv: 4.6, taxi: 4.4,
        sportsCar: 4.2, sportsCar2: 4.2, policeCar: 4.8,
        truck: 8.5, scooter: 1.8, tricycle: 2.2,
      };
      type GLBEntry = { gltf: GLTF; scale: number; rotOffset: number; yOffset: number };
      function makeEntry(key: string): GLBEntry | null {
        const gltf = gltfs[key as keyof typeof gltfs];
        if (!gltf) return null;
        const target = GLB_TARGET_LEN[key];
        if (!target) return { gltf, scale: 1, rotOffset: 0, yOffset: 0 };
        const box  = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        const facingZ = size.z > size.x;           // model is elongated along Z → faces +Z
        const major   = Math.max(size.x, size.z);
        const scale   = major > 0.01 ? target / major : 1;
        const rotOffset = facingZ ? Math.PI / 2 : 0;
        // Lift model so its lowest point sits exactly on the road surface (Y=0)
        const yOffset = box.isEmpty() ? 0 : -box.min.y * scale;
        return { gltf, scale, rotOffset, yOffset };
      }
      function buildPool(keys: readonly string[]): GLBEntry[] {
        return keys.map(makeEntry).filter((e): e is GLBEntry => e !== null);
      }

      const CAR_POOL   = buildPool(['car', 'car2', 'suv', 'taxi', 'sportsCar', 'sportsCar2', 'policeCar']);
      const MC_POOL    = buildPool(['scooter']);   // scooter only - tricycle.glb has 210 meshes/draw call
      const TRUCK_POOL = buildPool(['truck']);

      function pickEntry(pool: GLBEntry[]): GLBEntry { return pool[Math.floor(Math.random() * pool.length)]; }

      function spawnVehicle(app: number) {
        const type = sampleType(getAvgMix());

        let obj: THREE.Group;
        let vehRotOffset = 0;
        let vehYOffset   = 0;
        let pool: GLBEntry[] | null = null;
        if      (type === 'CAR'   && CAR_POOL.length)   pool = CAR_POOL;
        else if (type === 'MC'    && MC_POOL.length)     pool = MC_POOL;
        else if (type === 'TRUCK' && TRUCK_POOL.length)  pool = TRUCK_POOL;

        if (pool) {
          const { gltf: src, scale, rotOffset, yOffset } = pickEntry(pool);
          vehRotOffset = rotOffset;
          vehYOffset   = yOffset;
          obj = cloneGLBWithColor(src, pickColor(type));
          obj.scale.setScalar(scale);
          obj.rotation.y = APP_ROT[app] + rotOffset;
        } else {
          obj = VEHICLE_MAKERS[type](pickColor(type));
          obj.rotation.y = APP_ROT[app];
        }

        scene.add(obj);

        const tail = vehicles
          .filter(v => v.app === app)
          .reduce((mx, v) => Math.max(mx, v.dist + VPARAMS[v.type].len / 2), 0);
        const p    = VPARAMS[type];
        const dist = Math.max(tail + p.gap + p.len / 2, ARM - p.len / 2);
        const veh: Veh = { id: nextVehId++, type, app, dist, speed: 0, obj, turn: null, waypoints: [], wpIdx: 0, rotOffset: vehRotOffset, yOffset: vehYOffset, stoppedFor: 0, honked: false };
        vehicles.push(veh);
        placeVehicle(veh);  // position immediately so vehicles appear on first render
      }

      // Pre-populate: 6 per arm (24 total) - keeps draw calls reasonable at startup
      for (let app = 0; app < 4; app++) {
        for (let i = 0; i < 6; i++) spawnVehicle(app);
      }

      let simTime = 0, blinkOn = true, lastT = performance.now(), lastHudSec = -1;

      // pausedRef, speedRef, volumeRef are stable refs from the component scope.
      // Reading .current inside animate always gets the latest value without a remount.

      function update(dt: number) {
        simTime += dt;
        blinkOn  = Math.floor(simTime) % 2 === 0;
        const perApproachVolume = Math.max(volumeRef.current / 4, 1);

        // Update traffic lights
        for (let ai = 0; ai < 4; ai++) {
          const phase = approachPhase(ai, simTime, gTimes, effectiveSignalOff, blinkOn);
          const rem   = approachRemaining(ai, simTime, gTimes);
          setTLPhase(tls[ai], phase, effectiveSignalOff && !blinkOn, rem);
        }

        // Vehicle spawning - real schedule when available, Poisson otherwise.
        const arrByApp = arrivalsByAppRef.current;
        const hasSchedule = arrByApp.some(a => a && a.length > 0);
        if (hasSchedule) {
          const curSec = Math.floor(simTime);
          while (lastArrivalSecRef.current < curSec) {
            lastArrivalSecRef.current += 1;
            for (let i = 0; i < 4; i++) {
              const arr = arrByApp[i];
              if (!arr || arr.length === 0) continue;
              arrivalCarryRef.current[i] += arr[lastArrivalSecRef.current % arr.length] ?? 0;
            }
          }
          for (let app = 0; app < 4; app++) {
            while (arrivalCarryRef.current[app] >= 1) {
              if (vehicles.filter(v => v.app === app).length >= 25) break;
              spawnVehicle(app);
              arrivalCarryRef.current[app] -= 1;
            }
          }
        } else {
          for (let app = 0; app < 4; app++) {
            nextSpawn[app] -= dt;
            if (nextSpawn[app] <= 0) {
              if (vehicles.filter(v => v.app === app).length < 25) spawnVehicle(app);
              nextSpawn[app] = nextPoissonInterval(perApproachVolume / 3600);
            }
          }
        }

        // Vehicle physics - IDM queuing + Bezier arc intersection traversal
        for (let i = vehicles.length - 1; i >= 0; i--) {
          const v = vehicles[i];
          const p = VPARAMS[v.type];

          // ── Waypoint traversal (vehicle is clearing the intersection or exiting) ──
          if (v.waypoints.length > 0) {
            // IDM free-flow acceleration (no leader in exit arm)
            const freeAcc = p.accel * (1 - Math.pow(Math.max(v.speed, 0) / p.spd, 4));
            v.speed = Math.max(0, v.speed + freeAcc * dt);

            // Advance along arc waypoints
            let rem = v.speed * dt;
            while (rem > 1e-9 && v.wpIdx < v.waypoints.length) {
              const wp = v.waypoints[v.wpIdx];
              const dx = wp.x - v.obj.position.x;
              const dz = wp.z - v.obj.position.z;
              const d  = Math.sqrt(dx * dx + dz * dz);
              if (d < 1e-6) { v.wpIdx++; continue; }
              if (rem >= d) {
                v.obj.position.set(wp.x, v.yOffset, wp.z);
                v.wpIdx++;
                rem -= d;
              } else {
                v.obj.position.x += (dx / d) * rem;
                v.obj.position.z += (dz / d) * rem;
                rem = 0;
              }
            }

            // Rotate vehicle to face its next waypoint.
            // rotOffset corrects for GLB models that are elongated along Z instead of X.
            if (v.wpIdx < v.waypoints.length) {
              const wp = v.waypoints[v.wpIdx];
              const dx = wp.x - v.obj.position.x;
              const dz = wp.z - v.obj.position.z;
              if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) {
                v.obj.rotation.y = -Math.atan2(dz, dx) + v.rotOffset;
              }
            }

            if (v.wpIdx >= v.waypoints.length) {
              scene.remove(v.obj);
              v.obj.traverse(c => {
                const m = c as THREE.Mesh;
                if (!m.isMesh) return;
                m.geometry.dispose();
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                mats.forEach(mat => (mat as THREE.Material).dispose());
              });
              vehicles.splice(i, 1);
            }
            continue;
          }

          // ── Queuing vehicle (approaching or stopped at stop line) ──
          const phase   = approachPhase(v.app, simTime, gTimes, effectiveSignalOff, blinkOn);
          const gapAxis = Math.floor(simTime / 10) % 2;
          const canGo   = phase === 'green'
            || (effectiveSignalOff && v.app % 2 === gapAxis);

          // Find nearest queuing leader on same approach (bumper-to-bumper)
          let sGap = Infinity, vLead = Infinity;
          let leader3D: Veh | null = null;
          for (const other of vehicles) {
            if (other === v || other.app !== v.app || other.waypoints.length > 0) continue;
            // bumper-to-bumper gap: follower front (v.dist) minus leader rear (other.dist + other.len)
            const gap = v.dist - (other.dist + VPARAMS[other.type].len);
            if (gap >= -p.gap && gap < sGap) { sGap = gap; vLead = other.speed; leader3D = other; }
          }

          // Stop-line as virtual wall when not permitted
          if (!canGo) {
            const toStop = v.dist;
            if (toStop < sGap) { sGap = Math.max(toStop, 0.01); vLead = 0; }
          }

          // IDM acceleration - rule lives in lib/traffic-sim; this loop owns the
          // mesh + queueing context, the lib owns the car-following maths.
          const acc = idmAcceleration(p, v.speed, vLead, sGap);
          // Audio: trigger brake squeal on hard deceleration while still moving fast enough to skid.
          if (acc < -3 && v.speed > 1) triggersRef.current.brake();
          v.speed = Math.max(0, v.speed + acc * dt);

          // Audio: queue-frustration honk. After ~8s stopped behind a leader, the
          // vehicle honks once; the flag resets when it moves again.
          if (v.speed < 0.5 && leader3D) {
            v.stoppedFor += dt;
            if (v.stoppedFor > 8 && !v.honked) {
              v.honked = true;
              triggersRef.current.horn();
            }
          } else {
            v.stoppedFor = 0;
            v.honked = false;
          }

          const rawNext3D = v.dist - v.speed * dt;

          // Hard no-overlap constraint: pin to leader's rear / stop line, match speed
          if (leader3D) {
            const leaderRear = leader3D.dist + VPARAMS[leader3D.type].len;
            if (rawNext3D < leaderRear) {
              v.dist  = leaderRear;
              v.speed = Math.min(v.speed, leader3D.speed);
            } else {
              v.dist = rawNext3D;
            }
          } else {
            v.dist = rawNext3D;
          }

          // Hard stop at stop line when not permitted
          if (!canGo && v.dist < 0) { v.dist = 0; v.speed = 0; }

          // Initiate intersection traversal when vehicle clears stop line
          if (canGo && v.dist < 0 && v.turn === null) {
            const [epx, epz] = APP_ENTRY_XZ[v.app];
            // Entry gate: don't enter if another same-approach vehicle is still near the box entry
            const entryBlocked = vehicles.some(other =>
              other !== v && other.app === v.app && other.waypoints.length > 0 && other.wpIdx < 4 &&
              Math.hypot(other.obj.position.x - epx, other.obj.position.z - epz) < p.len + p.gap,
            );
            if (entryBlocked) { v.dist = 0; v.speed = 0; placeVehicle(v); continue; }

            // Box-clear check: hold if any vehicle from a different approach is still inside the
            // intersection box. With 4 independent phases, any cross-traffic could be in transit.
            const boxFull = vehicles.some(other =>
              other !== v &&
              other.app !== v.app &&
              other.waypoints.length > 0 &&
              Math.abs(other.obj.position.x) < BOX + 2 &&
              Math.abs(other.obj.position.z) < BOX + 2,
            );
            if (boxFull) { v.dist = 0; v.speed = 0; placeVehicle(v); continue; }

            // Pedestrian gate: peds start crossing only when the conflicting
            // vehicle phase is red (pedCanWalkAt), but they don't disappear
            // the instant the phase flips back to green - slow walkers can
            // still be mid-crossing. Without this check the first vehicles
            // of a new green plough straight through them. The mapping
            // mirrors CW_DEFS.blockedApp: NS approaches (SB/NB = app 0,2)
            // conflict with the N/S crosswalks (cwId 0,1); EW approaches
            // (WB/EB = app 1,3) conflict with the E/W crosswalks (cwId 2,3).
            const conflictingCws: readonly number[] =
              v.app % 2 === 0 ? [0, 1] : [2, 3];
            const pedInConflict = peds.some(
              p => conflictingCws.includes(p.cwId) && p.progress < 1,
            );
            if (pedInConflict) { v.dist = 0; v.speed = 0; placeVehicle(v); continue; }

            v.turn = sampleTurn();
            v.waypoints = buildPath3D(v.app, v.turn);
            v.wpIdx = 0;
            v.obj.position.set(epx, v.yOffset, epz);
            continue;
          }

          placeVehicle(v);
        }

        // Pedestrian crossings
        if (pedGLTFs.length > 0) {
          for (let cwId = 0; cwId < 4; cwId++) {
            const canWalk = pedCanWalkAt(cwId, simTime, gTimes, effectiveSignalOff);
            const wasWalkable = cwWalkablePrev[cwId];

            // Queue 1–2 staggered ped spawns at the start of each WALK phase
            if (canWalk && !wasWalkable) {
              const count = peds.filter(p => p.cwId === cwId).length + pedSpawnQueue[cwId].length;
              const toSpawn = Math.floor(Math.random() * 2) + 1;
              for (let k = 0; k < toSpawn && count + k < 3; k++) {
                pedSpawnQueue[cwId].push(k * 0.8);
              }
            }

            // Drain the spawn queue - each entry is a countdown; fire when it hits zero
            for (let qi = pedSpawnQueue[cwId].length - 1; qi >= 0; qi--) {
              pedSpawnQueue[cwId][qi] -= dt;
              if (pedSpawnQueue[cwId][qi] <= 0) {
                if (peds.filter(p => p.cwId === cwId).length < 3) spawnPed(cwId);
                pedSpawnQueue[cwId].splice(qi, 1);
              }
            }

            cwWalkablePrev[cwId] = canWalk;
          }

          // Move and update pedestrians
          for (let i = peds.length - 1; i >= 0; i--) {
            const p = peds[i];
            const canWalk = pedCanWalkAt(p.cwId, simTime, gTimes, effectiveSignalOff);

            if (canWalk) {
              p.progress += (PED_SPEED / ROAD_W) * dt;
              if (p.walkAction && !p.walkAction.isRunning()) p.walkAction.play();
            } else {
              // Stop in place at red; pause walk animation
              if (p.walkAction && p.walkAction.isRunning()) p.walkAction.stop();
            }

            p.mixer.update(dt);
            placePed(p);

            if (p.progress >= 1) {
              scene.remove(p.obj);
              peds.splice(i, 1);
            }
          }
        }

        // HUD overlay - update once per simulated second
        const curSec = Math.floor(simTime);
        if (curSec !== lastHudSec) {
          lastHudSec = curSec;
          const hudEl = overlayRef.current;
          if (hudEl) hudEl.innerHTML = buildHudHTML(vehicles, sim, showBefore);
        }
      }

      const MAX_PHYS_DT = 0.05; // physics sub-step cap (seconds) - prevents penetration at speed
      let rafId = 0;
      function animate(now: number) {
        rafId = requestAnimationFrame(animate);
        const rawDt = Math.min((now - lastT) / 1000, 0.1);
        lastT = now;
        if (!pausedRef.current) {
          // speed=1 → real time (1 sim-second per real-second). Previously
          // the base was 15, which made even 1× feel like a time-lapse and
          // was too fast to follow during demos. Cap remains 1.0 s per frame
          // so a tab-switch pause never integrates a giant step.
          let rem = Math.min(rawDt * speedRef.current, 1.0);
          while (rem > 0) { const step = Math.min(rem, MAX_PHYS_DT); update(step); rem -= step; }
        }
        renderer.render(scene, camera);
      }
      rafId = requestAnimationFrame(animate);

      return () => {
        cancelAnimationFrame(rafId);
        ro.disconnect();
        renderer.domElement.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('mousemove', onMouseMove);
        renderer.domElement.removeEventListener('wheel', onWheel);
        renderer.domElement.removeEventListener('touchstart', onTouchStart);
        renderer.domElement.removeEventListener('touchmove', onTouchMove);
        scene.traverse(obj => {
          const m = obj as THREE.Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            mats.forEach(mat => (mat as THREE.Material).dispose());
          }
        });
        renderer.dispose();
        if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timing.id, signalOff, showBefore]);

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <div
        ref={mountRef}
        style={{ width: '100%', height: '100%', borderRadius: 8, cursor: 'grab', background: '#0a0f1a' }}
      />
      <div
        ref={overlayRef}
        style={{ position: 'absolute', top: 10, left: 10, pointerEvents: 'none', zIndex: 1 }}
      />
      {/* Audio controls overlay - top-right */}
      <div
        style={{
          position: 'absolute', top: 10, right: 10, zIndex: 2,
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(10, 15, 26, 0.7)', borderRadius: 8,
          padding: '6px 10px', backdropFilter: 'blur(4px)',
          color: 'white', fontSize: 11,
        }}
      >
        <button
          type="button"
          onClick={() => setAudioEnabled(v => !v)}
          aria-label={audioEnabled ? 'Mute simulation audio' : 'Unmute simulation audio'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            border: 0, background: 'transparent', color: 'white',
            cursor: 'pointer', padding: 2, fontSize: 11,
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>{audioEnabled ? '🔊' : '🔇'}</span>
          {audioEnabled ? 'Sound on' : 'Sound off'}
        </button>
        {audioEnabled && (
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={audioVolume}
            onChange={e => setAudioVolume(Number(e.target.value))}
            aria-label="Audio volume"
            style={{ width: 70 }}
          />
        )}
      </div>
    </div>
  );
}
