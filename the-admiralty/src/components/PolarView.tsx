import { useMemo } from 'react';
import PolarChart from './charts/PolarChart';
import PolarStatsPanel from './PolarStatsPanel';
import type { HighResPoint } from '../types/telemetry';
import {
  extractValidPolarPoints,
  buildBuckets,
  smoothP90,
  findUpwindOptimum,
  findDownwindOptimum,
  buildZoneStats,
  maxSogOnCurve,
  POLAR_MIN_VALID_POINTS,
} from '../utils/polar';

interface Props {
  highResTrack: HighResPoint[];
  athleteLabel?: string;
  athleteColor?: string;
  isWindEstimated?: boolean;
  // Soglia in secondi sotto la quale mostriamo il warning "intervallo
  // troppo breve". Default 5 minuti = 300s.
  minIntervalSec?: number;
}

// Vista Polar a piena larghezza dentro il Laboratorio. Sostituisce
// list+detail quando l'utente seleziona la tab POLAR. Esegue tutta la
// pipeline polar in un solo useMemo: filter → bucket → smooth → ottimi/zone.
// Il filtro temporale del clock e' gia' applicato a monte da Dashboard
// (visibleFilteredSessions), quindi `highResTrack` e' gia' la finestra
// corrente e non serve ulteriore logica qui.
export default function PolarView({
  highResTrack,
  athleteLabel,
  athleteColor,
  isWindEstimated,
  minIntervalSec = 300,
}: Props) {
  const polarData = useMemo(() => {
    const valid = extractValidPolarPoints(highResTrack);
    const buckets = buildBuckets(valid);
    const smoothed = smoothP90(buckets);
    const upwind = findUpwindOptimum(buckets, smoothed);
    const downwind = findDownwindOptimum(buckets, smoothed);
    const zones = buildZoneStats(valid);
    const maxSog = maxSogOnCurve(buckets, smoothed);
    return { valid, buckets, smoothed, upwind, downwind, zones, maxSog };
  }, [highResTrack]);

  // Span temporale effettivo del track: timestamp e' ISO, parseo solo i
  // due estremi cosi' un track 1Hz da 6h non fa N parse inutili.
  const intervalSec = useMemo(() => {
    if (highResTrack.length < 2) return 0;
    const first = Date.parse(highResTrack[0].timestamp);
    const last = Date.parse(highResTrack[highResTrack.length - 1].timestamp);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
    return Math.max(0, (last - first) / 1000);
  }, [highResTrack]);

  const tooFewPoints = polarData.valid.length < POLAR_MIN_VALID_POINTS;
  const intervalTooShort = intervalSec > 0 && intervalSec < minIntervalSec;

  const windSourceLabel = isWindEstimated
    ? 'Calcolata su vento stimato da GPS'
    : 'Calcolata su vento Stormglass';

  return (
    <div className="flex-1 flex flex-col bg-surface-1 overflow-hidden">
      {/* Header polar: titolo + disclaimer fonte vento + atleta in multi */}
      <div className="px-6 py-3 border-b border-border bg-surface-1 shrink-0 flex items-baseline gap-3 flex-wrap">
        <span className="text-eyebrow uppercase tracking-eyebrow text-ink-muted">
          Diagramma polare
        </span>
        <span className="font-serif italic text-base text-ink leading-none">
          Performance
        </span>
        <span
          className="text-eyebrow uppercase tracking-eyebrow"
          style={{ color: 'rgb(var(--gold))' }}
        >
          {windSourceLabel}
        </span>
        {athleteLabel && athleteColor && (
          <span className="ml-auto flex items-center gap-2 text-eyebrow uppercase tracking-eyebrow text-ink-muted">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: athleteColor }} />
            {athleteLabel}
          </span>
        )}
      </div>

      {/* Sotto-header con la nota di interpretazione: stessa riga del
          tono "disclaimer" della Panoramica, in caption + ink-muted. */}
      <div className="px-6 py-2 border-b border-border bg-bg/40 shrink-0 text-caption text-ink-muted">
        La qualità della polar dipende dalla precisione della stima TWD.
        Con vento variabile interpretare con cautela.
      </div>

      {/* Warning intervallo breve (non bloccante: la polar viene comunque
          disegnata ma con barra ammonitiva). Sotto soglia conteggio
          punti validi (caso piu' grave) usiamo invece il fallback grande. */}
      {!tooFewPoints && intervalTooShort && (
        <div
          className="px-6 py-2 border-b border-border shrink-0 flex items-center gap-2 text-caption"
          style={{ background: 'rgba(212,162,76,0.06)', color: 'rgb(var(--amber))' }}
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber" />
          Intervallo selezionato breve ({Math.round(intervalSec / 60)} min): la polar potrebbe non essere rappresentativa.
        </div>
      )}

      {/* Layout 60/40: polar a sinistra, stats a destra. Su viewport stretti
          collassa in colonna verticale (lg breakpoint). Polar dark "vasca"
          come ManeuverFootprint per coerenza estetica del Laboratorio. */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        <div className="flex-1 lg:flex-[3] min-h-[480px] bg-[#050d1a] relative">
          <div
            className="absolute inset-0 opacity-[0.06] pointer-events-none"
            style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '40px 40px' }}
          />
          {tooFewPoints ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="bg-[#040d1a]/85 backdrop-blur border border-white/10 px-6 py-4 rounded-md text-center max-w-md">
                <div className="text-eyebrow uppercase tracking-eyebrow text-amber mb-2">
                  Dati insufficienti
                </div>
                <div className="text-caption text-white/70">
                  {polarData.valid.length} punti validi nel periodo selezionato (richiesti almeno {POLAR_MIN_VALID_POINTS}).
                  Seleziona un intervallo più ampio.
                </div>
              </div>
            </div>
          ) : (
            <PolarChart
              rawPoints={polarData.valid}
              buckets={polarData.buckets}
              smoothedP90={polarData.smoothed}
              maxSog={polarData.maxSog}
            />
          )}
        </div>
        <div className="lg:flex-[2] lg:max-w-[440px] border-t lg:border-t-0 lg:border-l border-border bg-bg/30 overflow-y-auto">
          <PolarStatsPanel
            upwind={polarData.upwind}
            downwind={polarData.downwind}
            zones={polarData.zones}
            totalPoints={polarData.valid.length}
          />
        </div>
      </div>
    </div>
  );
}
