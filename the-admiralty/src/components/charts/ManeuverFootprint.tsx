import React, { useState, useMemo } from 'react';

interface ManeuverFootprintProps {
  maneuvers: any[];
  trackData: any[];
}

// --- REGOLE FOILING SEMPLIFICATE (FLY vs TOUCH) ---
const getFoilingStatus = (type: string, sogMin: number) => {
  const isTack = type.toLowerCase().includes('virata');
  
  if (isTack) {
    if (sogMin >= 8.5) return { label: 'FLY', color: 'text-[#10b981]', bg: 'bg-[#10b981]/10', border: 'border-[#10b981]/30' };
    return { label: 'TOUCH', color: 'text-[#f59e0b]', bg: 'bg-[#f59e0b]/10', border: 'border-[#f59e0b]/30' };
  } else {
    // Strambata
    if (sogMin >= 12.0) return { label: 'FLY', color: 'text-[#10b981]', bg: 'bg-[#10b981]/10', border: 'border-[#10b981]/30' };
    return { label: 'TOUCH', color: 'text-[#f59e0b]', bg: 'bg-[#f59e0b]/10', border: 'border-[#f59e0b]/30' };
  }
};

export default function ManeuverFootprint({ maneuvers, trackData }: ManeuverFootprintProps) {
  const [mode, setMode] = useState<'FLY' | 'TOUCH'>('FLY');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // --- 1. FILTRAGGIO E ORDINAMENTO FOILING ---
  const sortedManeuvers = useMemo(() => {
    if (!maneuvers || maneuvers.length === 0) return [];
    
    return [...maneuvers]
      .filter(m => {
        const status = getFoilingStatus(m.type, Number(m.sog_min));
        return status.label === mode;
      })
      // Ordiniamo in base alla velocità minima: 
      // Se cerchiamo i FLY, mettiamo in cima quelli più veloci (i migliori in assoluto).
      // Se cerchiamo i TOUCH, mettiamo in cima quelli più lenti (i peggiori da analizzare).
      .sort((a, b) => mode === 'FLY' ? b.sog_min - a.sog_min : a.sog_min - b.sog_min);
  }, [maneuvers, mode]);

  React.useEffect(() => { setSelectedIndex(0); }, [mode]);

  const activeManeuver = sortedManeuvers[selectedIndex];
  const activeStatus = activeManeuver ? getFoilingStatus(activeManeuver.type, Number(activeManeuver.sog_min)) : null;

  const formatTime = (ts: string) => {
    if (!ts) return 'N/D';
    try {
      const date = new Date(ts.replace(' ', 'T'));
      if (isNaN(date.getTime())) return ts;
      return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return ts;
    }
  };

  // --- 2. MOTORE GEOMETRICO BLINDATO E ALLINEATO ---
  const renderData = useMemo(() => {
    if (!activeManeuver || !trackData || trackData.length === 0) return null;

    let centerIdx = -1;

    if (activeManeuver.timestamp && trackData[0]?.timestamp) {
      const targetT = new Date(activeManeuver.timestamp.replace(' ', 'T')).getTime();
      let minDiff = Infinity;
      trackData.forEach((p, i) => {
        const pt = new Date(p.timestamp.replace(' ', 'T')).getTime();
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

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    const points = validSegment.map((p, i) => {
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      
      const x_m = (lon - refLon) * (Math.PI / 180) * R * Math.cos(refLat * Math.PI / 180);
      const y_m = (lat - refLat) * (Math.PI / 180) * R;

      const theta = -(entryCog * Math.PI) / 180;
      const x_rot = x_m * Math.cos(theta) - y_m * Math.sin(theta);
      const y_rot = -(x_m * Math.sin(theta) + y_m * Math.cos(theta));

      if (!isNaN(x_rot) && !isNaN(y_rot)) {
        if (x_rot < minX) minX = x_rot;
        if (x_rot > maxX) maxX = x_rot;
        if (y_rot < minY) minY = y_rot;
        if (y_rot > maxY) maxY = y_rot;
      }

      const sog = Number(p.sog_knots) || 0;

      return { 
        x: x_rot, y: y_rot, sog, 
        isCenter: p === validSegment[Math.floor(validSegment.length/2)],
        lat, lon, time: p.timestamp 
      };
    }).filter(p => !isNaN(p.x) && !isNaN(p.y));

    if (points.length < 2) return null;

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

    if (minX === Infinity) minX = -50;
    if (maxX === -Infinity) maxX = 50;
    if (minY === Infinity) minY = -50;
    if (maxY === -Infinity) maxY = 50;

    const width = maxX - minX;
    const height = maxY - minY;
    const maxDim = Math.max(width, height, 80); 
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const padding = maxDim * 0.4; 
    
    if (isNaN(cx) || isNaN(cy) || isNaN(maxDim)) return null;

    const viewBox = `${cx - maxDim/2 - padding} ${cy - maxDim/2 - padding} ${maxDim + padding*2} ${maxDim + padding*2}`;
    const baseStroke = (maxDim + padding * 2) / 120; 
    
    // Solo Verde (Fly) o Arancione (Touch)
    const traceColor = activeStatus?.label === 'FLY' ? '#10b981' : '#f59e0b';

    return { 
      points, 
      viewBox, 
      turnPoint: { ...turnPoint, visualHeading }, 
      color: traceColor, 
      baseStroke 
    };
  }, [activeManeuver, trackData, mode, activeStatus]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* HEADER CONTROLLI */}
      <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <div className="flex bg-white border border-gray-200 rounded p-1">
          <button 
            onClick={() => setMode('FLY')}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-widest rounded transition-colors flex items-center gap-2 ${mode === 'FLY' ? 'bg-[#10b981] text-white shadow-sm' : 'text-gray-400 hover:bg-gray-50'}`}
          >
            <span>🟢</span> Manovre Fly
          </button>
          <button 
            onClick={() => setMode('TOUCH')}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-widest rounded transition-colors flex items-center gap-2 ${mode === 'TOUCH' ? 'bg-[#f59e0b] text-white shadow-sm' : 'text-gray-400 hover:bg-gray-50'}`}
          >
            <span>🟠</span> Manovre Touch
          </button>
        </div>
        <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">
          {sortedManeuvers.length} Manovre in questa categoria
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-[500px]">
        {/* LISTA LATERALE FOILING */}
        <div className="w-80 border-r border-gray-100 overflow-y-auto bg-white divide-y divide-gray-50 z-20 shadow-xl">
          {sortedManeuvers.length === 0 ? (
            <div className="p-6 text-center text-xs text-gray-400 uppercase tracking-widest mt-10">Nessuna manovra</div>
          ) : (
            sortedManeuvers.map((m, i) => {
              const status = getFoilingStatus(m.type, Number(m.sog_min));
              return (
                <button 
                  key={i} 
                  onClick={() => setSelectedIndex(i)}
                  className={`w-full p-5 text-left transition-colors relative ${selectedIndex === i ? 'bg-navy-50' : 'hover:bg-gray-50'}`}
                >
                  {selectedIndex === i && <div className={`absolute left-0 top-0 w-1.5 h-full`} style={{ backgroundColor: renderData?.color }}></div>}
                  
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-bold text-navy-900 uppercase tracking-widest">{m.type}</div>
                      {/* BADGE FOILING */}
                      <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${status.color} ${status.bg} ${status.border}`}>
                        {status.label}
                      </span>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div className="bg-white border border-gray-100 rounded p-1.5 text-center shadow-sm">
                      <div className="text-[9px] text-gray-400 uppercase tracking-widest">Vel Min</div>
                      <div className={`text-sm font-bold font-serif ${status.color}`}>{(Number(m.sog_min) || 0).toFixed(1)} <span className="text-[10px] font-sans">kts</span></div>
                    </div>
                    <div className="bg-white border border-gray-100 rounded p-1.5 text-center shadow-sm">
                      <div className="text-[9px] text-gray-400 uppercase tracking-widest">Delta V</div>
                      <div className={`text-sm font-bold font-serif ${m.delta_v >= 0 ? 'text-[#10b981]' : 'text-[#f59e0b]'}`}>
                        {m.delta_v >= 0 ? '+' : ''}{(Number(m.delta_v) || 0).toFixed(1)} <span className="text-[10px] font-sans">kts</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-[10px] text-gray-500 font-mono flex items-center justify-between">
                    <span>{formatTime(m.timestamp)}</span>
                    {m.leg_distance_nm !== undefined && (
                      <span className="text-gold font-bold bg-gold/10 px-1.5 py-0.5 rounded border border-gold/20">
                        Lato: {m.leg_distance_nm.toFixed(2)} NM
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* L'ACQUA E LA TRAIETTORIA */}
        <div className="flex-1 relative bg-[#061325] overflow-hidden flex items-center justify-center">
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

          {renderData ? (
            <svg 
              className="w-full h-full p-8 drop-shadow-2xl" 
              viewBox={renderData.viewBox} 
              preserveAspectRatio="xMidYMid meet"
            >
              <line 
                x1="0" y1={renderData.viewBox.split(' ')[1]} 
                x2="0" y2="10000" 
                stroke="#ffffff" strokeWidth={renderData.baseStroke * 0.3} strokeDasharray="4,4" opacity="0.15" 
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
                <text x={renderData.baseStroke * 3} y="0" fill="white" fontSize={renderData.baseStroke * 4} opacity="0.5" dominantBaseline="middle" className="font-bold tracking-widest uppercase">Inizio</text>
              </g>

              <g transform={`translate(${renderData.points[renderData.points.length - 1].x}, ${renderData.points[renderData.points.length - 1].y})`}>
                <rect x={-renderData.baseStroke} y={-renderData.baseStroke} width={renderData.baseStroke * 2} height={renderData.baseStroke * 2} fill="white" opacity="0.8" />
                <text x={renderData.baseStroke * 3} y="0" fill="white" fontSize={renderData.baseStroke * 4} opacity="0.8" dominantBaseline="middle" className="font-bold tracking-widest uppercase">Fine</text>
              </g>
              
              <g transform={`translate(${renderData.turnPoint.x}, ${renderData.turnPoint.y}) rotate(${renderData.turnPoint.visualHeading})`}>
                <polygon points={`-${renderData.baseStroke*1.5},${renderData.baseStroke*2} 0,-${renderData.baseStroke*3} ${renderData.baseStroke*1.5},${renderData.baseStroke*2} 0,${renderData.baseStroke}`} fill="white" />
                <circle cx="0" cy="0" r={renderData.baseStroke * 5} fill="none" stroke={renderData.color} strokeWidth={renderData.baseStroke * 0.6} opacity="0.8" />
              </g>

            </svg>
          ) : (
            <div className="text-gray-400 text-xs uppercase tracking-widest z-10 bg-[#061325]/80 px-6 py-4 rounded border border-gray-700">
              Traiettoria incompleta per questo segmento.
            </div>
          )}

          {activeManeuver && activeStatus && (
            <div className="absolute top-6 left-6 flex gap-4 pointer-events-none">
              <div className="bg-[#040d1a]/80 backdrop-blur-md border border-white/10 p-4 rounded text-white min-w-[100px]">
                <div className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">Vel Ingresso</div>
                <div className="text-2xl font-serif">{(Number(activeManeuver.sog_in) || 0).toFixed(1)} <span className="text-xs">kts</span></div>
              </div>
              
              {/* HUD CENTRALE DINAMICO FOILING */}
              <div className={`bg-[#040d1a]/80 backdrop-blur-md border p-4 rounded min-w-[120px] shadow-2xl transition-colors duration-300 ${activeStatus.border}`}>
                <div className={`text-[9px] uppercase font-bold tracking-widest mb-1 ${activeStatus.color}`}>
                  Manovra {activeStatus.label}
                </div>
                <div className={`text-3xl font-serif font-black ${activeStatus.color}`}>
                  {(Number(activeManeuver.sog_min) || 0).toFixed(1)} <span className="text-xs font-sans font-normal">kts</span>
                </div>
              </div>

              <div className="bg-[#040d1a]/80 backdrop-blur-md border border-white/10 p-4 rounded text-white min-w-[100px]">
                <div className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">Vel Uscita</div>
                <div className="text-2xl font-serif">{(Number(activeManeuver.sog_out) || 0).toFixed(1)} <span className="text-xs">kts</span></div>
              </div>
            </div>
          )}

          {renderData && activeManeuver && (
            <div className="absolute bottom-6 right-6 pointer-events-none">
              <div className="bg-[#040d1a]/80 backdrop-blur-md border border-white/10 p-5 rounded text-white text-right shadow-xl min-w-[200px]">
                <div className="flex flex-col items-end gap-4">
                  
                  <div>
                    <div className="text-[9px] text-gray-400 uppercase tracking-widest mb-1 flex items-center justify-end gap-1">
                       <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                       Orario Manovra
                    </div>
                    <div className="text-xl font-serif tracking-wider text-white">
                      {formatTime(activeManeuver.timestamp || renderData.turnPoint.time)}
                    </div>
                  </div>

                  {activeManeuver.leg_distance_nm !== undefined && (
                    <>
                      <div className="w-full border-t border-white/10"></div>
                      <div>
                        <div className="text-[9px] text-gray-400 uppercase tracking-widest mb-1 flex items-center justify-end gap-1">
                           <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                           Lunghezza Lato Precedente
                        </div>
                        <div className="text-lg font-serif tracking-wider text-gold">
                          {activeManeuver.leg_distance_nm.toFixed(2)} <span className="text-xs text-gray-400 font-sans">NM</span>
                        </div>
                      </div>
                    </>
                  )}

                  <div className="w-full border-t border-white/10"></div>
                  <div>
                    <div className="text-[9px] text-gray-500 uppercase tracking-widest flex items-center justify-end gap-1 mb-1">
                       Coordinate
                    </div>
                    <div className="text-[10px] font-mono text-gray-400">
                      {renderData.turnPoint.lat.toFixed(5)}° N, {renderData.turnPoint.lon.toFixed(5)}° E
                    </div>
                  </div>

                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}