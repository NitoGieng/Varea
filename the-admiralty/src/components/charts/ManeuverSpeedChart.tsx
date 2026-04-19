import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot
} from 'recharts';

interface Props {
  maneuver: any;
  highResTrack: any[];
  height?: number;
  // Secondi relativi al cambio mura mentre il mouse muove sul grafico.
  // null quando il cursore esce dall'area.
  onHoverChange?: (relativeSeconds: number | null) => void;
}

// Finestra fissa attorno al cambio mura: -20s / +40s (60s totali).
// Copre V.IN (mediana -10…-4s), V.MIN (entro +25s) e V.OUT (+12s da V.MIN).
const PRE_WINDOW_S = 20;
const POST_WINDOW_S = 40;
const V_OUT_OFFSET_S = 12;

// Palette coerente con i token semantici del design system (hex hardcoded
// perche' Recharts non legge le CSS vars). Default = tema dark.
const COLOR_LINE = '#c9a169';   // gold
const COLOR_GRID = 'rgba(201, 161, 105, 0.08)'; // gold/8 — gridlines quasi invisibili
const COLOR_AXIS_DIM = '#5e6b80'; // ink-muted dark
const COLOR_TICK = '#a8b3c4';
const COLOR_MARKER = '#c9a169'; // active dot
const COLOR_VIN = '#7fa885';    // sage
const COLOR_VMIN = '#c97462';   // terra
const COLOR_VOUT = '#e8cea0';   // brass
const COLOR_TOOLTIP_BG = '#0a1628'; // surface-1 dark
const COLOR_TOOLTIP_BORDER = 'rgba(201, 161, 105, 0.3)';

const parseTs = (ts: string) => {
  if (!ts) return NaN;
  const s = ts.replace(' ', 'T');
  return new Date(s.endsWith('Z') ? s : s + 'Z').getTime();
};

const formatXAxis = (v: number) => {
  if (v === 0) return 'MANOVRA';
  return v > 0 ? `+${v}s` : `${v}s`;
};

export default function ManeuverSpeedChart({ maneuver, highResTrack, height = 280, onHoverChange }: Props) {
  const { chartData, vMinTime, vInValue, vMinValue, vOutValue, ttrTarget } = useMemo(() => {
    const empty = { chartData: [] as any[], vMinTime: null as number | null, vInValue: null as number | null, vMinValue: null as number | null, vOutValue: null as number | null, ttrTarget: null as number | null };
    if (!maneuver || !highResTrack || highResTrack.length === 0) return empty;

    const t0 = parseTs(maneuver.timestamp);
    if (isNaN(t0)) return empty;

    const startEpoch = t0 - PRE_WINDOW_S * 1000;
    const endEpoch = t0 + POST_WINDOW_S * 1000;

    const filtered = highResTrack
      .map((p: any) => {
        const epoch = parseTs(p.timestamp);
        if (isNaN(epoch) || epoch < startEpoch || epoch > endEpoch) return null;
        return {
          relativeTime: Math.round((epoch - t0) / 1000),
          sog: Number(p.sog_knots) || 0,
          cog: Number(p.cog_deg) || 0,
          epoch
        };
      })
      .filter((p): p is { relativeTime: number; sog: number; cog: number; epoch: number } => p !== null);

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
      ttrTarget: typeof maneuver.ttr_target_sog === 'number' ? maneuver.ttr_target_sog : null
    };
  }, [maneuver, highResTrack]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload;
    const label = d.relativeTime === 0
      ? 'CAMBIO MURA'
      : d.relativeTime < 0 ? `${Math.abs(d.relativeTime)}s prima` : `+${d.relativeTime}s`;
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
        <p className="text-body-lg leading-tight">SOG <span className="font-bold">{d.sog.toFixed(1)}</span> kts</p>
        <p className="text-caption" style={{ color: COLOR_AXIS_DIM }}>COG {d.cog.toFixed(0)}°</p>
      </div>
    );
  };

  if (!chartData.length) {
    return (
      <div className="w-full flex items-center justify-center text-ink-muted text-caption italic" style={{ height }}>
        Nessun dato ad alta risoluzione in questa finestra.
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 24, right: 30, left: 0, bottom: 0 }}
          onMouseMove={(state: any) => {
            if (!onHoverChange) return;
            const label = state?.activeLabel;
            if (label != null && !isNaN(Number(label))) {
              onHoverChange(Number(label));
            }
          }}
          onMouseLeave={() => onHoverChange?.(null)}
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
            domain={['auto', 'auto']}
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
            activeDot={{ r: 4, fill: COLOR_MARKER, stroke: COLOR_TOOLTIP_BG, strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
