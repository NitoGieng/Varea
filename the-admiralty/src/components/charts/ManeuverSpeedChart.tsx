import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot
} from 'recharts';

interface Props {
  maneuver: any;
  highResTrack: any[];
  height?: number;
  // Callback invocato con i secondi relativi al cambio mura mentre l'utente
  // muove il mouse sul grafico. null quando il cursore esce dall'area.
  onHoverChange?: (relativeSeconds: number | null) => void;
}

// Finestra fissa attorno al timestamp del cambio mura: -20s / +40s (60s totali).
// Copre V.IN (mediana -10…-4s), V.MIN (entro +25s) e V.OUT (+12s da V.MIN).
const PRE_WINDOW_S = 20;
const POST_WINDOW_S = 40;

// Offset V.OUT rispetto a V.MIN, fissato dal motore manovre.
const V_OUT_OFFSET_S = 12;

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

    // Trovo il punto di V.MIN dentro la finestra: minimo assoluto (coerente col motore).
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
      <div className="bg-navy-900 text-white p-3 rounded shadow-lg text-xs font-mono">
        <p className="font-bold mb-1 text-gold">{label}</p>
        <p className="text-sm font-bold">SOG: {d.sog.toFixed(1)} kts</p>
        <p className="text-gray-400">COG: {d.cog.toFixed(0)}°</p>
      </div>
    );
  };

  if (!chartData.length) {
    return (
      <div className="w-full flex items-center justify-center text-gray-400 text-xs italic" style={{ height }}>
        Nessun dato ad alta risoluzione in questa finestra.
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 20, right: 30, left: 0, bottom: 0 }}
          onMouseMove={(state: any) => {
            if (!onHoverChange) return;
            const label = state?.activeLabel;
            if (label != null && !isNaN(Number(label))) {
              onHoverChange(Number(label));
            }
          }}
          onMouseLeave={() => onHoverChange?.(null)}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
          <XAxis
            dataKey="relativeTime"
            tickFormatter={formatXAxis}
            minTickGap={25}
            tick={{ fill: '#9ca3af', fontSize: 11, fontWeight: 'bold' }}
            axisLine={false}
            tickLine={false}
            type="number"
            domain={[-PRE_WINDOW_S, POST_WINDOW_S]}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v} kts`}
            width={60}
          />
          <Tooltip content={<CustomTooltip />} />

          {/* Cambio mura (t=0) */}
          <ReferenceLine
            x={0}
            stroke="#d4af37"
            strokeWidth={2}
            strokeDasharray="4 4"
            label={{ position: 'top', value: 'MANOVRA', fill: '#d4af37', fontSize: 11, fontWeight: 'bold' }}
          />

          {/* Soglia TTR 50% */}
          {ttrTarget !== null && (
            <ReferenceLine
              y={ttrTarget}
              stroke="#9ca3af"
              strokeWidth={1}
              strokeDasharray="3 3"
              label={{ position: 'right', value: `Target ${ttrTarget.toFixed(1)}`, fill: '#6b7280', fontSize: 10 }}
            />
          )}

          {/* V.IN: mediana della finestra -10…-4s */}
          {vInValue !== null && (
            <ReferenceDot
              x={-7}
              y={vInValue}
              r={5}
              fill="#10b981"
              stroke="#fff"
              strokeWidth={2}
              label={{ value: 'V.IN', position: 'top', fill: '#10b981', fontSize: 10, fontWeight: 'bold' }}
            />
          )}

          {/* V.MIN: minimo nella finestra */}
          {vMinTime !== null && vMinValue !== null && (
            <ReferenceDot
              x={vMinTime}
              y={vMinValue}
              r={6}
              fill="#ef4444"
              stroke="#fff"
              strokeWidth={2}
              label={{ value: 'V.MIN', position: 'bottom', fill: '#ef4444', fontSize: 10, fontWeight: 'bold' }}
            />
          )}

          {/* V.OUT: +12s da V.MIN */}
          {vMinTime !== null && vOutValue !== null && (
            <ReferenceDot
              x={vMinTime + V_OUT_OFFSET_S}
              y={vOutValue}
              r={5}
              fill="#3b82f6"
              stroke="#fff"
              strokeWidth={2}
              label={{ value: 'V.OUT', position: 'top', fill: '#3b82f6', fontSize: 10, fontWeight: 'bold' }}
            />
          )}

          <Line
            type="monotone"
            dataKey="sog"
            stroke="#061325"
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 5, fill: '#d4af37', stroke: '#fff', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
