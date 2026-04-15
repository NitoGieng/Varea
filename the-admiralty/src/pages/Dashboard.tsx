import React, { useState, useEffect, useMemo } from 'react';
import PolarPlot from '../components/charts/PolarPlot';
import TelemetryMap from '../components/charts/TelemetryMap';
import Maneuvers from './Maneuvers';

export default function Dashboard() {
  const [telemetryData, setTelemetryData] = useState<any>(null);
  const [isUploading, setIsUploading] = useState(false);
  
  const [currentView, setCurrentView] = useState<'overview' | 'maneuvers'>('overview');
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // STATI TEMPORALI: Accettano stringhe per evitare il bug dello '0' che non si cancella
  const [startMin, setStartMin] = useState<number | string>(0);
  const [startSec, setStartSec] = useState<number | string>(0); 
  const [endMin, setEndMin] = useState<number | string>(10);
  const [endSec, setEndSec] = useState<number | string>(0); 

  useEffect(() => {
    if (telemetryData && telemetryData.session_info) {
      setStartMin(0);
      setStartSec(0);
      setEndMin(Math.floor(telemetryData.session_info.duration_seconds / 60));
      setEndSec(telemetryData.session_info.duration_seconds % 60);
    }
  }, [telemetryData]);

  // --- MOTORE DI CALCOLO DELL'INTERVALLO (BLINDATO) ---
  const segmentMetrics = useMemo(() => {
    if (!telemetryData || !telemetryData.session_info.start_time) return null;

    // 1. Convertiamo in modo sicuro gli input vuoti in 0
    const sMin = Number(startMin) || 0;
    const sSec = Number(startSec) || 0;
    const eMin = Number(endMin) || 0;
    const eSec = Number(endSec) || 0;

    // 2. Allineamento Fuso Orario: Sincronizzazione perfetta tra Python e React
    const startStr = telemetryData.session_info.start_time.replace(' ', 'T');
    const startEpoch = new Date(startStr.endsWith('Z') ? startStr : startStr + 'Z').getTime();
    
    const totalStartSeconds = (sMin * 60) + sSec;
    const totalEndSeconds = (eMin * 60) + eSec;

    const filterStartEpoch = startEpoch + (totalStartSeconds * 1000);
    const filterEndEpoch = startEpoch + (totalEndSeconds * 1000);

    // 3. Filtra Manovre
    const segManeuvers = telemetryData.maneuvers.filter((m: any) => {
      if (!m.timestamp) return false;
      const mStr = m.timestamp.replace(' ', 'T');
      const t = new Date(mStr.endsWith('Z') ? mStr : mStr + 'Z').getTime();
      return t >= filterStartEpoch && t <= filterEndEpoch;
    });

    // 4. Conteggio Bilingue (Infallibile)
    const virate = segManeuvers.filter((m: any) => {
      const typeStr = m.type.toLowerCase();
      return typeStr.includes('virata') || typeStr.includes('tack');
    }).length;
    
    const strambate = segManeuvers.filter((m: any) => {
      const typeStr = m.type.toLowerCase();
      return typeStr.includes('strambata') || typeStr.includes('jibe') || typeStr.includes('gybe');
    }).length;

    // 5. Filtra Telemetria per calcolare le Medie
    const totalPoints = telemetryData.track_data.length;
    const durationSecs = telemetryData.session_info.duration_seconds;
    
    const segTrack = telemetryData.track_data.filter((p: any, i: number) => {
      const pointSecond = i * (durationSecs / totalPoints);
      return pointSecond >= totalStartSeconds && pointSecond <= totalEndSeconds;
    });

    const getAvg = (keywords: string[]) => {
      const pts = segTrack.filter((p: any) => {
        const andaturaStr = (p.andatura || '').toLowerCase();
        return keywords.some(kw => andaturaStr.includes(kw));
      });
      return pts.length > 0 
        ? (pts.reduce((acc: number, p: any) => acc + p.sog_knots, 0) / pts.length).toFixed(1) 
        : '--';
    };

    return {
      virate,
      strambate,
      bolina: getAvg(['bolina', 'upwind']),
      traverso: getAvg(['traverso', 'reaching']),
      poppa: getAvg(['poppa', 'lasco', 'downwind', 'run', 'broad'])
    };
  }, [telemetryData, startMin, startSec, endMin, endSec]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("http://localhost:8000/api/analyze", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Errore durante l'analisi del file");

      const data = await response.json();
      setTelemetryData(data);
    } catch (error) {
      alert("Errore di caricamento: assicurati che il server Python sia acceso.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleDownload = () => {
    if (!telemetryData) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(telemetryData, null, 2));
    const downloadNode = document.createElement('a');
    downloadNode.setAttribute("href", dataStr);
    downloadNode.setAttribute("download", `${telemetryData.session_info.file_name}_report.json`);
    document.body.appendChild(downloadNode);
    downloadNode.click();
    downloadNode.remove();
  };

  if (!telemetryData) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-8">
        <div className="bg-surface p-12 text-center shadow-lg border border-gray-200 max-w-md w-full">
           <h1 className="text-3xl font-serif font-black text-navy-900 mb-2">Varea</h1>
           <p className="text-sm text-gray-500 mb-8">Analisi Telemetrica delle Prestazioni</p>
           <label className="bg-navy-900 text-white px-8 py-4 text-xs font-bold uppercase tracking-widest cursor-pointer hover:bg-navy-800 transition-colors block w-full relative">
              {isUploading ? "Analisi in corso..." : "Carica File .FIT"}
              <input type="file" className="hidden" accept=".fit,.FIT" onChange={handleFileUpload} disabled={isUploading} />
           </label>
        </div>
      </div>
    );
  }

  const { session_info, environment, maneuvers } = telemetryData;
  const maxSessionMinutes = Math.floor(session_info.duration_seconds / 60);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col relative">
      <header className="bg-[#061325] px-6 py-5 flex items-center shadow-md sticky top-0 z-[100]">
        <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="text-gold hover:text-white transition-colors relative z-[110]">
          <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        {isMenuOpen && <div className="fixed inset-0 z-[105]" onClick={() => setIsMenuOpen(false)}></div>}
        {isMenuOpen && (
          <div className="absolute top-16 left-6 mt-2 w-56 bg-white rounded-md shadow-2xl border border-gray-100 overflow-hidden flex flex-col z-[110] transform transition-all duration-200 origin-top-left">
            <button onClick={() => { setCurrentView('overview'); setIsMenuOpen(false); }} className={`text-left px-6 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${currentView === 'overview' ? 'bg-gray-50 text-gold border-l-4 border-gold' : 'text-navy-900 hover:bg-gray-50 border-l-4 border-transparent'}`}>Panoramica</button>
            <button onClick={() => { setCurrentView('maneuvers'); setIsMenuOpen(false); }} className={`text-left px-6 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${currentView === 'maneuvers' ? 'bg-gray-50 text-gold border-l-4 border-gold' : 'text-navy-900 hover:bg-gray-50 border-l-4 border-transparent'}`}>Registro Manovre</button>
          </div>
        )}
      </header>

      <main className="flex-1 w-full bg-paper">
        {currentView === 'maneuvers' ? (
          <Maneuvers maneuvers={maneuvers} />
        ) : (
          <div className="p-8 lg:p-12 max-w-7xl mx-auto w-full">
            <div className="flex gap-4 mb-12">
              <button onClick={handleDownload} className="bg-white text-navy-900 border border-navy-900 px-6 py-3 text-xs font-bold uppercase tracking-widest hover:bg-gray-50 transition-colors">Esporta JSON</button>
              <label className="bg-navy-900 text-white px-6 py-3 text-xs font-bold uppercase tracking-widest cursor-pointer hover:bg-navy-800 transition-colors">
                {isUploading ? "Caricamento..." : "Cambia File .FIT"}
                <input type="file" className="hidden" accept=".fit,.FIT" onChange={handleFileUpload} disabled={isUploading} />
              </label>
            </div>
            
            <header className="mb-12 flex flex-col md:flex-row md:items-end justify-between border-b border-gray-300 pb-6">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-2">Log Sessione Corrente</p>
                <h1 className="text-6xl md:text-7xl font-serif font-black text-navy-900 leading-none tracking-tight">{session_info.file_name.replace('.fit', '').replace('.FIT', '')}</h1>
              </div>
              <div className="flex flex-col items-start md:items-end mt-6 md:mt-0">
                <div className="flex items-center gap-2 text-gold font-bold text-sm mb-1">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" /></svg>
                  <span>{Math.floor(session_info.duration_seconds / 3600)}H {Math.floor((session_info.duration_seconds % 3600) / 60)}M IN NAVIGAZIONE</span>
                </div>
                <p className="text-xs text-gray-500">TWD Calcolata: {environment.computed_twd_deg}°</p>
              </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="bg-surface p-8 shadow-sm relative overflow-hidden flex flex-col justify-between min-h-[220px]">
                <div className="absolute top-0 left-0 w-[6px] h-full bg-[#6a4f2e]"></div>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-navy-900 mb-6">Velocità di Picco</h3>
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="text-7xl font-serif font-black text-navy-900 italic tracking-tighter">{session_info.sog_max_kts.toFixed(1)}</span>
                    <span className="text-xl font-serif font-bold text-gold">KTS</span>
                  </div>
                </div>
                <p className="text-xs text-gray-500 flex items-center gap-1">Distanza Totale: {session_info.distance_nm} NM</p>
              </div>

              <div className="bg-surface p-8 shadow-sm flex flex-col justify-between min-h-[220px]">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-navy-900 mb-6">SOG Media</h3>
                  <div className="flex items-baseline gap-2 mb-4">
                    <span className="text-7xl font-serif font-black text-navy-900 italic tracking-tighter">{session_info.sog_avg_kts.toFixed(1)}</span>
                    <span className="text-xl font-serif font-bold text-gold">KTS</span>
                  </div>
                </div>
                <div>
                  <div className="w-full h-1 bg-gray-200 mb-2"><div className="h-1 bg-navy-900 w-[70%]"></div></div>
                  <p className="text-[10px] uppercase text-gray-500 tracking-wider">Costanza: Alta</p>
                </div>
              </div>
            </div>

            {segmentMetrics && (
              <div className="bg-white p-6 md:p-8 shadow-sm border border-gray-200 mt-8 rounded-sm">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center mb-6 border-b border-gray-100 pb-4 gap-6">
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-[0.15em] text-navy-900">Analisi di Precisione Temporale</h3>
                    <p className="text-xs text-gray-500 mt-1">Isola uno specifico segmento al secondo per estrarre le metriche veliche.</p>
                  </div>
                  
                  {/* --- NUOVI INPUT MINUTI : SECONDI --- */}
                  <div className="flex flex-wrap items-center gap-4">
                    
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Da:</span>
                      <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden">
                        <input 
                          type="number" min="0" max={Number(endMin)} placeholder="Min"
                          value={startMin} 
                          onChange={(e) => setStartMin(e.target.value === '' ? '' : Number(e.target.value))}
                          className="w-12 py-1.5 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                        <span className="text-gray-300 font-bold">:</span>
                        <input 
                          type="number" min="0" max="59" placeholder="Sec"
                          value={startSec} 
                          onChange={(e) => setStartSec(e.target.value === '' ? '' : Number(e.target.value))}
                          className="w-12 py-1.5 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">A:</span>
                      <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden">
                        <input 
                          type="number" min={Number(startMin)} max={maxSessionMinutes} placeholder="Min"
                          value={endMin} 
                          onChange={(e) => setEndMin(e.target.value === '' ? '' : Number(e.target.value))}
                          className="w-12 py-1.5 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                        <span className="text-gray-300 font-bold">:</span>
                        <input 
                          type="number" min="0" max="59" placeholder="Sec"
                          value={endSec} 
                          onChange={(e) => setEndSec(e.target.value === '' ? '' : Number(e.target.value))}
                          className="w-12 py-1.5 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                      </div>
                    </div>

                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div className="bg-gray-50 p-4 rounded border border-gray-100 text-center">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Virate</div>
                    <div className="text-2xl font-serif font-bold text-navy-900">{segmentMetrics.virate}</div>
                  </div>
                  <div className="bg-gray-50 p-4 rounded border border-gray-100 text-center">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Strambate</div>
                    <div className="text-2xl font-serif font-bold text-navy-900">{segmentMetrics.strambate}</div>
                  </div>
                  <div className="bg-blue-50/50 p-4 rounded border border-blue-100 text-center">
                    <div className="text-[10px] font-bold text-blue-800 uppercase tracking-widest mb-1">Bolina Avg</div>
                    <div className="text-2xl font-serif font-bold text-blue-900">{segmentMetrics.bolina} <span className="text-xs text-blue-600">kts</span></div>
                  </div>
                  <div className="bg-green-50/50 p-4 rounded border border-green-100 text-center">
                    <div className="text-[10px] font-bold text-green-800 uppercase tracking-widest mb-1">Traverso Avg</div>
                    <div className="text-2xl font-serif font-bold text-green-900">{segmentMetrics.traverso} <span className="text-xs text-green-600">kts</span></div>
                  </div>
                  <div className="bg-purple-50/50 p-4 rounded border border-purple-100 text-center">
                    <div className="text-[10px] font-bold text-purple-800 uppercase tracking-widest mb-1">Poppa Avg</div>
                    <div className="text-2xl font-serif font-bold text-purple-900">{segmentMetrics.poppa} <span className="text-xs text-purple-600">kts</span></div>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">
              <div className="lg:col-span-2 bg-surface shadow-sm min-h-[500px] flex flex-col border border-gray-200">
                  <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                    <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-navy-900">Telemetria GPS</h3>
                  </div>
                  <div className="flex-1 w-full relative bg-gray-50">
                    <TelemetryMap trackData={telemetryData.track_data} />
                  </div>
              </div>
              
              <div className="bg-surface shadow-sm min-h-[500px] flex flex-col border border-gray-200">
                  <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                    <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-navy-900">Polare Interattiva</h3>
                    <span className="text-[10px] text-gray-400 uppercase tracking-widest">Live</span>
                  </div>
                  <div className="flex-1 relative">
                    <PolarPlot />
                  </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}