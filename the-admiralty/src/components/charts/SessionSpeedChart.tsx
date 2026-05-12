import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { TrackPoint, HighResPoint } from '../../types/telemetry';
import { parseBackendTimestamp } from '../../utils/time';
import type { CoachNote } from '../../utils/notes';

interface Props {
  // Curva SOG dell'intera finestra. Accetta entrambi i tipi di track
  // perche' la Panoramica fornisce trackData (0.2Hz) o highResTrack (1Hz)
  // a seconda della durata della sessione.
  track: (TrackPoint | HighResPoint)[];
  // Inizio sessione in epoch-ms: usato per convertire i timestamp dei
  // punti in "secondi dall'inizio" (asse X). Coerente con CoachNote.timestampSec.
  sessionStartMs: number;
  notes: CoachNote[];
  numberOf: (id: string) => number;
  // ID nota da evidenziare temporaneamente (flash). Quando cambia, il
  // marker corrispondente cresce e diventa piu' luminoso. Il chiamante
  // fa scadere l'highlight via timeout.
  highlightedNoteId?: string | null;
  height?: number;
  // Click sull'area del grafico (lontano da un marker): il chiamante apre
  // il popup di nuova nota. timestampSec = secondi dall'inizio sessione.
  // pixelX/pixelY sono le coordinate del click nell'area del grafico,
  // utili per ancorare il popup vicino al punto cliccato.
  onChartClick?: (timestampSec: number, pixelX: number, pixelY: number) => void;
  // Click su un marker esistente: avvia il flusso di modifica.
  onNoteClick?: (note: CoachNote, pixelX: number, pixelY: number) => void;
  // Modalita' di formattazione dell'asse X e del tooltip:
  //   false (default) = "Relativo" — secondi dall'inizio sessione (HH:MM:SS o MM:SS).
  //   true            = "Orologio" — orario assoluto del browser (HH:MM:SS) calcolato
  //                     da sessionStartMs + t*1000.
  // Allineato al toggle "Relativo / Orologio" della FilterBar (Dashboard).
  useAbsoluteTime?: boolean;
  // Fonte vento usata dal backend per calcolare TWA -> VMG. Quando true il
  // vento e' una stima euristica dal GPS (Stormglass non disponibile per la
  // sessione); quando false e' un'osservazione satellitare. La legenda VMG
  // mostra una micro-pill che ricorda al coach l'origine del valore: la
  // stessa VMG con vento stimato vale meno come benchmark.
  isWindEstimated?: boolean;
}

const COLOR_LINE = '#c9a169';
const COLOR_VMG = '#5fb6c4'; // teal — distinto dal gold SOG, leggibile su dark
const COLOR_GRID = 'rgba(201, 161, 105, 0.12)';
const COLOR_TICK = '#a8b3c4';
const COLOR_TOOLTIP_BG = '#0a1628';
const COLOR_TOOLTIP_BORDER = 'rgba(201, 161, 105, 0.3)';
const COLOR_AXIS_DIM = '#5e6b80';
const COLOR_NOTE = '#c9a169';

// Format secondi → HH:MM:SS o MM:SS in base alla durata totale (modalita' Relativo).
function formatRelativeTickFactory(maxSec: number) {
  const showHours = maxSec >= 3600;
  return (v: number) => {
    if (!Number.isFinite(v)) return '';
    const total = Math.max(0, Math.round(v));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (showHours) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  };
}

