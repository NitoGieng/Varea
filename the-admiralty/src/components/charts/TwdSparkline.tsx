import { useMemo } from 'react';
import type { TwdTimelinePoint } from '../../types/telemetry';

interface Props {
  timeline: TwdTimelinePoint[];
  // Finestra temporale visibile (epoch-ms). Se presente disegna una
  // banda evidenziata sopra la sparkline cosi' l'allenatore vede a
  // quale porzione del giorno si riferisce il filtro Dashboard.
  highlightStartMs?: number;
  highlightEndMs?: number;
  width?: number;
  height?: number;
}

// Sparkline TWD orario per la panoramica. La linea unwrappa i salti a
// 360°/0° (350°→10° = +20°, non -340°) cosi' la curva visualizzata e'
// la rotazione reale del vento, non un sawtooth grafico. La banda gold
// chiara evidenzia la finestra di Dashboard quando l'utente filtra.
//
// Dimensione fissa di default (200×56): pensata per stare sotto il
// numero TWD della header senza disturbare il bilanciamento editoriale.

const GOLD = '#c9a169';
const GOLD_FAINT = 'rgba(201, 161, 105, 0.18)';
const INK_MUTED = '#5e6b80';
const TAU = 2 * Math.PI;
const DEG2RAD = Math.PI / 180;

export default function TwdSparkline({
  timeline,
  highlightStartMs,
  highlightEndMs,
  width = 200,
  height = 56,
}: Props) {
  const data = useMemo(() => {
    if (!timeline || timeline.length < 2) return null;

    const pts: { ms: number; deg: number; rad: number }[] = [];
    for (const p of timeline) {
      const ms = Date.parse(p.timestamp);
      if (Number.isNaN(ms) || !Number.isFinite(p.twd_deg)) continue;
      pts.push({ ms, deg: p.twd_deg, rad: p.twd_deg * DEG2RAD });
    }
    if (pts.length < 2) return null;

    pts.sort((a, b) => a.ms - b.ms);

    // Unwrap radianti per disegno fluido; per i tick numerici usiamo
    // i gradi originari (l'utente legge 350°, non 710°).
    const unwrapped = [pts[0].rad];
    for (let i = 1; i < pts.length; i++) {
      const prev = unwrapped[i - 1];
      let diff = pts[i].rad - prev;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      unwrapped.push(prev + diff);
    }

    const minMs = pts[0].ms;
    const maxMs = pts[pts.length - 1].ms;
    const minR = Math.min(...unwrapped);
    const maxR = Math.max(...unwrapped);
    // Padding verticale: 5% del range, altrimenti 0.05 rad fisso per
    // evitare denominatore zero quando il vento e' pressoche' costante.
    const span = Math.max(maxR - minR, 0.05);
    const padR = span * 0.15;

    return {
      pts: pts.map((p, i) => ({ ms: p.ms, deg: p.deg, rad: unwrapped[i] })),
      minMs,
      maxMs,
      minR: minR - padR,
      maxR: maxR + padR,
    };
  }, [timeline]);

  if (!data) return null;

  const { pts, minMs, maxMs, minR, maxR } = data;
  const padX = 4;
  const padY = 8;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const xOf = (ms: number) => padX + ((ms - minMs) / (maxMs - minMs)) * innerW;
  const yOf = (rad: number) => padY + ((maxR - rad) / (maxR - minR)) * innerH;

  const linePath = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.ms).toFixed(2)},${yOf(p.rad).toFixed(2)}`)
    .join(' ');

  const last = pts[pts.length - 1];
  const first = pts[0];

  // Banda finestra visibile: clipped ai bordi della sparkline.
  let highlightX1: number | null = null;
  let highlightX2: number | null = null;
  if (
    typeof highlightStartMs === 'number'
    && typeof highlightEndMs === 'number'
    && highlightEndMs > highlightStartMs
  ) {
    const a = Math.max(highlightStartMs, minMs);
    const b = Math.min(highlightEndMs, maxMs);
    if (b > a) {
      highlightX1 = xOf(a);
      highlightX2 = xOf(b);
    }
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Andamento orario direzione vento"
      className="overflow-visible"
    >
      {highlightX1 != null && highlightX2 != null && (
        <rect
          x={highlightX1}
          y={padY}
          width={Math.max(highlightX2 - highlightX1, 1)}
          height={innerH}
          fill={GOLD_FAINT}
        />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={GOLD}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={xOf(first.ms)} cy={yOf(first.rad)} r={2} fill={GOLD} opacity={0.6} />
      <circle cx={xOf(last.ms)} cy={yOf(last.rad)} r={2.5} fill={GOLD} />
      <text
        x={padX}
        y={height - 1}
        fill={INK_MUTED}
        fontSize={9}
        fontFamily="ui-monospace, monospace"
        textAnchor="start"
      >
        {Math.round(first.deg)}°
      </text>
      <text
        x={width - padX}
        y={height - 1}
        fill={GOLD}
        fontSize={9}
        fontFamily="ui-monospace, monospace"
        textAnchor="end"
      >
        {Math.round(last.deg)}°
      </text>
    </svg>
  );
}
