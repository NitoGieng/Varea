import { useState, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import TelemetryMap from '../components/charts/TelemetryMap';
import Maneuvers from './Maneuvers';
import StartAnalysis from './StartAnalysis';
import Lab from './Lab';
import type { SessionData, AnalyzeResponse } from '../types/telemetry';
import { assignColor } from '../data/palette';
import SessionsBar from '../components/SessionsBar';

type View = 'overview' | 'maneuvers' | 'lab' | 'start';

export default function Dashboard() {
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

  // --- FILTRO TEMPORALE IN UTC ASSOLUTO ---
  const [useAbsoluteTime, setUseAbsoluteTime] = useState(false);
  const [pendingRange, setPendingRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [debouncedRange, setDebouncedRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parseIsoMs = (s: string): number => {
    const norm = s.replace(' ', 'T');
    return new Date(norm.endsWith('Z') ? norm : norm + 'Z').getTime();
  };

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

  const handleFilesUpload = async (files: FileList) => {
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

  // ---------- EMPTY STATE (nessuna sessione caricata) ----------
  if (!telemetryData) {
    const loadingCount = sessions.filter(s => s.status === 'loading').length;
    const errorCount = sessions.filter(s => s.status === 'error').length;
    return (
      <div className="min-h-screen bg-bg text-ink flex items-center justify-center p-8">
        <div className="bg-surface-1 border border-border rounded-lg shadow-card-md p-12 text-center max-w-md w-full">
          <p className="eyebrow mb-3">Telemetry analytics</p>
          <h1 className="font-serif italic text-h1 text-ink leading-none mb-1">Varea</h1>
          <div className="rule-brass mt-6 mb-8" />
          <label className="block w-full bg-ink text-bg px-8 py-4 text-eyebrow uppercase tracking-eyebrow cursor-pointer hover:bg-gold transition-colors duration-220 ease-varea">
            {loadingCount > 0 ? `Analisi ${loadingCount} file…` : 'Carica file .FIT'}
            <input
              type="file"
              multiple
              className="hidden"
              accept=".fit,.FIT,.csv,.CSV"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) handleFilesUpload(e.target.files);
                e.target.value = '';
              }}
              disabled={loadingCount > 0}
            />
          </label>
          {errorCount > 0 && (
            <p className="text-caption text-terra mt-4">
              {errorCount} file non analizzati. Verifica che il backend sia attivo.
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
  const absStartDisplay = pendingRange ? fmtClockLocal(pendingRange.startMs) : '';
  const absEndDisplay = pendingRange ? fmtClockLocal(pendingRange.endMs) : '';
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
  const setStartAbsolute = (hms: string) => {
    if (!pendingRange) return;
    const newStart = parseClockLocal(hms, pendingRange.startMs);
    if (newStart == null) return;
    setPendingRange(prev => prev ? {
      startMs: newStart,
      endMs: Math.max(newStart + 1000, prev.endMs),
    } : prev);
  };
  const setEndAbsolute = (hms: string) => {
    if (!pendingRange) return;
    let newEnd = parseClockLocal(hms, pendingRange.endMs);
    if (newEnd == null) return;
    if (newEnd <= pendingRange.startMs) newEnd += 24 * 60 * 60 * 1000;
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
            maxRelMinutes={maxRelMinutes}
            setStartRelative={setStartRelative}
            setEndRelative={setEndRelative}
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
              <Maneuvers sessions={maneuversSessions} />
            </div>
          )}

          {currentView === 'lab' && (
            <Lab sessions={labSessions} />
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

interface SidebarProps {
  currentView: View;
  onNavigate: (v: View) => void;
}

// Sidebar collapsibile: 56px collapsed, 240px expanded on hover.
// Group hover sblocca le label e l'expand contemporaneamente.
function Sidebar({ currentView, onNavigate }: SidebarProps) {
  const items: { id: View; label: string; icon: ReactNode }[] = [
    { id: 'overview', label: 'Panoramica', icon: <CompassIcon /> },
    { id: 'maneuvers', label: 'Manovre', icon: <RotateIcon /> },
    { id: 'lab', label: 'Laboratorio', icon: <ScatterIcon /> },
    { id: 'start', label: 'Start', icon: <FlagIcon /> },
  ];

  return (
    <aside className="group fixed left-0 top-0 bottom-0 z-50 w-14 hover:w-60 bg-surface-1 border-r border-border transition-[width] duration-260 ease-varea overflow-hidden flex flex-col">
      <div className="h-14 flex items-center px-4 border-b border-border shrink-0">
        <span className="font-serif italic text-2xl text-gold leading-none w-6 text-center">V</span>
        <span className="ml-3 font-serif italic text-base text-ink whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-220 ease-varea">
          Varea
        </span>
      </div>

      <nav className="py-2 flex-1">
        {items.map(item => {
          const active = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full h-12 flex items-center px-4 relative transition-colors duration-220 ease-varea ${
                active ? 'text-gold' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-gold" />}
              <span className="w-6 h-6 flex items-center justify-center shrink-0">{item.icon}</span>
              <span className="ml-3 text-eyebrow whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-220 ease-varea">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-border h-14 flex items-center px-4 shrink-0">
        <button
          onClick={() => document.documentElement.classList.toggle('dark')}
          className="w-6 h-6 flex items-center justify-center text-ink-muted hover:text-gold transition-colors duration-220"
          title="Inverti tema"
          aria-label="Toggle tema"
        >
          <ThemeIcon />
        </button>
        <span className="ml-3 text-eyebrow text-ink-muted whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-220">
          Tema
        </span>
      </div>
    </aside>
  );
}

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

interface FilterBarProps {
  useAbsoluteTime: boolean;
  setUseAbsoluteTime: (v: boolean) => void;
  displayStart: { min: number; sec: number };
  displayEnd: { min: number; sec: number };
  absStartDisplay: string;
  absEndDisplay: string;
  maxRelMinutes: number;
  setStartRelative: (min: number, sec: number) => void;
  setEndRelative: (min: number, sec: number) => void;
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
                  min={p.displayStart.min}
                  sec={p.displayStart.sec}
                  maxMin={p.displayEnd.min}
                  onMinChange={(n) => p.setStartRelative(n, p.displayStart.sec)}
                  onSecChange={(n) => p.setStartRelative(p.displayStart.min, n)}
                />
              ) : (
                <ClockInput value={p.absStartDisplay} onChange={p.setStartAbsolute} />
              )}
            </FilterField>
            <FilterField label="A">
              {!p.useAbsoluteTime ? (
                <RelativeInput
                  min={p.displayEnd.min}
                  sec={p.displayEnd.sec}
                  minMin={p.displayStart.min}
                  maxMin={p.maxRelMinutes}
                  onMinChange={(n) => p.setEndRelative(n, p.displayEnd.sec)}
                  onSecChange={(n) => p.setEndRelative(p.displayEnd.min, n)}
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
  min,
  sec,
  minMin = 0,
  maxMin,
  onMinChange,
  onSecChange,
}: {
  min: number;
  sec: number;
  minMin?: number;
  maxMin: number;
  onMinChange: (n: number) => void;
  onSecChange: (n: number) => void;
}) {
  const handle = (raw: string, cb: (n: number) => void) => {
    if (raw === '') return;
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    cb(n);
  };
  return (
    <div className="flex items-center bg-bg border border-border rounded-md focus-within:border-gold overflow-hidden font-mono">
      <input
        type="number"
        min={minMin}
        max={maxMin}
        value={min}
        onChange={(e) => handle(e.target.value, onMinChange)}
        className="w-12 py-1 px-1 bg-transparent text-body text-ink outline-none text-center tabular"
      />
      <span className="text-ink-muted">:</span>
      <input
        type="number"
        min={0}
        max={59}
        value={sec}
        onChange={(e) => handle(e.target.value, onSecChange)}
        className="w-12 py-1 px-1 bg-transparent text-body text-ink outline-none text-center tabular"
      />
    </div>
  );
}

function ClockInput({ value, onChange }: { value: string; onChange: (hms: string) => void }) {
  return (
    <div className="flex items-center bg-bg border border-border rounded-md focus-within:border-gold overflow-hidden font-mono">
      <input
        type="time"
        step="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
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

// ============================================================
// ICONE — monoline 20px stroke 1.5
// ============================================================

function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <circle cx="12" cy="12" r="9" />
      <polygon points="14.5,9.5 12,15 9.5,9.5 12,4" fill="currentColor" stroke="none" opacity="0.85" />
    </svg>
  );
}

function RotateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M3 12a9 9 0 0 1 15.5-6.3M21 4v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3M3 20v-5h5" />
    </svg>
  );
}

function ScatterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M3 21h18" />
      <path d="M3 3v18" />
      <circle cx="8" cy="16" r="1.2" fill="currentColor" />
      <circle cx="13" cy="11" r="1.2" fill="currentColor" />
      <circle cx="17" cy="14" r="1.2" fill="currentColor" />
      <circle cx="19" cy="6" r="1.2" fill="currentColor" />
      <circle cx="11" cy="7" r="1.2" fill="currentColor" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" fill="currentColor" stroke="currentColor" opacity="0.85" />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}
