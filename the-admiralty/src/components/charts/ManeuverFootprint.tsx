import React, { useState, useMemo } from 'react';
import ManeuverSpeedChart from './ManeuverSpeedChart';
import FlyThresholdControl from '../FlyThresholdControl';
import type { Maneuver, TrackPoint, HighResPoint } from '../../types/telemetry';
import { parseBackendTimestamp } from '../../utils/time';
import { getFoilingStatus } from '../../utils/foiling';

// Una "lab session": tutto cio' che serve al footprint per un atleta.
// trackData (0.2Hz) per il disegno geometrico, highResTrack (1Hz) per il
// grafico SOG istante-per-istante.
export interface LabSession {
  id: string;
  label: string;
  color: string;
  maneuvers: Maneuver[];
  trackData: TrackPoint[];
  highResTrack: HighResPoint[];
}

interface ManeuverFootprintProps {
  sessions: LabSession[];
  // Soglia FLY/TOUCH unica con il Registro Manovre (sollevata in Dashboard).
  // Sostituisce le vecchie soglie type-dependent locali (8.5 virata / 12
  // strambata): stessa decisione in entrambe le viste.
  flyThreshold: number;
  onFlyThresholdChange: (v: number) => void;
}

// Fallback stabile per highResTrack: `?? []` inline romperebbe ref equality
// e farebbe partire memo a cascata.
const EMPTY_HIGH_RES: HighResPoint[] = [];

// Colori esadecimali coerenti col token sage/amber per gli elementi SVG
// che non possono leggere le CSS vars (stroke/fill di Plotly-style).
const FLY_COLOR = '#7fa885';   // sage
const TOUCH_COLOR = '#d4a24c'; // amber
const BOAT_GOLD = '#c9a169';   // gold dark

