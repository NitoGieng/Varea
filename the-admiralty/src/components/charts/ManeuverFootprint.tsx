import React, { useState, useMemo } from 'react';
import ManeuverSpeedChart from './ManeuverSpeedChart';
import FlyThresholdControl from '../FlyThresholdControl';
import type { Maneuver, TrackPoint, HighResPoint, TwdTimelinePoint } from '../../types/telemetry';
import { parseBackendTimestamp } from '../../utils/time';
import { getFoilingStatus } from '../../utils/foiling';
import { interpolateTwd } from '../../utils/wind';

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
  // TWD media della sessione in gradi geografici (0=N). Fallback per
  // disegnare gli indicatori del vento quando la timeline oraria non e'
  // disponibile (Stormglass off, vento stimato dal GPS).
  twd?: number;
  // Timeline TWD oraria (Stormglass). Se presente la freccia del vento
  // viene interpolata all'istante della manovra invece di usare la
  // media globale: utile su sessioni multi-orarie con rotazione del
  // vento (la mattinata 5 nodi da NE diventa pomeriggio 12 nodi da E).
  twdTimeline?: TwdTimelinePoint[] | null;
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
  // Selezione per chiave (timestamp) anziche' indice: cambiare filtro
  // FLY/TOUCH o soglia ricostruisce sortedManeuvers e quindi gli indici
  // saltano. La chiave persiste finche' la manovra resta nella lista
  // filtrata, evitando di "saltare" su una manovra diversa solo perche'
  // l'ordine e' cambiato.
  const [selectedManeuverKey, setSelectedManeuverKey] = useState<string | null>(null);
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

  // Auto-selezione: la chiave persiste fra cambi di filtro/soglia/atleta.
  // Quando la manovra selezionata sparisce dalla lista corrente (es. la
  // soglia la sposta da FLY a TOUCH, o cambio sessione) cade sulla prima
  // della nuova lista, cosi' il pannello di dettaglio non resta vuoto.
  React.useEffect(() => {
    if (sortedManeuvers.length === 0) {
      if (selectedManeuverKey !== null) setSelectedManeuverKey(null);
      return;
    }
    const stillPresent = selectedManeuverKey != null
      && sortedManeuvers.some(m => m.timestamp === selectedManeuverKey);
    if (!stillPresent) {
      setSelectedManeuverKey(sortedManeuvers[0].timestamp ?? null);
    }
  }, [sortedManeuvers, selectedManeuverKey]);

  // Indice derivato dalla chiave. Default 0 quando la chiave non si trova
  // (caso transitorio: l'effetto sopra riallinea al prossimo render); cosi'
  // la vista non sfarfalla mostrando un placeholder vuoto.
  const selectedIndex = useMemo(() => {
    if (selectedManeuverKey == null) return 0;
    const idx = sortedManeuvers.findIndex(m => m.timestamp === selectedManeuverKey);
    return idx >= 0 ? idx : 0;
  }, [sortedManeuvers, selectedManeuverKey]);

  React.useEffect(() => { setHoveredTime(null); }, [selectedManeuverKey, mode, activeSession?.id]);

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

    // Vento nel sistema di riferimento del footprint:
    // - Y_svg+ (verso il basso sullo schermo) = direzione di marcia all'ingresso.
    // - TWD geografica = direzione DA cui viene il vento (0=N, 90=E).
    // - Direzione del flusso = TWD + 180.
    // - In SVG, rotate(N) e' orario rispetto a Y_svg+. Quindi:
    //   angolo della freccia = (TWD + 180 - entryCog) % 360.
    //
    // Quando disponibile la timeline oraria interpoliamo all'istante
    // della manovra (coerente col tag andatura del backend); altrimenti
    // fallback alla TWD media della sessione.
    const maneuverMs = activeManeuver.timestamp ? parseBackendTimestamp(activeManeuver.timestamp) : NaN;
    const twdInterp = (!isNaN(maneuverMs) && activeSession?.twdTimeline)
      ? interpolateTwd(activeSession.twdTimeline, maneuverMs)
      : null;
    const twd = twdInterp ?? activeSession?.twd;
    const windAngleDeg = (typeof twd === 'number' && Number.isFinite(twd))
      ? (((twd + 180 - entryCog) % 360) + 360) % 360
      : null;

    // viewBox numerico per posizionare gli indicatori del vento senza
    // doverlo riparsare dalla stringa nel JSX.
    const vb = {
      x: cx - maxDim / 2 - padding,
      y: cy - maxDim / 2 - padding,
      w: maxDim + padding * 2,
      h: maxDim + padding * 2,
    };

    return {
      points,
      viewBox,
      vb,
      turnPoint: { ...turnPoint, visualHeading },
      color: traceColor,
      baseStroke,
      twd: typeof twd === 'number' && Number.isFinite(twd) ? twd : null,
      windAngleDeg,
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
      <div className="flex items-center justify-center h-[400px] bg-surface-1 eyebrow">
        Nessuna sessione visibile
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-surface-1">
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

      <div className="flex overflow-hidden h-[calc(100vh-340px)] min-h-[600px] max-h-[800px]">
        {/* Lista laterale */}
        <div className="w-80 border-r border-border overflow-y-auto bg-surface-1 divide-y divide-border z-20">
          {sortedManeuvers.length === 0 ? (
            <div className="p-6 text-center eyebrow mt-10">Nessuna manovra</div>
          ) : (
            sortedManeuvers.map((m, i) => {
              const status = getFoilingStatus(Number(m.sog_min) || 0, flyThreshold);
              const isSelected = selectedIndex === i;
              // Stato selected: tre segnali ridondanti per non lasciare
              // ambiguita' su quale card corrisponda al pannello a destra:
              // (1) bordo gold sx 3px — il piu' leggibile in lista densa,
              // (2) sfondo bg-surface-2 (vs surface-1 base / surface-2/60
              //     in hover) per stacco netto, (3) chevron a destra che
              //     "punta" al pannello di dettaglio. Le label metriche
              //     passano da muted a piene per finire di chiudere il gap.
              return (
                <button
                  key={m.timestamp || `idx-${i}`}
                  onClick={() => setSelectedManeuverKey(m.timestamp ?? null)}
                  aria-pressed={isSelected}
                  className={`w-full p-5 pr-9 text-left transition-colors duration-150 relative ${
                    isSelected
                      ? 'bg-surface-2 cursor-default'
                      : 'cursor-pointer hover:bg-surface-2/60'
                  }`}
                >
                  {isSelected && (
                    <>
                      <div className="absolute left-0 top-0 w-[3px] h-full bg-gold" />
                      <svg
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gold pointer-events-none"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        viewBox="0 0 24 24"
                        aria-hidden
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </>
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
                      <div className={`eyebrow mb-0.5 ${isSelected ? 'text-ink' : ''}`}>Vel min</div>
                      <div className={`text-lg font-mono tabular ${status.color}`}>
                        {(Number(m.sog_min) || 0).toFixed(1)}
                        <span className={`text-caption ml-1 ${isSelected ? 'text-ink-2' : 'text-ink-muted'}`}>kts</span>
                      </div>
                    </div>
                    <div className="bg-bg border border-border rounded-md p-2 text-center">
                      <div className={`eyebrow mb-0.5 ${isSelected ? 'text-ink' : ''}`}>Δ V</div>
                      <div className={`text-lg font-mono tabular ${(Number(m.delta_v) || 0) >= 0 ? 'text-sage' : 'text-amber'}`}>
                        {(Number(m.delta_v) || 0) >= 0 ? '+' : ''}{(Number(m.delta_v) || 0).toFixed(1)}
                        <span className={`text-caption ml-1 ${isSelected ? 'text-ink-2' : 'text-ink-muted'}`}>kts</span>
                      </div>
                    </div>
                  </div>

                  <div className={`text-caption font-mono tabular flex items-center justify-between ${isSelected ? 'text-ink-2' : 'text-ink-muted'}`}>
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

          {/* Breadcrumb manovra in analisi: tipo + orario in evidenza
              cosi' il pannello ha un titolo esplicito e l'utente puo'
              fare cross-reference con la card selezionata in lista
              (orario in font-mono gold per ancorare visivamente). */}
          {activeManeuver && (
            <div className="px-6 py-2.5 border-b border-border bg-surface-1 shrink-0 flex items-baseline gap-3 flex-wrap">
              <span className="text-eyebrow uppercase tracking-eyebrow text-ink-muted">
                Manovra
              </span>
              <span className="font-serif italic text-base text-ink leading-none">
                {activeManeuver.type}
              </span>
              <span className="font-mono tabular text-body text-gold leading-none">
                {formatTime(activeManeuver.timestamp)}
              </span>
              {activeStatus && (
                <span className={`text-[9px] font-medium uppercase tracking-eyebrow px-2 py-0.5 rounded-sm border ${activeStatus.color} ${activeStatus.bg} ${activeStatus.border}`}>
                  {activeStatus.label}
                </span>
              )}
            </div>
          )}

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

                {/* Indicatori del vento: frecce di sfondo distribuite sul
                    viewBox piu' una freccia principale con label TWD. La
                    direzione e' identica per tutte (TWD costante nella
                    finestra di una manovra) e ruotata nel frame del
                    footprint. Disegnate prima della traiettoria cosi' la
                    curva resta in primo piano. */}
                {renderData.windAngleDeg != null && renderData.twd != null && (() => {
                  const { vb, baseStroke, windAngleDeg, twd } = renderData;
                  const bgArrowLen = baseStroke * 7;
                  const mainArrowLen = baseStroke * 16;
                  const bgPositions = [
                    { x: vb.x + vb.w * 0.18, y: vb.y + vb.h * 0.30 },
                    { x: vb.x + vb.w * 0.50, y: vb.y + vb.h * 0.65 },
                    { x: vb.x + vb.w * 0.82, y: vb.y + vb.h * 0.78 },
                  ];
                  const mainPos = { x: vb.x + vb.w * 0.86, y: vb.y + vb.h * 0.13 };
                  // Forma freccia "verso Y+" (riusabile): asta + punta.
                  const renderArrow = (len: number, color: string, opacity: number, sw: number) => (
                    <>
                      <line
                        x1="0" y1={-len / 2}
                        x2="0" y2={len / 2 - len * 0.18}
                        stroke={color}
                        strokeWidth={sw}
                        strokeLinecap="round"
                        opacity={opacity}
                      />
                      <polygon
                        points={`-${len * 0.13},${len / 2 - len * 0.22} 0,${len / 2} ${len * 0.13},${len / 2 - len * 0.22}`}
                        fill={color}
                        opacity={opacity}
                      />
                    </>
                  );
                  return (
                    <g style={{ pointerEvents: 'none' }}>
                      {bgPositions.map((p, i) => (
                        <g
                          key={`wind-bg-${i}`}
                          transform={`translate(${p.x}, ${p.y}) rotate(${windAngleDeg})`}
                        >
                          {renderArrow(bgArrowLen, BOAT_GOLD, 0.22, baseStroke * 0.4)}
                        </g>
                      ))}
                      <g transform={`translate(${mainPos.x}, ${mainPos.y}) rotate(${windAngleDeg})`}>
                        {renderArrow(mainArrowLen, BOAT_GOLD, 0.92, baseStroke * 0.7)}
                      </g>
                      {/* Label TWD ancorata al riquadro (non ruotata): cosi'
                          il numero resta sempre leggibile a prescindere
                          dalla direzione del vento. */}
                      <g transform={`translate(${mainPos.x}, ${mainPos.y + mainArrowLen * 0.65})`}>
                        <rect
                          x={-baseStroke * 7}
                          y={-baseStroke * 1.8}
                          width={baseStroke * 14}
                          height={baseStroke * 3.6}
                          rx={baseStroke * 0.6}
                          fill="#040d1a"
                          opacity="0.75"
                          stroke={BOAT_GOLD}
                          strokeWidth={baseStroke * 0.2}
                        />
                        <text
                          x="0"
                          y={baseStroke * 0.4}
                          fill={BOAT_GOLD}
                          fontSize={baseStroke * 2.4}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          className="tracking-widest uppercase"
                        >
                          TWD {Math.round(twd)}°
                        </text>
                      </g>
                    </g>
                  );
                })()}

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
