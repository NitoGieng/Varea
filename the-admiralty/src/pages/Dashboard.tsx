import { useState, useEffect, useMemo, useRef } from 'react';
import ManeuverFootprint from '../components/charts/ManeuverFootprint';
import TelemetryMap from '../components/charts/TelemetryMap';
import Maneuvers from './Maneuvers';
import StartAnalysis from './StartAnalysis'; // IL NUOVO COMPONENTE
import type { SessionData, AnalyzeResponse } from '../types/telemetry';
import { assignColor } from '../data/palette';
import SessionsBar from '../components/SessionsBar';

export default function Dashboard() {
  // Stato multi-sessione. Un caricamento singolo produce un array di 1
  // elemento: il comportamento single-player resta identico. Gli step
  // successivi aggiungeranno upload multiplo e viste sovrapposte.
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Sessione pilota per le viste che non sono ancora multi-atleta (tutte
  // per ora: overview header, StartAnalysis, Lab). Gli step 4-7 rimuoveranno
  // questa dipendenza componente per componente. Preferisce una sessione
  // in stato 'ready' a un placeholder 'loading': cosi' se carichi N file in
  // parallelo, il main layout appare non appena la prima analisi termina,
  // senza aspettare la piu' lenta.
  const primarySession = useMemo(() => {
    const ready = sessions.filter(s => s.status === 'ready');
    if (ready.length === 0) return null;
    if (activeSessionId) {
      const found = ready.find(s => s.id === activeSessionId);
      if (found) return found;
    }
    return ready[0];
  }, [sessions, activeSessionId]);

  // Shim temporaneo: ricostruisce la vecchia forma {session_info, ...} da
  // primarySession così il resto del componente (filtri, memo, rendering)
  // resta invariato in questo step. Verrà rimosso quando ogni vista saprà
  // consumare direttamente sessions[].
  const telemetryData = useMemo(() => {
    if (!primarySession || primarySession.status !== 'ready') return null;
    if (!primarySession.sessionInfo || !primarySession.environment) return null;
    return {
      session_info: primarySession.sessionInfo,
      environment: primarySession.environment,
      track_data: primarySession.trackData ?? [],
      high_res_track: primarySession.highResTrack ?? [],
      maneuvers: primarySession.maneuvers ?? [],
    };
  }, [primarySession]);
  
  // Aggiunto 'start' come possibile vista
  const [currentView, setCurrentView] = useState<'overview' | 'maneuvers' | 'lab' | 'start'>('overview');
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // --- FILTRO TEMPORALE IN UTC ASSOLUTO ---
  // Sorgente di verita' unica per il filtro: un intervallo in millisecondi
  // UTC. La UI mostra i valori in due modi (relativo alla sessione attiva
  // oppure orologio solare HH:MM:SS), entrambi derivati da pendingRange.
  const [useAbsoluteTime, setUseAbsoluteTime] = useState(false);
  const [pendingRange, setPendingRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [debouncedRange, setDebouncedRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Parsing robusto del timestamp ISO restituito dal backend: supporta sia
  // 'YYYY-MM-DD HH:MM:SS' che 'YYYY-MM-DDTHH:MM:SS[Z]'. In Python pandas
  // restituisce la forma con spazio, l'aggiungiamo Z per forzare UTC.
  const parseIsoMs = (s: string): number => {
    const norm = s.replace(' ', 'T');
    return new Date(norm.endsWith('Z') ? norm : norm + 'Z').getTime();
  };

  // Bounds globali: unione di [session_start, session_end] delle sessioni
  // ready. Usati per inizializzare il filtro al primo caricamento e per
  // fare il clamp quando si aggiungono/rimuovono sessioni.
  const globalBounds = useMemo<{ startMs: number; endMs: number } | null>(() => {
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const s of sessions) {
      if (s.status !== 'ready' || !s.sessionInfo) continue;
      const startMs = parseIsoMs(s.sessionInfo.start_time);
      if (Number.isNaN(startMs)) continue;
      const endMs = startMs + s.sessionInfo.duration_seconds * 1000;
      if (startMs < minStart) minStart = startMs;
      if (endMs > maxEnd) maxEnd = endMs;
    }
    if (!isFinite(minStart) || !isFinite(maxEnd)) return null;
    return { startMs: minStart, endMs: maxEnd };
  }, [sessions]);

  // Quando i bounds cambiano (prima sessione, add/remove): inizializza o
  // clampa il range. Clamp sincrono anche sul debouncedRange cosi' l'utente
  // non aspetta 500ms per vedere i grafici riallinearsi.
  useEffect(() => {
    if (!globalBounds) {
      setPendingRange(null);
      setDebouncedRange(null);
      return;
    }
    const clampOrReset = (prev: { startMs: number; endMs: number } | null) => {
      if (!prev) return { startMs: globalBounds.startMs, endMs: globalBounds.endMs };
      const start = Math.max(globalBounds.startMs, Math.min(prev.startMs, globalBounds.endMs));
      const end = Math.max(globalBounds.startMs, Math.min(prev.endMs, globalBounds.endMs));
      if (end <= start) return { startMs: globalBounds.startMs, endMs: globalBounds.endMs };
      return { startMs: start, endMs: end };
    };
    setPendingRange(clampOrReset);
    setDebouncedRange(clampOrReset);
  }, [globalBounds]);

  // Debounce: pendingRange → debouncedRange dopo 500ms di inattivita'.
  useEffect(() => {
    if (!pendingRange) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedRange(pendingRange);
    }, 500);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [pendingRange]);

  // Ancora "tempo 0" per la modalita' relativa: e' la session attiva. Cambiare
  // sessione attiva cambia la lettura (i minuti visualizzati), non il range
  // di filtro sottostante (che resta in UTC assoluto).
  const primaryStartMs = useMemo(() => {
    if (!primarySession?.sessionInfo) return null;
    const ms = parseIsoMs(primarySession.sessionInfo.start_time);
    return Number.isNaN(ms) ? null : ms;
  }, [primarySession]);


  // MOTORE DI TAGLIO — ora lavora su un intervallo UTC assoluto.
  const segmentMetrics = useMemo(() => {
    if (!telemetryData || !debouncedRange) return null;

    const filterStartEpoch = Math.min(debouncedRange.startMs, debouncedRange.endMs);
    const filterEndEpoch = Math.max(debouncedRange.startMs, debouncedRange.endMs);

    const inRange = (ts: string | undefined, includeMissing: boolean) => {
      if (!ts) return includeMissing;
      const t = parseIsoMs(ts);
      return t >= filterStartEpoch && t <= filterEndEpoch;
    };

    const segTrack = telemetryData.track_data.filter((p) => inRange(p.timestamp, true));
    const segHighRes = (telemetryData.high_res_track || []).filter((p) => inRange(p.timestamp, true));
    const segManeuvers = telemetryData.maneuvers.filter((m) => inRange(m.timestamp, false));

    const virate = segManeuvers.filter((m) => m.type.toLowerCase().includes('virata')).length;
    const strambate = segManeuvers.filter((m) => m.type.toLowerCase().includes('strambata')).length;

    const getAvg = (keywords: string[]) => {
      const pts = segTrack.filter((p) => keywords.some(kw => (p.andatura || '').toLowerCase().includes(kw)));
      return pts.length > 0 ? (pts.reduce((acc, p) => acc + p.sog_knots, 0) / pts.length).toFixed(1) : '--';
    };

    return {
      virate,
      strambate,
      bolina: getAvg(['bolina', 'upwind']),
      traverso: getAvg(['traverso', 'reaching']),
      poppa: getAvg(['poppa', 'lasco', 'downwind', 'run', 'broad']),
      filteredManeuvers: segManeuvers,
      filteredTrack: segTrack,
      filteredHighRes: segHighRes
    };
  }, [telemetryData, debouncedRange]);

  // Soglia: 1Hz in mappa solo se la sessione totale dura al massimo 1h.
  // Oltre, fallback al track_data downsampled (0.2Hz) per non appesantire il DOM.
  const MapMemoized = useMemo(() => {
    if (!telemetryData) return null;
    const durationSecs = telemetryData.session_info?.duration_seconds ?? 0;
    const useHighRes = durationSecs <= 3600 && (telemetryData.high_res_track?.length ?? 0) > 0;
    const source = useHighRes
      ? (segmentMetrics ? segmentMetrics.filteredHighRes : telemetryData.high_res_track)
      : (segmentMetrics ? segmentMetrics.filteredTrack : telemetryData.track_data);
    return <TelemetryMap trackData={source} />;
  }, [segmentMetrics, telemetryData]);

  const LabMemoized = useMemo(() => {
    if (!telemetryData) return null;
    return (
      <ManeuverFootprint
        maneuvers={segmentMetrics ? segmentMetrics.filteredManeuvers : telemetryData.maneuvers}
        trackData={segmentMetrics ? segmentMetrics.filteredTrack : telemetryData.track_data}
        highResTrack={segmentMetrics ? segmentMetrics.filteredHighRes : (telemetryData.high_res_track || [])}
      />
    );
  }, [segmentMetrics, telemetryData]);


  const genId = () =>
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Upload N file in parallelo. Ogni file genera subito un placeholder
  // 'loading' in state cosi' l'utente vede il progresso nella SessionsBar;
  // poi fetch in Promise.all, ogni risposta aggiorna il suo placeholder in
  // 'ready' o 'error' indipendentemente dagli altri.
  const handleFilesUpload = async (files: FileList) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    // Pre-assegna id + colore per ogni file (il colore tiene conto degli slot
    // gia' occupati dalle sessioni esistenti e da quelle in questa stessa batch).
    const usedColors = sessions.map(s => s.color);
    const placeholders: SessionData[] = [];
    for (const file of fileArr) {
      const runningColors = [...usedColors, ...placeholders.map(p => p.color)];
      placeholders.push({
        id: genId(),
        fileName: file.name,
        label: file.name.replace(/\.(fit|csv)$/i, ''),
        color: assignColor(runningColors),
        visible: true,
        status: 'loading',
      });
    }

    setSessions(prev => [...prev, ...placeholders]);
    if (!activeSessionId && placeholders.length > 0) {
      setActiveSessionId(placeholders[0].id);
    }
    setIsUploading(true);

    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";

    await Promise.all(
      placeholders.map(async (ph, idx) => {
        const file = fileArr[idx];
        const formData = new FormData();
        formData.append("file", file);
        try {
          const response = await fetch(`${apiUrl}/api/analyze`, { method: "POST", body: formData });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data: AnalyzeResponse = await response.json();
          setSessions(prev => prev.map(s =>
            s.id === ph.id
              ? {
                  ...s,
                  status: 'ready' as const,
                  sessionInfo: data.session_info,
                  environment: data.environment,
                  trackData: data.track_data,
                  highResTrack: data.high_res_track,
                  maneuvers: data.maneuvers,
                }
              : s
          ));
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Errore sconosciuto';
          setSessions(prev => prev.map(s =>
            s.id === ph.id ? { ...s, status: 'error' as const, error: msg } : s
          ));
        }
      })
    );

    setIsUploading(false);
  };

  const handleSetActive = (id: string) => setActiveSessionId(id);

  const handleToggleVisible = (id: string) =>
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, visible: !s.visible } : s)));

  const handleRename = (id: string, newLabel: string) =>
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, label: newLabel } : s)));

  const handleRemoveSession = (id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) setActiveSessionId(null);
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
    const loadingCount = sessions.filter(s => s.status === 'loading').length;
    const errorCount = sessions.filter(s => s.status === 'error').length;
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-8">
        <div className="bg-surface p-12 text-center shadow-lg border border-gray-200 max-w-md w-full">
           <h1 className="text-3xl font-serif font-black text-navy-900 mb-2">Varea</h1>
           <p className="text-sm text-gray-500 mb-8">Analisi Telemetrica delle Prestazioni</p>
           <label className="bg-navy-900 text-white px-8 py-4 text-xs font-bold uppercase tracking-widest cursor-pointer hover:bg-navy-800 transition-colors block w-full relative">
              {loadingCount > 0
                ? `Analisi ${loadingCount} file in corso...`
                : 'Carica File .FIT'}
              <input
                type="file"
                multiple
                className="hidden"
                accept=".fit,.FIT,.csv,.CSV"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleFilesUpload(e.target.files);
                  }
                  e.target.value = '';
                }}
                disabled={loadingCount > 0}
              />
           </label>
           {errorCount > 0 && (
             <p className="text-xs text-red-500 mt-4">
               {errorCount} file non analizzati. Controlla che il backend sia acceso e riprova.
             </p>
           )}
        </div>
      </div>
    );
  }

  const { session_info, environment } = telemetryData;
  const isFiltered = segmentMetrics && segmentMetrics.filteredTrack.length < telemetryData.track_data.length;

  // --- Derivati UI del filtro temporale ---
  // Due letture dallo stesso pendingRange: relativa alla sessione attiva
  // (M:S da t=0) oppure orologio solare UTC (HH:MM:SS). Gli handler scrivono
  // sempre su pendingRange; il debounce a monte propaga a debouncedRange
  // dopo 500ms di inattivita', cosi' i grafici non si ricalcolano a ogni tasto.
  const fmtClockUtc = (ms: number) => {
    const d = new Date(ms);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };
  const toMinSec = (ms: number, baseMs: number) => {
    const totalSec = Math.max(0, Math.round((ms - baseMs) / 1000));
    return { min: Math.floor(totalSec / 60), sec: totalSec % 60 };
  };
  const displayStart = pendingRange && primaryStartMs != null
    ? toMinSec(pendingRange.startMs, primaryStartMs)
    : { min: 0, sec: 0 };
  const displayEnd = pendingRange && primaryStartMs != null
    ? toMinSec(pendingRange.endMs, primaryStartMs)
    : { min: 0, sec: 0 };
  const absStartDisplay = pendingRange ? fmtClockUtc(pendingRange.startMs) : '';
  const absEndDisplay = pendingRange ? fmtClockUtc(pendingRange.endMs) : '';
  const maxRelMinutes = globalBounds && primaryStartMs != null
    ? Math.max(0, Math.ceil((globalBounds.endMs - primaryStartMs) / 60000))
    : 0;

  const setStartRelative = (min: number, sec: number) => {
    if (primaryStartMs == null) return;
    const newStart = primaryStartMs + (min * 60 + sec) * 1000;
    setPendingRange(prev => prev ? {
      startMs: newStart,
      endMs: Math.max(newStart + 1000, prev.endMs),
    } : prev);
  };
  const setEndRelative = (min: number, sec: number) => {
    if (primaryStartMs == null) return;
    const newEnd = primaryStartMs + (min * 60 + sec) * 1000;
    setPendingRange(prev => prev ? {
      startMs: Math.min(prev.startMs, newEnd - 1000),
      endMs: newEnd,
    } : prev);
  };

  // Applica HH:MM[:SS] mantenendo la data (UTC) del ms di riferimento.
  const parseClockUtc = (hms: string, referenceMs: number): number | null => {
    const parts = hms.split(':');
    if (parts.length < 2) return null;
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    const ss = parts[2] != null ? Number(parts[2]) : 0;
    if ([hh, mm, ss].some(n => Number.isNaN(n))) return null;
    const ref = new Date(referenceMs);
    return Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hh, mm, ss);
  };
  const setStartAbsolute = (hms: string) => {
    if (!pendingRange) return;
    const newStart = parseClockUtc(hms, pendingRange.startMs);
    if (newStart == null) return;
    setPendingRange(prev => prev ? {
      startMs: newStart,
      endMs: Math.max(newStart + 1000, prev.endMs),
    } : prev);
  };
  const setEndAbsolute = (hms: string) => {
    if (!pendingRange) return;
    let newEnd = parseClockUtc(hms, pendingRange.endMs);
    if (newEnd == null) return;
    // Cross-midnight: se l'ora digitata e' prima dello start, assume giorno successivo.
    if (newEnd <= pendingRange.startMs) newEnd += 24 * 60 * 60 * 1000;
    setPendingRange(prev => prev ? {
      startMs: Math.min(prev.startMs, newEnd - 1000),
      endMs: newEnd,
    } : prev);
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col relative">
      <header className="bg-[#061325] px-6 py-5 flex items-center shadow-md sticky top-0 z-[100]">
        <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="text-gold hover:text-white transition-colors relative z-[110]">
          <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        {isMenuOpen && <div className="fixed inset-0 z-[105]" onClick={() => setIsMenuOpen(false)}></div>}
        {isMenuOpen && (
          <div className="absolute top-16 left-6 mt-2 w-64 bg-white rounded-md shadow-2xl border border-gray-100 overflow-hidden flex flex-col z-[110] transform transition-all duration-200 origin-top-left">
            <button onClick={() => { setCurrentView('overview'); setIsMenuOpen(false); }} className={`text-left px-6 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${currentView === 'overview' ? 'bg-gray-50 text-gold border-l-4 border-gold' : 'text-navy-900 hover:bg-gray-50 border-l-4 border-transparent'}`}>Panoramica Dashboard</button>
            <button onClick={() => { setCurrentView('maneuvers'); setIsMenuOpen(false); }} className={`text-left px-6 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${currentView === 'maneuvers' ? 'bg-gray-50 text-gold border-l-4 border-gold' : 'text-navy-900 hover:bg-gray-50 border-l-4 border-transparent'}`}>Registro Manovre</button>
            <button onClick={() => { setCurrentView('lab'); setIsMenuOpen(false); }} className={`text-left px-6 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${currentView === 'lab' ? 'bg-gray-50 text-gold border-l-4 border-gold' : 'text-navy-900 hover:bg-gray-50 border-l-4 border-transparent'}`}>Laboratorio Traiettorie</button>
            {/* NUOVA VOCE MENU */}
            <button onClick={() => { setCurrentView('start'); setIsMenuOpen(false); }} className={`text-left px-6 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${currentView === 'start' ? 'bg-gray-50 text-gold border-l-4 border-gold' : 'text-navy-900 hover:bg-gray-50 border-l-4 border-transparent'}`}>Analisi Start</button>
          </div>
        )}
      </header>

      <main className="flex-1 w-full bg-paper flex flex-col">

        {/* BARRA SESSIONI: lista delle sessioni caricate con gestione colore/
            label/visibilita'/rimozione + pulsante aggiungi file */}
        <SessionsBar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSetActive={handleSetActive}
          onToggleVisible={handleToggleVisible}
          onRename={handleRename}
          onRemove={handleRemoveSession}
          onAddFiles={handleFilesUpload}
          isUploading={isUploading}
        />

        {/* LA BARRA FILTRI SCOMPARE NELLA VISTA START (Lì c'è un time-picker dedicato) */}
        {currentView !== 'start' && (
          <div className="bg-white border-b border-gray-200 shadow-sm z-[90] relative px-6 lg:px-12 py-4">
            <div className="max-w-[1600px] mx-auto flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-[0.15em] text-navy-900">Filtro Temporale Globale</h3>
                <p className="text-[10px] text-gray-500 mt-0.5">La selezione viene applicata istantaneamente a Mappe, Tabelle e Grafici.</p>
              </div>
              
              <div className="flex flex-col gap-2">
                <div className="flex justify-end">
                  <div className="inline-flex bg-gray-100 rounded p-1">
                    <button onClick={() => setUseAbsoluteTime(false)} className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded ${!useAbsoluteTime ? 'bg-white shadow-sm text-navy-900' : 'text-gray-400'}`}>Timer Relativo</button>
                    <button onClick={() => setUseAbsoluteTime(true)} className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded ${useAbsoluteTime ? 'bg-white shadow-sm text-navy-900' : 'text-gray-400'}`}>Orologio Solare</button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Da:</span>
                    {!useAbsoluteTime ? (
                      <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden">
                        <input
                          type="number" min="0" max={displayEnd.min} placeholder="Min"
                          value={displayStart.min}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '') return;
                            const n = Number(v);
                            if (Number.isNaN(n)) return;
                            setStartRelative(n, displayStart.sec);
                          }}
                          className="w-12 py-1 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                        <span className="text-gray-300 font-bold">:</span>
                        <input
                          type="number" min="0" max="59" placeholder="Sec"
                          value={displayStart.sec}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '') return;
                            const n = Number(v);
                            if (Number.isNaN(n)) return;
                            setStartRelative(displayStart.min, n);
                          }}
                          className="w-12 py-1 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden">
                         <input
                           type="time" step="1"
                           value={absStartDisplay}
                           onChange={(e) => setStartAbsolute(e.target.value)}
                           className="py-1 px-2 bg-transparent text-xs font-bold text-navy-900 outline-none"
                         />
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">A:</span>
                    {!useAbsoluteTime ? (
                      <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden">
                        <input
                          type="number" min={displayStart.min} max={maxRelMinutes} placeholder="Min"
                          value={displayEnd.min}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '') return;
                            const n = Number(v);
                            if (Number.isNaN(n)) return;
                            setEndRelative(n, displayEnd.sec);
                          }}
                          className="w-12 py-1 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                        <span className="text-gray-300 font-bold">:</span>
                        <input
                          type="number" min="0" max="59" placeholder="Sec"
                          value={displayEnd.sec}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '') return;
                            const n = Number(v);
                            if (Number.isNaN(n)) return;
                            setEndRelative(displayEnd.min, n);
                          }}
                          className="w-12 py-1 px-1 bg-transparent text-xs font-bold text-navy-900 outline-none text-center"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden">
                         <input
                           type="time" step="1"
                           value={absEndDisplay}
                           onChange={(e) => setEndAbsolute(e.target.value)}
                           className="py-1 px-2 bg-transparent text-xs font-bold text-navy-900 outline-none"
                         />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- SCHERMATE DELL'APP --- */}
        <div className="flex-1 w-full">
          
          {currentView === 'maneuvers' && segmentMetrics && (
            <Maneuvers
              maneuvers={segmentMetrics.filteredManeuvers}
              highResTrack={segmentMetrics.filteredHighRes}
            />
          )}

          {currentView === 'lab' && (
            <div className="p-6 lg:p-8 max-w-[1600px] mx-auto w-full h-[calc(100vh-160px)]">
              <div className="bg-surface shadow-md h-full flex flex-col border border-gray-200 overflow-hidden rounded-md">
                 <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white">
                   <div>
                     <h3 className="text-lg font-serif font-bold text-navy-900">Laboratorio Traiettorie</h3>
                     <p className="text-[10px] text-gray-500 uppercase tracking-widest mt-1">Seleziona una manovra per analizzare la "radiografia" XY</p>
                   </div>
                 </div>
                 <div className="flex-1 relative flex flex-col overflow-hidden">
                   {LabMemoized}
                 </div>
              </div>
            </div>
          )}

          {/* LA NUOVA VISTA START (Riceve i dati High-Res 1Hz!) */}
          {currentView === 'start' && telemetryData.high_res_track && (
             <StartAnalysis trackData={telemetryData.high_res_track} sessionStart={telemetryData.session_info.start_time} />
          )}

          {currentView === 'overview' && (
            <div className="p-8 lg:p-12 max-w-7xl mx-auto w-full">
              
              <div className="flex gap-4 mb-12">
                <button onClick={handleDownload} className="bg-white text-navy-900 border border-navy-900 px-6 py-3 text-xs font-bold uppercase tracking-widest hover:bg-gray-50 transition-colors">Esporta JSON</button>
                <label className="bg-navy-900 text-white px-6 py-3 text-xs font-bold uppercase tracking-widest cursor-pointer hover:bg-navy-800 transition-colors">
                  {isUploading ? "Caricamento..." : "Aggiungi File .FIT"}
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    accept=".fit,.FIT,.csv,.CSV"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleFilesUpload(e.target.files);
                      }
                      e.target.value = '';
                    }}
                    disabled={isUploading}
                  />
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
                  <p className="text-xs text-gray-500 flex items-center gap-1">
                    {environment.is_estimated ? (
                      <span title="Dato stimato dall'algoritmo GPS" className="w-2 h-2 rounded-full bg-orange-400 inline-block"></span>
                    ) : (
                      <span title="Dato reale fornito da satellite" className="w-2 h-2 rounded-full bg-green-400 inline-block"></span>
                    )}
                    Direzione Vento: {environment.computed_twd_deg}°
                  </p>
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
                    <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-navy-900 mb-6">Velocità Media</h3>
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
                <div className="mt-8">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400 mb-3 ml-1">Metriche Segmento Selezionato</p>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div className="bg-white shadow-sm p-4 rounded border border-gray-100 text-center">
                      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Virate</div>
                      <div className="text-2xl font-serif font-bold text-navy-900">{segmentMetrics.virate}</div>
                    </div>
                    <div className="bg-white shadow-sm p-4 rounded border border-gray-100 text-center">
                      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Strambate</div>
                      <div className="text-2xl font-serif font-bold text-navy-900">{segmentMetrics.strambate}</div>
                    </div>
                    <div className="bg-white shadow-sm p-4 rounded border border-blue-100 text-center">
                      <div className="text-[10px] font-bold text-blue-800 uppercase tracking-widest mb-1">Bolina Avg</div>
                      <div className="text-2xl font-serif font-bold text-blue-900">{segmentMetrics.bolina} <span className="text-xs text-blue-600">kts</span></div>
                    </div>
                    <div className="bg-white shadow-sm p-4 rounded border border-green-100 text-center">
                      <div className="text-[10px] font-bold text-green-800 uppercase tracking-widest mb-1">Traverso Avg</div>
                      <div className="text-2xl font-serif font-bold text-green-900">{segmentMetrics.traverso} <span className="text-xs text-green-600">kts</span></div>
                    </div>
                    <div className="bg-white shadow-sm p-4 rounded border border-purple-100 text-center">
                      <div className="text-[10px] font-bold text-purple-800 uppercase tracking-widest mb-1">Poppa Avg</div>
                      <div className="text-2xl font-serif font-bold text-purple-900">{segmentMetrics.poppa} <span className="text-xs text-purple-600">kts</span></div>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-8 bg-surface shadow-sm min-h-[600px] flex flex-col border border-gray-200">
                  <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                    <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-navy-900">
                      Tracciato GPS {isFiltered ? '(Segmento Filtrato)' : 'Completo'}
                    </h3>
                  </div>
                  <div className="flex-1 w-full relative bg-gray-50">
                    {MapMemoized}
                  </div>
              </div>

            </div>
          )}
        </div>
      </main>
    </div>
  );
}