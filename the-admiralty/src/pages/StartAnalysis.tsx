import { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot } from 'recharts';
import type { HighResPoint } from '../types/telemetry';
import { parseBackendTimestamp } from '../utils/time';

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
const COLOR_GRID = 'rgba(201, 161, 105, 0.15)';
const COLOR_AXIS_DIM = '#5e6b80';
const COLOR_TICK = '#a8b3c4';
const COLOR_TOOLTIP_BG = '#0a1628';
const COLOR_TOOLTIP_BORDER = 'rgba(201, 161, 105, 0.3)';
// Hard-code di --bg dark (#04101f) per lo stroke del crossing-dot:
// Recharts non risolve CSS custom properties nei suoi prop SVG, quindi
// il valore va inlineato. Il match esatto col background del pannello
// chart fa "ritagliare" il dot dalle line sottostanti.
const COLOR_BG = '#04101f';

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

// Time-input con commit su blur/Enter invece di per-keystroke.
// `<input type="time" step="1">` emette onChange per ogni cifra digitata,
// producendo valori intermedi (HH parziale) che, ri-anchorando subito il T=0,
// facevano collassare il chart su finestre vuote durante l'edit. Stesso
// principio dello ClockInput nel Dashboard FilterBar; uso il pattern
// "derived state" per restare lint-clean su react-hooks/set-state-in-effect.
function ClockInput({ value, onCommit }: { value: string; onCommit: (hms: string) => void }) {
  const [local, setLocal] = useState(value);
  const [lastExternal, setLastExternal] = useState(value);
  if (value !== lastExternal) {
    setLastExternal(value);
    setLocal(value);
  }

  const commit = () => {
    if (local !== value) {
      setLastExternal(local);
      onCommit(local);
    }
  };

  return (
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
      // .cockpit-time-input gestisce font/colore + override dei separatori
      // ":" via pseudo-classi WebKit (vedi index.css). Tabular-nums tiene
      // l'allineamento delle cifre durante l'edit.
      className="cockpit-time-input tabular"
    />
  );
}

