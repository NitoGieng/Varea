import React, { useState, useMemo } from 'react';

export default function Maneuvers({ maneuvers = [] }: { maneuvers: any[] }) {
  
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'Virata' | 'Strambata'>('ALL');
  const [resultFilter, setResultFilter] = useState<'ALL' | 'FLY' | 'TOUCH'>('ALL');
  const [flyThreshold, setFlyThreshold] = useState<number>(12.0); 
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [collapsedLegs, setCollapsedLegs] = useState<Record<string, boolean>>({});

  const safeTime = (ts: string) => {
     if (!ts) return "--:--:--";
     try {
       if (ts.includes('T')) return ts.split('T')[1].substring(0, 8);
       if (ts.includes(' ')) return ts.split(' ')[1].substring(0, 8);
       return ts;
     } catch (error) {
       return "--:--:--";
     }
  };

  const maneuversWithIds = useMemo(() => {
    return maneuvers.map((m, index) => ({
      ...m,
      maneuverId: `#${4800 + index}`,
    }));
  }, [maneuvers]);

  const filteredManeuvers = useMemo(() => {
    return maneuversWithIds.filter((m) => {
      if (searchQuery) {
        const time = safeTime(m.timestamp);
        const query = searchQuery.toLowerCase();
        if (!m.maneuverId.toLowerCase().includes(query) && !time.toLowerCase().includes(query)) return false;
      }
      if (typeFilter !== 'ALL' && m.type !== typeFilter) return false;
      const isFly = m.sog_min != null && m.sog_min >= flyThreshold;
      if (resultFilter === 'FLY' && !isFly) return false;
      if (resultFilter === 'TOUCH' && isFly) return false;
      return true;
    });
  }, [maneuversWithIds, searchQuery, typeFilter, resultFilter, flyThreshold]);

  const legs = useMemo(() => {
    const groups: Record<string, any[]> = {};
    filteredManeuvers.forEach((m) => {
      if (!m.timestamp) return;
      const timeStr = safeTime(m.timestamp);
      const hour = timeStr !== "--:--:--" ? timeStr.substring(0, 2) : "00";
      
      const legName = `Leg ${hour}:00 — ${parseInt(hour)+1}:00`;
      if (!groups[legName]) groups[legName] = [];
      groups[legName].push(m);
    });
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filteredManeuvers]);

  const toggleLeg = (legName: string) => {
    setCollapsedLegs(prev => ({ ...prev, [legName]: !prev[legName] }));
  };

  const handleExportCSV = () => {
    let csv = "Ora,Tipo,SOG_Ingresso,SOG_Minima,SOG_Uscita,Delta_V,Dist_Leg_NM,Risultato,Durata_Totale_sec,TTR_sec,TTR_Target_kts\n";
    filteredManeuvers.forEach(m => {
      const time = safeTime(m.timestamp);
      const isFly = m.sog_min != null && m.sog_min >= flyThreshold;
      const ttr = m.recovery_time_s != null ? m.recovery_time_s : "Fail";
      const dur = m.duration_s != null ? m.duration_s : "Fail";
      csv += `${time},${m.type},${m.sog_in},${m.sog_min},${m.sog_out},${m.delta_v},${m.leg_distance_nm || 0},${isFly ? 'FLY' : 'TOUCH'},${dur},${ttr},${m.ttr_target_sog}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "registro_manovre_filtrato.csv";
    link.click();
  };

  return (
    <div className="bg-white min-h-screen text-gray-800 font-sans pb-20">
      <div className="max-w-5xl mx-auto px-4 py-6">
        
        <div className="relative mb-6">
          <svg className="w-5 h-5 absolute left-4 top-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input 
            type="text" 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cerca ID manovra (es. #4805) o orario..." 
            className="w-full bg-gray-100 border-none rounded-md py-3.5 pl-12 pr-4 text-sm font-medium text-gray-700 focus:ring-2 focus:ring-navy-900 outline-none transition-shadow"
          />
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6 mb-8 bg-gray-50 p-4 rounded-lg border border-gray-100">
          <div className="flex flex-wrap items-center gap-4">
            
            <div className="flex items-center gap-2 relative">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Tipo:</span>
              <button 
                onClick={() => setIsTypeDropdownOpen(!isTypeDropdownOpen)}
                className="bg-white border border-gray-200 text-xs font-bold px-4 py-2 rounded flex items-center gap-2 text-navy-900 hover:bg-gray-50 min-w-[140px] justify-between"
              >
                {typeFilter === 'ALL' ? 'TUTTE' : typeFilter.toUpperCase()}
                <svg className={`w-3 h-3 transform transition-transform ${isTypeDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </button>
              
              {isTypeDropdownOpen && (
                <div className="absolute top-full left-10 mt-1 w-48 bg-white border border-gray-100 rounded shadow-lg z-50 overflow-hidden">
                  {['ALL', 'Virata', 'Strambata'].map((type) => (
                    <button key={type} onClick={() => { setTypeFilter(type as any); setIsTypeDropdownOpen(false); }} className={`w-full text-left px-4 py-2 text-xs font-bold uppercase tracking-widest hover:bg-gray-50 ${typeFilter === type ? 'text-gold bg-gray-50' : 'text-gray-600'}`}>
                      {type === 'ALL' ? 'TUTTE LE MANOVRE' : type}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Risultato:</span>
              <div className="flex bg-white border border-gray-200 rounded overflow-hidden">
                <button onClick={() => setResultFilter('ALL')} className={`text-xs font-bold px-3 py-2 transition-colors ${resultFilter === 'ALL' ? 'bg-[#8b6b4a] text-white' : 'text-gray-500 hover:bg-gray-50'}`}>TUTTI</button>
                <button onClick={() => setResultFilter('FLY')} className={`text-xs font-bold px-3 py-2 transition-colors border-l border-gray-200 ${resultFilter === 'FLY' ? 'bg-[#8b6b4a] text-white' : 'text-gray-500 hover:bg-gray-50'}`}>FLY</button>
                <button onClick={() => setResultFilter('TOUCH')} className={`text-xs font-bold px-3 py-2 transition-colors border-l border-gray-200 ${resultFilter === 'TOUCH' ? 'bg-[#8b6b4a] text-white' : 'text-gray-500 hover:bg-gray-50'}`}>TOUCH</button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Soglia Fly:</span>
              <div className="flex items-center bg-white border border-gray-200 rounded overflow-hidden px-2">
                <input 
                  type="number" 
                  step="0.5"
                  value={flyThreshold}
                  onChange={(e) => setFlyThreshold(Number(e.target.value))}
                  className="w-12 py-1.5 text-xs font-bold text-navy-900 outline-none text-right"
                />
                <span className="text-xs font-bold text-gray-400 pl-1 pr-2">kts</span>
              </div>
            </div>

          </div>

          <button onClick={handleExportCSV} className="bg-[#061325] text-white text-xs font-bold uppercase tracking-widest px-6 py-3 rounded flex items-center justify-center gap-2 hover:bg-navy-800 transition-colors whitespace-nowrap">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Esporta CSV
          </button>
        </div>

        {legs.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-400 italic mb-2">Nessuna manovra trovata con questi filtri.</p>
            <button onClick={() => { setSearchQuery(''); setTypeFilter('ALL'); setResultFilter('ALL'); }} className="text-gold text-xs font-bold uppercase tracking-widest hover:underline">
              Resetta Filtri
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {legs.map(([legName, legManeuvers], legIndex) => {
              const isCollapsed = collapsedLegs[legName];
              
              return (
                <div key={legIndex} className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden transition-all">
                  
                  <button 
                    onClick={() => toggleLeg(legName)}
                    className="w-full flex items-center justify-between p-4 bg-gray-50/50 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <svg className={`w-4 h-4 text-navy-900 transform transition-transform duration-200 ${isCollapsed ? '-rotate-90' : 'rotate-0'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                      <h2 className="text-lg font-serif text-navy-900">
                        {legName.split(' ')[0]} {legName.split(' ')[1]} 
                        <span className="text-gray-400 text-sm ml-2 font-sans tracking-tight">{legName.split(' ').slice(2).join(' ')}</span>
                      </h2>
                    </div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-white px-2 py-1 rounded border border-gray-200">
                      {legManeuvers.length} Manovre
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="border-t border-gray-100">
                      {/* GRIGLIA A 12 COLONNE OTTIMIZZATA */}
                      <div className="grid grid-cols-12 gap-2 px-6 py-2 bg-white text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b border-gray-50">
                        <div className="col-span-2">Info</div>
                        <div className="col-span-2">Manovra</div>
                        <div className="col-span-1 text-center" title="Velocità Ingresso">V. In</div>
                        <div className="col-span-1 text-center text-navy-900" title="Velocità Minima">V. Min</div>
                        <div className="col-span-1 text-center" title="Velocità Uscita (+12s)">V. Out</div>
                        <div className="col-span-1 text-center" title="Durata totale (Discesa + Recupero)">Durata</div>
                        <div className="col-span-3 text-center" title="Tempo per recuperare il 50% della V persa">TTR (50%)</div>
                        <div className="col-span-1 text-right">ΔV</div>
                      </div>

                      <div className="divide-y divide-gray-50">
                        {legManeuvers.map((m: any, idx: number) => {
                          const isTack = m.type === 'Virata';
                          const isPositive = m.delta_v >= 0;
                          const isFly = m.sog_min != null && m.sog_min >= flyThreshold;
                          const timeString = safeTime(m.timestamp);

                          return (
                            <div key={idx} className="grid grid-cols-12 gap-2 px-6 py-3.5 items-center hover:bg-gray-50/80 transition-colors">
                              
                              <div className="col-span-2 flex flex-col">
                                <span className="text-xs font-mono text-gray-800">{timeString}</span>
                                <span className="text-[9px] text-gray-400 font-mono tracking-tight">
                                  {m.maneuverId} • {m.leg_distance_nm != null ? m.leg_distance_nm.toFixed(2) : '--'} NM
                                </span>
                              </div>
                              
                              <div className="col-span-2 flex flex-col items-start gap-1">
                                <div className="flex items-center gap-1.5">
                                  <div className={`w-1.5 h-1.5 rounded-full ${isTack ? 'bg-[#d4af37]' : 'bg-[#718eb2]'}`}></div>
                                  <span className="text-xs font-bold text-navy-900">{isTack ? 'Virata' : 'Strambata'}</span>
                                </div>
                                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded uppercase tracking-widest ${isFly ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                                  {isFly ? 'Fly' : 'Touch'}
                                </span>
                              </div>

                              <div className="col-span-1 text-center">
                                <span className="text-xs font-bold text-gray-600">{m.sog_in != null ? m.sog_in.toFixed(1) : '--'}</span>
                              </div>

                              <div className="col-span-1 text-center">
                                <span className="text-sm font-black text-navy-900">{m.sog_min != null ? m.sog_min.toFixed(1) : '--'}</span>
                              </div>

                              <div className="col-span-1 text-center">
                                <span className="text-xs font-bold text-gray-600">{m.sog_out != null ? m.sog_out.toFixed(1) : '--'}</span>
                              </div>

                              {/* NUOVA COLONNA DURATA TOTALE */}
                              <div className="col-span-1 text-center flex justify-center">
                                {m.duration_s !== "Fail" && m.duration_s != null ? (
                                  <span className="text-xs font-bold text-navy-900 bg-gray-100 px-2 py-0.5 rounded">{m.duration_s}s</span>
                                ) : (
                                  <span className="text-[10px] text-gray-400">--</span>
                                )}
                              </div>

                              {/* TTR CON IL DATO "RAGGI X" SE FALLISCE */}
                              <div className="col-span-3 flex flex-col items-center justify-center">
                                {typeof m.recovery_time_s === 'number' ? (
                                  <>
                                    <div className="flex items-baseline justify-center">
                                      <span className="text-xs font-bold text-navy-900">{m.recovery_time_s}</span>
                                      <span className="text-[9px] text-gray-500 ml-0.5">s</span>
                                    </div>
                                    <span className="text-[8px] text-gray-400 uppercase tracking-widest mt-0.5" title="Velocità Target">
                                      Target: {m.ttr_target_sog}
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <span className="text-red-400 bg-red-50 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest" title="Mancato recupero">
                                      {m.recovery_time_s} {/* Mostra i Raggi X! */}
                                    </span>
                                  </>
                                )}
                              </div>

                              <div className={`col-span-1 text-right text-xs font-bold tracking-tight ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                                {isPositive ? '+' : ''}{m.delta_v != null ? m.delta_v.toFixed(1) : '--'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}