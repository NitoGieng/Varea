import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NoteMarker } from '../components/charts/TelemetryMap';
// TelemetryMap importa Plotly (~3 MB minified): split in chunk separato
// cosi' la Landing e il primo paint non pagano questo peso. Suspense
// fallback piazzato dove il Map e' renderizzato. L'import-type sopra e'
// type-only (erased a build) per non bloccare il chunk split.
const TelemetryMap = lazy(() => import('../components/charts/TelemetryMap'));
import Maneuvers from './Maneuvers';
import StartAnalysis from './StartAnalysis';
import Lab from './Lab';
import type { SessionData, AnalyzeResponse } from '../types/telemetry';
import { assignColor } from '../data/palette';
import SessionsBar from '../components/SessionsBar';
import Sidebar, { type View } from '../components/Sidebar';
import ExportReportModal, { type ExportConfig } from '../components/ExportReportModal';
import GlossaryModal from '../components/GlossaryModal';
import TwdSparkline from '../components/charts/TwdSparkline';
import WindRose from '../components/charts/WindRose';
import SessionSpeedChart from '../components/charts/SessionSpeedChart';
import NotesPanel from '../components/NotesPanel';
import NoteEditPopup from '../components/NoteEditPopup';
import StatusStrip from '../components/StatusStrip';
import { parseBackendTimestamp } from '../utils/time';
import { DEFAULT_FLY_THRESHOLD } from '../utils/foiling';
import { generateSessionReport } from '../utils/pdfExport';
import { useCoachNotes, type CoachNote } from '../utils/notes';

interface DashboardProps {
  // File selezionati nella landing: se presenti l'analisi parte al mount.
  // File[] anziche' FileList: la FileList live dell'input puo' svuotarsi
  // mentre la Landing si smonta, lasciando initialFiles vuota al mount
  // del Dashboard. L'array e' uno snapshot stabile.
  initialFiles?: File[] | null;
}

