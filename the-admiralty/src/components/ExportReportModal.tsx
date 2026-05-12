import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Modale di pre-export: raccoglie i parametri editabili (atleta, soglia
// foiling, note allenatore) prima di generare il PDF. Mostra un avviso
// se la finestra temporale e' molto corta (< 2 minuti) perche' su
// segmenti cosi' brevi le metriche derivate sono poco significative.
//
// Il componente si aspetta un mount fresco a ogni apertura (il parent
// usa rendering condizionale): cosi' i default si applicano via lazy
// initializer e il focus iniziale via useEffect senza setState nel body.

export interface ExportConfig {
  athleteName: string;
  flyThreshold: number;
  coachNotes: string;
}

interface Props {
  onClose: () => void;
  onConfirm: (cfg: ExportConfig) => void;
  initialFlyThreshold: number;
  initialAthleteName?: string;
  initialCoachNotes?: string;
  // Lunghezza in secondi del periodo selezionato sul Dashboard.
  periodSeconds: number;
}

const SHORT_PERIOD_THRESHOLD = 120;

export default function ExportReportModal({
  onClose,
  onConfirm,
  initialFlyThreshold,
  initialAthleteName = '',
  initialCoachNotes = '',
  periodSeconds,
}: Props) {
  const { t } = useTranslation();
  const [athleteName, setAthleteName] = useState(initialAthleteName);
  const [flyThreshold, setFlyThreshold] = useState<string>(initialFlyThreshold.toFixed(1));
  const [coachNotes, setCoachNotes] = useState(initialCoachNotes);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Focus al primo campo subito dopo il mount (accessibilita').
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const isShortPeriod = periodSeconds > 0 && periodSeconds < SHORT_PERIOD_THRESHOLD;
  const parsedThreshold = Number(flyThreshold);
  const thresholdValid = Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold < 50;

  const handleConfirm = () => {
    if (!thresholdValid) return;
    onConfirm({
      athleteName: athleteName.trim(),
      flyThreshold: parsedThreshold,
      coachNotes,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-1 border border-border rounded-lg shadow-card-md w-full max-w-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-5">
          <p className="eyebrow text-gold mb-2">{t('exportModal.eyebrow')}</p>
          <h2 className="font-serif italic text-2xl text-ink leading-none">{t('exportModal.title')}</h2>
          <p className="text-caption text-ink-muted mt-2">
            {t('exportModal.subtitle')}
          </p>
        </header>

        <div className="rule-brass mb-5" />

        <div className="space-y-4">
          <div>
            <label className="block eyebrow mb-1.5" htmlFor="athleteName">
              {t('exportModal.athleteLabel')}
            </label>
            <input
              id="athleteName"
              ref={firstFieldRef}
              type="text"
              value={athleteName}
              onChange={(e) => setAthleteName(e.target.value)}
              placeholder={t('exportModal.athletePlaceholder')}
              className="w-full bg-bg border border-border rounded-md px-3 py-2 text-body text-ink placeholder-ink-muted focus:outline-none focus:border-gold transition-colors duration-220"
            />
          </div>

          <div>
            <label className="block eyebrow mb-1.5" htmlFor="flyThreshold">
              {t('exportModal.flyThresholdLabel')}
            </label>
            <input
              id="flyThreshold"
              type="number"
              min="0.5"
              max="50"
              step="0.1"
              value={flyThreshold}
              onChange={(e) => setFlyThreshold(e.target.value)}
              className={`w-full bg-bg border rounded-md px-3 py-2 text-body font-mono tabular text-ink focus:outline-none transition-colors duration-220 ${
                thresholdValid ? 'border-border focus:border-gold' : 'border-terra/60 focus:border-terra'
              }`}
            />
            <p className="text-caption text-ink-muted mt-1">
              {t('exportModal.flyThresholdHelp', { value: initialFlyThreshold.toFixed(1) })}
            </p>
          </div>

          <div>
            <label className="block eyebrow mb-1.5" htmlFor="coachNotes">
              {t('exportModal.coachNotesLabel')}
            </label>
            <textarea
              id="coachNotes"
              value={coachNotes}
              onChange={(e) => setCoachNotes(e.target.value)}
              rows={4}
              placeholder={t('exportModal.coachNotesPlaceholder')}
              className="w-full bg-bg border border-border rounded-md px-3 py-2 text-body text-ink placeholder-ink-muted focus:outline-none focus:border-gold transition-colors duration-220 resize-y"
            />
          </div>

          {isShortPeriod && (
            <div className="border border-amber/40 bg-amber/10 rounded-md px-3 py-2 text-caption text-ink">
              <strong className="text-amber">{t('exportModal.shortPeriodWarningTitle')}</strong>{' '}
              {t('exportModal.shortPeriodWarningBody', { seconds: SHORT_PERIOD_THRESHOLD })}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-eyebrow uppercase tracking-eyebrow text-ink-muted hover:text-ink transition-colors duration-220"
          >
            {t('exportModal.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!thresholdValid}
            className="px-5 py-2 bg-gold hover:bg-[#e8cea0] text-[#0a1428] text-eyebrow uppercase tracking-eyebrow rounded-md transition-all duration-220 ease-varea hover:-translate-y-0.5 shadow-card disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
          >
            {t('exportModal.confirm')}
          </button>
        </footer>
      </div>
    </div>
  );
}
