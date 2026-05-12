import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// Modal del glossario tecnico. Centralizza in un unico posto le definizioni
// dei termini e delle sigle che compaiono nelle viste (TWA, VMG, V.IN/OUT,
// foiling…) cosi' un allenatore o un atleta possono richiamarli senza
// uscire dall'app.
//
// Il modal e' "puro contenuto": nessuna logica derivata dai dati di
// sessione, nessun side-effect oltre al body-scroll-lock e al keydown
// listener per ESC. Cosi' rimane montabile da qualsiasi schermata senza
// dipendenze.

interface Props {
  onClose: () => void;
}

// Skeleton strutturale: i contenuti (titolo sezione, name, description) vengono
// da i18n; qui restano solo i17ny / sigle (TWD, V.MIN, ΔV...) che non si traducono.
interface TermRef {
  // Chiave i18n in glossary.terms.<key>. Da qui risolviamo name/description.
  key: string;
  // Sigla mostrata in serif italic prima del name esteso (TWD, V.MIN, ΔV...).
  // Quando assente, l'intestazione mostra direttamente il name tradotto.
  shortLabel?: string;
}

interface SectionRef {
  num: string;
  titleKey: 'wind' | 'movement' | 'pointsOfSail' | 'maneuverMetrics' | 'foiling' | 'data';
  terms: TermRef[];
}

const SECTIONS: SectionRef[] = [
  {
    num: '01',
    titleKey: 'wind',
    terms: [
      { key: 'twd', shortLabel: 'TWD' },
      { key: 'tws', shortLabel: 'TWS' },
      { key: 'twa', shortLabel: 'TWA' },
    ],
  },
  {
    num: '02',
    titleKey: 'movement',
    terms: [
      { key: 'sog', shortLabel: 'SOG' },
      { key: 'cog', shortLabel: 'COG' },
      { key: 'vmg', shortLabel: 'VMG' },
    ],
  },
  {
    num: '03',
    titleKey: 'pointsOfSail',
    terms: [
      { key: 'bolina' },
      { key: 'traverso' },
      { key: 'lasco' },
      { key: 'poppa' },
      { key: 'virata' },
      { key: 'strambata' },
    ],
  },
  {
    num: '04',
    titleKey: 'maneuverMetrics',
    terms: [
      { key: 'vIn', shortLabel: 'V.IN' },
      { key: 'vMin', shortLabel: 'V.MIN' },
      { key: 'vOut', shortLabel: 'V.OUT' },
      { key: 'deltaV', shortLabel: 'ΔV' },
      { key: 'ttr', shortLabel: 'TTR' },
    ],
  },
  {
    num: '05',
    titleKey: 'foiling',
    terms: [
      { key: 'fly' },
      { key: 'touch' },
      { key: 'soglia' },
      { key: 'foilingRatio' },
    ],
  },
  {
    num: '06',
    titleKey: 'data',
    terms: [
      { key: 'stormglass' },
      { key: 'hz' },
      { key: 'fit' },
    ],
  },
];

// Stile inline ricorrente: eyebrow di sezione (10.5px Mono uppercase 0.22em).
// Lo letterspacing 0.22em e' fuori dalla scala Tailwind progettuale (0.18em),
// quindi va inline; il resto sarebbe ottenibile via utility ma sarebbe meno
// leggibile mescolato.
const eyebrowStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: 'rgb(var(--ink-3))',
  whiteSpace: 'nowrap',
};

export default function GlossaryModal({ onClose }: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  // Body scroll lock + ESC handler. Il listener viene rimosso al cleanup
  // quando il componente smonta (chiusura del modal). Salviamo il valore
  // precedente di overflow per ripristinarlo: cosi' se un altro modal
  // aveva gia' bloccato lo scroll non interferiamo.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    // Focus iniziale al pannello cosi' la prima Tab parte da qui invece
    // che dal trigger nascosto sotto il backdrop.
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="glossary-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(0, 0, 0, 0.7)' }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full flex flex-col outline-none"
        style={{
          maxWidth: 720,
          maxHeight: '80vh',
          background: 'rgb(var(--surface-1))',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(212, 175, 110, 0.08)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header sticky: titolo + sottotitolo a sinistra, X a destra. Il
            background opaco impedisce che il contenuto in scroll trasuli
            sotto il bordo. */}
        <header
          className="sticky top-0 flex items-start justify-between gap-4 shrink-0"
          style={{
            background: 'rgb(var(--surface-1))',
            borderBottom: '1px solid var(--line)',
            padding: '24px 32px 18px 32px',
            borderTopLeftRadius: 'var(--radius-lg)',
            borderTopRightRadius: 'var(--radius-lg)',
          }}
        >
          <div className="min-w-0">
            <h2
              id="glossary-title"
              className="font-serif italic"
              style={{ fontSize: 24, color: 'rgb(var(--ink))', lineHeight: 1.1 }}
            >
              {t('glossary.title')}
            </h2>
            <p style={{ ...eyebrowStyle, marginTop: 8 }}>
              {t('glossary.subtitle')}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('glossary.closeAria')}
            onClick={onClose}
            className="shrink-0 transition-colors duration-220 ease-varea"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 16,
              lineHeight: 1,
              color: 'rgb(var(--ink-3))',
              background: 'transparent',
              border: '1px solid var(--line-2)',
              borderRadius: 'var(--radius-lg)',
              padding: '6px 10px',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--line-hot)';
              e.currentTarget.style.color = 'rgb(var(--gold))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--line-2)';
              e.currentTarget.style.color = 'rgb(var(--ink-3))';
            }}
          >
            ×
          </button>
        </header>

        {/* Corpo scrollabile. overflow-y-auto sul wrapper interno cosi' lo
            scroll resta locale al modal: il body-lock di useEffect blocca
            quello della pagina. */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ padding: '24px 32px 32px 32px' }}
        >
          {SECTIONS.map((section) => (
            <section key={section.num} style={{ marginBottom: 28 }}>
              {/* Eyebrow di sezione: numero · titolo, con filo orizzontale a
                  destra per dare il ritmo "cockpit" delle altre schermate. */}
              <div
                className="flex items-center gap-3"
                style={{ marginBottom: 14 }}
              >
                <span style={eyebrowStyle}>
                  {section.num} · {t(`glossary.sections.${section.titleKey}`)}
                </span>
                <span
                  className="flex-1"
                  style={{ height: 1, background: 'var(--line)' }}
                />
              </div>

              {section.terms.map((term) => {
                const name = t(`glossary.terms.${term.key}.name`);
                const description = t(`glossary.terms.${term.key}.description`);
                return (
                  <article
                    key={`${section.num}-${term.key}`}
                    style={{ marginBottom: 18 }}
                  >
                    <h3
                      className="flex items-baseline flex-wrap gap-2"
                      style={{ marginBottom: 4 }}
                    >
                      <span
                        className="font-serif italic"
                        style={{ fontSize: 16, color: 'rgb(var(--ink))', lineHeight: 1.2 }}
                      >
                        {term.shortLabel ?? name}
                      </span>
                      {term.shortLabel && (
                        <span
                          className="font-serif italic"
                          style={{ fontSize: 14, color: 'rgb(var(--ink-2))', lineHeight: 1.2 }}
                        >
                          — {name}
                        </span>
                      )}
                    </h3>
                    <p
                      style={{
                        fontFamily: 'var(--sans)',
                        fontSize: 13,
                        lineHeight: 1.55,
                        color: 'rgb(var(--ink-2))',
                        margin: 0,
                      }}
                    >
                      {description}
                    </p>
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
