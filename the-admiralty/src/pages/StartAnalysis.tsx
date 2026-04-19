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

// Palette coerente col design system (Recharts non legge CSS vars).
const COLOR_LINE = '#c9a169';
const COLOR_GRID = 'rgba(201, 161, 105, 0.08)';
const COLOR_AXIS_DIM = '#5e6b80';
const COLOR_TICK = '#a8b3c4';
const COLOR_TOOLTIP_BG = '#0a1628';
const COLOR_TOOLTIP_BORDER = 'rgba(201, 161, 105, 0.3)';

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
    <div
      className="px-3 py-2 rounded-md font-mono tabular text-caption min-w-[200px]"
      style={{
        backgroundColor: COLOR_TOOLTIP_BG,
        border: `1px solid ${COLOR_TOOLTIP_BORDER}`,
        color: '#f5f1e6',
        boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
      }}
    >
      <p className="text-eyebrow uppercase tracking-eyebrow mb-2" style={{ color: COLOR_LINE }}>
        {rel === 0
          ? 'IL MOMENTO DELLO SPARO'
          : rel < 0
            ? `${Math.abs(rel)}s allo start`
            : `+${rel}s di gara`}
      </p>
      {visibleSessions.map((s) => {
        const sog = payload.find((p: AnyProps) => p.dataKey === `sog_${s.id}`)?.value;
        const row = payload[0]?.payload as Record<string, number | undefined> | undefined;
        const cog = row?.[`cog_${s.id}`];
        if (sog == null) return null;
        return (
          <div key={s.id} className="flex items-center gap-2 mb-1 last:mb-0">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
            <span className="font-bold flex-1 truncate">{s.label}</span>
            <span>{sog.toFixed(1)} kts</span>
            {cog != null && <span className="text-[10px]" style={{ color: COLOR_AXIS_DIM }}>{Math.round(cog)}°</span>}
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
    if (!primary) return '12:00:00';
    try {
      const norm = primary.sessionStart.replace(' ', 'T');
      const d = new Date(norm.endsWith('Z') ? norm : norm + 'Z');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const ss = String(d.getUTCSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    } catch {
      return '12:00:00';
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
    if (tickItem === 0) return 'START';
    return tickItem > 0 ? `+${tickItem}s` : `${tickItem}s`;
  };

  if (!primary) {
    return (
      <div className="px-6 lg:px-12 py-8 max-w-[1500px] mx-auto w-full">
        <header className="pb-5">
          <p className="eyebrow mb-2">Analisi partenza</p>
          <h1 className="font-serif italic text-h2 text-ink leading-none">Sparo</h1>
        </header>
        <div className="rule-brass mb-8" />
        <div className="text-ink-muted text-caption italic">
          Nessuna sessione visibile.
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 lg:px-12 py-8 max-w-[1500px] mx-auto w-full">
      <header className="pb-5">
        <p className="eyebrow mb-2">Analisi partenza</p>
        <h1 className="font-serif italic text-h2 text-ink leading-none">Sparo</h1>
        <p className="text-caption text-ink-muted mt-3 max-w-2xl">
          Finestra tattica di 2 minuti pre-start e 1 minuto post-start attorno al
          momento dello sparo.
          {isMulti && (
            <span className="text-gold ml-1">
              Ghosting di {sessions.length} atleti su T=0 condiviso.
            </span>
          )}
        </p>
      </header>

      <div className="rule-brass mb-6" />

      <div className="bg-surface-1 border border-border rounded-lg shadow-card p-5 mb-6 flex flex-col md:flex-row items-end gap-6 justify-between flex-wrap">
        <div>
          <label className="block text-eyebrow uppercase tracking-eyebrow text-ink-muted mb-2">
            Ora esatta del T=0 (lo sparo)
          </label>
          <div className="flex items-center bg-bg border border-border rounded-md focus-within:border-gold overflow-hidden w-fit transition-colors">
            <input
              type="time"
              step="1"
              value={startTimeInput}
              onChange={(e) => setStartTimeInput(e.target.value)}
              className="py-2 px-4 bg-transparent text-body-lg font-mono tabular font-bold text-ink outline-none"
            />
          </div>
          <p className="text-caption text-ink-muted mt-2">
            {isMulti
              ? 'Tutti gli atleti vengono allineati a questo istante UTC.'
              : 'Inserisci l\'orario reale in cui il comitato ha dato il via.'}
          </p>
        </div>
      </div>

      {perSessionStats.some(s => s.hasData) && (
        <div className="mb-6 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {perSessionStats.map(({ session, speedAtZero, maxPreStart, avgPostStart, hasData }) => (
            <div
              key={session.id}
              className={`bg-surface-1 border border-border rounded-lg shadow-card p-4 ${hasData ? '' : 'opacity-50'}`}
            >
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: session.color }} />
                <span className="text-caption font-bold text-ink truncate">{session.label}</span>
                {!hasData && <span className="text-[10px] text-ink-muted ml-auto italic">— fuori finestra</span>}
              </div>
              {hasData && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center">
                    <div className="text-eyebrow uppercase tracking-eyebrow text-ink-muted mb-1">Accel -15s</div>
                    <div className="text-body-lg font-mono tabular font-bold text-ink-2">
                      {maxPreStart.toFixed(1)}<span className="text-[10px] font-sans text-ink-muted ml-0.5">kts</span>
                    </div>
                  </div>
                  <div className="text-center bg-gold/10 rounded px-1 py-0.5">
                    <div className="text-eyebrow uppercase tracking-eyebrow text-gold mb-1">Crossing</div>
                    <div className="text-body-lg font-mono tabular font-bold text-ink">
                      {speedAtZero.toFixed(1)}<span className="text-[10px] font-sans text-ink-muted ml-0.5">kts</span>
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-eyebrow uppercase tracking-eyebrow text-ink-muted mb-1">Cruise +15s</div>
                    <div className="text-body-lg font-mono tabular font-bold text-ink-2">
                      {avgPostStart.toFixed(1)}<span className="text-[10px] font-sans text-ink-muted ml-0.5">kts</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bg-surface-1 border border-border rounded-lg shadow-card p-6 h-[500px]">
        {mergedChartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={mergedChartData} margin={{ top: 24, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" vertical={false} stroke={COLOR_GRID} />
              <XAxis
                dataKey="relativeTime"
                type="number"
                domain={[-PRE_START_SEC, POST_START_SEC]}
                tickFormatter={formatXAxis}
                minTickGap={30}
                tick={{ fill: COLOR_TICK, fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: COLOR_TICK, fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(val) => `${val}`}
                width={40}
              />
              <Tooltip content={<CustomTooltip sessions={sessions} />} cursor={{ stroke: COLOR_LINE, strokeOpacity: 0.3, strokeWidth: 1 }} />
              <ReferenceLine
                x={0}
                stroke={COLOR_LINE}
                strokeWidth={1}
                strokeDasharray="3 4"
                label={{
                  position: 'top',
                  value: 'START',
                  fill: COLOR_LINE,
                  fontSize: 10,
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              />
              {sessions.map((s) => (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={`sog_${s.id}`}
                  stroke={s.color}
                  strokeWidth={isMulti ? 1.5 : 2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                  activeDot={{ r: 4, fill: s.color, stroke: COLOR_TOOLTIP_BG, strokeWidth: 2 }}
                  name={s.label}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-ink-muted">
            <svg className="w-10 h-10 mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="font-serif italic text-body-lg">Nessun dato GPS in questo orario.</p>
            <p className="text-caption mt-1">Usa la barra qui sopra per cercare il momento esatto della partenza.</p>
          </div>
        )}
      </div>
    </div>
  );
}
