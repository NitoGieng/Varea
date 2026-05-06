import { useState, useMemo, useEffect, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import ManeuverSpeedChart from '../components/charts/ManeuverSpeedChart';
import FlyThresholdControl from '../components/FlyThresholdControl';
import type { Maneuver, HighResPoint } from '../types/telemetry';
import { parseBackendTimestamp } from '../utils/time';
import { getFoilingStatus } from '../utils/foiling';

// Sessione nel registro manovre. Multi-atleta con un array; con singolo
// elemento si comporta come la versione single-session.
export interface ManeuversSession {
  id: string;
  label: string;
  color: string;
  maneuvers: Maneuver[];
  highResTrack: HighResPoint[];
}

interface Props {
  sessions: ManeuversSession[];
  // Soglia FLY/TOUCH condivisa col Laboratorio: vive in Dashboard cosi' un
  // cambio in una vista si riflette nell'altra. Default = DEFAULT_FLY_THRESHOLD.
  flyThreshold: number;
  onFlyThresholdChange: (v: number) => void;
  // Quando la Topbar deve esporre l'export CSV nel suo dropdown, Dashboard
  // passa un ref. Maneuvers vi registra l'handler corrente (chiuso su
  // filteredManeuvers + flyThreshold) e lo annulla allo smount, cosi' la
  // Topbar non puo' invocare un export stantio quando l'utente lascia la
  // vista. Pattern alternativo (lifting state up) richiederebbe spostare
  // tutto il modello di filtri in Dashboard: piu' ortogonale ma piu' churn.
  csvExportRef?: MutableRefObject<(() => void) | null>;
  // Fonte vento (true = vento stimato dal GPS, false = Stormglass). Usata
  // per il disclaimer nella VMG media leg e nel ManeuverSpeedChart aperto
  // nel modale: nessuno dei due ha contesto sufficiente per inferirla, va
  // passata da Dashboard che ha gia' l'EnvironmentInfo del backend.
  isWindEstimated?: boolean;
}

// Hoistata fuori dal componente: pura, nessuna closure su state. In scope
// modulo cosi' useCallback non deve elencarla nelle deps (e quindi non si
// ricrea ad ogni render perdendo la stabilita' richiesta dal csvExportRef).
const safeTime = (ts: string | undefined): string => {
  if (!ts) return '--:--:--';
  try {
    const ms = parseBackendTimestamp(ts);
    if (isNaN(ms)) return '--:--:--';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '--:--:--';
  }
};

// Manovra arricchita con identita' atleta. ID progressivi assegnati DOPO il
// merge cronologico cosi' #4810 e' sempre la decima in ordine di tempo.
type ManeuverRow = Maneuver & {
  maneuverId: string;
  athleteId: string;
  athleteLabel: string;
  athleteColor: string;
};

// Sotto soglia: leg grouping; sopra: tabella flat paginata (raggruppare legs
// fra pagine porterebbe a legs troncate ripetute, pessima UX).
const ROWS_PER_PAGE = 50;
const PAGINATION_THRESHOLD = 500;

export default function Maneuvers({ sessions, flyThreshold, onFlyThresholdChange, csvExportRef, isWindEstimated }: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'Virata' | 'Strambata'>('ALL');
  const [resultFilter, setResultFilter] = useState<'ALL' | 'FLY' | 'TOUCH'>('ALL');
  const [athleteFilter, setAthleteFilter] = useState<string>('ALL');
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [isAthleteDropdownOpen, setIsAthleteDropdownOpen] = useState(false);
  const [collapsedLegs, setCollapsedLegs] = useState<Record<string, boolean>>({});
  const [selectedManeuver, setSelectedManeuver] = useState<ManeuverRow | null>(null);
  const [page, setPage] = useState(1);

  const isMulti = sessions.length > 1;

  const sessionById = useMemo(() => {
    const m = new Map<string, ManeuversSession>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  // Merge cronologico + ID stabili. Numerare prima del filtro fa si' che lo
  // stesso evento abbia lo stesso ID anche cambiando il filtro atleta.
  const allManeuvers = useMemo<ManeuverRow[]>(() => {
    const flat: Array<Maneuver & { _sid: string; _label: string; _color: string }> = [];
    for (const s of sessions) {
      for (const m of s.maneuvers) {
        flat.push({ ...m, _sid: s.id, _label: s.label, _color: s.color });
      }
    }
    flat.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    return flat.map((m, i) => ({
      ...m,
      maneuverId: `#${4800 + i}`,
      athleteId: m._sid,
      athleteLabel: m._label,
      athleteColor: m._color,
    }));
  }, [sessions]);

  const filteredManeuvers = useMemo(() => {
    return allManeuvers.filter((m) => {
      if (athleteFilter !== 'ALL' && m.athleteId !== athleteFilter) return false;
      if (searchQuery) {
        const time = safeTime(m.timestamp);
        const query = searchQuery.toLowerCase();
        const hay = `${m.maneuverId} ${time} ${m.athleteLabel}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      if (typeFilter !== 'ALL' && m.type !== typeFilter) return false;
      const isFly = m.sog_min != null && getFoilingStatus(m.sog_min, flyThreshold).label === 'FLY';
      if (resultFilter === 'FLY' && !isFly) return false;
      if (resultFilter === 'TOUCH' && isFly) return false;
      return true;
    });
  }, [allManeuvers, searchQuery, typeFilter, resultFilter, athleteFilter, flyThreshold]);

  const isPaginated = filteredManeuvers.length > PAGINATION_THRESHOLD;
  const totalPages = isPaginated ? Math.ceil(filteredManeuvers.length / ROWS_PER_PAGE) : 1;

  // Pagina effettiva clampata: niente useEffect per resettare page quando i
  // filtri riducono il dataset sotto la pagina corrente.
  const safePage = Math.min(Math.max(1, page), Math.max(1, totalPages));
  const visibleRows = isPaginated
    ? filteredManeuvers.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE)
    : filteredManeuvers;

  const legs = useMemo<Array<[string, { maneuvers: ManeuverRow[]; vmgAvg: number | null }]>>(() => {
    if (isPaginated) return [];
    const groups: Record<string, ManeuverRow[]> = {};
    for (const m of visibleRows) {
      if (!m.timestamp) continue;
      const timeStr = safeTime(m.timestamp);
      const hourStr = timeStr !== '--:--:--' ? timeStr.substring(0, 2) : '00';
      const startHour = parseInt(hourStr, 10);
      const safeStartHour = Number.isFinite(startHour) ? startHour : 0;
      const endHour = (safeStartHour + 1) % 24;
      const legName = `Leg ${String(safeStartHour).padStart(2, '0')}:00 — ${String(endHour).padStart(2, '0')}:00`;
      if (!groups[legName]) groups[legName] = [];
      groups[legName].push(m);
    }
    // VMG media per leg: prendiamo i campioni high-res delle sessioni che
    // hanno almeno una manovra nel leg, filtriamo per la stessa ora locale
    // e mediamo |vmg_knots|. Modulo (non signed) cosi' il numero e' positivo
    // sia che il leg sia bolina sia lasco: un singolo indicatore di
    // "efficienza verso/dal vento" comparabile fra leg eterogenei.
    const result: Array<[string, { maneuvers: ManeuverRow[]; vmgAvg: number | null }]> = [];
    for (const [legName, legManeuvers] of Object.entries(groups)) {
      const match = legName.match(/^Leg (\d{2}):/);
      const targetHour = match ? parseInt(match[1], 10) : NaN;
      let vmgAvg: number | null = null;
      if (Number.isFinite(targetHour)) {
        const sids = new Set(legManeuvers.map(m => m.athleteId));
        let sum = 0, count = 0;
        for (const sid of sids) {
          const sess = sessionById.get(sid);
          if (!sess) continue;
          for (const p of sess.highResTrack) {
            const ms = parseBackendTimestamp(p.timestamp);
            if (!Number.isFinite(ms)) continue;
            if (new Date(ms).getHours() !== targetHour) continue;
            const v = typeof p.vmg_knots === 'number' && Number.isFinite(p.vmg_knots) ? p.vmg_knots : null;
            if (v === null) continue;
            sum += Math.abs(v);
            count += 1;
          }
        }
        vmgAvg = count > 0 ? sum / count : null;
      }
      result.push([legName, { maneuvers: legManeuvers, vmgAvg }]);
    }
    return result.sort((a, b) => b[0].localeCompare(a[0]));
  }, [visibleRows, isPaginated, sessionById]);

  const toggleLeg = (legName: string) => {
    setCollapsedLegs(prev => ({ ...prev, [legName]: !prev[legName] }));
  };

  const resetFilters = () => {
    setSearchQuery('');
    setTypeFilter('ALL');
    setResultFilter('ALL');
    setAthleteFilter('ALL');
  };

  const handleExportCSV = useCallback(() => {
    // Escape RFC4180: virgolette, virgole e newline obbligano il quoting
    // del campo. L'athleteLabel e' rinominabile dall'utente — senza escape
    // un nome con la virgola spaccava in due colonne.
    const csvCell = (v: unknown): string => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = ['Atleta', 'Ora', 'Tipo', 'SOG_Ingresso', 'SOG_Minima', 'SOG_Uscita', 'Delta_V', 'Dist_Leg_NM', 'Risultato', 'Durata_Totale_sec', 'TTR_sec', 'TTR_Target_kts'];
    const rows = filteredManeuvers.map(m => {
      const time = safeTime(m.timestamp);
      const isFly = m.sog_min != null && getFoilingStatus(m.sog_min, flyThreshold).label === 'FLY';
      const ttr = m.recovery_time_s != null ? m.recovery_time_s : 'Fail';
      const dur = m.duration_s != null ? m.duration_s : 'Fail';
      return [
        m.athleteLabel,
        time,
        m.type,
        m.sog_in,
        m.sog_min,
        m.sog_out,
        m.delta_v,
        m.leg_distance_nm ?? 0,
        isFly ? 'FLY' : 'TOUCH',
        dur,
        ttr,
        m.ttr_target_sog,
      ].map(csvCell).join(',');
    });
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'registro_manovre_filtrato.csv';
    link.click();
    URL.revokeObjectURL(url);
  }, [filteredManeuvers, flyThreshold]);

  // Registra l'handler nel ref della Topbar finche' la vista Manovre e'
  // montata. Allo smount/cambio vista la cleanup mette current=null cosi'
  // un click sul dropdown da un'altra vista non invocherebbe nulla (anche
  // se la Topbar oggi non espone il CSV item fuori da Manovre).
  useEffect(() => {
    if (!csvExportRef) return;
    csvExportRef.current = handleExportCSV;
    return () => {
      csvExportRef.current = null;
    };
  }, [csvExportRef, handleExportCSV]);

  // Header griglia — riusato da leg grouping e modalita' paginata.
  const headerRow = (
    <div className="grid grid-cols-12 gap-2 px-6 py-2 bg-surface-2 eyebrow border-b border-border">
      <div className="col-span-2">{isMulti ? 'Atleta · Info' : 'Info'}</div>
      <div className="col-span-2">Manovra</div>
      <div className="col-span-1 text-center" title="Velocità ingresso">V.in</div>
      <div className="col-span-1 text-center text-ink" title="Velocità minima">V.min</div>
      <div className="col-span-1 text-center" title="Velocità uscita (+12s)">V.out</div>
      <div className="col-span-1 text-center" title="Durata totale (Discesa + Recupero)">Durata</div>
      <div className="col-span-3 text-center" title="Tempo per recuperare il 50% della V persa">TTR (50%)</div>
      <div className="col-span-1 text-right">ΔV</div>
    </div>
  );

  const renderRow = (m: ManeuverRow) => {
    const isTack = m.type === 'Virata';
    const isPositive = (m.delta_v ?? 0) >= 0;
    const isFly = m.sog_min != null && getFoilingStatus(m.sog_min, flyThreshold).label === 'FLY';
    const timeString = safeTime(m.timestamp);

    return (
      <div
        key={`${m.athleteId}-${m.maneuverId}`}
        onClick={() => setSelectedManeuver(m)}
        className="grid grid-cols-12 gap-2 px-6 py-3.5 items-center hover:bg-surface-2 transition-colors duration-220 cursor-pointer"
      >
        <div className="col-span-2 flex flex-col">
          {isMulti && (
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: m.athleteColor }} />
              <span className="text-eyebrow uppercase tracking-eyebrow text-ink truncate">{m.athleteLabel}</span>
            </div>
          )}
          <span className="text-body font-mono tabular text-ink">{timeString}</span>
          <span className="text-caption font-mono tabular text-ink-muted">
            {m.maneuverId} · {m.leg_distance_nm != null ? m.leg_distance_nm.toFixed(2) : '--'} NM
          </span>
        </div>

        <div className="col-span-2 flex flex-col items-start gap-1.5">
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${isTack ? 'bg-gold' : 'bg-ink-2'}`} />
            <span className="text-body text-ink">{isTack ? 'Virata' : 'Strambata'}</span>
          </div>
          <span className={`text-[9px] uppercase tracking-eyebrow px-1.5 py-0.5 rounded-sm border ${
            isFly ? 'bg-sage/15 text-sage border-sage/30' : 'bg-amber/15 text-amber border-amber/30'
          }`}>
            {isFly ? 'Fly' : 'Touch'}
          </span>
        </div>

        <div className="col-span-1 text-center">
          <span className="font-mono tabular text-body text-ink-2">{m.sog_in != null ? m.sog_in.toFixed(1) : '--'}</span>
        </div>
        <div className="col-span-1 text-center">
          <span className="font-mono tabular text-body-lg text-ink">{m.sog_min != null ? m.sog_min.toFixed(1) : '--'}</span>
        </div>
        <div className="col-span-1 text-center">
          <span className="font-mono tabular text-body text-ink-2">{m.sog_out != null ? m.sog_out.toFixed(1) : '--'}</span>
        </div>

        <div className="col-span-1 text-center flex justify-center">
          {m.duration_s !== 'Fail' && m.duration_s != null ? (
            <span className="font-mono tabular text-body text-ink bg-surface-2 px-2 py-0.5 rounded-sm border border-border">{m.duration_s}s</span>
          ) : (
            <span className="text-caption text-ink-muted">--</span>
          )}
        </div>

        <div className="col-span-3 flex flex-col items-center justify-center">
          {typeof m.recovery_time_s === 'number' ? (
            <>
              <div className="flex items-baseline justify-center">
                <span className="font-mono tabular text-body text-ink">{m.recovery_time_s}</span>
                <span className="text-caption text-ink-muted ml-0.5">s</span>
              </div>
              <span className="text-[9px] text-ink-muted uppercase tracking-eyebrow mt-0.5" title="Velocità target">
                Target {m.ttr_target_sog}
              </span>
            </>
          ) : (
            <span className="text-terra bg-terra/10 px-1.5 py-0.5 rounded-sm text-[9px] uppercase tracking-eyebrow border border-terra/30" title="Mancato recupero">
              {m.recovery_time_s}
            </span>
          )}
        </div>

        <div className={`col-span-1 text-right font-mono tabular text-body ${isPositive ? 'text-sage' : 'text-amber'}`}>
          {isPositive ? '+' : ''}{m.delta_v != null ? m.delta_v.toFixed(1) : '--'}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-bg text-ink min-h-screen pb-20">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12 py-8">

        {/* Header pagina editoriale */}
        <header className="pb-6">
          <p className="eyebrow mb-2">Catalogo manovre</p>
          <h1 className="font-serif italic text-h2 text-ink leading-none">Registro</h1>
          <p className="text-caption text-ink-muted mt-3 max-w-2xl">
            Ogni virata e strambata della finestra temporale corrente, con le metriche
            chiave del motore foiling (V.in / V.min / V.out, TTR 50%, ΔV).
          </p>
        </header>

        <div className="rule-brass mb-6" />

        {/* Search */}
        <div className="relative mb-4">
          <svg className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={isMulti ? 'Cerca ID, orario o atleta…' : 'Cerca ID manovra (es. #4805) o orario…'}
            className="w-full bg-surface-1 border border-border rounded-md py-3 pl-12 pr-4 text-body text-ink placeholder:text-ink-muted focus:border-gold outline-none transition-colors duration-220"
          />
        </div>

        {/* Filtri */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-6 bg-surface-1 border border-border p-4 rounded-md">
          <div className="flex flex-wrap items-center gap-4">

            {isMulti && (
              <div className="flex items-center gap-2 relative">
                <span className="eyebrow">Atleta</span>
                <button
                  onClick={() => setIsAthleteDropdownOpen(!isAthleteDropdownOpen)}
                  className="bg-bg border border-border text-eyebrow uppercase tracking-eyebrow px-3 py-2 rounded-md flex items-center gap-2 text-ink hover:border-gold min-w-[160px] justify-between transition-colors duration-220"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {athleteFilter !== 'ALL' && (
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sessionById.get(athleteFilter)?.color }} />
                    )}
                    <span className="truncate">
                      {athleteFilter === 'ALL' ? 'Tutti' : (sessionById.get(athleteFilter)?.label ?? '—')}
                    </span>
                  </span>
                  <svg className={`w-3 h-3 transform transition-transform duration-220 ${isAthleteDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {isAthleteDropdownOpen && (
                  <div className="absolute top-full left-16 mt-1 w-56 bg-surface-1 border border-border rounded-md shadow-card-md z-50 overflow-hidden">
                    <button
                      onClick={() => { setAthleteFilter('ALL'); setIsAthleteDropdownOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-eyebrow uppercase tracking-eyebrow hover:bg-surface-2 transition-colors duration-220 ${athleteFilter === 'ALL' ? 'text-gold bg-surface-2' : 'text-ink-2'}`}
                    >
                      Tutti gli atleti
                    </button>
                    {sessions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => { setAthleteFilter(s.id); setIsAthleteDropdownOpen(false); }}
                        className={`w-full text-left px-4 py-2 text-eyebrow uppercase tracking-eyebrow hover:bg-surface-2 transition-colors duration-220 flex items-center gap-2 ${athleteFilter === s.id ? 'text-gold bg-surface-2' : 'text-ink-2'}`}
                      >
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                        <span className="truncate">{s.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 relative">
              <span className="eyebrow">Tipo</span>
              <button
                onClick={() => setIsTypeDropdownOpen(!isTypeDropdownOpen)}
                className="bg-bg border border-border text-eyebrow uppercase tracking-eyebrow px-3 py-2 rounded-md flex items-center gap-2 text-ink hover:border-gold min-w-[140px] justify-between transition-colors duration-220"
              >
                {typeFilter === 'ALL' ? 'Tutte' : typeFilter}
                <svg className={`w-3 h-3 transform transition-transform duration-220 ${isTypeDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </button>
              {isTypeDropdownOpen && (
                <div className="absolute top-full left-10 mt-1 w-48 bg-surface-1 border border-border rounded-md shadow-card-md z-50 overflow-hidden">
                  {(['ALL', 'Virata', 'Strambata'] as const).map((type) => (
                    <button
                      key={type}
                      onClick={() => { setTypeFilter(type); setIsTypeDropdownOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-eyebrow uppercase tracking-eyebrow hover:bg-surface-2 transition-colors duration-220 ${typeFilter === type ? 'text-gold bg-surface-2' : 'text-ink-2'}`}
                    >
                      {type === 'ALL' ? 'Tutte le manovre' : type}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="eyebrow">Risultato</span>
              <div className="flex bg-bg border border-border rounded-md overflow-hidden">
                <button
                  onClick={() => setResultFilter('ALL')}
                  className={`text-eyebrow uppercase tracking-eyebrow px-3 py-2 transition-colors duration-220 ${
                    resultFilter === 'ALL' ? 'bg-ink text-bg' : 'text-ink-muted hover:text-ink'
                  }`}
                >Tutti</button>
                <button
                  onClick={() => setResultFilter('FLY')}
                  className={`text-eyebrow uppercase tracking-eyebrow px-3 py-2 transition-colors duration-220 border-l border-border ${
                    resultFilter === 'FLY' ? 'bg-sage/20 text-sage' : 'text-ink-muted hover:text-ink'
                  }`}
                >Fly</button>
                <button
                  onClick={() => setResultFilter('TOUCH')}
                  className={`text-eyebrow uppercase tracking-eyebrow px-3 py-2 transition-colors duration-220 border-l border-border ${
                    resultFilter === 'TOUCH' ? 'bg-amber/20 text-amber' : 'text-ink-muted hover:text-ink'
                  }`}
                >Touch</button>
              </div>
            </div>

            <FlyThresholdControl value={flyThreshold} onChange={onFlyThresholdChange} />

          </div>
        </div>

        {filteredManeuvers.length === 0 ? (
          <div className="text-center py-20 bg-surface-1 border border-border rounded-lg">
            <p className="font-serif italic text-ink-muted mb-2">Nessuna manovra trovata con questi filtri.</p>
            <button onClick={resetFilters} className="text-gold text-eyebrow uppercase tracking-eyebrow hover:underline">
              Resetta filtri
            </button>
          </div>
        ) : isPaginated ? (
          <div className="bg-surface-1 border border-border rounded-md shadow-card overflow-hidden">
            <div className="flex items-center justify-between px-6 py-3 bg-surface-2 border-b border-border">
              <div className="text-caption text-ink-2">
                Pagina <span className="font-mono tabular text-ink">{safePage}</span> di <span className="font-mono tabular">{totalPages}</span>
                <span className="text-ink-muted ml-3 font-mono tabular">
                  ({(safePage - 1) * ROWS_PER_PAGE + 1}–{Math.min(safePage * ROWS_PER_PAGE, filteredManeuvers.length)} di {filteredManeuvers.length})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(Math.max(1, safePage - 1))}
                  disabled={safePage === 1}
                  className="text-eyebrow uppercase tracking-eyebrow px-3 py-1.5 rounded-md border border-border text-ink-2 hover:border-gold hover:text-ink transition-colors duration-220 disabled:opacity-40 disabled:cursor-not-allowed"
                >← Prec</button>
                <button
                  onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  disabled={safePage === totalPages}
                  className="text-eyebrow uppercase tracking-eyebrow px-3 py-1.5 rounded-md border border-border text-ink-2 hover:border-gold hover:text-ink transition-colors duration-220 disabled:opacity-40 disabled:cursor-not-allowed"
                >Succ →</button>
              </div>
            </div>
            {headerRow}
            <div className="divide-y divide-border">
              {visibleRows.map(renderRow)}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {legs.map(([legName, legData], legIndex) => {
              const isCollapsed = collapsedLegs[legName];
              const { maneuvers: legManeuvers, vmgAvg } = legData;
              return (
                <div key={legIndex} className="bg-surface-1 border border-border rounded-md shadow-card overflow-hidden">
                  <button
                    onClick={() => toggleLeg(legName)}
                    className="w-full flex items-center justify-between p-4 bg-surface-2 hover:bg-surface-2/80 transition-colors duration-220"
                  >
                    <div className="flex items-center gap-3">
                      <svg className={`w-4 h-4 text-ink transform transition-transform duration-220 ${isCollapsed ? '-rotate-90' : 'rotate-0'}`} fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                      <h2 className="font-serif italic text-base text-ink">
                        {legName.split(' ')[0]} {legName.split(' ')[1]}
                        <span className="text-ink-muted text-caption ml-2 font-sans not-italic font-mono tabular">{legName.split(' ').slice(2).join(' ')}</span>
                      </h2>
                    </div>
                    {/* Riepilogo leg: VMG media + conteggio manovre. La VMG
                        e' "n/d" se nessun campione high-res del leg aveva
                        TWA valida (TWD assente per quell'ora). */}
                    <div className="flex items-center gap-2">
                      <span
                        className="eyebrow bg-bg px-2 py-1 rounded-sm border border-border"
                        title={`VMG media del leg (modulo, indipendente dall'andatura). ${
                          typeof isWindEstimated === 'boolean'
                            ? (isWindEstimated
                                ? 'Calcolata su vento stimato dal GPS.'
                                : 'Calcolata su vento osservato da Stormglass.')
                            : ''
                        }`.trim()}
                      >
                        <span className="normal-case tracking-normal text-ink-muted">VMG</span>{' '}
                        <span className="font-mono tabular normal-case tracking-normal text-ink">
                          {vmgAvg != null ? vmgAvg.toFixed(1) : 'n/d'}
                        </span>
                        {vmgAvg != null && <span className="normal-case tracking-normal text-ink-muted"> kts</span>}
                      </span>
                      <span className="eyebrow bg-bg px-2 py-1 rounded-sm border border-border">
                        <span className="font-mono tabular normal-case tracking-normal text-ink">{legManeuvers.length}</span> manovre
                      </span>
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div className="border-t border-border">
                      {headerRow}
                      <div className="divide-y divide-border">
                        {legManeuvers.map(renderRow)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal manovra selezionata */}
      {selectedManeuver && (
        <div
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur flex items-center justify-center p-6"
          onClick={() => setSelectedManeuver(null)}
        >
          <div
            className="bg-surface-1 border border-border rounded-lg shadow-card-md w-full max-w-4xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <div className="flex items-center gap-2.5">
                  <div className={`w-2 h-2 rounded-full ${selectedManeuver.type === 'Virata' ? 'bg-gold' : 'bg-ink-2'}`} />
                  <h3 className="font-serif italic text-h2 text-ink leading-none">{selectedManeuver.type}</h3>
                  <span className="text-caption font-mono tabular text-ink-muted">{selectedManeuver.maneuverId}</span>
                </div>
                <div className="eyebrow mt-2 flex items-center gap-2">
                  {isMulti && (
                    <>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedManeuver.athleteColor }} />
                      <span className="text-ink normal-case tracking-normal">{selectedManeuver.athleteLabel}</span>
                      <span className="text-ink-muted">·</span>
                    </>
                  )}
                  <span className="font-mono tabular normal-case tracking-normal text-ink-2">{safeTime(selectedManeuver.timestamp)}</span>
                  <span className="text-ink-muted">·</span>
                  <span>Velocità istante-per-istante</span>
                </div>
              </div>
              <button
                onClick={() => setSelectedManeuver(null)}
                className="text-ink-muted hover:text-ink transition-colors duration-220"
                aria-label="Chiudi"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5">
              <div className="grid grid-cols-5 gap-3 mb-6">
                <ModalStat label="V.in" value={selectedManeuver.sog_in != null ? selectedManeuver.sog_in.toFixed(1) : '--'} />
                <ModalStat label="V.min" value={selectedManeuver.sog_min != null ? selectedManeuver.sog_min.toFixed(1) : '--'} accent="amber" />
                <ModalStat label="V.out" value={selectedManeuver.sog_out != null ? selectedManeuver.sog_out.toFixed(1) : '--'} />
                <ModalStat
                  label="Δ V"
                  value={`${(selectedManeuver.delta_v ?? 0) >= 0 ? '+' : ''}${selectedManeuver.delta_v != null ? selectedManeuver.delta_v.toFixed(1) : '--'}`}
                  accent={(selectedManeuver.delta_v ?? 0) >= 0 ? 'sage' : 'amber'}
                />
                <ModalStat
                  label="TTR (50%)"
                  value={typeof selectedManeuver.recovery_time_s === 'number' ? `${selectedManeuver.recovery_time_s}s` : '—'}
                />
              </div>

              <ManeuverSpeedChart
                maneuver={selectedManeuver}
                highResTrack={sessionById.get(selectedManeuver.athleteId)?.highResTrack ?? []}
                height={320}
                isWindEstimated={isWindEstimated}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModalStat({ label, value, accent }: { label: string; value: string; accent?: 'sage' | 'amber' | 'terra' }) {
  const accentClass =
    accent === 'sage' ? 'text-sage' :
    accent === 'amber' ? 'text-amber' :
    accent === 'terra' ? 'text-terra' :
    'text-ink';
  return (
    <div className="bg-bg border border-border rounded-md p-3 text-center">
      <div className="eyebrow mb-1.5">{label}</div>
      <div className={`font-mono tabular text-body-lg leading-none ${accentClass}`}>{value}</div>
    </div>
  );
}
