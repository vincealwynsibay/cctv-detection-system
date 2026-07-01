/**
 * Plain-English definitions for traffic-engineering jargon used across the UI.
 *
 * The Manual page consumes the same dictionary so a `<JargonTip term="...">`
 * tip and its "Learn more" link stay in lock-step. Keep entries short
 * (one or two sentences) - the tooltip is a hint, not the spec.
 *
 * `manualAnchor` is the kebab-case slug rendered as `/manual#<slug>` on the
 * Manual page. If the Manual hasn't been updated to host the anchor yet, the
 * link still works - it lands on the page top.
 */
export interface JargonEntry {
  term: string;
  short: string;
  /** Optional enumerated values rendered as a vertical list under `short`. */
  options?: Array<{ label: string; desc: string }>;
  /** Tabs `value` on the Manual page (e.g. "warrants"). Used to deep-link. */
  manualTab?: string;
  manualAnchor: string;
}

export const JARGON: Record<string, JargonEntry> = {
  mutcd: {
    term: 'MUTCD warrant',
    short:
      'A U.S. traffic-engineering rule (Manual on Uniform Traffic Control Devices) that says when an intersection is required by law to have a signal, based on volume thresholds.',
    manualAnchor: 'mutcd-warrant',
  },
  w1: {
    term: 'Warrant 1',
    short:
      'Peak-hour volume met - the busiest hour of the day exceeds the MUTCD threshold for an 8-hour cumulative volume study.',
    manualAnchor: 'warrant-1',
  },
  w2: {
    term: 'Warrant 2',
    short:
      'Four-hour volume met - at least four hours in the day exceed the MUTCD threshold.',
    manualAnchor: 'warrant-2',
  },
  w4: {
    term: 'Warrant 4',
    short:
      'Pedestrian volume met - pedestrian crossings exceed the MUTCD pedestrian-volume threshold.',
    manualAnchor: 'warrant-4',
  },
  websters: {
    term: 'Webster’s timing',
    short:
      'The standard math that picks the best cycle length and green-time split for a signalized intersection to minimize average vehicle delay.',
    manualAnchor: 'websters',
  },
  vc_ratio: {
    term: 'v/c ratio',
    short:
      'Volume divided by capacity. 1.0 means the road is full at the signal; above 0.9 means re-timing alone will not help - you need more lanes.',
    manualAnchor: 'vc-ratio',
  },
  critical_vc: {
    term: 'critical v/c',
    short:
      'The v/c ratio of the worst approach at the intersection - the bottleneck that limits the whole signal.',
    manualAnchor: 'critical-vc',
  },
  los: {
    term: 'LOS',
    short:
      'Level of Service. Letter grade from A (no delay) to F (gridlock) summarizing how an intersection performs. Most cities target C or better at peak hour.',
    manualAnchor: 'los',
  },
  vh_saved: {
    term: 'vehicle-hours saved',
    short:
      'Total hours of waiting avoided per day across all vehicles. 1 vehicle-hour ≈ 60 cars saving 1 minute each.',
    manualAnchor: 'vehicle-hours-saved',
  },
  pcu: {
    term: 'PCU/hr',
    short:
      'Passenger Car Units per hour. Trucks count as ~2 cars, motorcycles as ~0.4. Different from raw vehicle counts.',
    manualAnchor: 'pcu',
  },
  phf: {
    term: 'PHF',
    short:
      'Peak Hour Factor - how spiky the peak hour is. 1.0 = perfectly flat traffic, 0.5 = very bursty (rush-hour-of-the-rush-hour).',
    manualAnchor: 'phf',
  },
  tod_chunk: {
    term: 'TOD chunk',
    short:
      'Time-Of-Day period (Overnight, AM Rush, Midday, PM Rush, Evening). Each chunk gets its own optimal signal timing.',
    manualAnchor: 'tod-chunk',
  },
  gap_acceptance: {
    term: 'gap acceptance',
    short:
      'The delay model used at unsignalized intersections. Minor-street drivers must wait for a gap in major-street traffic to cross or turn.',
    manualAnchor: 'gap-acceptance',
  },
  saturation_flow: {
    term: 'saturation flow',
    short:
      'The maximum vehicles a single lane can discharge during a fully-used green phase. Used as the capacity unit in Webster’s math.',
    manualAnchor: 'saturation-flow',
  },
  vph: {
    term: 'vehicles per hour',
    short:
      'Raw vehicle counts per hour - does not weight trucks or motorcycles like PCU does.',
    manualAnchor: 'vph',
  },
  cycle_length: {
    term: 'cycle length',
    short:
      'Total seconds it takes for a signal to cycle through every phase once. Typical urban range is 60–120 seconds.',
    manualAnchor: 'cycle-length',
  },
  green_split: {
    term: 'green split',
    short:
      'How the cycle’s green time is divided between competing approaches. Sum of all green splits + yellows + all-reds = cycle length.',
    manualAnchor: 'green-split',
  },
  approach: {
    term: 'approach',
    short:
      'One of the legs entering the intersection (Northbound, Southbound, etc.). Each approach gets its own green phase and counts.',
    manualAnchor: 'approach',
  },
  rtsp: {
    term: 'RTSP URL',
    short:
      'Real-Time Streaming Protocol address - the camera’s live video feed (e.g. rtsp://192.168.1.31:554/stream1). Most IP cameras expose one.',
    manualAnchor: 'rtsp',
  },
  onvif: {
    term: 'ONVIF',
    short:
      'Industry standard for IP cameras. Lets EyeGila auto-discover compatible cameras on the local network without manual config.',
    manualAnchor: 'onvif',
  },
  nvr: {
    term: 'NVR / DVR',
    short:
      'Network/Digital Video Recorder - a box that aggregates multiple cameras under one IP. EyeGila can query an NVR to import all of its channels at once.',
    manualAnchor: 'nvr',
  },
  aggregation_window: {
    term: 'aggregation window',
    short:
      'A fixed time block (minute, hour, day, week) over which raw detections are summed. Hour-buckets drive the warrant check.',
    manualAnchor: 'aggregation-window',
  },
  pce: {
    term: 'PCE',
    short:
      'Passenger Car Equivalent - how many cars one vehicle of a given type is worth (truck ≈ 2.0, motorcycle ≈ 0.4). Used to convert counts into PCU/hr.',
    manualAnchor: 'pce',
  },
  recommendation: {
    term: 'recommendation',
    short:
      'EyeGila’s suggested next step for an intersection, picked from MUTCD warrant results and Webster’s timing math. One of:',
    options: [
      { label: 'Signalize', desc: 'install a new traffic signal' },
      { label: 'Adjust timing', desc: 're-time the existing signal' },
      { label: 'Widen approach', desc: 'add lanes - capital project' },
      { label: 'No action', desc: 'current setup is fine' },
    ],
    manualTab: 'warrants',
    manualAnchor: 'recommendation',
  },
  critical_approach: {
    term: 'critical approach',
    short:
      'The leg with the highest v/c ratio - the bottleneck the whole signal’s cycle length is sized for.',
    manualAnchor: 'critical-approach',
  },
  all_red: {
    term: 'all-red clearance',
    short:
      'Brief interval when every direction is red. Lets vehicles still in the box clear before cross-traffic gets green. Typically 1–3 seconds.',
    manualAnchor: 'all-red',
  },
  lost_time: {
    term: 'lost time',
    short:
      'Seconds per phase that don’t move vehicles (startup + clearance + all-red). Subtracted from the cycle when computing effective green.',
    manualAnchor: 'lost-time',
  },
  signal_status: {
    term: 'signal status',
    short:
      'Whether the intersection is unsignalized (stop-controlled), fixed-time (static cycle), or actuated (sensor-driven). Drives which delay model applies.',
    manualAnchor: 'signal-status',
  },
  region: {
    term: 'detection region',
    short:
      'A polygon drawn over the camera’s live frame. Only vehicles inside the polygon are counted - keeps cross-street traffic from leaking in.',
    manualAnchor: 'region',
  },
  monte_carlo: {
    term: 'Confidence (Monte Carlo)',
    short:
      'We replayed the recommended hour 100 times with realistic random arrivals. The badge summarizes how reliable the savings number is.',
    options: [
      { label: 'High',     desc: 'savings are consistent across replays; safe to act on' },
      { label: 'Moderate', desc: 'savings are real but variable; monitor after deployment' },
      { label: 'Marginal', desc: 'savings can\'t be told apart from random noise; don\'t re-time yet' },
    ],
    manualAnchor: 'monte-carlo-confidence',
  },
};

export type JargonKey = keyof typeof JARGON;
