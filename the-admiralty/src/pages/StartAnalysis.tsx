import { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { HighResPoint } from '../types/telemetry';

// Una sessione nello start analyzer. Con un solo elemento la UI si comporta
// come la versione single-session storica; con N elementi sovrappone le linee
// SOG di ogni atleta sullo stesso T=0 condiviso (ghosting tattico).
export interface StartSession {
  id: string;
  label: string;
  color: string;
  trackData: HighResPoint[];
  sessionStart: string;
}

interface Props {
  sessions: StartSession[];
}

const PRE_START_SEC = 120;
const POST_START_SEC = 60;

// Tipo per i payload di Recharts (no tipi ufficiali stabili).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = any;

// Tooltip a livello modulo per non re-creare il componente a ogni render
// (regola react-hooks/static-components). Recharts inietta active/payload/label
// via cloneElement; sessions arriva dall'elemento JSX inline.
function CustomTooltip(props: AnyProps) {
  const { active, payload, label, sessions } = props;
  if (!active || !payload || payload.length === 0) return null;
  const rel = label as number;
  const visibleSessions: StartSession[] = sessions ?? [];
  return (
    <div className="bg-navy-900 text-white p-3 rounded shadow-lg text-xs font-mono min-w-[200px]">
      <p className="font-bold mb-2 text-gold">
        {rel === 0
          ? "IL MOMENTO DELLO SPARO"
          : rel < 0
            ? `${Math.abs(rel)} SECONDI ALLO START`
            : `${rel} SECONDI DI GARA`}
      </p>
      {visibleSessions.map((s) => {
        const sog = payload.find((p: AnyProps) => p.dataKey === `sog_${s.id}`)?.value;
        const row = payload[0]?.payload as Record<string, number | undefined> | undefined;
        const cog = row?.[`cog_${s.id}`];
        if (sog == null) return null;
        return (
          <div key={s.id} className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
            <span className="font-bold flex-1 truncate">{s.label}</span>
            <span>{sog.toFixed(1)} kts</span>
            {cog != null && <span className="text-gray-400 text-[10px]">{Math.round(cog)}°</span>}
          </div>
        );
      })}
    </div>
  );
}

export default function StartAnalysis({ sessions }: Props) {
  const primary = sessions[0];
  const isMulti = sessions.length > 1;

  // Default T=0 = ora di start della prima sessione (HH:MM:SS UTC). L'input
  // type="time" usa la stessa convenzione UTC del filtro globale (Step 3),
  // cosi' i due tempi restano comparabili tra le viste.
  const [startTimeInput, setStartTimeInput] = useState<string>(() => {
    if (!primary) return "12:00:00";
    try {
      const norm = primary.sessionStart.replace(' ', 'T');
      const d = new Date(norm.endsWith('Z') ? norm : norm + 'Z');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const ss = String(d.getUTCSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    } catch {
      return "12:00:00";
    }
  });

  // Epoch UTC del T=0: data dalla sessione primaria + HH:MM:SS digitato.
  // Tutti gli atleti sono allineati a questo istante; se A e B hanno
  // sessioni in giorni diversi (caso patologico) il render di B sara' vuoto,
  // il che e' corretto — la UI mostra "fuori finestra" nella stat card.
  const tZeroEpoch = useMemo<number | null>(() => {
    if (!primary) return null;
    try {
      const baseDateStr = primary.sessionStart.split(' ')[0] || primary.sessionStart.split('T')[0];
      const d = new Date(`${baseDateStr}T${startTimeInput}Z`);
      const ms = d.getTime();
      return Number.isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  }, [primary, startTimeInput]);

  // Per atleta: punti nella finestra [-120, +60] dal T=0 con tempo relativo.
  const perSessionData = useMemo(() => {
    if (tZeroEpoch == null) return [];
    const startWin = tZeroEpoch - PRE_START_SEC * 1000;
    const endWin = tZeroEpoch + POST_START_SEC * 1000;
    return sessions.map(s => {
      const points = s.trackData
        .map(pt => {
          const norm = pt.timestamp.replace(' ', 'T');
          const epoch = new Date(norm.endsWith('Z') ? norm : norm + 'Z').getTime();
          return { epoch, sog: pt.sog_knots, cog: pt.cog_deg };
        })
        .filter(pt => pt.epoch >= startWin && pt.epoch <= endWin)
        .map(pt => ({
          relativeTime: Math.round((pt.epoch - tZeroEpoch) / 1000),
          sog: pt.sog,
          cog: pt.cog,
        }));
      return { session: s, points };
    });
  }, [sessions, tZeroEpoch]);

  // Merge per Recharts: una riga per relativeTime con campi sog_<id>/cog_<id>.
  // Tenere i dati separati e renderizzare N <Line data={...}> indipendenti
  // sembrava piu' semplice ma rompe il tooltip cross-atleta (Recharts mostra
  // solo i payload del Line attivo). Il merge unifica l'hover.
  const mergedChartData = useMemo(() => {
    const byRel = new Map<number, Record<string, number>>();
    for (const { session, points } of perSessionData) {
      for (const p of points) {
        const row = byRel.get(p.relativeTime) ?? { relativeTime: p.relativeTime };
        row[`sog_${session.id}`] = p.sog;
        row[`cog_${session.id}`] = p.cog;
        byRel.set(p.relativeTime, row);
      }
    }
    return Array.from(byRel.values()).sort((a, b) => a.relativeTime - b.relativeTime);
  }, [perSessionData]);

  // Stat per atleta: accelerazione, crossing, crociera. Confrontare i tre
  // numeri tra atleti = il valore vero del ghosting (chi e' arrivato alla
  // linea piu' veloce, chi ha accelerato meglio, chi gestisce meglio il dopo).
  const perSessionStats = useMemo(() => {
    return perSessionData.map(({ session, points }) => {
      const preStart = points.filter(d => d.relativeTime >= -15 && d.relativeTime <= 0);
      const postStart = points.filter(d => d.relativeTime > 0 && d.relativeTime <= 15);
      const maxPre = preStart.length > 0 ? Math.max(...preStart.map(d => d.sog)) : 0;
      const avgPost = postStart.length > 0 ? (postStart.reduce((acc, d) => acc + d.sog, 0) / postStart.length) : 0;
      const tZeroPoint = points.find(d => d.relativeTime === 0);
      return {
        session,
        speedAtZero: tZeroPoint ? tZeroPoint.sog : 0,
        maxPreStart: maxPre,
        avgPostStart: avgPost,
        hasData: points.length > 0,
      };
    });
  }, [perSessionData]);

  const formatXAxis = (tickItem: number) => {
    if (tickItem === 0) return "START";
    return tickItem > 0 ? `+${tickItem}s` : `${tickItem}s`;
  };

  if (!primary) {
    return (
      <div className="p-12 text-center text-gray-400 italic">
        Nessuna sessione visibile.
      </div>
    );
  }

  return (
    <div className="p-8 lg:p-12 max-w-[1600px] mx-auto w-full">
      <header className="mb-8">
        <h2 className="text-3xl font-serif font-black text-navy-900 leading-none">Analisi Partenza (Start)</h2>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500 mt-2">
          Finestra tattica: 2 Minuti pre-start / 1 Minuto post-start
          {isMulti && (
            <span className="text-gold ml-2 normal-case tracking-normal font-sans">
              — ghosting di {sessions.length} atleti su T=0 condiviso
            </span>
          )}
        </p>
      </header>

      <div className="bg-white p-6 shadow-sm border border-gray-200 rounded mb-8 flex flex-col md:flex-row items-end gap-6 justify-between flex-wrap">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Ora esatta del T=0 (Lo Sparo)</label>
          <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden w-fit">
            <input
              type="time"
              step="1"
              value={startTimeInput}
              onChange={(e) => setStartTimeInput(e.target.value)}
              className="py-2 px-4 bg-transparent text-lg font-mono font-bold text-navy-900 outline-none"
            />
          </div>
          <p className="text-xs text-gray-400 mt-2">
            {isMulti
              ? "Tutti gli atleti vengono allineati a questo istante UTC."
              : "Inserisci l'orario reale in cui il comitato ha dato il via."}
          </p>
        </div>
      </div>

      {perSessionStats.some(s => s.hasData) && (
        <div className="mb-8 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {perSessionStats.map(({ session, speedAtZero, maxPreStart, avgPostStart, hasData }) => (
            <div
              key={session.id}
              className={`bg-white p-4 shadow-sm border border-gray-200 rounded ${hasData ? '' : 'opacity-50'}`}
            >
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-100">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: session.color }} />
                <span className="text-sm font-bold text-navy-900 truncate">{session.label}</span>
                {!hasData && <span className="text-[10px] text-gray-400 ml-auto">— fuori finestra</span>}
              </div>
              {hasData && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center">
                    <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">Accel (-15s)</div>
                    <div className="text-base font-serif font-bold text-navy-900">
                      {maxPreStart.toFixed(1)}<span className="text-[10px] font-sans text-gray-500"> kts</span>
                    </div>
                  </div>
                  <div className="text-center bg-gold/10 rounded px-1 py-0.5">
                    <div className="text-[9px] font-bold text-gold uppercase tracking-widest mb-1">Crossing</div>
                    <div className="text-lg font-serif font-bold text-navy-900">
                      {speedAtZero.toFixed(1)}<span className="text-[10px] font-sans text-gray-500"> kts</span>
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">Cruise (+15s)</div>
                    <div className="text-base font-serif font-bold text-navy-900">
                      {avgPostStart.toFixed(1)}<span className="text-[10px] font-sans text-gray-500"> kts</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bg-white shadow-sm border border-gray-200 rounded p-6 h-[500px]">
        {mergedChartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={mergedChartData} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis
                dataKey="relativeTime"
                type="number"
                domain={[-PRE_START_SEC, POST_START_SEC]}
                tickFormatter={formatXAxis}
                minTickGap={30}
                tick={{ fill: '#9ca3af', fontSize: 12, fontWeight: 'bold' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: '#9ca3af', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(val) => `${val} kts`}
              />
              <Tooltip content={<CustomTooltip sessions={sessions} />} />
              <ReferenceLine
                x={0}
                stroke="#d4af37"
                strokeWidth={3}
                strokeDasharray="4 4"
                label={{ position: 'top', value: 'START', fill: '#d4af37', fontSize: 14, fontWeight: 'bold' }}
              />
              {sessions.map((s) => (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={`sog_${s.id}`}
                  stroke={s.color}
                  strokeWidth={isMulti ? 2 : 3}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                  activeDot={{ r: 5, fill: s.color, stroke: "#fff", strokeWidth: 2 }}
                  name={s.label}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-400">
            <svg className="w-12 h-12 mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>Nessun dato GPS in questo orario.</p>
            <p className="text-xs mt-1">Usa la barra qui sopra per cercare il momento esatto della partenza.</p>
          </div>
        )}
      </div>

    </div>
  );
}
