import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot
} from 'recharts';
import type { Maneuver, HighResPoint } from '../../types/telemetry';
import { parseBackendTimestamp } from '../../utils/time';
import type { CoachNote } from '../../utils/notes';

interface Props {
  maneuver: Maneuver | undefined | null;
  highResTrack: HighResPoint[];
  height?: number;
  // Secondi relativi al cambio mura mentre il mouse muove sul grafico.
  // null quando il cursore esce dall'area.
  onHoverChange?: (relativeSeconds: number | null) => void;
  // Note allenatore della sessione corrente. Renderizziamo solo quelle che
  // cadono nella finestra -20s/+40s della manovra (le altre vivono nei
  // grafici di Panoramica / mappa). Le coordinate del marker e del popup
  // sono tradotte in secondi relativi al cambio mura.
  notes?: CoachNote[];
  numberOf?: (id: string) => number;
  // Inizio sessione (epoch-ms): serve per tradurre note.timestampSec in
  // secondi relativi al cambio mura della manovra corrente. Senza questo
  // valore le note non vengono renderizzate (niente fallback silenziosi:
  // un grafico senza ancora temporale e' un'incoerenza che vogliamo
  // notare in dev, non un comportamento "best-effort").
  sessionStartMs?: number;
  highlightedNoteId?: string | null;
  // Click su un'area libera del grafico: il chiamante apre il popup di
  // nuova nota. timestampSec assoluto (secondi dall'inizio sessione)
  // pre-calcolato qui dal relativeTime + maneuverMs.
  onChartClick?: (timestampSec: number, pixelX: number, pixelY: number) => void;
  onNoteClick?: (note: CoachNote, pixelX: number, pixelY: number) => void;
  // Fonte vento usata dal backend per calcolare TWA -> VMG (vedi commento
  // gemello in SessionSpeedChart). La micro-pill nella legenda fa da
  // disclaimer cosi' il coach sa quanto pesare il valore.
  isWindEstimated?: boolean;
}

// Finestra fissa attorno al cambio mura: -20s / +40s (60s totali).
// Copre V.IN (mediana -10…-4s), V.MIN (entro +25s) e V.OUT (+12s da V.MIN).
const PRE_WINDOW_S = 20;
const POST_WINDOW_S = 40;
const V_OUT_OFFSET_S = 12;

// Palette coerente con i token semantici del design system (hex hardcoded
// perche' Recharts non legge le CSS vars). Default = tema dark.
const COLOR_LINE = '#c9a169';   // gold
const COLOR_VMG = '#5fb6c4';    // teal — distinto dai marker V.IN/V.MIN/V.OUT
const COLOR_GRID = 'rgba(201, 161, 105, 0.15)'; // gold/15 — subtle ma visibili in dark
const COLOR_AXIS_DIM = '#5e6b80'; // ink-muted dark
const COLOR_TICK = '#a8b3c4';
const COLOR_MARKER = '#c9a169'; // active dot
const COLOR_VIN = '#7fa885';    // sage
const COLOR_VMIN = '#c97462';   // terra
const COLOR_VOUT = '#e8cea0';   // brass
const COLOR_TOOLTIP_BG = '#0a1628'; // surface-1 dark
const COLOR_TOOLTIP_BORDER = 'rgba(201, 161, 105, 0.3)';

const formatXAxis = (v: number) => {
  if (v === 0) return 'MANOVRA';
  return v > 0 ? `+${v}s` : `${v}s`;
};

// Tipi Recharts non sono stabili: tooltip e onMouseMove ricevono shape any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = any;

// Tooltip a livello modulo: Recharts inietta active/payload via cloneElement,
// ridichiararlo a ogni render azzererebbe lo stato interno (regola
// react-hooks/static-components).
function CustomTooltip({ active, payload }: AnyProps) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  const label = d.relativeTime === 0
    ? 'CAMBIO MURA'
    : d.relativeTime < 0 ? `${Math.abs(d.relativeTime)}s prima` : `+${d.relativeTime}s`;
  const vmgValid = typeof d.vmg === 'number' && Number.isFinite(d.vmg);
  return (
    <div
      className="px-3 py-2 rounded-md font-mono tabular text-caption"
      style={{
        backgroundColor: COLOR_TOOLTIP_BG,
        border: `1px solid ${COLOR_TOOLTIP_BORDER}`,
        color: '#f5f1e6',
        boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
      }}
    >
      <p className="text-eyebrow uppercase tracking-eyebrow mb-1" style={{ color: COLOR_LINE }}>{label}</p>
      <p className="text-body-lg leading-tight">
        <span style={{ color: COLOR_LINE }}>SOG</span>{' '}
        <span className="font-bold">{d.sog.toFixed(1)}</span> kts
      </p>
      <p className="text-body leading-tight" style={{ color: COLOR_VMG }}>
        VMG <span className="font-bold">{vmgValid ? d.vmg.toFixed(1) : 'n/d'}</span>
        {vmgValid ? ' kts' : ''}
      </p>
      <p className="text-caption" style={{ color: COLOR_AXIS_DIM }}>COG {d.cog.toFixed(0)}°</p>
    </div>
  );
}