export default function Dashboard({ initialFiles }: DashboardProps = {}) {
  const { t, i18n } = useTranslation();
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

  // Stato del flusso di export PDF: modale aperta + ultimi valori inseriti
  // dall'utente (sopravvivono alla chiusura cosi' un secondo export non
  // richiede di riscrivere atleta/note).
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  // Glossario tecnico: modal globale apribile dalla Topbar in qualsiasi
  // vista. Stateless lato dati — solo il flag di apertura vive qui.
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);
  const [athleteName, setAthleteName] = useState<string>('');
  const [coachNotes, setCoachNotes] = useState<string>('');

  // Ref per delegare l'export CSV (filtrato per atleta/tipo/risultato) al
  // dropdown della Topbar. Maneuvers vi registra il proprio handler corrente
  // quando montato; la cleanup di useEffect rimette current=null al cambio
  // vista, cosi' la Topbar non puo' chiamare un export sulla vista sbagliata.
  const maneuversCsvExportRef = useRef<(() => void) | null>(null);
  const handleExportCSVFromTopbar = useCallback(() => {
    maneuversCsvExportRef.current?.();
  }, []);

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

  // ---------- COACH NOTES ----------
  // Le note vivono per fileName: cambiare sessione attiva ricarica le note
  // dallo slot localStorage corrispondente. Tutte le viste della Panoramica
  // (grafico SOG, mappa, pannello sotto) condividono questa stessa lista.
  const { notes, addNote, updateNote, deleteNote, numberOf } =
    useCoachNotes(primarySession?.fileName);

  // Stato del popup di nuova/modifica nota nella Panoramica. anchorX/anchorY
  // sono il punto di click in pixel relativi al container .relative del
  // chiamante (SOG chart o mappa); il popup calcola da solo la propria
  // posizione (sopra/sotto/centrato) per restare visibile in viewport.
  // editingId distingue create da edit.
  interface OverviewNotePopup {
    anchorX: number;
    anchorY: number;
    timestampSec: number;
    initialText: string;
    editingId: string | null;
    // Anchor del container: il popup vive in due contenitori diversi
    // (sopra il grafico vs sopra la mappa) e ognuno ha il proprio
    // sistema di coordinate relative. Salviamo qui dove deve renderizzare.
    anchor: 'chart' | 'map';
  }
  const [notePopup, setNotePopup] = useState<OverviewNotePopup | null>(null);

  // ID nota evidenziata (flash 1.4s). Cambia quando l'utente clicca una
  // riga del NotesPanel: il marker corrispondente cresce su grafico e mappa.
  const [highlightedNoteId, setHighlightedNoteId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashHighlight = useCallback((id: string) => {
    setHighlightedNoteId(id);
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(() => setHighlightedNoteId(null), 1400);
  }, []);
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    };
  }, []);

  // Formatter del timestamp nota: HH:MM:SS nel fuso del browser. Usato
  // dal NotesPanel; il popup ne riceve gia' il risultato. Definito qui
  // perche' dipende da primaryStartMs (epoch dell'inizio sessione).
  const formatNoteTimestamp = useCallback((timestampSec: number): string => {
    if (primaryStartMs == null) return `+${timestampSec}s`;
    const d = new Date(primaryStartMs + timestampSec * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }, [primaryStartMs]);

  // Marker delle note sulla mappa: per ogni nota cerca il highResTrack
  // point piu' vicino al timestamp e usa la sua lat/lon. Se non c'e'
  // highResTrack (sessione lunga > 1h), fallback al trackData decimato.
  const noteMarkers = useMemo<NoteMarker[]>(() => {
    if (!primarySession || primaryStartMs == null) return [];
    const tracks = (primarySession.highResTrack && primarySession.highResTrack.length > 0)
      ? primarySession.highResTrack
      : (primarySession.trackData ?? []);
    if (tracks.length === 0) return [];
    const out: NoteMarker[] = [];
    for (const n of notes) {
      const targetMs = primaryStartMs + n.timestampSec * 1000;
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < tracks.length; i++) {
        const ms = parseIsoMs(tracks[i].timestamp);
        if (!Number.isFinite(ms)) continue;
        const diff = Math.abs(ms - targetMs);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      }
      if (bestIdx < 0) continue;
      const p = tracks[bestIdx];
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      out.push({
        id: n.id,
        lat: p.lat,
        lon: p.lon,
        number: numberOf(n.id),
        color: n.color ?? '#c9a169',
      });
    }
    return out;
  }, [notes, primarySession, primaryStartMs, numberOf]);

  // Ref del container .relative che ospita il SOG chart e il popup ancorato:
  // serve a convertire i clientX/Y dei click mappa in coordinate locali.
  const overviewChartContainerRef = useRef<HTMLDivElement>(null);
  const overviewMapContainerRef = useRef<HTMLDivElement>(null);

  // Handler per il click sull'area del SOG chart (Panoramica): apre il
  // popup di nuova nota. anchorX/anchorY sono il punto di click in
  // coordinate del container .relative; sara' il popup a decidere se
  // disegnare sopra/sotto/centrato in base al fit viewport.
  const handleChartClickNote = useCallback((timestampSec: number, pixelX: number, pixelY: number) => {
    setNotePopup({
      anchorX: pixelX,
      anchorY: pixelY,
      timestampSec,
      initialText: '',
      editingId: null,
      anchor: 'chart',
    });
  }, []);

  // Click su un marker esistente nel SOG chart: avvia la modifica.
  const handleNoteMarkerClickInChart = useCallback((note: CoachNote, pixelX: number, pixelY: number) => {
    setNotePopup({
      anchorX: pixelX,
      anchorY: pixelY,
      timestampSec: note.timestampSec,
      initialText: note.text,
      editingId: note.id,
      anchor: 'chart',
    });
  }, []);

  // Click su un punto del tracciato sulla mappa: timestamp ISO viene
  // convertito a "secondi dall'inizio sessione" e si apre il popup di
  // nuova nota ancorato al container mappa.
  const handleMapTrackClick = useCallback((timestampIso: string, clientX: number, clientY: number) => {
    if (primaryStartMs == null) return;
    const ms = parseIsoMs(timestampIso);
    if (!Number.isFinite(ms)) return;
    const t = Math.round((ms - primaryStartMs) / 1000);
    const rect = overviewMapContainerRef.current?.getBoundingClientRect();
    const localX = rect ? clientX - rect.left : clientX;
    const localY = rect ? clientY - rect.top : clientY;
    setNotePopup({
      anchorX: localX,
      anchorY: localY,
      timestampSec: t,
      initialText: '',
      editingId: null,
      anchor: 'map',
    });
  }, [primaryStartMs]);

  // Click su un marker numerato sulla mappa: avvia la modifica della nota.
  const handleMapNoteMarkerClick = useCallback((id: string, clientX: number, clientY: number) => {
    const n = notes.find(x => x.id === id);
    if (!n) return;
    const rect = overviewMapContainerRef.current?.getBoundingClientRect();
    const localX = rect ? clientX - rect.left : clientX;
    const localY = rect ? clientY - rect.top : clientY;
    setNotePopup({
      anchorX: localX,
      anchorY: localY,
      timestampSec: n.timestampSec,
      initialText: n.text,
      editingId: n.id,
      anchor: 'map',
    });
  }, [notes]);

  const handleNotePopupSave = useCallback((text: string) => {
    if (!notePopup) return;
    if (notePopup.editingId) {
      updateNote(notePopup.editingId, text);
      flashHighlight(notePopup.editingId);
    } else {
      const created = addNote(notePopup.timestampSec, text);
      flashHighlight(created.id);
    }
    setNotePopup(null);
  }, [notePopup, addNote, updateNote, flashHighlight]);

  const handleNotePopupDelete = useCallback(() => {
    if (!notePopup?.editingId) return;
    deleteNote(notePopup.editingId);
    setNotePopup(null);
  }, [notePopup, deleteNote]);

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
    // Percentuale tempo per andatura: rapporto fra punti classificati e
    // totale punti del segmento. segTrack e' a 1 punto/5s, ma essendo
    // numeratore e denominatore alla stessa risoluzione il rapporto
    // approssima fedelmente il tempo realmente trascorso in quell'andatura.
    const totalSamples = segTrack.length;
    const getPctTime = (keywords: string[]) => {
      if (totalSamples === 0) return null;
      const pts = segTrack.filter((p) => keywords.some(kw => (p.andatura || '').toLowerCase().includes(kw)));
      return (pts.length / totalSamples) * 100;
    };
    const periodHours = Math.max(0, (filterEndEpoch - filterStartEpoch) / 3_600_000);

    // SOG di picco e medio sul segmento filtrato. Preferiamo l'high-res
    // (1 Hz) per il picco — il decimato a 5s puo' saltare il singolo
    // istante di velocita' massima — e per la media usiamo la stessa
    // sorgente per coerenza fra i due numeri. Fallback al track decimato
    // quando l'high-res non e' disponibile (sessioni > 1h o legacy).
    const sogSource = segHighRes.length > 0 ? segHighRes : segTrack;
    let sogMax: number | null = null;
    let sogAvg: number | null = null;
    if (sogSource.length > 0) {
      let sum = 0;
      let max = -Infinity;
      let count = 0;
      for (const p of sogSource) {
        const v = Number(p.sog_knots);
        if (!Number.isFinite(v)) continue;
        sum += v;
        if (v > max) max = v;
        count += 1;
      }
      if (count > 0) {
        sogMax = max;
        sogAvg = sum / count;
      }
    }

    // VMG aggregata sul segmento filtrato. Stessa fonte di sogMax/sogAvg per
    // coerenza fra metriche. Bolina come signed (cos>0 -> positiva), lasco
    // come |vmg| medio (cos<0 -> negativa, ma l'UI parla di "velocita' verso
    // sottovento" quindi mostriamo il modulo). Punti con vmg_knots null
    // (TWD assente per quel campione) sono saltati: il count effettivo
    // governa il fallback "n/d".
    const isBolina = (s: string | undefined) => /bolina|upwind/i.test(s || '');
    const isLasco = (s: string | undefined) => /poppa|lasco|downwind|run|broad/i.test(s || '');
    let vmgBolinaSum = 0, vmgBolinaCount = 0, vmgBolinaMax: number | null = null;
    let vmgLascoSum = 0, vmgLascoCount = 0;
    let sogBolinaSum = 0, sogBolinaCount = 0;
    let sogLascoSum = 0, sogLascoCount = 0;
    for (const p of sogSource) {
      const andatura = p.andatura;
      const sog = Number(p.sog_knots);
      const vmg = typeof p.vmg_knots === 'number' && Number.isFinite(p.vmg_knots) ? p.vmg_knots : null;
      if (isBolina(andatura)) {
        if (Number.isFinite(sog)) { sogBolinaSum += sog; sogBolinaCount += 1; }
        if (vmg !== null) {
          vmgBolinaSum += vmg;
          vmgBolinaCount += 1;
          if (vmgBolinaMax === null || vmg > vmgBolinaMax) vmgBolinaMax = vmg;
        }
      } else if (isLasco(andatura)) {
        if (Number.isFinite(sog)) { sogLascoSum += sog; sogLascoCount += 1; }
        if (vmg !== null) {
          vmgLascoSum += Math.abs(vmg);
          vmgLascoCount += 1;
        }
      }
    }
    const vmgBolinaAvg = vmgBolinaCount > 0 ? vmgBolinaSum / vmgBolinaCount : null;
    const vmgLascoAvg = vmgLascoCount > 0 ? vmgLascoSum / vmgLascoCount : null;
    const sogBolinaAvgNum = sogBolinaCount > 0 ? sogBolinaSum / sogBolinaCount : null;
    const sogLascoAvgNum = sogLascoCount > 0 ? sogLascoSum / sogLascoCount : null;

    return {
      virate,
      strambate,
      bolina: getAvg(['bolina', 'upwind']),
      traverso: getAvg(['traverso', 'reaching']),
      poppa: getAvg(['poppa', 'lasco', 'downwind', 'run', 'broad']),
      bolinaPct: getPctTime(['bolina', 'upwind']),
      traversoPct: getPctTime(['traverso', 'reaching']),
      poppaPct: getPctTime(['poppa', 'lasco', 'downwind', 'run', 'broad']),
      periodHours,
      filteredManeuvers: segManeuvers,
      filteredTrack: segTrack,
      filteredHighRes: segHighRes,
      sogMax,
      sogAvg,
      vmgBolinaAvg,
      vmgBolinaMax,
      vmgLascoAvg,
      sogBolinaAvgNum,
      sogLascoAvgNum,
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
        // fileName + sessionStartIso accompagnano la sessione cosi' Lab/
        // ManeuverFootprint puo' chiamare useCoachNotes con la chiave
        // corretta e tradurre note.timestampSec in epoch.
        fileName: s.fileName,
        sessionStartIso: s.sessionInfo?.start_time ?? '',
        durationSecs,
        trackData,
        highResTrack,
        maneuvers,
        twd: s.environment?.computed_twd_deg,
        twdTimeline: s.environment?.twd_timeline ?? null,
        environment: s.environment,
      };
    });
  }, [sessions, debouncedRange]);

  // Frequenza adattiva del tracciato in mappa Panoramica: dipende dalla
  // durata del filtro temporale (clock), NON dalla durata totale della
  // sessione. Soglie scelte per leggibilita' visiva senza saturare Plotly:
  //   < 1h    → 1 Hz   (1 punto/s,  max ~3600 punti)
  //   1h - 3h → 0.2 Hz (1 punto/5s, max ~2160 punti)
  //   > 3h    → 0.1 Hz (1 punto/10s, max ~3600 punti su 10h)
  // Aggiornata reattivamente da debouncedRange come il resto della dashboard.
  const mapStepSec = useMemo(() => {
    if (!debouncedRange) return 1;
    const durSec = Math.abs(debouncedRange.endMs - debouncedRange.startMs) / 1000;
    if (durSec < 3600) return 1;
    if (durSec < 10800) return 5;
    return 10;
  }, [debouncedRange]);

  const mapFreqLabel = mapStepSec === 1 ? '1 Hz' : mapStepSec === 5 ? '0.2 Hz' : '0.1 Hz';

  const MapMemoized = useMemo(() => {
    if (visibleFilteredSessions.length === 0) return null;
    const layers = visibleFilteredSessions.map(s => {
      // Sorgente preferita: highResTrack (1 Hz nativo, garantito da api.py).
      // Subsampling per indice uniforme: highResTrack ha esattamente 1
      // sample/sec quindi step in array == mapStepSec. Fallback difensivo
      // su trackData (0.2 Hz) se highResTrack mancasse: lo step in array
      // diventa max(1, round(mapStepSec/5)) per non sovracampionare oltre
      // la sorgente.
      const useHighRes = s.highResTrack.length > 0;
      const source = useHighRes ? s.highResTrack : s.trackData;
      const arrayStep = useHighRes ? mapStepSec : Math.max(1, Math.round(mapStepSec / 5));
      const points = arrayStep === 1 ? source : source.filter((_, i) => i % arrayStep === 0);
      return {
        id: s.id,
        label: s.label,
        color: s.color,
        points,
      };
    });
    // Il TelemetryMap ha un cap interno di sicurezza (DEFAULT_MAX_POINTS) che
    // applicherebbe una decimazione SOPRA la nostra: vanificherebbe la
    // frequenza scelta dall'utente. Passiamo un budget pari ai punti reali
    // (con piccolo margine) cosi' la decimazione interna resta inerte salvo
    // scenari estremi (>1200 punti totali = molti atleti su finestre lunghe).
    const totalPts = layers.reduce((a, l) => a + l.points.length, 0);
    const dynamicMaxPoints = Math.max(1200, totalPts + 200);
    const colorMode: 'speed' | 'session' = visibleFilteredSessions.length === 1 ? 'speed' : 'session';
    // Note allenatore: solo in modalita' speed (single session). I callback
    // sono passati anche con array vuoto cosi' il click su un punto del
    // tracciato apre comunque il popup di nuova nota.
    return (
      <TelemetryMap
        layers={layers}
        colorMode={colorMode}
        maxPoints={dynamicMaxPoints}
        noteMarkers={colorMode === 'speed' ? noteMarkers : undefined}
        highlightedNoteId={highlightedNoteId}
        onTrackClick={colorMode === 'speed' ? handleMapTrackClick : undefined}
        onNoteMarkerClick={colorMode === 'speed' ? handleMapNoteMarkerClick : undefined}
      />
    );
  }, [visibleFilteredSessions, mapStepSec, noteMarkers, highlightedNoteId, handleMapTrackClick, handleMapNoteMarkerClick]);

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
      fileName: s.fileName,
      sessionStartIso: s.sessionStartIso,
      maneuvers: s.maneuvers,
      trackData: s.trackData,
      highResTrack: s.highResTrack,
      twd: s.twd,
      twdTimeline: s.twdTimeline,
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
          const msg = err instanceof Error ? err.message : t('errors.unknown');
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

  // Genera il PDF usando i dati gia' filtrati su debouncedRange e i parametri
  // editati dall'utente nel modale. La soglia foiling editabile nel modale
  // sovrascrive il flyThreshold globale solo per questo export, cosi' un
  // allenatore puo' provare uno scenario "se la soglia fosse 14 kts" senza
  // toccare le altre viste.
  const handleExportReport = async (cfg: ExportConfig) => {
    if (!telemetryData || !debouncedRange) return;
    setAthleteName(cfg.athleteName);
    setCoachNotes(cfg.coachNotes);
    setIsExportModalOpen(false);

    const filterStart = Math.min(debouncedRange.startMs, debouncedRange.endMs);
    const filterEnd = Math.max(debouncedRange.startMs, debouncedRange.endMs);
    const inRange = (ts: string | undefined) => {
      if (!ts) return false;
      const t = parseBackendTimestamp(ts);
      return Number.isFinite(t) && t >= filterStart && t <= filterEnd;
    };
    const filteredTrack = telemetryData.track_data.filter(p => inRange(p.timestamp));
    const filteredHighRes = telemetryData.high_res_track.filter(p => inRange(p.timestamp));
    const filteredManeuvers = telemetryData.maneuvers.filter(m => inRange(m.timestamp));

    // Note allenatore filtrate sulla finestra temporale: solo quelle che
    // cadono dentro l'intervallo selezionato compaiono nel PDF, coerenti
    // col resto del report.
    const sessionStartMsForNotes = parseBackendTimestamp(telemetryData.session_info.start_time);
    const filteredCoachAnnotations = Number.isFinite(sessionStartMsForNotes)
      ? notes.filter(n => {
          const ms = sessionStartMsForNotes + n.timestampSec * 1000;
          return ms >= filterStart && ms <= filterEnd;
        })
      : [];

    try {
      await generateSessionReport({
        sessionInfo: telemetryData.session_info,
        environment: telemetryData.environment,
        trackData: filteredTrack,
        highResTrack: filteredHighRes,
        maneuvers: filteredManeuvers,
        rangeStartMs: filterStart,
        rangeEndMs: filterEnd,
        athleteName: cfg.athleteName,
        flyThreshold: cfg.flyThreshold,
        coachNotes: cfg.coachNotes,
        sessionStartIsoFull: telemetryData.session_info.start_time,
        fileName: telemetryData.session_info.file_name,
        coachAnnotations: filteredCoachAnnotations,
        t,
        locale: i18n.language === 'en' ? 'en-US' : 'it-IT',
      });
    } catch (err) {
      console.error('Export PDF fallito:', err);
      window.alert(t('errors.pdfGenerationFailed'));
    }
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
                {t('loading.analyzing')}
              </p>
              <p className="text-sm text-[#f5f1e6]/50 font-sans">
                {t('loading.analyzingHint')}
              </p>
            </>
          ) : errorCount > 0 ? (
            <>
              <p className="text-lg text-[#f5f1e6]/80 font-sans leading-relaxed mb-2">
                {t('loading.failed')}
              </p>
              <p className="text-sm text-[#f5f1e6]/50 font-sans">
                {t('loading.failedHint')}
              </p>
            </>
          ) : (
            <p className="text-lg text-[#f5f1e6]/80 font-sans leading-relaxed">
              {t('loading.noSession')}
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
          viewLabelKey={VIEW_LABEL_KEYS[currentView]}
          onExportPDF={() => setIsExportModalOpen(true)}
          onExportJSON={handleDownload}
          onExportCSV={currentView === 'maneuvers' ? handleExportCSVFromTopbar : undefined}
          hasSession={!!telemetryData}
          onUpload={handleFilesUpload}
          isUploading={isUploading}
          onOpenGlossary={() => setIsGlossaryOpen(true)}
          // Telltale info: nome del file della sessione attiva. Mostrato
          // a destra della breadcrumb in stile cockpit (mono 10px) insieme
          // alle info di campionamento e fix GPS.
          sessionFileName={telemetryData?.session_info.file_name}
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

        {/* Strip cockpit con metriche di sessione sempre visibili.
            Il primo punto del tracciato fornisce le coordinate di riferimento
            (lat/lon di sessione). Tutto il resto e' tirato dallo stato
            sessione gia' calcolato dal backend. */}
        <StatusStrip
          hasSession={!!telemetryData}
          durationSeconds={telemetryData?.session_info.duration_seconds}
          distanceNm={telemetryData?.session_info.distance_nm}
          twdDeg={telemetryData?.environment.computed_twd_deg}
          isEstimated={telemetryData?.environment.is_estimated}
          lat={telemetryData?.track_data?.[0]?.lat}
          lon={telemetryData?.track_data?.[0]?.lon}
        />

        <main className="flex-1 w-full">
          {currentView === 'overview' && (
            <div className="px-6 lg:px-12 py-10 max-w-[1500px] mx-auto w-full">
              {/* HEADER SESSIONE — editoriale */}
              <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-8">
                <div className="min-w-0">
                  <p className="eyebrow mb-3">{t('overview.currentSession')}</p>
                  <h1 className="font-serif italic text-h1 text-ink leading-none truncate">
                    {sessionDisplayName}
                  </h1>
                </div>
                <div className="text-left md:text-right shrink-0">
                  <p className="eyebrow mb-2">{t('overview.trueWind')}</p>
                  {/* Rosa dei venti accanto al readout numerico, allineati
                      verticalmente al centro. La rosa appare solo quando il
                      backend ha prodotto un TWD finito; il numero a destra
                      resta sempre, anche con TWD == 0. */}
                  <div className="flex items-center gap-4 md:justify-end">
                    {Number.isFinite(environment.computed_twd_deg) && (
                      <WindRose size={112} dir={environment.computed_twd_deg} />
                    )}
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono tabular text-3xl text-gold leading-none">
                        {environment.computed_twd_deg}
                      </span>
                      <span className="text-eyebrow text-ink-muted">{t('overview.twdSuffix')}</span>
                    </div>
                  </div>
                  {/* Pill fonte vento: amber per stima GPS, sage per Stormglass.
                      Volutamente piu' visibile della vecchia riga col pallino:
                      l'utente deve poter capire al volo se i numeri TWD/TWA
                      derivano da osservazione satellitare o da euristica GPS. */}
                  <div className="mt-3 flex items-center gap-2 md:justify-end flex-wrap">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-eyebrow uppercase tracking-eyebrow ${
                        environment.is_estimated
                          ? 'bg-amber/10 border-amber/50 text-amber'
                          : 'bg-sage/10 border-sage/50 text-sage'
                      }`}
                      title={environment.is_estimated
                        ? t('overview.windEstimatedTitle')
                        : t('overview.windObservedTitle')}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${environment.is_estimated ? 'bg-amber' : 'bg-sage'}`} />
                      {environment.is_estimated ? t('overview.estimatedFromGps') : t('overview.fromStormglass')}
                    </span>
                    <span className="text-caption text-ink-muted font-mono tabular">
                      {durationH}h {String(durationM).padStart(2, '0')}m
                    </span>
                  </div>
                  {/* Sparkline TWD oraria: visibile solo con timeline >=2 punti
                      (sessioni multi-orarie con dati Stormglass). La banda
                      gold chiara evidenzia la finestra del filtro temporale
                      Dashboard cosi' l'allenatore vede a quale momento del
                      giorno si riferiscono i numeri della panoramica. */}
                  {environment.twd_timeline && environment.twd_timeline.length >= 2 && (
                    <div className="mt-3 flex flex-col items-start md:items-end gap-1">
                      <TwdSparkline
                        timeline={environment.twd_timeline}
                        highlightStartMs={debouncedRange?.startMs}
                        highlightEndMs={debouncedRange?.endMs}
                      />
                      <span className="text-caption text-ink-muted">
                        {t('overview.windRotation')}
                      </span>
                    </div>
                  )}
                </div>
              </header>

              <div className="rule-brass mb-10" />

              {/* Notice esplicativo: visibile solo quando il vento e' stimato
                  dal GPS, cosi' l'utente capisce che le metriche derivate
                  (TWA, andature, VMG) ereditano l'incertezza dell'euristica
                  invece di essere ancorate a un'osservazione satellitare. */}
              {environment.is_estimated && (
                <div className="mb-10 -mt-4 flex items-start gap-3 px-4 py-3 bg-amber/10 border border-amber/40 rounded-md">
                  <svg
                    className="w-5 h-5 text-amber shrink-0 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.007M12 3.75 2.25 21h19.5L12 3.75Z" />
                  </svg>
                  <div className="text-body text-ink leading-snug">
                    <strong className="font-semibold">{t('overview.windEstimatedHeader')}</strong>{' '}
                    <span className="text-ink-2">
                      {t('overview.windEstimatedDescription')}
                    </span>
                  </div>
                </div>
              )}

              {/* HERO KPI — 2 metriche giant in mono.
                  Picco e media sono SEMPRE calcolati sul segmento del filtro
                  temporale (segmentMetrics.sogMax/sogAvg), coerentemente con
                  manovre, andature e gli altri numeri della Panoramica. Quando
                  il filtro copre tutta la sessione coincidono con i valori
                  dell'header session_info; quando l'utente restringe la
                  finestra si aggiornano in tempo reale. La sub di "picco"
                  resta "Distanza totale" (etichetta esplicita "totale" =
                  intera sessione) per non perdere quel riferimento. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
                <KpiHero
                  label={t('overview.peakSpeed')}
                  value={segmentMetrics?.sogMax != null ? segmentMetrics.sogMax.toFixed(1) : '--'}
                  suffix="kts"
                  sub={t('overview.totalDistance', { value: session_info.distance_nm })}
                />
                <KpiHero
                  label={t('overview.avgSpeed')}
                  value={segmentMetrics?.sogAvg != null ? segmentMetrics.sogAvg.toFixed(1) : '--'}
                  suffix="kts"
                  sub={t('overview.highConsistency')}
                />
              </div>

              {/* SEGMENT METRICS — separati per natura della metrica.
                  Volume (manovre conteggiate) vs performance (velocita'
                  media per andatura): prima erano 5 card paritetiche,
                  ma per un allenatore le velocita' per andatura sono
                  l'informazione diagnostica primaria mentre i conteggi
                  sono contesto. Due gruppi distinti con eyebrow e
                  trattamento visivo differente (accent gold sulle
                  performance) rendono la gerarchia esplicita. */}
              {segmentMetrics && (
                <section className="mb-10 space-y-6">
                  <div>
                    <SectionRule>{t('overview.maneuversVolume')}</SectionRule>
                    <div className="grid grid-cols-2 gap-3 max-w-md">
                      <VolumeCard
                        label={t('overview.tacks')}
                        value={segmentMetrics.virate}
                        periodHours={segmentMetrics.periodHours}
                      />
                      <VolumeCard
                        label={t('overview.gybes')}
                        value={segmentMetrics.strambate}
                        periodHours={segmentMetrics.periodHours}
                      />
                    </div>
                  </div>
                  <div>
                    <SectionRule>{t('overview.speedByPointOfSail')}</SectionRule>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <PerformanceCard
                        label={t('overview.upwind')}
                        value={segmentMetrics.bolina}
                        unit="kts"
                        pctTime={segmentMetrics.bolinaPct}
                      />
                      <PerformanceCard
                        label={t('overview.beamReach')}
                        value={segmentMetrics.traverso}
                        unit="kts"
                        pctTime={segmentMetrics.traversoPct}
                      />
                      <PerformanceCard
                        label={t('overview.downwind')}
                        value={segmentMetrics.poppa}
                        unit="kts"
                        pctTime={segmentMetrics.poppaPct}
                      />
                    </div>
                  </div>
                </section>
              )}

              {/* GRAFICO VELOCITA' + NOTE ALLENATORE.
                  Il chart copre tutta la sessione (non filtrata) cosi'
                  l'allenatore puo' annotare anche fuori dalla finestra
                  temporale corrente. Il pannello note resta sincronizzato
                  con i marker del chart e della mappa. */}
              {primarySession && primaryStartMs != null && (
                <section className="mb-10 space-y-6">
                  <div className="bg-surface-1 border border-border rounded-lg shadow-card overflow-hidden">
                    <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                      <h3 className="eyebrow">{t('overview.sessionSpeed')}</h3>
                      <span className="text-caption text-ink-muted italic">
                        {t('overview.clickToAddNote')}
                      </span>
                    </div>
                    <div ref={overviewChartContainerRef} className="relative px-4 py-4">
                      <SessionSpeedChart
                        track={
                          // Curva SOG ristretta al segmento del filtro temporale
                          // per coerenza con le altre metriche della Panoramica.
                          // Preferiamo l'high-res (1 Hz) per non perdere picchi
                          // brevi; fallback al decimato (5s) quando l'high-res
                          // non e' disponibile.
                          (segmentMetrics && segmentMetrics.filteredHighRes.length > 0)
                            ? segmentMetrics.filteredHighRes
                            : (segmentMetrics?.filteredTrack ?? [])
                        }
                        sessionStartMs={primaryStartMs}
                        notes={notes}
                        numberOf={numberOf}
                        highlightedNoteId={highlightedNoteId}
                        height={240}
                        onChartClick={handleChartClickNote}
                        onNoteClick={handleNoteMarkerClickInChart}
                        useAbsoluteTime={useAbsoluteTime}
                        isWindEstimated={environment.is_estimated}
                      />
                      {notePopup && notePopup.anchor === 'chart' && (
                        <NoteEditPopup
                          anchorX={notePopup.anchorX}
                          anchorY={notePopup.anchorY}
                          timestampDisplay={formatNoteTimestamp(notePopup.timestampSec)}
                          initialText={notePopup.initialText}
                          isEditing={notePopup.editingId !== null}
                          onSave={handleNotePopupSave}
                          onCancel={() => setNotePopup(null)}
                          onDelete={notePopup.editingId ? handleNotePopupDelete : undefined}
                        />
                      )}
                    </div>
                  </div>

                  <NotesPanel
                    notes={notes}
                    numberOf={numberOf}
                    formatTimestamp={formatNoteTimestamp}
                    onEdit={(n) => {
                      // Apri il popup di modifica ancorato al chart, ancorato
                      // al centro orizzontale e leggermente sotto il top: il
                      // popup decidera' da solo se aprirsi sopra o sotto in
                      // base allo spazio. L'utente arriva qui dal pannello,
                      // non dal grafico, quindi non abbiamo coordinate del
                      // click sorgente.
                      const rect = overviewChartContainerRef.current?.getBoundingClientRect();
                      const cx = rect ? rect.width / 2 : 144;
                      const cy = rect ? rect.height / 2 : 120;
                      setNotePopup({
                        anchorX: cx,
                        anchorY: cy,
                        timestampSec: n.timestampSec,
                        initialText: n.text,
                        editingId: n.id,
                        anchor: 'chart',
                      });
                      flashHighlight(n.id);
                    }}
                    onDelete={(id) => {
                      deleteNote(id);
                    }}
                    onHighlight={flashHighlight}
                  />
                </section>
              )}

              {/* VELOCITY MADE GOOD — efficienza reale verso il segnavento.
                  Le card rispettano il filtro temporale del clock come tutte
                  le altre metriche della Panoramica. Bolina mostra la VMG
                  signed (positiva = guadagno verso vento), Lasco mostra |VMG|
                  (positivo "verso sottovento") cosi' i due numeri sono
                  confrontabili a colpo d'occhio. La riga di confronto
                  Vel.media -> VMG aiuta l'allenatore a capire l'efficienza
                  angolare senza dover aprire documentazione. */}
              {segmentMetrics && (
                <section className="mb-10">
                  <SectionRule>{t('overview.vmg')}</SectionRule>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <VmgCard
                      label={t('overview.vmgUpwind')}
                      value={segmentMetrics.vmgBolinaAvg}
                      peak={segmentMetrics.vmgBolinaMax}
                      sogAvg={segmentMetrics.sogBolinaAvgNum}
                      sogLabel={t('overview.avgUpwindSpeed')}
                    />
                    <VmgCard
                      label={t('overview.vmgBroad')}
                      value={segmentMetrics.vmgLascoAvg}
                      peak={null}
                      sogAvg={segmentMetrics.sogLascoAvgNum}
                      sogLabel={t('overview.avgBroadSpeed')}
                    />
                  </div>
                </section>
              )}

              {/* MAPPA */}
              <section className="bg-surface-1 border border-border rounded-lg shadow-card overflow-hidden">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                  <h3 className="eyebrow">
                    {t('overview.gpsTrack')}{isFiltered ? ` · ${t('overview.filteredSegment')}` : ''}
                  </h3>
                </div>
                <div ref={overviewMapContainerRef} className="relative h-[600px] w-full bg-bg">
                  {/* Suspense: alla prima apertura del dashboard scarica
                      il chunk Plotly. Fallback minimalista (no spinner
                      animato) per non sovrastimolare l'attesa breve. */}
                  <Suspense fallback={
                    <div className="absolute inset-0 flex items-center justify-center text-eyebrow uppercase tracking-eyebrow text-ink-muted">
                      {t('common.loadingMap')}
                    </div>
                  }>
                    {MapMemoized}
                  </Suspense>
                  {/* Badge frequenza adattiva: informa l'allenatore della
                      densita' di punti effettivamente renderizzata, utile
                      quando si confronta dettaglio fra finestre temporali
                      diverse. Posizionato in basso a sinistra cosi' non
                      copre la colorbar SOG (lato destro) ne' i marker
                      START/FINE (vicini al primo e ultimo punto). */}
                  <div className="absolute bottom-3 left-3 z-10 px-2 py-1 bg-bg/80 border border-border rounded font-mono tabular text-eyebrow text-ink-muted pointer-events-none">
                    {mapFreqLabel}
                  </div>
                  {notePopup && notePopup.anchor === 'map' && (
                    <NoteEditPopup
                      anchorX={notePopup.anchorX}
                      anchorY={notePopup.anchorY}
                      timestampDisplay={formatNoteTimestamp(notePopup.timestampSec)}
                      initialText={notePopup.initialText}
                      isEditing={notePopup.editingId !== null}
                      onSave={handleNotePopupSave}
                      onCancel={() => setNotePopup(null)}
                      onDelete={notePopup.editingId ? handleNotePopupDelete : undefined}
                    />
                  )}
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
                csvExportRef={maneuversCsvExportRef}
                isWindEstimated={environment.is_estimated}
              />
            </div>
          )}

          {currentView === 'lab' && (
            <Lab
              sessions={labSessions}
              flyThreshold={flyThreshold}
              onFlyThresholdChange={setFlyThreshold}
              isWindEstimated={environment.is_estimated}
            />
          )}

          {currentView === 'start' && (
            <div className="bg-bg text-ink min-h-[60vh]">
              <StartAnalysis sessions={startSessions} />
            </div>
          )}
        </main>
      </div>

      {isExportModalOpen && (
        <ExportReportModal
          onClose={() => setIsExportModalOpen(false)}
          onConfirm={handleExportReport}
          initialFlyThreshold={flyThreshold}
          initialAthleteName={athleteName}
          initialCoachNotes={coachNotes}
          periodSeconds={debouncedRange ? Math.max(0, (debouncedRange.endMs - debouncedRange.startMs) / 1000) : 0}
        />
      )}

      {isGlossaryOpen && (
        <GlossaryModal onClose={() => setIsGlossaryOpen(false)} />
      )}
    </div>
  );
}

