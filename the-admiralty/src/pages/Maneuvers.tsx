import { useState, useMemo } from 'react';
import ManeuverSpeedChart from '../components/charts/ManeuverSpeedChart';
import type { Maneuver, HighResPoint } from '../types/telemetry';

// Una sessione nel registro manovre: la struttura minima necessaria per
// rendering + modal. Nel multi-atleta si passa un array di queste; con un
// solo elemento il registro si comporta come la versione single-session.
export interface ManeuversSession {
  id: string;
  label: string;
  color: string;
  maneuvers: Maneuver[];
  highResTrack: HighResPoint[];
}

interface Props {
  sessions: ManeuversSession[];
}

// Manovra arricchita con identita' dell'atleta. Gli ID progressivi sono
// assegnati dopo il merge-ordinamento cronologico: cosi' #4810 e' sempre
// la decima in ordine di tempo, indipendentemente da chi l'ha eseguita.
type ManeuverRow = Maneuver & {
  maneuverId: string;
  athleteId: string;
  athleteLabel: string;
  athleteColor: string;
};

// Soglie di paginazione. Sotto threshold il registro mantiene il leg grouping
// canonico; sopra passa a tabella flat (raggruppare legs tra pagine porterebbe
// a legs troncate e ripetute, pessima UX con quantita' di dati elevate).
const ROWS_PER_PAGE = 50;
const PAGINATION_THRESHOLD = 500;