// Soglia "vicino a marker": click entro 2s da una nota esistente non apre
// il popup di nuova nota (lascia che sia il marker a gestire il click).
const NEAR_MARKER_TOLERANCE_SEC = 2;

export default function ManeuverSpeedChart({
  maneuver,
  highResTrack,
  height = 280,
  onHoverChange,
  notes,
  numberOf,
  sessionStartMs,
  highlightedNoteId,
  onChartClick,
  onNoteClick,
  isWindEstimated,
}: Props) {
  const { chartData, vMinTime, vInValue, vMinValue, vOutValue, ttrTarget } = useMemo(() => {
    const empty = {
      chartData: [] as Array<{ relativeTime: number; sog: number; cog: number; epoch: number; vmg: number | null }>,
      vMinTime: null as number | null,
      vInValue: null as number | null,
      vMinValue: null as number | null,
      vOutValue: null as number | null,
      ttrTarget: null as number | null,
    };
    if (!maneuver || !highResTrack || highResTrack.length === 0) return empty;

    const t0 = parseBackendTimestamp(maneuver.timestamp);
    if (isNaN(t0)) return empty;

    const startEpoch = t0 - PRE_WINDOW_S * 1000;
    const endEpoch = t0 + POST_WINDOW_S * 1000;

    const filtered: Array<{ relativeTime: number; sog: number; cog: number; epoch: number; vmg: number | null }> = [];
    for (const p of highResTrack) {
      const epoch = parseBackendTimestamp(p.timestamp);
      if (isNaN(epoch) || epoch < startEpoch || epoch > endEpoch) continue;
      // VMG signed dal backend: positivo = guadagno verso vento. Per la
      // sola visualizzazione grafica clampiamo a 0 (Math.max(0, ...)) cosi'
      // la curva resta leggibile senza scendere a -15/-30 nei +40s di una
      // virata che apre l'angolo. I valori raw nel report e nelle card
      // restano signed: questa e' una scelta puramente di asse Y, coerente
      // col chart Panoramica. connectNulls del Recharts gestisce le
      // interruzioni quando la TWA mancava.
      const vmgRaw = (p as { vmg_knots?: number | null }).vmg_knots;
      const vmg = typeof vmgRaw === 'number' && Number.isFinite(vmgRaw) ? Math.max(0, vmgRaw) : null;
      filtered.push({
        relativeTime: Math.round((epoch - t0) / 1000),
        sog: Number(p.sog_knots) || 0,
        cog: Number(p.cog_deg) || 0,
        epoch,
        vmg,
      });
    }

    if (filtered.length === 0) return empty;

    let minPoint = filtered[0];
    for (const p of filtered) {
      if (p.sog < minPoint.sog) minPoint = p;
    }

    return {
      chartData: filtered,
      vMinTime: minPoint.relativeTime,
      vInValue: typeof maneuver.sog_in === 'number' ? maneuver.sog_in : null,
      vMinValue: typeof maneuver.sog_min === 'number' ? maneuver.sog_min : null,
      vOutValue: typeof maneuver.sog_out === 'number' ? maneuver.sog_out : null,
      ttrTarget: typeof maneuver.ttr_target_sog === 'number' ? maneuver.ttr_target_sog : null,
    };
  }, [maneuver, highResTrack]);

  // Note nella finestra: traslate da timestampSec assoluto a relativeTime
  // (secondi dal cambio mura). Calcolato solo se abbiamo sessionStartMs e
  // un timestamp di manovra valido — altrimenti nessuna nota viene
  // renderizzata (silenziosamente coerente con "no ancora temporale").
  const notesInWindow = useMemo(() => {
    if (!notes || notes.length === 0 || !maneuver || sessionStartMs == null) return [];
    const maneuverMs = parseBackendTimestamp(maneuver.timestamp);
    if (!Number.isFinite(maneuverMs)) return [];
    const offsetSec = (maneuverMs - sessionStartMs) / 1000;
    const out: Array<{ id: string; relTime: number; color?: string }> = [];
    for (const n of notes) {
      const rel = n.timestampSec - offsetSec;
      if (rel >= -PRE_WINDOW_S && rel <= POST_WINDOW_S) {
        out.push({ id: n.id, relTime: rel, color: n.color });
      }
    }
    return out;
  }, [notes, maneuver, sessionStartMs]);

  // Mappa id -> nota originale per il callback onNoteClick.
  const notesById = useMemo(() => {
    const m = new Map<string, CoachNote>();
    if (notes) for (const n of notes) m.set(n.id, n);
    return m;
  }, [notes]);

  if (!chartData.length) {
    return (
      <div className="w-full flex items-center justify-center text-ink-muted text-caption italic" style={{ height }}>
        Nessun dato ad alta risoluzione in questa finestra.
      </div>
    );
  }

  const handleChartClick = (state: AnyProps) => {
    if (!onChartClick || !maneuver || sessionStartMs == null) return;
    const label = state?.activeLabel;
    if (label == null || isNaN(Number(label))) return;
    const rel = Number(label);
    // Lascia gestire al marker quando il click cade vicino a una nota.
    if (notesInWindow.some(n => Math.abs(n.relTime - rel) <= NEAR_MARKER_TOLERANCE_SEC)) return;
    const maneuverMs = parseBackendTimestamp(maneuver.timestamp);
    if (!Number.isFinite(maneuverMs)) return;
    const timestampSec = Math.round((maneuverMs - sessionStartMs) / 1000 + rel);
    const coord = state?.activeCoordinate;
    const px = typeof coord?.x === 'number' ? coord.x : 0;
    const py = typeof coord?.y === 'number' ? coord.y : 0;
    onChartClick(timestampSec, px, py);
  };

  return (
    <div style={{ width: '100%', height }} className={`relative ${onChartClick ? 'cursor-crosshair' : ''}`}>
      {/* Legenda overlay top-right: minimale, font-mono coerente con i tick.
          Aiuta il coach a distinguere a colpo d'occhio le due curve quando
          la VMG si avvicina alla SOG (bolina) o diverge (lasco). */}
      <div className="absolute top-1 right-3 z-10 flex items-center gap-3 text-eyebrow uppercase tracking-eyebrow pointer-events-none select-none">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5" style={{ backgroundColor: COLOR_LINE }} />
          <span style={{ color: COLOR_LINE }}>SOG</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5" style={{ backgroundColor: COLOR_VMG }} />
          <span style={{ color: COLOR_VMG }}>VMG</span>
        </span>
        {/* Fonte vento: pill discreta accanto alla legenda. Coerente con
            SessionSpeedChart per non confondere il coach quando passa dal
            grafico Panoramica a quello del Laboratorio. */}
        {typeof isWindEstimated === 'boolean' && (
          <span
            className="flex items-center gap-1"
            title={isWindEstimated
              ? 'VMG calcolata su vento stimato dal GPS (Stormglass non disponibile)'
              : 'VMG calcolata su vento osservato da Stormglass'}
            style={{ color: isWindEstimated ? '#d4a345' : '#8a9a5b' }}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: isWindEstimated ? '#d4a345' : '#8a9a5b' }} />
            <span>{isWindEstimated ? 'Stimato GPS' : 'Stormglass'}</span>
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 24, right: 30, left: 0, bottom: 0 }}
          onMouseMove={(state: AnyProps) => {
            if (!onHoverChange) return;
            const label = state?.activeLabel;
            if (label != null && !isNaN(Number(label))) {
              onHoverChange(Number(label));
            }
          }}
          onMouseLeave={() => onHoverChange?.(null)}
          onClick={handleChartClick}
        >
          {/* Style 8D — gridlines quasi invisibili */}
          <CartesianGrid strokeDasharray="2 4" vertical={false} stroke={COLOR_GRID} />
          <XAxis
            dataKey="relativeTime"
            tickFormatter={formatXAxis}
            minTickGap={25}
            tick={{ fill: COLOR_TICK, fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            axisLine={false}
            tickLine={false}
            type="number"
            domain={[-PRE_WINDOW_S, POST_WINDOW_S]}
          />
          <YAxis
            // Baseline pinnata a 0: con la VMG clampata a >=0 in dataPrep
            // l'asse non deve mai scendere sotto zero, altrimenti riapparirebbe
            // un grosso vuoto sotto la baseline.
            domain={[0, 'auto']}
            tick={{ fill: COLOR_TICK, fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v}`}
            width={40}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: COLOR_LINE, strokeOpacity: 0.3, strokeWidth: 1 }} />

          {/* Cambio mura (t=0) — gold dashed */}
          <ReferenceLine
            x={0}
            stroke={COLOR_LINE}
            strokeWidth={1}
            strokeDasharray="3 4"
            label={{
              position: 'top',
              value: 'MANOVRA',
              fill: COLOR_LINE,
              fontSize: 10,
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />

          {/* Soglia TTR 50% */}
          {ttrTarget !== null && (
            <ReferenceLine
              y={ttrTarget}
              stroke={COLOR_AXIS_DIM}
              strokeWidth={1}
              strokeDasharray="2 4"
              label={{
                position: 'right',
                value: `Target ${ttrTarget.toFixed(1)}`,
                fill: COLOR_AXIS_DIM,
                fontSize: 9,
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
          )}

          {/* V.IN: mediana -10…-4s */}
          {vInValue !== null && (
            <ReferenceDot
              x={-7}
              y={vInValue}
              r={4}
              fill={COLOR_VIN}
              stroke={COLOR_TOOLTIP_BG}
              strokeWidth={2}
              label={{ value: 'V.IN', position: 'top', fill: COLOR_VIN, fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
            />
          )}

          {/* V.MIN: minimo nella finestra */}
          {vMinTime !== null && vMinValue !== null && (
            <ReferenceDot
              x={vMinTime}
              y={vMinValue}
              r={5}
              fill={COLOR_VMIN}
              stroke={COLOR_TOOLTIP_BG}
              strokeWidth={2}
              label={{ value: 'V.MIN', position: 'bottom', fill: COLOR_VMIN, fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
            />
          )}

          {/* V.OUT: +12s da V.MIN */}
          {vMinTime !== null && vOutValue !== null && (
            <ReferenceDot
              x={vMinTime + V_OUT_OFFSET_S}
              y={vOutValue}
              r={4}
              fill={COLOR_VOUT}
              stroke={COLOR_TOOLTIP_BG}
              strokeWidth={2}
              label={{ value: 'V.OUT', position: 'top', fill: COLOR_VOUT, fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
            />
          )}

          {/* Linea SOG: stile 8D — sottile, gold, no fill */}
          <Line
            type="monotone"
            dataKey="sog"
            stroke={COLOR_LINE}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            activeDot={{ r: 4, fill: COLOR_MARKER, stroke: COLOR_TOOLTIP_BG, strokeWidth: 2 }}
          />

          {/* VMG sovrapposta: piu' sottile della SOG per gerarchia visiva.
              connectNulls=false cosi' i gap (TWA mancante) interrompono la
              curva invece di interpolare. La VMG puo' diventare negativa
              dopo il cambio mura mentre la barca apre l'angolo: e' un
              segnale didattico utile per il coach, non un errore. */}
          <Line
            type="monotone"
            dataKey="vmg"
            stroke={COLOR_VMG}
            strokeWidth={1.1}
            strokeOpacity={0.9}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
            activeDot={{ r: 3, fill: COLOR_VMG, stroke: COLOR_TOOLTIP_BG, strokeWidth: 2 }}
          />

          {/* Note allenatore nella finestra: linea tratteggiata + cerchio
              numerato cliccabile in cima al grafico. */}
          {notesInWindow.map(n => (
            <ReferenceLine
              key={`note-line-${n.id}`}
              x={n.relTime}
              stroke={n.color ?? COLOR_LINE}
              strokeWidth={1}
              strokeDasharray="3 4"
              ifOverflow="extendDomain"
            />
          ))}
          {notesInWindow.map(n => {
            const isHi = highlightedNoteId === n.id;
            const num = numberOf ? numberOf(n.id) : 0;
            const radius = isHi ? 11 : 9;
            return (
              <ReferenceDot
                key={`note-dot-${n.id}`}
                x={n.relTime}
                y={chartData[0]?.sog ?? 0}
                r={radius}
                ifOverflow="extendDomain"
                shape={(props: AnyProps) => {
                  const cx = Number(props.cx);
                  if (!Number.isFinite(cx)) return <g />;
                  const yTop = 18;
                  const fill = n.color ?? COLOR_LINE;
                  const original = notesById.get(n.id);
                  return (
                    <g
                      transform={`translate(${cx}, ${yTop})`}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onNoteClick && original) onNoteClick(original, cx, yTop);
                      }}
                    >
                      <circle
                        r={radius}
                        fill={fill}
                        stroke={COLOR_TOOLTIP_BG}
                        strokeWidth={2}
                        opacity={isHi ? 1 : 0.95}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#0a1428"
                        fontSize={10}
                        fontFamily="JetBrains Mono, ui-monospace, monospace"
                        fontWeight="bold"
                        pointerEvents="none"
                      >
                        {num}
                      </text>
                    </g>
                  );
                }}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