// Format secondi-da-inizio-sessione → orario di parete HH:MM:SS nel fuso del
// browser (modalita' Orologio). Coerente con formatNoteTimestamp del
// Dashboard, cosi' i tick dell'asse X parlano la stessa lingua dei timestamp
// delle note quando il toggle e' su "Orologio".
function formatAbsoluteTickFactory(sessionStartMs: number) {
  return (v: number) => {
    if (!Number.isFinite(v) || !Number.isFinite(sessionStartMs)) return '';
    const d = new Date(sessionStartMs + Math.round(v) * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };
}

// Tipi Recharts non sono stabili: tooltip e onClick ricevono shape any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = any;

function CustomTooltip({ active, payload, formatTick, t }: AnyProps & { t: TFunction }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  const vmgValid = typeof d.vmg === 'number' && Number.isFinite(d.vmg);
  return (
    <div
      className="px-3 py-2 rounded-md font-mono tabular text-caption"
      style={{
        backgroundColor: COLOR_TOOLTIP_BG,
        border: `1px solid ${COLOR_TOOLTIP_BORDER}`,
        color: '#f5f1e6',
        boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
      }}
    >
      <p className="text-eyebrow uppercase tracking-eyebrow mb-1" style={{ color: COLOR_LINE }}>
        {formatTick(d.t)}
      </p>
      <p className="text-body-lg leading-tight">
        <span style={{ color: COLOR_LINE }}>SOG</span>{' '}
        <span className="font-bold">{d.sog.toFixed(1)}</span> kts
      </p>
      <p className="text-body leading-tight" style={{ color: COLOR_VMG }}>
        VMG{' '}
        <span className="font-bold">{vmgValid ? d.vmg.toFixed(1) : t('common.na')}</span>
        {vmgValid ? ' kts' : ''}
      </p>
    </div>
  );
}

// Soglia visiva (in secondi) entro cui un click sull'area del grafico viene
// considerato "vicino" a un marker esistente: in tal caso non viene aperto
// il popup di nuova nota (per non sovrapporsi al click sul marker stesso).
const NEAR_MARKER_TOLERANCE_SEC = 2;

export default function SessionSpeedChart({
  track,
  sessionStartMs,
  notes,
  numberOf,
  highlightedNoteId,
  height = 220,
  onChartClick,
  onNoteClick,
  useAbsoluteTime = false,
  isWindEstimated,
}: Props) {
  const { t } = useTranslation();
  const { chartData, minSec, maxSec } = useMemo(() => {
    if (!track || track.length === 0 || !Number.isFinite(sessionStartMs)) {
      return { chartData: [] as Array<{ t: number; sog: number; vmg: number | null }>, minSec: 0, maxSec: 0 };
    }
    const out: Array<{ t: number; sog: number; vmg: number | null }> = [];
    let max = -Infinity;
    let min = Infinity;
    for (const p of track) {
      const ms = parseBackendTimestamp(p.timestamp);
      if (!Number.isFinite(ms)) continue;
      const t = Math.round((ms - sessionStartMs) / 1000);
      const sog = Number(p.sog_knots);
      if (!Number.isFinite(sog)) continue;
      // vmg_knots e' null sui campioni dove il backend non aveva TWA: passiamo
      // null a Recharts cosi' la linea si interrompe naturalmente sul gap.
      // I valori negativi (perdita verso vento in lasco/poppa, fisicamente
      // legittimi) vengono clampati a 0 SOLO per la visualizzazione: il dato
      // sorgente in p.vmg_knots resta intatto e le card VMG continuano a
      // mostrare i valori veri. Senza clamp la curva scivolava a -15/-30 kts
      // schiacciando il dominio Y e rendendo illeggibile la SOG.
      const vmgRaw = p.vmg_knots;
      const vmg = typeof vmgRaw === 'number' && Number.isFinite(vmgRaw)
        ? Math.max(0, vmgRaw)
        : null;
      out.push({ t, sog, vmg });
      if (t > max) max = t;
      if (t < min) min = t;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { chartData: out, minSec: 0, maxSec: 0 };
    }
    return { chartData: out, minSec: min, maxSec: max };
  }, [track, sessionStartMs]);

  // Note visibili solo se il loro timestamp cade dentro la finestra del
  // chart: quando il filtro temporale restringe il track, le note fuori
  // periodo non devono estendere il dominio X (ifOverflow="extendDomain"
  // del Recharts riallargherebbe l'asse, vanificando il filtro).
  const visibleNotes = useMemo(() => {
    return notes.filter(n => n.timestampSec >= minSec && n.timestampSec <= maxSec);
  }, [notes, minSec, maxSec]);

  // Tick formatter switchato dal toggle "Relativo / Orologio". In modalita'
  // Orologio richiede sessionStartMs valido; se manca (sessione non ancora
  // inizializzata) cade sul formatter relativo per non mostrare "NaN".
  const formatTick = useMemo(() => {
    if (useAbsoluteTime && Number.isFinite(sessionStartMs)) {
      return formatAbsoluteTickFactory(sessionStartMs);
    }
    return formatRelativeTickFactory(maxSec);
  }, [useAbsoluteTime, sessionStartMs, maxSec]);

  if (chartData.length === 0) {
    return (
      <div className="w-full flex items-center justify-center text-ink-muted text-caption italic" style={{ height }}>
        {t('speedChart.noSpeedData')}
      </div>
    );
  }

  const handleChartClick = (state: AnyProps) => {
    if (!onChartClick) return;
    const label = state?.activeLabel;
    if (label == null || isNaN(Number(label))) return;
    const t = Number(label);
    // Se il click cade vicino a una nota visibile, lascia che sia il marker
    // a gestirlo (evita popup di "nuova nota" sovrapposto al popup di
    // modifica che parte dal click sul marker). Solo le note dentro la
    // finestra visibile rendono un marker, quindi solo quelle possono essere
    // intercettate dal click sull'area.
    const nearMarker = visibleNotes.some(n => Math.abs(n.timestampSec - t) <= NEAR_MARKER_TOLERANCE_SEC);
    if (nearMarker) return;
    const coord = state?.activeCoordinate;
    const px = typeof coord?.x === 'number' ? coord.x : 0;
    const py = typeof coord?.y === 'number' ? coord.y : 0;
    onChartClick(t, px, py);
  };

  return (
    <div style={{ width: '100%', height }} className="cursor-crosshair relative">
      {/* Legenda overlay top-right: minimale, font-mono coerente con i tick.
          Posizionata fuori dal flow del LineChart cosi' non interferisce con
          l'area di plot e con i marker delle note. */}
      <div className="absolute top-1 right-3 z-10 flex items-center gap-3 text-eyebrow uppercase tracking-eyebrow pointer-events-none select-none">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5" style={{ backgroundColor: COLOR_LINE }} />
          <span style={{ color: COLOR_LINE }}>SOG</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5" style={{ backgroundColor: COLOR_VMG }} />
          <span style={{ color: COLOR_VMG }}>VMG</span>
        </span>
        {/* Fonte vento: pill discreta accanto alla legenda. Niente parole
            quando isWindEstimated e' undefined (caso noto: dati di test). */}
        {typeof isWindEstimated === 'boolean' && (
          <span
            className="flex items-center gap-1"
            title={isWindEstimated
              ? t('speedChart.vmgEstimatedTitle')
              : t('speedChart.vmgObservedTitle')}
            style={{ color: isWindEstimated ? '#d4a345' : '#8a9a5b' }}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: isWindEstimated ? '#d4a345' : '#8a9a5b' }} />
            <span>{isWindEstimated ? t('speedChart.vmgEstimatedPill') : t('speedChart.vmgObservedPill')}</span>
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 24, right: 30, left: 0, bottom: 0 }}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray="2 4" vertical={false} stroke={COLOR_GRID} />
          <XAxis
            dataKey="t"
            type="number"
            domain={[minSec, maxSec]}
            tickFormatter={formatTick}
            minTickGap={40}
            tick={{ fill: COLOR_TICK, fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            axisLine={false}
            tickLine={false}
          />
          {/* Domain forzato a partire da 0: la VMG e' gia' clampata a >=0 in
              chartData, e i nodi non potranno mai essere negativi. Esplicitare
              il min evita che recharts lo deduca da SOG ed introduca padding
              negativo se in futuro arrivasse una serie con valori sotto zero. */}
          <YAxis
            domain={[0, 'auto']}
            tick={{ fill: COLOR_TICK, fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip content={<CustomTooltip formatTick={formatTick} t={t} />} cursor={{ stroke: COLOR_LINE, strokeOpacity: 0.3, strokeWidth: 1 }} />

          <Line
            type="monotone"
            dataKey="sog"
            stroke={COLOR_LINE}
            strokeWidth={1.4}
            dot={false}
            isAnimationActive={false}
            activeDot={{ r: 3.5, fill: COLOR_LINE, stroke: COLOR_TOOLTIP_BG, strokeWidth: 2 }}
          />

          {/* VMG sovrapposta: piu' sottile della SOG per gerarchia visiva,
              connectNulls=false cosi' i gap (TWA assente) interrompono la
              curva invece di mascherarli con interpolazione lineare. */}
          <Line
            type="monotone"
            dataKey="vmg"
            stroke={COLOR_VMG}
            strokeWidth={1.1}
            strokeOpacity={0.9}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
            activeDot={{ r: 3, fill: COLOR_VMG, stroke: COLOR_TOOLTIP_BG, strokeWidth: 2 }}
          />

          {/* Linee tratteggiate gold per ogni nota: leggibili a colpo d'occhio
              anche con tante annotazioni vicine. */}
          {visibleNotes.map((n) => (
            <ReferenceLine
              key={`note-line-${n.id}`}
              x={n.timestampSec}
              stroke={n.color ?? COLOR_NOTE}
              strokeWidth={1}
              strokeDasharray="3 4"
              ifOverflow="hidden"
            />
          ))}

          {/* Cerchio numerato in cima al grafico per ogni nota. La shape
              custom intercetta il click cosi' il chiamante puo' aprire il
              popup di modifica senza che il click "passi attraverso" al
              LineChart sottostante (che aprirebbe invece il popup di nuova
              nota). */}
          {visibleNotes.map((n) => {
            const isHi = highlightedNoteId === n.id;
            const num = numberOf(n.id);
            const radius = isHi ? 11 : 9;
            return (
              <ReferenceDot
                key={`note-dot-${n.id}`}
                x={n.timestampSec}
                y={chartData[0]?.sog ?? 0}
                r={radius}
                ifOverflow="hidden"
                yAxisId={0}
                shape={(props: AnyProps) => {
                  const cx = Number(props.cx);
                  const cy = Number(props.cy);
                  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return <g />;
                  const fill = n.color ?? COLOR_NOTE;
                  // Posizione fissa in alto: y del payload non e' affidabile
                  // perche' l'asse Y del grafico e' auto. Ancoriamo il
                  // marker a top=18px del plot area (margin.top - 6).
                  const yTop = 18;
                  return (
                    <g
                      transform={`translate(${cx}, ${yTop})`}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onNoteClick) {
                          // Coordinate per posizionare il popup: cx in
                          // pixel del plot area, yTop sopra al marker.
                          onNoteClick(n, cx, yTop);
                        }
                      }}
                    >
                      <circle
                        r={radius}
                        fill={fill}
                        stroke={COLOR_TOOLTIP_BG}
                        strokeWidth={2}
                        opacity={isHi ? 1 : 0.95}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#0a1428"
                        fontSize={10}
                        fontFamily="JetBrains Mono, ui-monospace, monospace"
                        fontWeight="bold"
                        pointerEvents="none"
                      >
                        {num}
                      </text>
                    </g>
                  );
                }}
              />
            );
          })}

          {/* Asse zero "0 kts" tenue: orienta visivamente il fondo del grafico
              senza interferire con la lettura del trend. */}
          <ReferenceLine y={0} stroke={COLOR_AXIS_DIM} strokeWidth={0.5} strokeDasharray="2 4" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
