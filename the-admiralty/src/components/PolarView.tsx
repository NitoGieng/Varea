import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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

  // Stato per il tooltip del help icon. Mouse enter/leave sono sul
  // wrapper del bottone: cosi' il movimento mouse->tooltip non e'
  // possibile (pointer-events:none) e il tooltip si chiude in modo
  // pulito quando il cursore lascia l'icona.
  const [helpOpen, setHelpOpen] = useState(false);

  const windSourceLabel = isWindEstimated
    ? t('polarView.windEstimated')
    : t('polarView.windObserved');

  return (
    <div className="flex-1 flex flex-col bg-surface-1 overflow-hidden">
      {/* Header polar: titolo + disclaimer fonte vento + (a destra)
          atleta in multi e help icon. Cluster destro raggruppato in
          un unico ml-auto cosi' help resta sempre l'ultimo elemento
          a prescindere dalla presenza di athleteLabel. */}
      <div className="px-6 py-3 border-b border-border bg-surface-1 shrink-0 flex items-baseline gap-3 flex-wrap">
        <span className="text-eyebrow uppercase tracking-eyebrow text-ink-muted">
          {t('polarView.polarChart')}
        </span>
        <span className="font-serif italic text-base text-ink leading-none">
          {t('polarView.performance')}
        </span>
        <span
          className="text-eyebrow uppercase tracking-eyebrow"
          style={{ color: 'rgb(var(--gold))' }}
        >
          {windSourceLabel}
        </span>
        <div className="ml-auto flex items-center gap-3" style={{ alignSelf: 'center' }}>
          {athleteLabel && athleteColor && (
            <span className="flex items-center gap-2 text-eyebrow uppercase tracking-eyebrow text-ink-muted">
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: athleteColor }} />
              {athleteLabel}
            </span>
          )}
          {/* Help icon: cerchio 18px, hover gold. Il tooltip e'
              renderizzato in absolute sotto l'icona, allineato a
              destra cosi' non sfora a destra del viewport. */}
          <div
            className="relative"
            onMouseEnter={() => setHelpOpen(true)}
            onMouseLeave={() => setHelpOpen(false)}
          >
            <button
              type="button"
              aria-label={t('polarView.helpAria')}
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: '1px solid rgb(var(--ink-3))',
                background: 'transparent',
                color: 'rgb(var(--ink-3))',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                lineHeight: 1,
                cursor: 'help',
                transition: 'border-color 150ms ease, color 150ms ease',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgb(var(--gold))';
                e.currentTarget.style.color = 'rgb(var(--gold))';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgb(var(--ink-3))';
                e.currentTarget.style.color = 'rgb(var(--ink-3))';
              }}
            >
              ?
            </button>
            <div
              role="tooltip"
              aria-hidden={!helpOpen}
              style={{
                position: 'absolute',
                top: 'calc(100% + 8px)',
                right: 0,
                width: 360,
                maxWidth: 360,
                padding: 16,
                background: 'rgb(var(--surface-2))',
                border: '1px solid var(--line-2)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: '0 12px 28px rgba(0, 0, 0, 0.45)',
                opacity: helpOpen ? 1 : 0,
                pointerEvents: 'none',
                transition: 'opacity 150ms ease',
                zIndex: 10000,
                fontFamily: 'var(--sans)',
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'rgb(var(--ink-2))',
              }}
            >
              <div
                className="font-serif italic"
                style={{
                  fontSize: 14,
                  color: 'rgb(var(--ink))',
                  marginBottom: 8,
                  lineHeight: 1.2,
                }}
              >
                {t('polarView.helpTitle')}
              </div>
              <p style={{ margin: 0 }}>{t('polarView.helpP1')}</p>
              <p style={{ margin: '10px 0 0 0' }}>{t('polarView.helpP2')}</p>
              <p style={{ margin: '10px 0 0 0' }}>{t('polarView.helpP3')}</p>
              <p style={{ margin: '10px 0 0 0' }}>{t('polarView.helpP4')}</p>
              <p style={{ margin: '10px 0 0 0' }}>{t('polarView.helpP5')}</p>
              <p style={{ margin: '10px 0 0 0' }}>{t('polarView.helpP6')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Sotto-header con la nota di interpretazione: stessa riga del
          tono "disclaimer" della Panoramica, in caption + ink-muted. */}
      <div className="px-6 py-2 border-b border-border bg-bg/40 shrink-0 text-caption text-ink-muted">
        {t('polarView.interpretationNote')}
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
          {t('polarView.intervalTooShort', { minutes: Math.round(intervalSec / 60) })}
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
                  {t('polarView.insufficientDataTitle')}
                </div>
                <div className="text-caption text-white/70">
                  {t('polarView.insufficientDataBody', { count: polarData.valid.length, min: POLAR_MIN_VALID_POINTS })}
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