// ============================================================
// SOTTO-COMPONENTI UI
// ============================================================

// Chiavi i18n per la breadcrumb del Topbar. La traduzione effettiva avviene
// dentro Topbar via useTranslation, cosi' il cambio lingua aggiorna il label
// senza dover propagare il `t` da Dashboard.
const VIEW_LABEL_KEYS: Record<View, string> = {
  overview: 'navigation.overview',
  maneuvers: 'navigation.maneuvers',
  lab: 'navigation.lab',
  start: 'navigation.start',
};

interface TopbarProps {
  // Chiave i18n della vista corrente (es. 'navigation.overview'). Topbar
  // chiama t() su questa chiave: cambia con la lingua senza re-render forzato
  // da Dashboard.
  viewLabelKey: string;
  // Due azioni: dropdown "Esporta" (secondario, bordo gold) che consolida
  // PDF + JSON + CSV, e "+ Carica .FIT" come primario (filled gold). Il
  // dropdown e' disabilitato finche' non c'e' una sessione caricata: tutte
  // le voci richiedono dati. CSV e' passato solo dalla vista Manovre dove
  // i filtri locali definiscono il dataset esportato.
  onExportPDF: () => void;
  onExportJSON: () => void;
  onExportCSV?: () => void;
  hasSession: boolean;
  onUpload: (files: FileList) => void;
  isUploading: boolean;
  // Apertura del modal Glossario tecnico. Disponibile in tutte le viste:
  // il bottone non dipende dalla presenza di una sessione caricata, e'
  // un riferimento sempre consultabile.
  onOpenGlossary: () => void;
  // Telltale info: nome del file della sessione attiva. Quando assente
  // i tre indicatori (FIT/SAMPLE/GPS FIX) non vengono renderizzati.
  sessionFileName?: string;
}