export default function ManeuverFootprint({ sessions, flyThreshold, onFlyThresholdChange }: ManeuverFootprintProps) {
  const [mode, setMode] = useState<'FLY' | 'TOUCH'>('FLY');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);

  const isMulti = sessions.length > 1;

  const activeSession = useMemo(() => {
    if (sessions.length === 0) return null;
    const found = sessions.find(s => s.id === selectedAthleteId);
    return found ?? sessions[0];
  }, [sessions, selectedAthleteId]);

  const highResTrack = activeSession?.highResTrack ?? EMPTY_HIGH_RES;

  const sortedManeuvers = useMemo(() => {
    const ms = activeSession?.maneuvers;
    if (!ms || ms.length === 0) return [];
    return [...ms]
      .filter(m => {
        const status = getFoilingStatus(Number(m.sog_min) || 0, flyThreshold);
        return status.label === mode;
      })
      .sort((a, b) => mode === 'FLY' ? Number(b.sog_min) - Number(a.sog_min) : Number(a.sog_min) - Number(b.sog_min));
  }, [activeSession, mode, flyThreshold]);

  React.useEffect(() => { setSelectedIndex(0); }, [mode, activeSession?.id]);
  React.useEffect(() => { setHoveredTime(null); }, [selectedIndex, mode, activeSession?.id]);

  const activeManeuver = sortedManeuvers[selectedIndex];
  const activeStatus = activeManeuver ? getFoilingStatus(Number(activeManeuver.sog_min) || 0, flyThreshold) : null;

  const formatTime = (ts: string) => {
    if (!ts) return 'N/D';
    try {
      // Backend emette UTC con offset esplicito (`+00:00`); parseBackendTimestamp
      // gestisce anche le forme storiche `Z` o tz-naive. toLocaleTimeString
      // converte nel fuso del browser (=fuso di regata).
      const ms = parseBackendTimestamp(ts);
      if (isNaN(ms)) return ts;
      return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  };

  // --- MOTORE GEOMETRICO (invariato — restyle solo grafico) ---
  const renderData = useMemo(() => {
    const trackData = activeSession?.trackData;
    if (!activeManeuver || !trackData || trackData.length === 0) return null;

    let centerIdx = -1;

    if (activeManeuver.timestamp && trackData[0]?.timestamp) {
      const targetT = parseBackendTimestamp(activeManeuver.timestamp);
      let minDiff = Infinity;
      trackData.forEach((p, i) => {
        const pt = parseBackendTimestamp(p.timestamp);
        if (!isNaN(pt)) {
          const diff = Math.abs(pt - targetT);
          if (diff < minDiff) { minDiff = diff; centerIdx = i; }
        }
      });
    }

    if (centerIdx === -1) {
      let minDiff = Infinity;
      trackData.forEach((p, i) => {
        const diff = Math.abs((Number(p.sog_knots) || 0) - (Number(activeManeuver.sog_min) || 0));
        if (diff < minDiff) { minDiff = diff; centerIdx = i; }
      });
    }

    const start = Math.max(0, centerIdx - 15);
    const end = Math.min(trackData.length - 1, centerIdx + 25);

    const validSegment = trackData.slice(start, end).filter(p =>
      p != null && p.lat != null && p.lon != null && !isNaN(Number(p.lat)) && !isNaN(Number(p.lon))
    );

    if (validSegment.length < 2) return null;

    const R = 6371000;
    const refLat = Number(validSegment[0].lat);
    const refLon = Number(validSegment[0].lon);
    const entryCog = Number(validSegment[0].cog_deg) || 0;
    const centerIdxInSegment = Math.floor(validSegment.length / 2);

    const points = validSegment.map((p, i) => {
      const lat = Number(p.lat);
      const lon = Number(p.lon);

      const x_m = (lon - refLon) * (Math.PI / 180) * R * Math.cos(refLat * Math.PI / 180);
      const y_m = (lat - refLat) * (Math.PI / 180) * R;

      const theta = -(entryCog * Math.PI) / 180;
      const x_rot = x_m * Math.cos(theta) - y_m * Math.sin(theta);
      const y_rot = -(x_m * Math.sin(theta) + y_m * Math.cos(theta));

      const sog = Number(p.sog_knots) || 0;

      return {
        x: x_rot, y: y_rot, sog,
        isCenter: i === centerIdxInSegment,
        lat, lon, time: p.timestamp
      };
    }).filter(p => !isNaN(p.x) && !isNaN(p.y));

    if (points.length < 2) return null;

    // Bounding box calcolata in una passata sui soli punti validi: niente
    // mutazione di variabili catturate nella callback di .map (regola
    // react-hooks/immutability).
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = xs.length > 0 ? Math.min(...xs) : -50;
    const maxX = xs.length > 0 ? Math.max(...xs) : 50;
    const minY = ys.length > 0 ? Math.min(...ys) : -50;
    const maxY = ys.length > 0 ? Math.max(...ys) : 50;

    const turnPointIndex = points.findIndex(p => p.isCenter);
    const safeTurnIndex = turnPointIndex !== -1 ? turnPointIndex : Math.floor(points.length / 2);
    const turnPoint = points[safeTurnIndex];

    let visualHeading = 0;
    if (safeTurnIndex > 0 && safeTurnIndex < points.length - 1) {
      const prevP = points[safeTurnIndex - 1];
      const nextP = points[safeTurnIndex + 1];
      const dx = nextP.x - prevP.x;
      const dy = nextP.y - prevP.y;
      visualHeading = (Math.atan2(dy, dx) * (180 / Math.PI)) + 90;
    }

    const width = maxX - minX;
    const height = maxY - minY;
    const maxDim = Math.max(width, height, 80);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const padding = maxDim * 0.4;

    if (isNaN(cx) || isNaN(cy) || isNaN(maxDim)) return null;

    const viewBox = `${cx - maxDim / 2 - padding} ${cy - maxDim / 2 - padding} ${maxDim + padding * 2} ${maxDim + padding * 2}`;
    const baseStroke = (maxDim + padding * 2) / 120;

    const traceColor = activeStatus?.label === 'FLY' ? FLY_COLOR : TOUCH_COLOR;

    return {
      points,
      viewBox,
      turnPoint: { ...turnPoint, visualHeading },
      color: traceColor,
      baseStroke
    };
  }, [activeManeuver, activeSession, activeStatus]);

  const boatMarker = useMemo(() => {
    if (hoveredTime == null || !renderData || !activeManeuver?.timestamp) return null;
    const t0 = parseBackendTimestamp(activeManeuver.timestamp);
    if (isNaN(t0)) return null;
    const target = t0 + hoveredTime * 1000;
    const pts = renderData.points;
    const toEpoch = (t: string) => parseBackendTimestamp(t);
    for (let i = 0; i < pts.length - 1; i++) {
      const ta = toEpoch(pts[i].time);
      const tb = toEpoch(pts[i + 1].time);
      if (isNaN(ta) || isNaN(tb)) continue;
      if (target >= ta && target <= tb) {
        const frac = tb === ta ? 0 : (target - ta) / (tb - ta);
        const x = pts[i].x + (pts[i + 1].x - pts[i].x) * frac;
        const y = pts[i].y + (pts[i + 1].y - pts[i].y) * frac;
        const sog = pts[i].sog + (pts[i + 1].sog - pts[i].sog) * frac;
        const dx = pts[i + 1].x - pts[i].x;
        const dy = pts[i + 1].y - pts[i].y;
        const heading = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        return { x, y, sog, heading };
      }
    }
    return null;
  }, [hoveredTime, renderData, activeManeuver]);

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-1 eyebrow">
        Nessuna sessione visibile
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface-1">
      {/* Selettore atleta — visibile solo in multi */}
      {isMulti && (
        <div className="px-4 py-2 border-b border-border bg-surface-1 flex items-center gap-3 overflow-x-auto">
          <span className="eyebrow shrink-0">Atleta</span>
          <div className="flex gap-2">
            {sessions.map(s => {
              const isActive = activeSession?.id === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedAthleteId(s.id)}
                  className={`px-3 py-1.5 text-eyebrow uppercase tracking-eyebrow rounded-md border transition-colors duration-220 ease-varea flex items-center gap-2 shrink-0 ${
                    isActive
                      ? 'bg-surface-2 text-ink border-gold'
                      : 'bg-bg text-ink-2 border-border hover:border-ink-muted'
                  }`}
                >
                  <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                  {s.label}
                  <span className="font-mono tabular text-ink-muted opacity-70">
                    {s.maneuvers.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Header controlli FLY/TOUCH + soglia condivisa */}
      <div className="px-4 py-3 border-b border-border bg-surface-1 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex bg-bg border border-border rounded-md p-0.5">
          <button
            onClick={() => setMode('FLY')}
            className={`px-4 py-1.5 text-eyebrow uppercase tracking-eyebrow rounded-sm transition-colors duration-220 flex items-center gap-2 ${
              mode === 'FLY' ? 'bg-sage/15 text-sage' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-sage" />
            Manovre Fly
          </button>
          <button
            onClick={() => setMode('TOUCH')}
            className={`px-4 py-1.5 text-eyebrow uppercase tracking-eyebrow rounded-sm transition-colors duration-220 flex items-center gap-2 ${
              mode === 'TOUCH' ? 'bg-amber/15 text-amber' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber" />
            Manovre Touch
          </button>
        </div>
        <div className="flex items-center gap-4">
          <FlyThresholdControl
            value={flyThreshold}
            onChange={onFlyThresholdChange}
            label="Soglia FLY/TOUCH"
          />
          <span className="eyebrow">
            {sortedManeuvers.length} in categoria
          </span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-[500px]">
        {/* Lista laterale */}
        <div className="w-80 border-r border-border overflow-y-auto bg-surface-1 divide-y divide-border z-20">
          {sortedManeuvers.length === 0 ? (
            <div className="p-6 text-center eyebrow mt-10">Nessuna manovra</div>
          ) : (
            sortedManeuvers.map((m, i) => {
              const status = getFoilingStatus(Number(m.sog_min) || 0, flyThreshold);
              const isSelected = selectedIndex === i;
              return (
                <button
                  key={i}
                  onClick={() => setSelectedIndex(i)}
                  className={`w-full p-5 text-left transition-colors duration-220 relative ${
                    isSelected ? 'bg-surface-2' : 'hover:bg-surface-2/60'
                  }`}
                >
                  {isSelected && (
                    <div
                      className="absolute left-0 top-0 w-0.5 h-full"
                      style={{ backgroundColor: renderData?.color }}
                    />
                  )}

                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2">
                      <div className="text-eyebrow uppercase tracking-eyebrow text-ink">{m.type}</div>
                      <span className={`text-[9px] font-medium uppercase tracking-eyebrow px-2 py-0.5 rounded-sm border ${status.color} ${status.bg} ${status.border}`}>
                        {status.label}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="bg-bg border border-border rounded-md p-2 text-center">
                      <div className="eyebrow mb-0.5">Vel min</div>
                      <div className={`text-lg font-mono tabular ${status.color}`}>
                        {(Number(m.sog_min) || 0).toFixed(1)}
                        <span className="text-caption text-ink-muted ml-1">kts</span>
                      </div>
                    </div>
                    <div className="bg-bg border border-border rounded-md p-2 text-center">
                      <div className="eyebrow mb-0.5">Δ V</div>
                      <div className={`text-lg font-mono tabular ${(Number(m.delta_v) || 0) >= 0 ? 'text-sage' : 'text-amber'}`}>
                        {(Number(m.delta_v) || 0) >= 0 ? '+' : ''}{(Number(m.delta_v) || 0).toFixed(1)}
                        <span className="text-caption text-ink-muted ml-1">kts</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-caption text-ink-muted font-mono tabular flex items-center justify-between">
                    <span>{formatTime(m.timestamp)}</span>
                    {m.leg_distance_nm !== undefined && (
                      <span className="text-gold bg-gold/10 px-1.5 py-0.5 rounded-sm border border-gold/20">
                        Lato {m.leg_distance_nm.toFixed(2)} NM
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Colonna destra: vasca XY + grafico SOG */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* La vasca scura — sempre dark, e' il "mare" indipendente dal tema */}
          <div className="flex-1 relative bg-[#050d1a] overflow-hidden flex items-center justify-center">
            <div
              className="absolute inset-0 opacity-[0.06]"
              style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '40px 40px' }}
            />

            {renderData ? (
              <svg
                className="w-full h-full p-8"
                viewBox={renderData.viewBox}
                preserveAspectRatio="xMidYMid meet"
              >
                <line
                  x1="0" y1={renderData.viewBox.split(' ')[1]}
                  x2="0" y2="10000"
                  stroke="#ffffff" strokeWidth={renderData.baseStroke * 0.3} strokeDasharray="4,4" opacity="0.12"
                />

                {renderData.points.map((p, i) => {
                  if (i === 0) return null;
                  const prev = renderData.points[i - 1];
                  const dynamicStroke = renderData.baseStroke * Math.max(0.5, p.sog / 4);
                  const cometOpacity = 0.2 + (i / renderData.points.length) * 0.8;
                  return (
                    <line
                      key={i}
                      x1={prev.x} y1={prev.y}
                      x2={p.x} y2={p.y}
                      stroke={renderData.color}
                      strokeWidth={dynamicStroke}
                      strokeLinecap="round"
                      opacity={cometOpacity}
                    />
                  );
                })}

                <g transform={`translate(${renderData.points[0].x}, ${renderData.points[0].y})`}>
                  <circle cx="0" cy="0" r={renderData.baseStroke * 1.5} fill="none" stroke="white" strokeWidth={renderData.baseStroke * 0.3} opacity="0.5" />
                  <text x={renderData.baseStroke * 3} y="0" fill="white" fontSize={renderData.baseStroke * 4} opacity="0.5" dominantBaseline="middle" className="tracking-widest uppercase">Inizio</text>
                </g>

                <g transform={`translate(${renderData.points[renderData.points.length - 1].x}, ${renderData.points[renderData.points.length - 1].y})`}>
                  <rect x={-renderData.baseStroke} y={-renderData.baseStroke} width={renderData.baseStroke * 2} height={renderData.baseStroke * 2} fill="white" opacity="0.8" />
                  <text x={renderData.baseStroke * 3} y="0" fill="white" fontSize={renderData.baseStroke * 4} opacity="0.8" dominantBaseline="middle" className="tracking-widest uppercase">Fine</text>
                </g>

                <g transform={`translate(${renderData.turnPoint.x}, ${renderData.turnPoint.y}) rotate(${renderData.turnPoint.visualHeading})`}>
                  <polygon
                    points={`-${renderData.baseStroke * 1.5},${renderData.baseStroke * 2} 0,-${renderData.baseStroke * 3} ${renderData.baseStroke * 1.5},${renderData.baseStroke * 2} 0,${renderData.baseStroke}`}
                    fill="white"
                  />
                  <circle cx="0" cy="0" r={renderData.baseStroke * 5} fill="none" stroke={renderData.color} strokeWidth={renderData.baseStroke * 0.6} opacity="0.8" />
                </g>

                {/* Icona barca sincronizzata col chart SOG */}
                {boatMarker && (
                  <g transform={`translate(${boatMarker.x}, ${boatMarker.y}) rotate(${boatMarker.heading})`} style={{ pointerEvents: 'none' }}>
                    <circle cx="0" cy="0" r={renderData.baseStroke * 4} fill={BOAT_GOLD} opacity="0.18" />
                    <circle cx="0" cy="0" r={renderData.baseStroke * 2.6} fill="none" stroke={BOAT_GOLD} strokeWidth={renderData.baseStroke * 0.4} opacity="0.9" />
                    <polygon
                      points={`-${renderData.baseStroke * 1.3},${renderData.baseStroke * 1.8} 0,-${renderData.baseStroke * 2.8} ${renderData.baseStroke * 1.3},${renderData.baseStroke * 1.8} 0,${renderData.baseStroke * 0.8}`}
                      fill={BOAT_GOLD}
                      stroke="white"
                      strokeWidth={renderData.baseStroke * 0.35}
                    />
                  </g>
                )}
              </svg>
            ) : (
              <div className="text-white/60 eyebrow z-10 bg-black/40 px-6 py-4 rounded-md border border-white/10">
                Traiettoria incompleta per questo segmento.
              </div>
            )}

            {/* Badge atleta */}
            {isMulti && activeSession && (
              <div className="absolute top-6 right-6 pointer-events-none">
                <div className="bg-[#040d1a]/85 backdrop-blur border border-white/10 px-3 py-2 rounded-md flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: activeSession.color }} />
                  <span className="text-eyebrow uppercase tracking-eyebrow text-white">{activeSession.label}</span>
                </div>
              </div>
            )}

            {/* HUD ingresso/centro/uscita */}
            {activeManeuver && activeStatus && (
              <div className="absolute top-6 left-6 flex gap-3 pointer-events-none">
                <div className="bg-[#040d1a]/85 backdrop-blur border border-white/10 px-4 py-3 rounded-md text-white min-w-[110px]">
                  <div className="text-[9px] text-white/50 uppercase tracking-eyebrow mb-1">Vel ingresso</div>
                  <div className="text-2xl font-mono tabular">
                    {(Number(activeManeuver.sog_in) || 0).toFixed(1)}
                    <span className="text-caption text-white/60 ml-1">kts</span>
                  </div>
                </div>

                <div className={`bg-[#040d1a]/85 backdrop-blur border px-4 py-3 rounded-md min-w-[130px] ${activeStatus.border}`}>
                  <div className={`text-[9px] uppercase tracking-eyebrow mb-1 ${activeStatus.color}`}>
                    Manovra {activeStatus.label}
                  </div>
                  <div className={`text-3xl font-mono tabular leading-none ${activeStatus.color}`}>
                    {(Number(activeManeuver.sog_min) || 0).toFixed(1)}
                    <span className="text-caption text-white/60 ml-1">kts</span>
                  </div>
                </div>

                <div className="bg-[#040d1a]/85 backdrop-blur border border-white/10 px-4 py-3 rounded-md text-white min-w-[110px]">
                  <div className="text-[9px] text-white/50 uppercase tracking-eyebrow mb-1">Vel uscita</div>
                  <div className="text-2xl font-mono tabular">
                    {(Number(activeManeuver.sog_out) || 0).toFixed(1)}
                    <span className="text-caption text-white/60 ml-1">kts</span>
                  </div>
                </div>
              </div>
            )}

            {/* HUD orario + lato + coordinate */}
            {renderData && activeManeuver && (
              <div className="absolute bottom-6 right-6 pointer-events-none">
                <div className="bg-[#040d1a]/85 backdrop-blur border border-white/10 p-5 rounded-md text-white text-right min-w-[200px]">
                  <div className="flex flex-col items-end gap-4">

                    <div>
                      <div className="text-[9px] text-white/50 uppercase tracking-eyebrow mb-1">Orario manovra</div>
                      <div className="text-lg font-mono tabular text-white">
                        {formatTime(activeManeuver.timestamp || renderData.turnPoint.time)}
                      </div>
                    </div>

                    {activeManeuver.leg_distance_nm !== undefined && (
                      <>
                        <div className="w-full border-t border-white/10" />
                        <div>
                          <div className="text-[9px] text-white/50 uppercase tracking-eyebrow mb-1">Lato precedente</div>
                          <div className="text-lg font-mono tabular text-gold">
                            {activeManeuver.leg_distance_nm.toFixed(2)}
                            <span className="text-caption text-white/60 ml-1">NM</span>
                          </div>
                        </div>
                      </>
                    )}

                    <div className="w-full border-t border-white/10" />
                    <div>
                      <div className="text-[9px] text-white/50 uppercase tracking-eyebrow mb-1">Coordinate</div>
                      <div className="text-caption font-mono tabular text-white/60">
                        {renderData.turnPoint.lat.toFixed(5)}° N, {renderData.turnPoint.lon.toFixed(5)}° E
                      </div>
                    </div>

                  </div>
                </div>
              </div>
            )}

          </div>

          {/* Grafico SOG istantaneo */}
          <div className="border-t border-border bg-surface-1 px-6 py-3 shrink-0">
            <div className="flex items-baseline justify-between mb-1">
              <h4 className="eyebrow">Velocità istante-per-istante</h4>
              <span className="text-caption text-ink-muted font-mono tabular">−20s / +40s</span>
            </div>
            <ManeuverSpeedChart
              maneuver={activeManeuver}
              highResTrack={highResTrack}
              height={200}
              onHoverChange={setHoveredTime}
            />
          </div>

        </div>
      </div>
    </div>
  );
}
