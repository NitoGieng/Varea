import { useEffect, useRef } from 'react';

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

interface Term {
  // Nome esteso (forma serif italic). Es: "True Wind Direction"
  name: string;
  // Sigla in mono gold tra parentesi accanto al nome. Opzionale — alcuni
  // termini (Bolina, Virata) non hanno acronimo.
  sigla?: string;
  // Etichetta principale prima della sigla — usata per i termini in cui
  // il "titolo visibile" e' la sigla stessa (es. "TWD" prima di "True Wind
  // Direction"). Quando assente si parte direttamente dal `name`.
  shortLabel?: string;
  // Descrizione 2-4 frasi, plain text. Le interruzioni di paragrafo non
  // sono supportate per scelta: ogni voce e' un blocco compatto.
  description: string;
}

interface Section {
  // Numero d'ordine mostrato nell'eyebrow (es. "01"). Stringa per
  // preservare il padding "01" / "02" / "03".
  num: string;
  // Titolo dell'eyebrow in uppercase.
  title: string;
  terms: Term[];
}

// Contenuto centralizzato. Aggiungere termini significa solo estendere
// l'array — il rendering li scorre uniformemente.
const SECTIONS: Section[] = [
  {
    num: '01',
    title: 'Vento',
    terms: [
      {
        shortLabel: 'TWD',
        name: 'True Wind Direction',
        description:
          'Direzione da cui proviene il vento reale, espressa in gradi (0°=Nord, 90°=Est, 180°=Sud, 270°=Ovest). In Varea può essere stimata dal GPS analizzando la distribuzione delle rotte oppure ricavata dall\u2019API Stormglass quando disponibile.',
      },
      {
        shortLabel: 'TWS',
        name: 'True Wind Speed',
        description:
          'Intensità del vento reale in nodi (kts): indica quanto forte sta tirando. In Varea proviene da Stormglass quando disponibile, altrimenti non viene calcolata.',
      },
      {
        shortLabel: 'TWA',
        name: 'True Wind Angle',
        description:
          'Angolo tra la rotta della barca (COG) e la direzione del vento (TWD). Range 0°-180°. Determina l\u2019andatura: TWA basso = bolina, TWA medio = traverso, TWA alto = poppa.',
      },
    ],
  },
  {
    num: '02',
    title: 'Movimento',
    terms: [
      {
        shortLabel: 'SOG',
        name: 'Speed Over Ground',
        description:
          'Velocità della barca rispetto al fondo, misurata dal GPS in nodi. È la velocità "vera" dell\u2019imbarcazione, indipendente da correnti.',
      },
      {
        shortLabel: 'COG',
        name: 'Course Over Ground',
        description:
          'Direzione del moto della barca rispetto al Nord, in gradi. Su molti orologi GPS Garmin questo dato manca o è zero — in quel caso Varea lo ricostruisce dai punti GPS consecutivi tramite calcolo del bearing sferico.',
      },
      {
        shortLabel: 'VMG',
        name: 'Velocity Made Good',
        description:
          'Componente della SOG nella direzione del vento. Formula: VMG = SOG × cos(TWA). Misura quanto efficacemente l\u2019atleta avanza verso il segnavento (in bolina) o si allontana (in poppa). Due atleti con SOG simile possono avere VMG molto diverse se navigano ad angoli diversi.',
      },
    ],
  },
  {
    num: '03',
    title: 'Andature e manovre',
    terms: [
      {
        name: 'Bolina',
        description:
          'Andatura controvento, TWA tipicamente 30°-60°. La barca risale verso il vento. È l\u2019andatura più tecnica e dove conta di più la VMG.',
      },
      {
        name: 'Traverso',
        description:
          'Andatura con vento al traverso, TWA 60°-120°. Solitamente l\u2019andatura più veloce in assoluto.',
      },
      {
        name: 'Lasco',
        description: 'Andatura con vento da poppa angolato, TWA 120°-150°.',
      },
      {
        name: 'Poppa',
        description: 'Andatura con vento da dietro, TWA 150°-180°.',
      },
      {
        name: 'Virata',
        description:
          'Manovra controvento: la barca passa con la prua attraverso il vento, cambiando lato di mura.',
      },
      {
        name: 'Strambata',
        sigla: 'GYBE',
        description:
          'Manovra in poppa: la barca passa con la poppa attraverso il vento, cambiando lato di mura.',
      },
    ],
  },
  {
    num: '04',
    title: 'Metriche manovra',
    terms: [
      {
        shortLabel: 'V.IN',
        name: 'Velocità in ingresso',
        description:
          'SOG nei secondi prima della manovra. Indica con quanta velocità l\u2019atleta arriva alla virata o strambata.',
      },
      {
        shortLabel: 'V.MIN',
        name: 'Velocità minima',
        description:
          'SOG più bassa raggiunta durante la manovra. Misura quanta velocità si "perde" nel passaggio.',
      },
      {
        shortLabel: 'V.OUT',
        name: 'Velocità in uscita',
        description:
          'SOG nei secondi dopo la manovra, una volta stabilizzata.',
      },
      {
        shortLabel: 'ΔV',
        name: 'Delta-V',
        description:
          'Differenza tra V.OUT e V.IN. Positivo = la manovra ha lasciato l\u2019atleta più veloce; negativo = ha perso velocità. Metrica chiave per valutare la qualità della manovra.',
      },
      {
        shortLabel: 'TTR',
        name: 'Time To Recovery 50%',
        description:
          'Tempo in secondi necessario per recuperare il 50% della velocità persa durante la manovra. Più basso = manovra più efficiente.',
      },
    ],
  },
  {
    num: '05',
    title: 'Foiling',
    terms: [
      {
        name: 'FLY',
        description:
          'Stato in cui la tavola è in volo sull\u2019idroala, con SOG sopra la soglia configurata (default 12 kts). Una manovra "fly" è una virata o strambata eseguita mantenendo il volo.',
      },
      {
        name: 'TOUCH',
        description:
          'Stato in cui la tavola tocca l\u2019acqua, con SOG sotto la soglia foiling. Una manovra "touch" significa che l\u2019atleta ha perso il volo durante l\u2019esecuzione.',
      },
      {
        name: 'Soglia foiling',
        description:
          'Velocità SOG (configurabile dall\u2019utente) sopra la quale Varea considera l\u2019atleta in volo. Default: 12 kts. Modificabile nelle viste Manovre e Laboratorio.',
      },
      {
        name: 'Foiling ratio',
        description:
          'Percentuale di tempo in cui la SOG è stata sopra la soglia foiling. Indica quanto della sessione è stata effettivamente in volo.',
      },
    ],
  },
  {
    num: '06',
    title: 'Dati',
    terms: [
      {
        name: 'Stormglass',
        description:
          'Servizio API che fornisce dati storici di vento (TWD, TWS), correnti e onde per coordinate geografiche e date specifiche. Quando disponibile, Varea lo usa come fonte primaria per il vento. Il pallino verde "DA STORMGLASS" indica che i dati provengono dall\u2019API.',
      },
      {
        name: '1 Hz',
        description:
          'Frequenza di campionamento dei dati GPS: un punto al secondo. Tutti i dati in Varea sono ricampionati a 1 Hz dopo il parsing del file FIT originale.',
      },
      {
        name: 'FIT',
        description:
          'Formato file binario standard di Garmin per registrare attività sportive. Contiene punti GPS, timestamp e metadati della sessione.',
      },
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

const siglaStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'rgb(var(--gold))',
};

export default function GlossaryModal({ onClose }: Props) {
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
              Glossario · Termini e sigle
            </h2>
            <p style={{ ...eyebrowStyle, marginTop: 8 }}>
              Riferimento rapido per le metriche e i concetti usati in Varea
            </p>
          </div>
          <button
            type="button"
            aria-label="Chiudi glossario"
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
                  {section.num} · {section.title}
                </span>
                <span
                  className="flex-1"
                  style={{ height: 1, background: 'var(--line)' }}
                />
              </div>

              {section.terms.map((term, i) => (
                <article
                  key={`${section.num}-${i}`}
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
                      {term.shortLabel ?? term.name}
                    </span>
                    {term.shortLabel && (
                      <span
                        className="font-serif italic"
                        style={{ fontSize: 14, color: 'rgb(var(--ink-2))', lineHeight: 1.2 }}
                      >
                        — {term.name}
                      </span>
                    )}
                    {term.sigla && !term.shortLabel && (
                      <span style={siglaStyle}>({term.sigla})</span>
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
                    {term.description}
                  </p>
                </article>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