function Topbar({ viewLabelKey, onExportPDF, onExportJSON, onExportCSV, hasSession, onUpload, isUploading, onOpenGlossary, sessionFileName }: TopbarProps) {
  const { t } = useTranslation();

  // Ordine voci dropdown: PDF in cima (formato narrativo, target principale
  // per l'allenatore), JSON sotto (dump strutturato per analisi esterna),
  // CSV in coda e solo nella vista Manovre dove i filtri locali definiscono
  // il dataset.
  const exportItems: ExportMenuItem[] = [
    { label: t('topbar.exportPdf'), onClick: onExportPDF },
    { label: t('topbar.exportJson'), onClick: onExportJSON },
  ];
  if (onExportCSV) {
    exportItems.push({ label: t('topbar.exportCsv'), onClick: onExportCSV });
  }

  // Stile mono comune ai tre telltale: colore var(--ink-3), uppercase con
  // letter-spacing wide. Il primo non ha bordo sinistro.
  const telltaleBase: React.CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 10,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'rgb(var(--ink-3))',
    paddingLeft: 18,
    paddingRight: 0,
    borderLeft: '1px solid var(--line)',
    whiteSpace: 'nowrap',
  };

  return (
    <header
      className="sticky top-0 z-40 h-14 backdrop-blur flex items-center px-6 lg:px-12"
      style={{
        background: 'rgba(4, 16, 31, 0.85)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div className="flex-1 flex items-center gap-3 min-w-0 overflow-hidden">
        {/* Breadcrumb mono uppercase + nome schermata serif italic. Lo
            stile e' iscritto direttamente perche' i token del cockpit
            (mono 11px, letterspacing 0.12em) non hanno utility tailwind
            esistenti coerenti. */}
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'rgb(var(--ink-3))',
            whiteSpace: 'nowrap',
          }}
        >
          {t('topbar.brand')}
        </span>
        <span style={{ color: 'rgb(var(--ink-4))' }}>/</span>
        <span
          className="font-serif italic truncate"
          style={{ fontSize: 17, color: 'rgb(var(--ink))', lineHeight: 1 }}
        >
          {t(viewLabelKey)}
        </span>

        {/* Telltale a destra della breadcrumb. Visibili solo con sessione
            caricata; il filo sinistro li separa dal nome della schermata. */}
        {sessionFileName && (
          <div className="flex items-center gap-0 ml-4 min-w-0 overflow-hidden">
            <span style={telltaleBase} className="truncate">
              FIT · {sessionFileName}
            </span>
            <span style={telltaleBase}>{t('topbar.telltaleSample')}</span>
            <span style={telltaleBase}>{t('topbar.telltaleGpsFix')}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0 ml-3">
        {/* Selettore lingua IT · EN: piccolo, in mono uppercase, prima del
            Glossario. La scelta viene persistita in localStorage dal
            language detector di i18next (chiave varea_language). */}
        <LanguageSwitcher />
        {/* Trigger Glossario: bottone terziario in stile cockpit, stesso
            footprint di "Esporta" (mono 11px, bordo line-2, hover gold).
            Posizionato prima dell'export per far capire la gerarchia:
            riferimento prima di azione. Non dipende da hasSession. */}
        <button
          type="button"
          onClick={onOpenGlossary}
          aria-label={t('topbar.glossary')}
          className="transition-all duration-220 ease-varea"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            padding: '8px 14px',
            borderRadius: 6,
            border: '1px solid var(--line-2)',
            background: 'transparent',
            color: 'rgb(var(--ink-3))',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgb(var(--ink-3))';
            e.currentTarget.style.color = 'rgb(var(--ink-2))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--line-2)';
            e.currentTarget.style.color = 'rgb(var(--ink-3))';
          }}
        >
          {t('topbar.glossary')}
        </button>
        <ExportMenu items={exportItems} disabled={!hasSession} />
        {/* Bottone primario "+ CARICA .FIT": gold gradient + glow.
            Stile cockpit avionics — il colore testo navy molto scuro per
            contrasto AAA su gold, peso 600. */}
        <label
          className={`cursor-pointer transition-all duration-220 ease-varea ${
            isUploading ? 'opacity-70 cursor-wait' : ''
          }`}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            fontWeight: 600,
            color: '#1a1407',
            background: 'linear-gradient(180deg, #e3c180 0%, #c79b56 100%)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            borderRadius: 6,
            padding: '8px 14px',
            boxShadow: '0 0 14px rgba(212, 175, 110, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
          }}
        >
          {isUploading ? t('common.loading') : `+ ${t('topbar.loadFit')}`}
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

