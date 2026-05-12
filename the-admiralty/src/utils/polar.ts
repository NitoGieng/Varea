import type { HighResPoint } from '../types/telemetry';

// Motore di calcolo per la polar chart del Laboratorio. Lavora sul TWA
// gia' precalcolato dal backend (api.py emette `twa` per ogni punto in
// high_res_track come abs(angular_diff(cog, twd_dynamic)), range 0-180°),
// quindi nessuna logica di derivazione vento qui: ci limitiamo a filtrare,
// bucketizzare e calcolare percentili. Se il backend cambia la
// definizione di TWA, questo file resta corretto: ne consuma il valore.

export interface PolarValidPoint {
  twa: number;
  sog: number;
  andatura: string;
}

export interface PolarBucket {
  startDeg: number;
  endDeg: number;
  centerDeg: number;
  // null quando il bucket ha meno di MIN_BUCKET_COUNT punti: il chart
  // disegna un gap nella curva invece di un valore fittizio.
  sogP90: number | null;
  sogAvg: number | null;
  sogMax: number;
  count: number;
}

export interface PolarOptimum {
  twaDeg: number;
  vmgKnots: number;
  sogKnots: number;
}

export type PolarZoneId = 'bolinaStretta' | 'bolina' | 'traverso' | 'lasco' | 'poppa';

export interface PolarZoneStats {
  // ID stabile della zona: i consumer lo usano come chiave i18n
  // (polar.zoneBolinaStretta ecc.). Disaccoppia logica da etichette UI.
  zoneId: PolarZoneId;
  rangeDeg: [number, number];
  sogMax: number;
  sogP90: number | null;
  count: number;
  fraction: number;
}

export const POLAR_BUCKET_WIDTH_DEG = 5;
export const POLAR_NUM_BUCKETS = 36; // 0..180° in 5° steps
export const POLAR_SOG_MIN_KNOTS = 2;
export const POLAR_MIN_BUCKET_COUNT = 3;
export const POLAR_MIN_VALID_POINTS = 50;

// Percentile lineare: array piccoli (3-200 campioni per bucket) per cui
// le differenze con metodi tipo Hyndman-Fan sono trascurabili.
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// Filtra il track sul subset utilizzabile per la polar:
// - sog > 2 kts (sotto soglia: drifting / fermo / errore GPS, falsa la curva)
// - twa finito e in [0, 180]
// Gli `andatura` non riconosciuti restano (verranno colorati col fallback).
export function extractValidPolarPoints(track: HighResPoint[]): PolarValidPoint[] {
  const out: PolarValidPoint[] = [];
  for (const p of track) {
    const sog = Number(p.sog_knots);
    const twa = Number(p.twa);
    if (!Number.isFinite(sog) || !Number.isFinite(twa)) continue;
    if (sog <= POLAR_SOG_MIN_KNOTS) continue;
    if (twa < 0 || twa > 180) continue;
    out.push({ twa, sog, andatura: String(p.andatura ?? '') });
  }
  return out;
}

// Bucket angolari di 5°. L'ultimo bucket include 180° per non perdere il
// punto di poppa esatta (il backend emette twa = abs(diff), 180 e' un
// valore raggiungibile).
export function buildBuckets(points: PolarValidPoint[]): PolarBucket[] {
  const acc: { sogs: number[]; count: number }[] = Array.from(
    { length: POLAR_NUM_BUCKETS },
    () => ({ sogs: [], count: 0 }),
  );

  for (const p of points) {
    let idx = Math.floor(p.twa / POLAR_BUCKET_WIDTH_DEG);
    if (idx >= POLAR_NUM_BUCKETS) idx = POLAR_NUM_BUCKETS - 1;
    if (idx < 0) idx = 0;
    acc[idx].sogs.push(p.sog);
    acc[idx].count++;
  }

  return acc.map((b, i) => {
    const center = i * POLAR_BUCKET_WIDTH_DEG + POLAR_BUCKET_WIDTH_DEG / 2;
    const enough = b.count >= POLAR_MIN_BUCKET_COUNT;
    return {
      startDeg: i * POLAR_BUCKET_WIDTH_DEG,
      endDeg: (i + 1) * POLAR_BUCKET_WIDTH_DEG,
      centerDeg: center,
      sogP90: enough ? percentile(b.sogs, 0.9) : null,
      sogAvg: enough ? b.sogs.reduce((s, v) => s + v, 0) / b.sogs.length : null,
      sogMax: b.sogs.length === 0 ? 0 : Math.max(...b.sogs),
      count: b.count,
    };
  });
}

