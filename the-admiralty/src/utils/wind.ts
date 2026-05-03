import type { TwdTimelinePoint } from '../types/telemetry';

// Interpolazione TWD (true wind direction) lato client. Specchio della
// logica di main._build_dynamic_twd: unwrap circolare in radianti per
// evitare la discontinuita' a 360°/0° (es. da 350° a 10° su due ore
// successive non e' una rotazione di -340° ma di +20°), interpolazione
// lineare su epoch-seconds, re-wrap modulo 360.
//
// Tenere allineata con main._build_dynamic_twd: se cambia la logica
// backend, i tag di andatura del backend e la freccia del vento del Lab
// divergeranno per sessioni multi-orarie con rotazione del vento.

interface PreparedTimeline {
  times: number[];
  unwrappedRad: number[];
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TAU = 2 * Math.PI;

function prepareTimeline(timeline: TwdTimelinePoint[]): PreparedTimeline | null {
  if (timeline.length === 0) return null;

  const times: number[] = [];
  const radValues: number[] = [];
  for (const p of timeline) {
    const ms = Date.parse(p.timestamp);
    if (Number.isNaN(ms)) continue;
    if (!Number.isFinite(p.twd_deg)) continue;
    times.push(ms / 1000);
    radValues.push(p.twd_deg * DEG2RAD);
  }
  if (times.length === 0) return null;

  // Unwrap circolare: rimuove i salti > pi tra campioni consecutivi.
  // Replica numpy.unwrap. Senza questo, l'interpolazione lineare fra
  // 350° e 10° passerebbe dai valori centrali (~180°) invece di girare
  // di 20° attraverso lo zero.
  const unwrappedRad: number[] = [radValues[0]];
  for (let i = 1; i < radValues.length; i++) {
    const prev = unwrappedRad[i - 1];
    const curr = radValues[i];
    let diff = curr - prev;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    unwrappedRad.push(prev + diff);
  }

  return { times, unwrappedRad };
}

// TWD all'istante target in gradi [0, 360). Restituisce null se la
// timeline e' vuota o non interpretabile.
export function interpolateTwd(
  timeline: TwdTimelinePoint[] | null | undefined,
  targetMs: number,
): number | null {
  if (!timeline || timeline.length === 0) return null;

  const prepared = prepareTimeline(timeline);
  if (!prepared) return null;

  const { times, unwrappedRad } = prepared;
  const targetSec = targetMs / 1000;

  // Caso degenere: 1 solo campione → vento costante.
  if (times.length === 1) {
    return ((unwrappedRad[0] * RAD2DEG) % 360 + 360) % 360;
  }

  // Estrapolazione: clamp ai bordi (np.interp default behaviour).
  if (targetSec <= times[0]) {
    return ((unwrappedRad[0] * RAD2DEG) % 360 + 360) % 360;
  }
  if (targetSec >= times[times.length - 1]) {
    const last = unwrappedRad[unwrappedRad.length - 1];
    return ((last * RAD2DEG) % 360 + 360) % 360;
  }

  // Bisezione per trovare l'intervallo [times[i], times[i+1]].
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= targetSec) lo = mid;
    else hi = mid;
  }

  const t0 = times[lo];
  const t1 = times[hi];
  const r0 = unwrappedRad[lo];
  const r1 = unwrappedRad[hi];
  const f = (targetSec - t0) / (t1 - t0);
  const interpRad = r0 + (r1 - r0) * f;
  return ((interpRad * RAD2DEG) % 360 + 360) % 360;
}

// Sample uniformi della timeline interpolata, utili per disegnare lo
// sparkline TWD vs tempo. start/end in epoch-ms, count = numero punti.
export interface TwdSample {
  ms: number;
  twd_deg: number;
}

export function sampleTwdSeries(
  timeline: TwdTimelinePoint[] | null | undefined,
  startMs: number,
  endMs: number,
  count: number,
): TwdSample[] {
  if (!timeline || timeline.length < 2 || count < 2 || endMs <= startMs) return [];

  const prepared = prepareTimeline(timeline);
  if (!prepared || prepared.times.length < 2) return [];

  const out: TwdSample[] = [];
  for (let i = 0; i < count; i++) {
    const ms = startMs + ((endMs - startMs) * i) / (count - 1);
    const twd = interpolateTwd(timeline, ms);
    if (twd !== null) out.push({ ms, twd_deg: twd });
  }
  return out;
}