export default function Maneuvers({ sessions }: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'Virata' | 'Strambata'>('ALL');
  const [resultFilter, setResultFilter] = useState<'ALL' | 'FLY' | 'TOUCH'>('ALL');
  const [athleteFilter, setAthleteFilter] = useState<string>('ALL'); // session.id oppure 'ALL'
  const [flyThreshold, setFlyThreshold] = useState<number>(12.0);
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [isAthleteDropdownOpen, setIsAthleteDropdownOpen] = useState(false);
  const [collapsedLegs, setCollapsedLegs] = useState<Record<string, boolean>>({});
  const [selectedManeuver, setSelectedManeuver] = useState<ManeuverRow | null>(null);
  const [page, setPage] = useState(1);

  const isMulti = sessions.length > 1;

  const safeTime = (ts: string | undefined) => {
    if (!ts) return "--:--:--";
    try {
      if (ts.includes('T')) return ts.split('T')[1].substring(0, 8);
      if (ts.includes(' ')) return ts.split(' ')[1].substring(0, 8);
      return ts;
    } catch {
      return "--:--:--";
    }
  };

  // Lookup id → session per recuperare highResTrack corretto dal modal.
  const sessionById = useMemo(() => {
    const m = new Map<string, ManeuversSession>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  // Merge globale cronologico + ID progressivo stabile. Numerare dopo il sort
  // fa si' che lo stesso evento abbia lo stesso ID anche cambiando il filtro
  // atleta (filtriamo dopo la numerazione).
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
      const isFly = m.sog_min != null && m.sog_min >= flyThreshold;
      if (resultFilter === 'FLY' && !isFly) return false;
      if (resultFilter === 'TOUCH' && isFly) return false;
      return true;
    });
  }, [allManeuvers, searchQuery, typeFilter, resultFilter, athleteFilter, flyThreshold]);

  const isPaginated = filteredManeuvers.length > PAGINATION_THRESHOLD;
  const totalPages = isPaginated ? Math.ceil(filteredManeuvers.length / ROWS_PER_PAGE) : 1;

  // Pagina effettiva: clampata a [1, totalPages]. Cosi' quando i filtri riducono
  // il dataset sotto la pagina corrente, la UI ricade automaticamente sull'ultima
  // pagina disponibile senza bisogno di un useEffect che resetta page.
  const safePage = Math.min(Math.max(1, page), Math.max(1, totalPages));
  const visibleRows = isPaginated
    ? filteredManeuvers.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE)
    : filteredManeuvers;

  // Leg grouping solo quando non paginato.
  const legs = useMemo<Array<[string, ManeuverRow[]]>>(() => {
    if (isPaginated) return [];
    const groups: Record<string, ManeuverRow[]> = {};
    for (const m of visibleRows) {
      if (!m.timestamp) continue;
      const timeStr = safeTime(m.timestamp);
      const hour = timeStr !== "--:--:--" ? timeStr.substring(0, 2) : "00";
      const legName = `Leg ${hour}:00 — ${parseInt(hour) + 1}:00`;
      if (!groups[legName]) groups[legName] = [];
      groups[legName].push(m);
    }
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
  }, [visibleRows, isPaginated]);

  const toggleLeg = (legName: string) => {
    setCollapsedLegs(prev => ({ ...prev, [legName]: !prev[legName] }));
  };

  const resetFilters = () => {
    setSearchQuery('');
    setTypeFilter('ALL');
    setResultFilter('ALL');
    setAthleteFilter('ALL');
  };

  const handleExportCSV = () => {
    let csv = "Atleta,Ora,Tipo,SOG_Ingresso,SOG_Minima,SOG_Uscita,Delta_V,Dist_Leg_NM,Risultato,Durata_Totale_sec,TTR_sec,TTR_Target_kts\n";
    filteredManeuvers.forEach(m => {
      const time = safeTime(m.timestamp);
      const isFly = m.sog_min != null && m.sog_min >= flyThreshold;
      const ttr = m.recovery_time_s != null ? m.recovery_time_s : "Fail";
      const dur = m.duration_s != null ? m.duration_s : "Fail";
      csv += `${m.athleteLabel},${time},${m.type},${m.sog_in},${m.sog_min},${m.sog_out},${m.delta_v},${m.leg_distance_nm || 0},${isFly ? 'FLY' : 'TOUCH'},${dur},${ttr},${m.ttr_target_sog}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "registro_manovre_filtrato.csv";
    link.click();
  };

  // Intestazione griglia manovre. Riusata da leg grouping e modalita' paginata.
  const headerRow = (
    <div className="grid grid-cols-12 gap-2 px-6 py-2 bg-white text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b border-gray-50">
      <div className="col-span-2">{isMulti ? 'Atleta / Info' : 'Info'}</div>
      <div className="col-span-2">Manovra</div>
      <div className="col-span-1 text-center" title="Velocità Ingresso">V. In</div>
      <div className="col-span-1 text-center text-navy-900" title="Velocità Minima">V. Min</div>
      <div className="col-span-1 text-center" title="Velocità Uscita (+12s)">V. Out</div>
      <div className="col-span-1 text-center" title="Durata totale (Discesa + Recupero)">Durata</div>
      <div className="col-span-3 text-center" title="Tempo per recuperare il 50% della V persa">TTR (50%)</div>
      <div className="col-span-1 text-right">ΔV</div>
    </div>
  );

  const renderRow = (m: ManeuverRow) => {
    const isTack = m.type === 'Virata';
    const isPositive = (m.delta_v ?? 0) >= 0;
    const isFly = m.sog_min != null && m.sog_min >= flyThreshold;
    const timeString = safeTime(m.timestamp);

    return (
      <div
        key={`${m.athleteId}-${m.maneuverId}`}
        onClick={() => setSelectedManeuver(m)}
        className="grid grid-cols-12 gap-2 px-6 py-3.5 items-center hover:bg-gray-50/80 transition-colors cursor-pointer"
      >
        <div className="col-span-2 flex flex-col">
          {isMulti && (
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: m.athleteColor }} />
              <span className="text-[10px] font-bold text-navy-900 truncate">{m.athleteLabel}</span>
            </div>
          )}
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

        <div className="col-span-1 text-center flex justify-center">
          {m.duration_s !== "Fail" && m.duration_s != null ? (
            <span className="text-xs font-bold text-navy-900 bg-gray-100 px-2 py-0.5 rounded">{m.duration_s}s</span>
          ) : (
            <span className="text-[10px] text-gray-400">--</span>
          )}
        </div>

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
            <span className="text-red-400 bg-red-50 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest" title="Mancato recupero">
              {m.recovery_time_s}
            </span>
          )}
        </div>

        <div className={`col-span-1 text-right text-xs font-bold tracking-tight ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
          {isPositive ? '+' : ''}{m.delta_v != null ? m.delta_v.toFixed(1) : '--'}
        </div>
      </div>
    );
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
            placeholder={isMulti ? "Cerca ID, orario o atleta..." : "Cerca ID manovra (es. #4805) o orario..."}
            className="w-full bg-gray-100 border-none rounded-md py-3.5 pl-12 pr-4 text-sm font-medium text-gray-700 focus:ring-2 focus:ring-navy-900 outline-none transition-shadow"
          />
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6 mb-8 bg-gray-50 p-4 rounded-lg border border-gray-100">
          <div className="flex flex-wrap items-center gap-4">

            {isMulti && (
              <div className="flex items-center gap-2 relative">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Atleta:</span>
                <button
                  onClick={() => setIsAthleteDropdownOpen(!isAthleteDropdownOpen)}
                  className="bg-white border border-gray-200 text-xs font-bold px-4 py-2 rounded flex items-center gap-2 text-navy-900 hover:bg-gray-50 min-w-[160px] justify-between"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {athleteFilter !== 'ALL' && (
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sessionById.get(athleteFilter)?.color }} />
                    )}
                    <span className="truncate">
                      {athleteFilter === 'ALL' ? 'TUTTI' : (sessionById.get(athleteFilter)?.label ?? '—')}
                    </span>
                  </span>
                  <svg className={`w-3 h-3 transform transition-transform ${isAthleteDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {isAthleteDropdownOpen && (
                  <div className="absolute top-full left-16 mt-1 w-56 bg-white border border-gray-100 rounded shadow-lg z-50 overflow-hidden">
                    <button
                      onClick={() => { setAthleteFilter('ALL'); setIsAthleteDropdownOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-xs font-bold uppercase tracking-widest hover:bg-gray-50 ${athleteFilter === 'ALL' ? 'text-gold bg-gray-50' : 'text-gray-600'}`}
                    >
                      TUTTI GLI ATLETI
                    </button>
                    {sessions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => { setAthleteFilter(s.id); setIsAthleteDropdownOpen(false); }}
                        className={`w-full text-left px-4 py-2 text-xs font-bold uppercase tracking-widest hover:bg-gray-50 flex items-center gap-2 ${athleteFilter === s.id ? 'text-gold bg-gray-50' : 'text-gray-600'}`}
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
                  {(['ALL', 'Virata', 'Strambata'] as const).map((type) => (
                    <button
                      key={type}
                      onClick={() => { setTypeFilter(type); setIsTypeDropdownOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-xs font-bold uppercase tracking-widest hover:bg-gray-50 ${typeFilter === type ? 'text-gold bg-gray-50' : 'text-gray-600'}`}
                    >
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

        {filteredManeuvers.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-400 italic mb-2">Nessuna manovra trovata con questi filtri.</p>
            <button onClick={resetFilters} className="text-gold text-xs font-bold uppercase tracking-widest hover:underline">
              Resetta Filtri
            </button>
          </div>
        ) : isPaginated ? (
          <div className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-3 bg-gray-50/50 border-b border-gray-100">
              <div className="text-xs text-gray-600">
                Pagina <span className="font-bold text-navy-900">{safePage}</span> di {totalPages}
                <span className="text-gray-400 ml-3">
                  ({(safePage - 1) * ROWS_PER_PAGE + 1}–{Math.min(safePage * ROWS_PER_PAGE, filteredManeuvers.length)} di {filteredManeuvers.length})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(Math.max(1, safePage - 1))}
                  disabled={safePage === 1}
                  className="text-xs font-bold px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >← Prec</button>
                <button
                  onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  disabled={safePage === totalPages}
                  className="text-xs font-bold px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >Succ →</button>
              </div>
            </div>
            {headerRow}
            <div className="divide-y divide-gray-50">
              {visibleRows.map(renderRow)}
            </div>
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
                      {headerRow}
                      <div className="divide-y divide-gray-50">
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

      {selectedManeuver && (
        <div
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setSelectedManeuver(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${selectedManeuver.type === 'Virata' ? 'bg-[#d4af37]' : 'bg-[#718eb2]'}`}></div>
                  <h3 className="text-lg font-serif font-bold text-navy-900">{selectedManeuver.type}</h3>
                  <span className="text-xs text-gray-400 font-mono">{selectedManeuver.maneuverId}</span>
                </div>
                <div className="text-[10px] text-gray-400 uppercase tracking-widest mt-1 flex items-center gap-2">
                  {isMulti && (
                    <>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedManeuver.athleteColor }} />
                      <span className="text-navy-900 normal-case tracking-normal font-bold">{selectedManeuver.athleteLabel}</span>
                      <span>•</span>
                    </>
                  )}
                  <span>{safeTime(selectedManeuver.timestamp)} — Velocità istante-per-istante</span>
                </div>
              </div>
              <button
                onClick={() => setSelectedManeuver(null)}
                className="text-gray-400 hover:text-navy-900 transition-colors"
                aria-label="Chiudi"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-4">
              <div className="grid grid-cols-5 gap-3 mb-6">
                <div className="bg-gray-50 rounded p-3 text-center">
                  <div className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">V. In</div>
                  <div className="text-lg font-serif font-bold text-navy-900">{selectedManeuver.sog_in != null ? selectedManeuver.sog_in.toFixed(1) : '--'}</div>
                </div>
                <div className="bg-red-50 rounded p-3 text-center">
                  <div className="text-[9px] text-red-700 uppercase tracking-widest mb-1">V. Min</div>
                  <div className="text-lg font-serif font-bold text-red-700">{selectedManeuver.sog_min != null ? selectedManeuver.sog_min.toFixed(1) : '--'}</div>
                </div>
                <div className="bg-blue-50 rounded p-3 text-center">
                  <div className="text-[9px] text-blue-700 uppercase tracking-widest mb-1">V. Out</div>
                  <div className="text-lg font-serif font-bold text-blue-700">{selectedManeuver.sog_out != null ? selectedManeuver.sog_out.toFixed(1) : '--'}</div>
                </div>
                <div className="bg-gray-50 rounded p-3 text-center">
                  <div className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">Δ V</div>
                  <div className={`text-lg font-serif font-bold ${(selectedManeuver.delta_v ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {(selectedManeuver.delta_v ?? 0) >= 0 ? '+' : ''}{selectedManeuver.delta_v != null ? selectedManeuver.delta_v.toFixed(1) : '--'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded p-3 text-center">
                  <div className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">TTR (50%)</div>
                  <div className="text-lg font-serif font-bold text-navy-900">
                    {typeof selectedManeuver.recovery_time_s === 'number' ? `${selectedManeuver.recovery_time_s}s` : '—'}
                  </div>
                </div>
              </div>

              <ManeuverSpeedChart
                maneuver={selectedManeuver}
                highResTrack={sessionById.get(selectedManeuver.athleteId)?.highResTrack ?? []}
                height={320}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