// Default T=0 = ora di start della sessione primaria in fuso LOCALE del
// browser (=fuso di regata). Coerente col filtro globale del Dashboard e
// con il Registro Manovre, così i tempi restano comparabili tra viste.
function deriveDefaultStartTime(sessionStart: string | undefined): string {
  if (!sessionStart) return '12:00:00';
  const ms = parseBackendTimestamp(sessionStart);
  if (Number.isNaN(ms)) return '12:00:00';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export default function StartAnalysis({ sessions }: Props) {
  const primary = sessions[0];
  const isMulti = sessions.length > 1;

  const [startTimeInput, setStartTimeInput] = useState<string>(() => deriveDefaultStartTime(primary?.sessionStart));

  // Re-anchor del default quando cambia la sessione primaria (rimozione
  // dell'attiva, switch tra atleti, primo upload). Pattern "derived state":
  // setState durante il render quando l'identita' della primary cambia,
  // niente useEffect (lint-clean su react-hooks/set-state-in-effect).
  // Senza questo re-anchor, la stringa restava bloccata sul valore della
  // prima sessione caricata e la finestra T=0 finiva fuori range.
  const [lastPrimaryId, setLastPrimaryId] = useState<string | undefined>(primary?.id);
  if (primary?.id !== lastPrimaryId) {
    setLastPrimaryId(primary?.id);
    setStartTimeInput(deriveDefaultStartTime(primary?.sessionStart));
  }

  // Epoch del T=0: prendiamo la data LOCALE della sessione primaria (tenendo
  // conto che sessionStart è in UTC) e applichiamo HH:MM:SS digitato come
  // orario locale. Così typing "15:38:28" in CEST → epoch corretto.
  const tZeroEpoch = useMemo<number | null>(() => {
    if (!primary) return null;
    try {
      const sessionStartMs = parseBackendTimestamp(primary.sessionStart);
      if (Number.isNaN(sessionStartMs)) return null;
      const ref = new Date(sessionStartMs);
      const parts = startTimeInput.split(':').map(Number);
      const hh = Number.isFinite(parts[0]) ? parts[0] : 0;
      const mm = Number.isFinite(parts[1]) ? parts[1] : 0;
      const ss = Number.isFinite(parts[2]) ? parts[2] : 0;
      const ms = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hh, mm, ss).getTime();
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
          const epoch = parseBackendTimestamp(pt.timestamp);
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

  // Y del crossing dot: SOG dell'atleta primario al T=0. null se non c'e'
  // un campione esattamente in 0 (Recharts non fa interpolazione per il
  // ReferenceDot, vuole un valore reale del dataset).
  const primaryStat = perSessionStats.find(s => s.session.id === primary?.id);
  const primaryCrossingY =
    primaryStat?.hasData && primaryStat.speedAtZero > 0 ? primaryStat.speedAtZero : null;

  if (!primary) {
    return (
      <div className="px-6 lg:px-12 py-8 max-w-[1500px] mx-auto w-full">
        <header className="pb-5">
          {/* Eyebrow cockpit: mono uppercase + filo --line a destra,
              stesso pattern di Manovre / Lab. */}
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
              Analisi partenza
            </span>
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          </div>
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
        {/* Eyebrow cockpit: mono uppercase + filo --line a destra,
            stesso pattern di Manovre / Lab. */}
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
            Analisi partenza
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        </div>
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

      {/* Card T=0 in stile cockpit: gradient sottile + bordo --line +
          radius-lg. L'header porta il numero di sezione "02" (in --gold-dim,
          marker tipografico tipo capitolo) accanto alla label mono, separato
          dal corpo da un filo --line. L'input orario vive nel corpo: cifre
          gold-2 32px, separatori ":" smorzati in --ink-4. */}
      <div
        className="mb-6"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        <div
          className="flex items-baseline gap-3"
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span
            className="tabular"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              fontWeight: 500,
              color: 'rgb(var(--gold-dim))',
              letterSpacing: '0.06em',
            }}
          >
            02
          </span>
          <label
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'rgb(var(--ink-3))',
            }}
          >
            Ora esatta del T=0 (lo sparo)
          </label>
        </div>

        <div style={{ padding: '16px' }}>
          <div
            className="flex items-center w-fit transition-colors"
            style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--line-2)',
              borderRadius: 'var(--radius-cockpit)',
            }}
          >
            <ClockInput value={startTimeInput} onCommit={setStartTimeInput} />
          </div>
          <p
            style={{
              marginTop: 10,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'rgb(var(--ink-3))',
            }}
          >
            {isMulti
              ? 'Tutti gli atleti vengono allineati a questo istante.'
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
                  <StartStat label="-15s" value={maxPreStart} variant="neutral" />
                  <StartStat label="Crossing" value={speedAtZero} variant="gold" />
                  <StartStat label="+15s" value={avgPostStart} variant="neutral" />
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
                strokeDasharray="3 3"
                label={{
                  position: 'top',
                  value: 'START · T0',
                  fill: COLOR_LINE,
                  fontSize: 10,
                  fontFamily: 'JetBrains Mono, monospace',
                  letterSpacing: '0.22em',
                }}
              />
              {/* Crossing dot: marker tondo dove la linea START taglia la
                  curva SOG dell'atleta primario. Lo stroke dal colore del
                  background "scolpisce" il dot dalle line sottostanti, look
                  da indicatore strumento. */}
              {primaryCrossingY != null && (
                <ReferenceDot
                  x={0}
                  y={primaryCrossingY}
                  r={4}
                  fill={COLOR_LINE}
                  stroke={COLOR_BG}
                  strokeWidth={2}
                />
              )}
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

// Stat box delle finestre -15s/Crossing/+15s. Variante "gold" per il
// crossing (tinta gold-tenue + bordo gold + label/valore in --gold) cosi'
// l'occhio vede subito il numero che conta; "neutral" per pre/post.
// Numero principale in mono 28px tabular per allinearsi al linguaggio
// cockpit delle altre card.
function StartStat({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: 'neutral' | 'gold';
}) {
  const isGold = variant === 'gold';
  return (
    <div
      className="text-center"
      style={{
        background: isGold ? 'rgba(212,175,110,0.06)' : 'rgba(255,255,255,0.012)',
        border: `1px solid ${isGold ? 'rgba(212,175,110,0.3)' : 'var(--line)'}`,
        borderRadius: 'var(--radius-cockpit)',
        padding: '10px 8px',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: isGold ? 'rgb(var(--gold))' : 'rgb(var(--ink-3))',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div className="flex items-baseline justify-center">
        <span
          className="tabular"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: '-0.02em',
            color: isGold ? 'rgb(var(--gold))' : 'rgb(var(--ink))',
            lineHeight: 1,
          }}
        >
          {value.toFixed(1)}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'rgb(var(--ink-3))',
            marginLeft: 4,
          }}
        >
          kts
        </span>
      </div>
    </div>
  );
}