// Smoothing 3-finestra centrato del p90. Bucket invalidi (null) restano
// null nell'output e non contribuiscono ai vicini: il gap visivo
// nella curva sopravvive al filtro.
export function smoothP90(buckets: PolarBucket[]): (number | null)[] {
  return buckets.map((b, i) => {
    if (b.sogP90 == null) return null;
    const samples: number[] = [b.sogP90];
    const left = i > 0 ? buckets[i - 1].sogP90 : null;
    const right = i < buckets.length - 1 ? buckets[i + 1].sogP90 : null;
    if (left != null) samples.push(left);
    if (right != null) samples.push(right);
    return samples.reduce((s, v) => s + v, 0) / samples.length;
  });
}

// Angolo bolina ottimale: TWA che massimizza VMG = sog * cos(twa) nella
// fascia 30°-80°. Usa il P90 smoothato cosi' l'ottimo riflette la
// performance sostenibile, non un picco isolato.
export function findUpwindOptimum(
  buckets: PolarBucket[],
  smoothedP90: (number | null)[],
): PolarOptimum | null {
  let best: PolarOptimum | null = null;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.centerDeg < 30 || b.centerDeg > 80) continue;
    const sog = smoothedP90[i];
    if (sog == null) continue;
    const vmg = sog * Math.cos((b.centerDeg * Math.PI) / 180);
    if (best == null || vmg > best.vmgKnots) {
      best = { twaDeg: b.centerDeg, vmgKnots: vmg, sogKnots: sog };
    }
  }
  return best;
}

// Angolo lasco ottimale: TWA che massimizza VMG sottovento = sog * cos(180-twa)
// nella fascia 100°-160°. Equivalente a "minimizzare sog*cos(twa)" ma
// teniamo la formulazione esplicita richiesta dalla spec.
export function findDownwindOptimum(
  buckets: PolarBucket[],
  smoothedP90: (number | null)[],
): PolarOptimum | null {
  let best: PolarOptimum | null = null;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.centerDeg < 100 || b.centerDeg > 160) continue;
    const sog = smoothedP90[i];
    if (sog == null) continue;
    const vmg = sog * Math.cos(((180 - b.centerDeg) * Math.PI) / 180);
    if (best == null || vmg > best.vmgKnots) {
      best = { twaDeg: b.centerDeg, vmgKnots: vmg, sogKnots: sog };
    }
  }
  return best;
}

const ZONES: { zoneId: PolarZoneId; range: [number, number] }[] = [
  { zoneId: 'bolinaStretta', range: [0, 45] },
  { zoneId: 'bolina', range: [45, 80] },
  { zoneId: 'traverso', range: [80, 100] },
  { zoneId: 'lasco', range: [100, 150] },
  // Estremo destro 180.001 cosi' twa=180 esatto (poppa pura) cade nella
  // zona Poppa invece di essere scartato dal half-open intervallo.
  { zoneId: 'poppa', range: [150, 180.001] },
];

export function buildZoneStats(points: PolarValidPoint[]): PolarZoneStats[] {
  const total = points.length;
  return ZONES.map(({ zoneId, range }) => {
    const sogs: number[] = [];
    for (const p of points) {
      if (p.twa >= range[0] && p.twa < range[1]) sogs.push(p.sog);
    }
    return {
      zoneId,
      rangeDeg: [range[0], Math.min(range[1], 180)],
      sogMax: sogs.length === 0 ? 0 : Math.max(...sogs),
      sogP90: sogs.length >= POLAR_MIN_BUCKET_COUNT ? percentile(sogs, 0.9) : null,
      count: sogs.length,
      fraction: total > 0 ? sogs.length / total : 0,
    };
  });
}

export function maxSogOnCurve(
  buckets: PolarBucket[],
  smoothedP90: (number | null)[],
): number {
  let m = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].sogMax > m) m = buckets[i].sogMax;
    const s = smoothedP90[i];
    if (s != null && s > m) m = s;
  }
  return m;
}
