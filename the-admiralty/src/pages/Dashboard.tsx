import { useState, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import TelemetryMap from '../components/charts/TelemetryMap';
import Maneuvers from './Maneuvers';
import StartAnalysis from './StartAnalysis';
import Lab from './Lab';
import type { SessionData, AnalyzeResponse } from '../types/telemetry';
import { assignColor } from '../data/palette';
import SessionsBar from '../components/SessionsBar';
import Sidebar, { type View } from '../components/Sidebar';
import { parseBackendTimestamp } from '../utils/time';
import { DEFAULT_FLY_THRESHOLD } from '../utils/foiling';

interface DashboardProps {
  // File selezionati nella landing: se presenti l'analisi parte al mount.
  // File[] anziche' FileList: la FileList live dell'input puo' svuotarsi
  // mentre la Landing si smonta, lasciando initialFiles vuota al mount
  // del Dashboard. L'array e' uno snapshot stabile.
  initialFiles?: File[] | null;
}

export default function Dashboard({ initialFiles }: DashboardProps = {}) {
  // Stato multi-sessione. Un caricamento singolo produce un array di 1
  // elemento: il comportamento single-player resta identico.
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Sessione pilota per le viste non ancora multi-atleta.
  const primarySession = useMemo(() => {
    const ready = sessions.filter(s => s.status === 'ready');
    if (ready.length === 0) return null;
    if (activeSessionId) {
      const found = ready.find(s => s.id === activeSessionId);
      if (found) return found;
    }
    return ready[0];
  }, [sessions, activeSessionId]);

  // Shim temporaneo verso la vecchia forma {session_info, ...}.
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

  const [currentView, setCurrentView] = useState<View>('overview');

  // Soglia FLY/TOUCH sollevata qui per essere unica fra Manovre e Laboratorio:
  // entrambe le viste leggono lo stesso valore via getFoilingStatus, cosi' una
  // manovra a 9 kts non puo' essere FLY in una vista e TOUCH nell'altra.
  const [flyThreshold, setFlyThreshold] = useState<number>(DEFAULT_FLY_THRESHOLD);

  // --- FILTRO TEMPORALE IN UTC ASSOLUTO ---
  const [useAbsoluteTime, setUseAbsoluteTime] = useState(false);
  const [pendingRange, setPendingRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [debouncedRange, setDebouncedRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parseIsoMs = (s: string): number => parseBackendTimestamp(s);

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

  const primaryStartMs = useMemo(() => {
    if (!primarySession?.sessionInfo) return null;
    const ms = parseIsoMs(primarySession.sessionInfo.start_time);
    return Number.isNaN(ms) ? null : ms;
  }, [primarySession]);

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
      filteredHighRes: segHighRes,
    };
  }, [telemetryData, debouncedRange]);

  const visibleFilteredSessions = useMemo(() => {
    const visible = sessions.filter(s => s.status === 'ready' && s.visible);
    const range = debouncedRange;
    const inRange = (ts: string | undefined) => {
      if (!range || !ts) return true;
      const t = parseIsoMs(ts);
      if (Number.isNaN(t)) return true;
      return t >= range.startMs && t <= range.endMs;
    };
    return visible.map(s => {
      const trackData = (s.trackData ?? []).filter(p => inRange(p.timestamp));
      const highResTrack = (s.highResTrack ?? []).filter(p => inRange(p.timestamp));
      const maneuvers = (s.maneuvers ?? []).filter(m => inRange(m.timestamp));
      const durationSecs = s.sessionInfo?.duration_seconds ?? 0;
      return {
        id: s.id,
        label: s.label,
        color: s.color,
        durationSecs,
        trackData,
        highResTrack,
        maneuvers,
      };
    });
  }, [sessions, debouncedRange]);

  const MapMemoized = useMemo(() => {
    if (visibleFilteredSessions.length === 0) return null;
    const layers = visibleFilteredSessions.map(s => {
      const useHighRes = s.durationSecs <= 3600 && s.highResTrack.length > 0;
      return {
        id: s.id,
        label: s.label,
        color: s.color,
        points: useHighRes ? s.highResTrack : s.trackData,
      };
    });
    const colorMode: 'speed' | 'session' = visibleFilteredSessions.length === 1 ? 'speed' : 'session';
    return <TelemetryMap layers={layers} colorMode={colorMode} />;
  }, [visibleFilteredSessions]);

  const maneuversSessions = useMemo(() => {
    return visibleFilteredSessions.map(s => ({
      id: s.id,
      label: s.label,
      color: s.color,
      maneuvers: s.maneuvers,
      highResTrack: s.highResTrack,
    }));
  }, [visibleFilteredSessions]);

  const startSessions = useMemo(() => {
    return sessions
      .filter(s => s.status === 'ready' && s.visible && s.highResTrack && s.sessionInfo)
      .map(s => ({
        id: s.id,
        label: s.label,
        color: s.color,
        trackData: s.highResTrack ?? [],
        sessionStart: s.sessionInfo!.start_time,
      }));
  }, [sessions]);

  const labSessions = useMemo(() => {
    return visibleFilteredSessions.map(s => ({
      id: s.id,
      label: s.label,
      color: s.color,
      maneuvers: s.maneuvers,
      trackData: s.trackData,
      highResTrack: s.highResTrack,
    }));
  }, [visibleFilteredSessions]);

  const genId = () =>
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const handleFilesUpload = async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

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

    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';

    await Promise.all(
      placeholders.map(async (ph, idx) => {
        const file = fileArr[idx];
        const formData = new FormData();
        formData.append('file', file);
        try {
          const response = await fetch(`${apiUrl}/api/analyze`, { method: 'POST', body: formData });
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

  // Upload one-shot dei file passati dalla landing. Il ref impedisce il
  // doppio mount di StrictMode (dev) di lanciare due upload identici.
  const initialFilesProcessed = useRef(false);
  useEffect(() => {
    if (initialFilesProcessed.current) return;
    if (!initialFiles || initialFiles.length === 0) return;
    initialFilesProcessed.current = true;
    handleFilesUpload(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(telemetryData, null, 2));
    const downloadNode = document.createElement('a');
    downloadNode.setAttribute('href', dataStr);
    downloadNode.setAttribute('download', `${telemetryData.session_info.file_name}_report.json`);
    document.body.appendChild(downloadNode);
    downloadNode.click();
    downloadNode.remove();
  };

  // ---------- LOADING / ERROR / FALLBACK ----------
  // Volutamente NIENTE upload qui: il file picker vive solo nella landing
  // CTA, cosi' l'utente non si imbatte mai in una "seconda" pagina di
  // upload dopo aver gia' scelto il file. Sfondo navy/oro come la landing
  // per una transizione visiva senza stacco.
  if (!telemetryData) {
    const loadingCount = sessions.filter(s => s.status === 'loading').length;
    const errorCount = sessions.filter(s => s.status === 'error').length;
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-b from-[#02060f] via-[#0a1d36] to-[#0e2a4d] text-[#f5f1e6] p-8">
        <div className="text-center max-w-lg">
          <p className="text-eyebrow uppercase tracking-eyebrow text-[#c9a169] mb-6">Telemetry analytics</p>
          <h1 className="font-serif italic text-5xl sm:text-7xl text-[#f5f1e6] leading-none mb-6 tracking-tighter">Varea</h1>
          <div className="mx-auto h-px w-24 bg-gradient-to-r from-transparent via-[#c9a169] to-transparent mb-8" />
          {loadingCount > 0 ? (
            <>
              <p className="text-lg text-[#f5f1e6]/80 font-sans leading-relaxed mb-2 animate-pulse">
                Analisi della sessione in corso…
              </p>
              <p className="text-sm text-[#f5f1e6]/50 font-sans">
                L'operazione potrebbe richiedere qualche secondo.
              </p>
            </>
          ) : errorCount > 0 ? (
            <>
              <p className="text-lg text-[#f5f1e6]/80 font-sans leading-relaxed mb-2">
                Analisi fallita.
              </p>
              <p className="text-sm text-[#f5f1e6]/50 font-sans">
                Verifica che il backend sia attivo e ricarica la pagina per riprovare.
              </p>
            </>
          ) : (
            <p className="text-lg text-[#f5f1e6]/80 font-sans leading-relaxed">
              Nessuna sessione attiva. Ricarica la pagina per iniziare una nuova analisi.
            </p>
          )}
        </div>
      </div>
    );
  }

  const { session_info, environment } = telemetryData;
  const isFiltered = segmentMetrics && segmentMetrics.filteredTrack.length < telemetryData.track_data.length;
  const sessionDisplayName = session_info.file_name.replace(/\.(fit|FIT)$/, '');
  const durationH = Math.floor(session_info.duration_seconds / 3600);
  const durationM = Math.floor((session_info.duration_seconds % 3600) / 60);

  // ---------- DERIVATI UI DEL FILTRO TEMPORALE ----------
  // Gli orari display sono nel fuso del browser (= fuso di regata per chi
  // rivede le proprie sessioni sul proprio device). I file .FIT memorizzano
  // UTC: parseIsoMs aggiunge 'Z' per ottenere l'epoch corretto, poi qui
  // applichiamo il fuso locale per la resa a schermo.
  const fmtClockLocal = (ms: number) => {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };
  const toHMS = (ms: number, baseMs: number) => {
    const totalSec = Math.max(0, Math.round((ms - baseMs) / 1000));
    return {
      h: Math.floor(totalSec / 3600),
      m: Math.floor((totalSec % 3600) / 60),
      s: totalSec % 60,
      total: totalSec,
    };
  };
  const displayStart = pendingRange && primaryStartMs != null
    ? toHMS(pendingRange.startMs, primaryStartMs)
    : { h: 0, m: 0, s: 0, total: 0 };
  const displayEnd = pendingRange && primaryStartMs != null
    ? toHMS(pendingRange.endMs, primaryStartMs)
    : { h: 0, m: 0, s: 0, total: 0 };
  const absStartDisplay = pendingRange ? fmtClockLocal(pendingRange.startMs) : '';
  const absEndDisplay = pendingRange ? fmtClockLocal(pendingRange.endMs) : '';
  const maxRelSec = globalBounds && primaryStartMs != null
    ? Math.max(0, Math.ceil((globalBounds.endMs - primaryStartMs) / 1000))
    : 0;
  // Sopra 1h la UI min:sec costringe a digitare "240:00": mostro HH:MM:SS.
  const showHours = maxRelSec > 3600;

  const setStartRelativeSec = (totalSec: number) => {
    if (primaryStartMs == null) return;
    const newStart = primaryStartMs + totalSec * 1000;
    setPendingRange(prev => prev ? {
      startMs: newStart,
      endMs: Math.max(newStart + 1000, prev.endMs),
    } : prev);
  };
  const setEndRelativeSec = (totalSec: number) => {
    if (primaryStartMs == null) return;
    const newEnd = primaryStartMs + totalSec * 1000;
    setPendingRange(prev => prev ? {
      startMs: Math.min(prev.startMs, newEnd - 1000),
      endMs: newEnd,
    } : prev);
  };
  // Parsa un HH:MM:SS digitato dall'utente come orario LOCALE, usando la
  // data locale della referenza (serve per non saltare giorno quando il
  // fuso sposta l'istante attraverso mezzanotte UTC).
  const parseClockLocal = (hms: string, referenceMs: number): number | null => {
    const parts = hms.split(':');
    if (parts.length < 2) return null;
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    const ss = parts[2] != null ? Number(parts[2]) : 0;
    if ([hh, mm, ss].some(n => Number.isNaN(n))) return null;
    const ref = new Date(referenceMs);
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hh, mm, ss).getTime();
  };
  // L'ancora e' sempre la data di inizio sessione: <input type="time"> emette
  // un onChange per ogni carattere digitato, producendo valori intermedi come
  // "01:53:23" mentre l'utente sostituisce l'HH di "15:30:04". Se ancorassimo
  // al pendingRange.{start,end}Ms, un intermedio piu' piccolo di start
  // wrappava al giorno successivo e i tasti successivi restavano bloccati
  // nel giorno+1, estendendo la finestra a ~24h.
  const setStartAbsolute = (hms: string) => {
    if (!pendingRange || primaryStartMs == null) return;
    const newStart = parseClockLocal(hms, primaryStartMs);
    if (newStart == null) return;
    setPendingRange(prev => prev ? {
      startMs: newStart,
      endMs: Math.max(newStart + 1000, prev.endMs),
    } : prev);
  };
  const setEndAbsolute = (hms: string) => {
    if (!pendingRange || primaryStartMs == null) return;
    const newEnd = parseClockLocal(hms, primaryStartMs);
    if (newEnd == null) return;
    setPendingRange(prev => prev ? {
      startMs: Math.min(prev.startMs, newEnd - 1000),
      endMs: newEnd,
    } : prev);
  };

  // ---------- RENDER ----------
  return (
    <div className="min-h-screen bg-bg text-ink flex">
      <Sidebar currentView={currentView} onNavigate={setCurrentView} />

      <div className="flex-1 ml-14 flex flex-col min-w-0">
        <Topbar
          viewLabel={VIEW_LABELS[currentView]}
          onDownload={handleDownload}
          onUpload={handleFilesUpload}
          isUploading={isUploading}
        />

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

        {currentView !== 'start' && (
          <FilterBar
            useAbsoluteTime={useAbsoluteTime}
            setUseAbsoluteTime={setUseAbsoluteTime}
            displayStart={displayStart}
            displayEnd={displayEnd}
            absStartDisplay={absStartDisplay}
            absEndDisplay={absEndDisplay}
            maxRelSec={maxRelSec}
            showHours={showHours}
            setStartRelativeSec={setStartRelativeSec}
            setEndRelativeSec={setEndRelativeSec}
            setStartAbsolute={setStartAbsolute}
            setEndAbsolute={setEndAbsolute}
          />
        )}

        <main className="flex-1 w-full">
          {currentView === 'overview' && (
            <div className="px-6 lg:px-12 py-10 max-w-[1500px] mx-auto w-full">
              {/* HEADER SESSIONE — editoriale */}
              <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-8">
                <div className="min-w-0">
                  <p className="eyebrow mb-3">Sessione corrente</p>
                  <h1 className="font-serif italic text-h1 text-ink leading-none truncate">
                    {sessionDisplayName}
                  </h1>
                </div>
                <div className="text-left md:text-right shrink-0">
                  <p className="eyebrow mb-2">Vento reale</p>
                  <div className="flex items-baseline gap-2 md:justify-end">
                    <span className="font-mono tabular text-3xl text-gold leading-none">
                      {environment.computed_twd_deg}
                    </span>
                    <span className="text-eyebrow text-ink-muted">°TWD</span>
                  </div>
                  <p className="text-caption text-ink-muted mt-2 flex items-center gap-2 md:justify-end">
                    <span className={`w-1.5 h-1.5 rounded-full ${environment.is_estimated ? 'bg-amber' : 'bg-sage'}`} />
                    {environment.is_estimated ? 'Stimato GPS' : 'Stormglass'}
                    <span className="text-ink-muted">·</span>
                    <span className="font-mono tabular">{durationH}h {String(durationM).padStart(2, '0')}m</span>
                  </p>
                </div>
              </header>

              <div className="rule-brass mb-10" />

              {/* HERO KPI — 2 metriche giant in mono */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
                <KpiHero
                  label="Velocità di picco"
                  value={session_info.sog_max_kts.toFixed(1)}
                  suffix="kts"
                  sub={`Distanza totale ${session_info.distance_nm} NM`}
                  highlight
                />
                <KpiHero
                  label="Velocità media"
                  value={session_info.sog_avg_kts.toFixed(1)}
                  suffix="kts"
                  sub="Costanza alta"
                />
              </div>

              {/* SEGMENT METRICS — 5 stat neutre */}
              {segmentMetrics && (
                <section className="mb-10">
                  <p className="eyebrow mb-4">Segmento selezionato</p>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <StatCard label="Virate" value={String(segmentMetrics.virate)} />
                    <StatCard label="Strambate" value={String(segmentMetrics.strambate)} />
                    <StatCard label="Bolina" value={segmentMetrics.bolina} unit="kts" />
                    <StatCard label="Traverso" value={segmentMetrics.traverso} unit="kts" />
                    <StatCard label="Poppa" value={segmentMetrics.poppa} unit="kts" />
                  </div>
                </section>
              )}

              {/* MAPPA */}
              <section className="bg-surface-1 border border-border rounded-lg shadow-card overflow-hidden">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                  <h3 className="eyebrow">
                    Tracciato GPS{isFiltered ? ' · segmento filtrato' : ''}
                  </h3>
                </div>
                <div className="relative h-[600px] w-full bg-bg">
                  {MapMemoized}
                </div>
              </section>
            </div>
          )}

          {currentView === 'maneuvers' && (
            <div className="bg-bg text-ink min-h-[60vh]">
              <Maneuvers
                sessions={maneuversSessions}
                flyThreshold={flyThreshold}
                onFlyThresholdChange={setFlyThreshold}
              />
            </div>
          )}

          {currentView === 'lab' && (
            <Lab
              sessions={labSessions}
              flyThreshold={flyThreshold}
              onFlyThresholdChange={setFlyThreshold}
            />
          )}

          {currentView === 'start' && (
            <div className="bg-bg text-ink min-h-[60vh]">
              <StartAnalysis sessions={startSessions} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ============================================================
// SOTTO-COMPONENTI UI
// ============================================================

const VIEW_LABELS: Record<View, string> = {
  overview: 'Panoramica',
  maneuvers: 'Manovre',
  lab: 'Laboratorio',
  start: 'Start',
};

interface TopbarProps {
  viewLabel: string;
  onDownload: () => void;
  onUpload: (files: FileList) => void;
  isUploading: boolean;
}

function Topbar({ viewLabel, onDownload, onUpload, isUploading }: TopbarProps) {
  return (
    <header className="sticky top-0 z-40 h-14 bg-bg/85 backdrop-blur border-b border-border flex items-center px-6 lg:px-12">
      <div className="flex-1 flex items-center gap-3 min-w-0">
        <span className="eyebrow">Varea · Telemetry</span>
        <span className="text-ink-muted">/</span>
        <span className="font-serif italic text-base text-ink truncate">{viewLabel}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onDownload}
          className="text-eyebrow uppercase tracking-eyebrow text-ink-2 hover:text-gold border border-border hover:border-gold rounded-md px-3 py-2 transition-colors duration-220 ease-varea"
        >
          Esporta JSON
        </button>
        <label className="text-eyebrow uppercase tracking-eyebrow bg-ink text-bg hover:bg-gold rounded-md px-3 py-2 cursor-pointer transition-colors duration-220 ease-varea">
          {isUploading ? 'Caricamento…' : '+ Carica .FIT'}
          <input
            type="file"
            multiple
            className="hidden"
            accept=".fit,.FIT,.csv,.CSV"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) onUpload(e.target.files);
              e.target.value = '';
            }}
            disabled={isUploading}
          />
        </label>
      </div>
    </header>
  );
}

interface HMSValue {
  h: number;
  m: number;
  s: number;
  total: number;
}

interface FilterBarProps {
  useAbsoluteTime: boolean;
  setUseAbsoluteTime: (v: boolean) => void;
  displayStart: HMSValue;
  displayEnd: HMSValue;
  absStartDisplay: string;
  absEndDisplay: string;
  maxRelSec: number;
  showHours: boolean;
  setStartRelativeSec: (totalSec: number) => void;
  setEndRelativeSec: (totalSec: number) => void;
  setStartAbsolute: (hms: string) => void;
  setEndAbsolute: (hms: string) => void;
}

function FilterBar(p: FilterBarProps) {
  return (
    <div className="bg-surface-1 border-b border-border px-6 lg:px-12 py-3">
      <div className="max-w-[1500px] mx-auto flex flex-col xl:flex-row justify-between items-start xl:items-center gap-3">
        <div>
          <p className="eyebrow">Filtro temporale</p>
          <p className="text-caption text-ink-muted mt-0.5">Applicato a mappe, tabelle e grafici.</p>
        </div>
        <div className="flex flex-col gap-2 items-end">
          <div className="inline-flex bg-bg border border-border rounded-md p-0.5">
            <button
              onClick={() => p.setUseAbsoluteTime(false)}
              className={`px-3 py-1 text-eyebrow uppercase tracking-eyebrow rounded-sm transition-colors duration-220 ${
                !p.useAbsoluteTime ? 'bg-surface-2 text-ink' : 'text-ink-muted'
              }`}
            >
              Relativo
            </button>
            <button
              onClick={() => p.setUseAbsoluteTime(true)}
              className={`px-3 py-1 text-eyebrow uppercase tracking-eyebrow rounded-sm transition-colors duration-220 ${
                p.useAbsoluteTime ? 'bg-surface-2 text-ink' : 'text-ink-muted'
              }`}
            >
              Orologio
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <FilterField label="Da">
              {!p.useAbsoluteTime ? (
                <RelativeInput
                  value={p.displayStart}
                  showHours={p.showHours}
                  maxSec={p.displayEnd.total}
                  onChange={p.setStartRelativeSec}
                />
              ) : (
                <ClockInput value={p.absStartDisplay} onChange={p.setStartAbsolute} />
              )}
            </FilterField>
            <FilterField label="A">
              {!p.useAbsoluteTime ? (
                <RelativeInput
                  value={p.displayEnd}
                  showHours={p.showHours}
                  minSec={p.displayStart.total}
                  maxSec={p.maxRelSec}
                  onChange={p.setEndRelativeSec}
                />
              ) : (
                <ClockInput value={p.absEndDisplay} onChange={p.setEndAbsolute} />
              )}
            </FilterField>
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}

function RelativeInput({
  value,
  showHours,
  minSec = 0,
  maxSec,
  onChange,
}: {
  value: HMSValue;
  showHours: boolean;
  minSec?: number;
  maxSec: number;
  onChange: (totalSec: number) => void;
}) {
  // onChange emette sempre *totale in secondi*: i tre campi restano
  // indipendenti nella UI ma non possono produrre stati incoerenti perché
  // ricomponiamo il totale ad ogni tasto e il parent clampa agli estremi.
  const emit = (h: number, m: number, s: number) => {
    const total = Math.max(minSec, Math.min(maxSec, h * 3600 + m * 60 + s));
    onChange(total);
  };
  const parse = (raw: string): number | null => {
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  };
  const maxHour = Math.floor(maxSec / 3600);

  return (
    <div className="flex items-center bg-bg border border-border rounded-md focus-within:border-gold overflow-hidden font-mono">
      {showHours && (
        <>
          <input
            type="number"
            min={0}
            max={maxHour}
            value={value.h}
            onChange={(e) => {
              const n = parse(e.target.value);
              if (n !== null) emit(n, value.m, value.s);
            }}
            className="w-10 py-1 px-1 bg-transparent text-body text-ink outline-none text-center tabular"
            aria-label="Ore"
          />
          <span className="text-ink-muted">:</span>
        </>
      )}
      <input
        type="number"
        min={0}
        max={showHours ? 59 : Math.floor(maxSec / 60)}
        value={value.m}
        onChange={(e) => {
          const n = parse(e.target.value);
          if (n !== null) emit(value.h, n, value.s);
        }}
        className="w-12 py-1 px-1 bg-transparent text-body text-ink outline-none text-center tabular"
        aria-label="Minuti"
      />
      <span className="text-ink-muted">:</span>
      <input
        type="number"
        min={0}
        max={59}
        value={value.s}
        onChange={(e) => {
          const n = parse(e.target.value);
          if (n !== null) emit(value.h, value.m, n);
        }}
        className="w-12 py-1 px-1 bg-transparent text-body text-ink outline-none text-center tabular"
        aria-label="Secondi"
      />
    </div>
  );
}

function ClockInput({ value, onChange }: { value: string; onChange: (hms: string) => void }) {
  // Commit su blur/Enter invece di per-keystroke: <input type="time" step="1">
  // emette onChange ad ogni cifra digitata, producendo valori intermedi che,
  // passati al cross-push del parent (end = max(newStart+1s, end)), potevano
  // trascinare l'altro lato della finestra mentre l'utente finiva di scrivere.
  // Stato locale durante l'edit, push al parent solo alla conferma.
  // Re-sync col parent via derived-state (confronto in render) anziche'
  // useEffect+ref: la regola react-hooks/set-state-in-effect vieta setState
  // dentro useEffect; il pattern qui sotto e' equivalente e canonical-React.
  const [local, setLocal] = useState(value);
  const [lastExternal, setLastExternal] = useState(value);

  if (value !== lastExternal) {
    setLastExternal(value);
    setLocal(value);
  }

  const commit = () => {
    if (local !== value) {
      setLastExternal(local);
      onChange(local);
    }
  };

  return (
    <div className="flex items-center bg-bg border border-border rounded-md focus-within:border-gold overflow-hidden font-mono">
      <input
        type="time"
        step="1"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="py-1 px-2 bg-transparent text-body text-ink outline-none tabular"
      />
    </div>
  );
}

interface KpiHeroProps {
  label: string;
  value: string;
  suffix: string;
  sub: string;
  highlight?: boolean;
}

// Card hero: numero giant mono, eyebrow uppercase, brass rule sotto al sub.
// `highlight` disegna una linea brass verticale a sx (richiamo trim Riva).
function KpiHero({ label, value, suffix, sub, highlight }: KpiHeroProps) {
  return (
    <div className="bg-surface-1 border border-border rounded-lg shadow-card p-8 relative overflow-hidden">
      {highlight && <div className="absolute top-0 left-0 w-0.5 h-full bg-gold" />}
      <p className="eyebrow mb-6">{label}</p>
      <div className="flex items-baseline gap-3 mb-6">
        <span className="font-mono text-display tabular text-ink leading-none">{value}</span>
        <span className="text-eyebrow text-gold">{suffix}</span>
      </div>
      <div className="rule-brass pt-3">
        <p className="text-caption text-ink-muted">{sub}</p>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="bg-surface-1 border border-border rounded-md p-4">
      <p className="eyebrow mb-3">{label}</p>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl text-ink tabular leading-none">{value}</span>
        {unit && <span className="text-caption text-ink-muted">{unit}</span>}
      </div>
    </div>
  );
}