interface ExportMenuItem {
  label: string;
  onClick: () => void;
}

interface ExportMenuProps {
  items: ExportMenuItem[];
  disabled: boolean;
}

// Dropdown export consolidato. Click-outside via mousedown listener montato
// solo quando il menu e' aperto (no listener fantasma quando chiuso). Esc
// chiude. Bordo gold per dare peso di azione secondaria (consolida PDF +
// JSON + CSV); disabilitato senza sessioni caricate.
function ExportMenu({ items, disabled }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Niente "force-close" via setState-in-effect quando disabled=true:
  // basta gateare il pannello con `open && !disabled` qui sotto. Se la
  // sessione viene rimossa col menu aperto, il pannello sparisce ed e'
  // aria-hidden; alla ri-abilitazione torna visibile (inert), ma e' un
  // edge case raro (richiede un disabled→enabled mentre `open=true`).

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { if (!disabled) setOpen(v => !v); }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="transition-all duration-220 ease-varea flex items-center gap-1.5"
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          padding: '8px 14px',
          borderRadius: 6,
          border: '1px solid var(--line-2)',
          background: 'transparent',
          color: disabled ? 'rgb(var(--ink-4))' : 'rgb(var(--ink-2))',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.borderColor = 'var(--line-hot)';
          e.currentTarget.style.color = 'rgb(var(--gold))';
        }}
        onMouseLeave={(e) => {
          if (disabled) return;
          e.currentTarget.style.borderColor = 'var(--line-2)';
          e.currentTarget.style.color = 'rgb(var(--ink-2))';
        }}
      >
        {t('topbar.export')}
        <svg className={`w-3 h-3 transform transition-transform duration-220 ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-1 min-w-[180px] z-50 overflow-hidden"
          style={{
            background: 'rgb(var(--surface-1))',
            border: '1px solid var(--line-2)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(140, 180, 230, 0.04)',
          }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => { item.onClick(); setOpen(false); }}
              className="w-full text-left transition-colors duration-220"
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'rgb(var(--ink-2))',
                padding: '10px 14px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(212, 175, 110, 0.06)';
                e.currentTarget.style.color = 'rgb(var(--gold))';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'rgb(var(--ink-2))';
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Selettore lingua "IT · EN" per la Topbar. Stile mono uppercase coerente
// con i telltale, attivo in gold con underline, inattivo in ink-3.
// La persistenza e' gestita dal language detector di i18next, qui ci limitiamo
// a chiamare changeLanguage e leggere i18n.resolvedLanguage per evidenziare
// la lingua corrente.
function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = (i18n.resolvedLanguage ?? i18n.language ?? 'it').slice(0, 2);

  const baseStyle: React.CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    padding: '4px 8px',
    background: 'transparent',
    cursor: 'pointer',
    transition: 'color 220ms var(--ease-varea, ease), border-color 220ms var(--ease-varea, ease)',
  };

  const renderButton = (lang: 'it' | 'en') => {
    const active = current === lang;
    return (
      <button
        type="button"
        onClick={() => {
          if (current !== lang) i18n.changeLanguage(lang);
        }}
        aria-label={lang === 'it' ? t('common.italian') : t('common.english')}
        aria-pressed={active}
        style={{
          ...baseStyle,
          color: active ? 'rgb(var(--gold))' : 'rgb(var(--ink-3))',
          borderBottom: active ? '1px solid rgb(var(--gold))' : '1px solid transparent',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.color = 'rgb(var(--ink-2))';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.color = 'rgb(var(--ink-3))';
        }}
      >
        {lang.toUpperCase()}
      </button>
    );
  };

  return (
    <div className="flex items-center" aria-label={t('common.language')}>
      {renderButton('it')}
      <span
        aria-hidden
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: 'rgb(var(--ink-4))',
          padding: '0 2px',
        }}
      >
        ·
      </span>
      {renderButton('en')}
    </div>
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
  const { t } = useTranslation();
  return (
    // Sub-bar piatta sul colore di sfondo: nessun pannello distinto
    // dal bg pagina, solo il filo --line di separazione.
    <div
      className="bg-bg px-6 lg:px-12 py-3"
      style={{ borderBottom: '1px solid var(--line)' }}
    >
      <div className="max-w-[1500px] mx-auto flex flex-col xl:flex-row justify-between items-start xl:items-center gap-3">
        <div>
          <p className="eyebrow">{t('filters.temporal')}</p>
          <p className="text-caption text-ink-muted mt-0.5">{t('filters.applied')}</p>
        </div>
        <div className="flex flex-col gap-2 items-end">
          <div className="inline-flex bg-bg border border-border rounded-md p-0.5">
            <button
              onClick={() => p.setUseAbsoluteTime(false)}
              className={`px-3 py-1 text-eyebrow uppercase tracking-eyebrow rounded-sm transition-colors duration-220 ${
                !p.useAbsoluteTime ? 'bg-surface-2 text-ink' : 'text-ink-muted'
              }`}
            >
              {t('filters.relative')}
            </button>
            <button
              onClick={() => p.setUseAbsoluteTime(true)}
              className={`px-3 py-1 text-eyebrow uppercase tracking-eyebrow rounded-sm transition-colors duration-220 ${
                p.useAbsoluteTime ? 'bg-surface-2 text-ink' : 'text-ink-muted'
              }`}
            >
              {t('filters.clock')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <FilterField label={t('filters.from')}>
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
            <FilterField label={t('filters.to')}>
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
  const { t } = useTranslation();
  const hoursAria = t('filters.hoursAria');
  const minutesAria = t('filters.minutesAria');
  const secondsAria = t('filters.secondsAria');
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
            aria-label={hoursAria}
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
        aria-label={minutesAria}
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
        aria-label={secondsAria}
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
}

// Card hero cockpit: gradient navy in basso che sfuma in alto, accent
// gold a sinistra largo 3px (border compound), 4 angolini decorativi
// in --line-2 stile mirino strumento. Numero principale grande in mono
// per coerenza con la lettura di cruscotto.
function KpiHero({ label, value, suffix, sub }: KpiHeroProps) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(20,40,70,0.55) 0%, rgba(10,26,46,0.95) 100%)',
        border: '1px solid var(--line)',
        borderLeft: '3px solid rgb(var(--gold))',
        borderRadius: 'var(--radius-lg)',
        padding: '24px 28px',
      }}
    >
      <CornerBrackets />

      <span
        className="block"
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'rgb(var(--ink-3))',
          marginBottom: 18,
        }}
      >
        {label}
      </span>

      <div className="flex items-start gap-2">
        {/* Numero principale in DM Serif Display italic — taglio editoriale
            che contrasta con la mono dei pannelli "strumento" e dichiara la
            metrica come l'asse principale della Panoramica. La tabular-nums
            mantiene l'allineamento delle cifre fra le due hero affiancate. */}
        <span
          style={{
            fontFamily: 'var(--serif)',
            fontStyle: 'italic',
            fontSize: 64,
            fontWeight: 400,
            color: 'rgb(var(--ink))',
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
        <sup
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'rgb(var(--ink-3))',
            marginLeft: 4,
            marginTop: 6,
            verticalAlign: 'top',
          }}
        >
          {suffix}
        </sup>
      </div>

      {/* Separatore filo --line: divide la metrica dal footer. */}
      <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0' }} />

      <div
        className="flex items-center gap-3 flex-wrap"
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'rgb(var(--ink-3))',
        }}
      >
        <span>{sub}</span>
      </div>
    </div>
  );
}

// Eyebrow di sezione in stile cockpit: la label mono-uppercase a
// sinistra + un filo orizzontale --line che corre fino al margine
// destro. Sostituisce la vecchia <p className="eyebrow"> piatta dove
// vogliamo sottolineare la struttura "pannello strumento".
function SectionRule({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3.5 mb-3.5">
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'rgb(var(--ink-3))',
        }}
      >
        {children}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
    </div>
  );
}

// Quattro angolini decorativi stile mirino strumento. Posizionati
// assoluti nei quattro angoli del contenitore relative+overflow-hidden
// (es. KpiHero). Solo decorazione visiva, nessuna semantica.
function CornerBrackets() {
  const size = 10;
  const color = 'rgba(212,175,110,0.35)';
  const thickness = 1;
  const corner = (pos: 'tl' | 'tr' | 'bl' | 'br'): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      width: size,
      height: size,
      pointerEvents: 'none',
    };
    if (pos === 'tl') return { ...base, top: 6, left: 6, borderTop: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` };
    if (pos === 'tr') return { ...base, top: 6, right: 6, borderTop: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` };
    if (pos === 'bl') return { ...base, bottom: 6, left: 6, borderBottom: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` };
    return { ...base, bottom: 6, right: 6, borderBottom: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` };
  };
  return (
    <>
      <span aria-hidden style={corner('tl')} />
      <span aria-hidden style={corner('tr')} />
      <span aria-hidden style={corner('bl')} />
      <span aria-hidden style={corner('br')} />
    </>
  );
}

// Stile condiviso per le card stat (Volume/Performance/Vmg): gradient
// chiarissimo dall'alto, bordo --line, radius LG, padding cockpit. La
// stessa famiglia visiva tiene compatte conteggi (Virate/Strambate),
// medie per andatura (Bolina/Traverso/Poppa) e VMG senza variare lo
// "stack" ottico delle griglie.
const statCardStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-lg)',
  padding: '14px 16px',
};

const statLabelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'rgb(var(--ink-3))',
  marginBottom: 6,
};

const statValueStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 30,
  fontWeight: 500,
  color: 'rgb(var(--ink))',
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1,
};

const statUnitStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'rgb(var(--ink-3))',
  marginLeft: 6,
};

// Meta riga sotto il numero. Niente min-height: lasciamo che le card si
// dimensionino sul contenuto effettivo. L'allineamento fra card affiancate
// e' garantito dalla griglia (grid items stretchano), non da una baseline
// forzata sulla meta.
const statMetaStyle: React.CSSProperties = {
  marginTop: 4,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'rgb(var(--ink-3))',
  fontVariantNumeric: 'tabular-nums',
};

// Card "volume": metriche di conteggio (numero di manovre). Look neutro,
// dimensione compatta. Subline con la frequenza oraria (es. "18/h")
// calcolata sulla finestra del filtro temporale: aggiunge contesto senza
// distrarre dal numero principale. Soppressa quando il periodo e' troppo
// breve per stabilizzare il tasso (< 6 minuti).
function VolumeCard({
  label,
  value,
  periodHours,
}: {
  label: string;
  value: number;
  periodHours: number;
}) {
  const { t } = useTranslation();
  const showRate = periodHours >= 0.1 && value > 0;
  const rate = showRate ? value / periodHours : null;
  return (
    <div style={statCardStyle}>
      <span style={statLabelStyle}>{label}</span>
      <div className="flex items-baseline">
        <span style={statValueStyle}>{value}</span>
      </div>
      <p style={statMetaStyle}>
        {rate != null ? t('overview.ratePerHour', { value: rate.toFixed(0) }) : '\u00A0'}
      </p>
    </div>
  );
}

// Card "performance": velocita' media per andatura. Stessa famiglia
// visiva delle volume card (la gerarchia ora vive nell'eyebrow di
// sezione, non sull'accent gold della singola card). Subline con la
// percentuale di tempo trascorso in quell'andatura nel periodo
// selezionato: aiuta a distinguere "Poppa 18 kts ma 4% del tempo"
// (lampo isolato) da "Bolina 12 kts e 60% del tempo" (regime dominante
// della sessione).
function PerformanceCard({
  label,
  value,
  unit,
  pctTime,
}: {
  label: string;
  value: string;
  unit: string;
  pctTime: number | null;
}) {
  const { t } = useTranslation();
  return (
    <div style={statCardStyle}>
      <span style={statLabelStyle}>{label}</span>
      <div className="flex items-baseline">
        <span style={statValueStyle}>{value}</span>
        <span style={statUnitStyle}>{unit}</span>
      </div>
      <p style={statMetaStyle}>
        {pctTime != null ? t('overview.percentOfTime', { value: pctTime.toFixed(0) }) : '\u00A0'}
      </p>
    </div>
  );
}

// Card VMG dedicata: stessa famiglia visiva di PerformanceCard ma senza la
// percentuale di tempo (la VMG non e' una "permanenza" ma un'efficienza).
// La riga di confronto sotto il valore mostra la velocita' media della
// stessa andatura, cosi' l'allenatore vede a colpo d'occhio quanto della
// SOG si traduce in guadagno verso vento. La fonte del vento (Stormglass
// vs stimata) e' gia' esposta dal pannello vento in cima alla Panoramica:
// non la ripetiamo qui per non introdurre rumore visivo.
function VmgCard({
  label,
  value,
  peak,
  sogAvg,
  sogLabel,
}: {
  label: string;
  value: number | null;
  peak: number | null;
  sogAvg: number | null;
  sogLabel: string;
}) {
  const { t } = useTranslation();
  const display = value != null && Number.isFinite(value) ? value.toFixed(1) : t('common.na');
  const peakDisplay = peak != null && Number.isFinite(peak) ? peak.toFixed(1) : null;
  const sogDisplay = sogAvg != null && Number.isFinite(sogAvg) ? sogAvg.toFixed(1) : null;
  return (
    <div style={statCardStyle}>
      <span style={statLabelStyle}>{label}</span>
      <div className="flex items-baseline">
        <span style={statValueStyle}>{display}</span>
        <span style={statUnitStyle}>kts</span>
      </div>
      <p style={statMetaStyle}>
        {peakDisplay != null ? t('overview.peakLabel', { value: peakDisplay }) : '\u00A0'}
      </p>
      {sogDisplay != null && value != null && Number.isFinite(value) ? (
        <p
          style={{
            marginTop: 6,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'rgb(var(--ink-3))',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {sogLabel}: <span style={{ color: 'rgb(var(--ink-2))' }}>{sogDisplay}</span> kts
        </p>
      ) : (
        <p
          style={{
            marginTop: 6,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'rgb(var(--ink-4))',
            fontStyle: 'italic',
          }}
        >
          {t('overview.insufficientForComparison')}
        </p>
      )}
    </div>
  );
}

