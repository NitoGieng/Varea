import ManeuverFootprint from '../components/charts/ManeuverFootprint';
import type { LabSession } from '../components/charts/ManeuverFootprint';

interface LabProps {
  sessions: LabSession[];
  // Soglia FLY/TOUCH condivisa col Registro Manovre: vive in Dashboard cosi'
  // un cambio in una vista si riflette nell'altra.
  flyThreshold: number;
  onFlyThresholdChange: (v: number) => void;
  // Fonte vento (true = stimata da GPS). Inoltrata a ManeuverFootprint che
  // la usa nella legenda VMG del chart -20s/+40s come disclaimer.
  isWindEstimated?: boolean;
}

// Pagina autonoma del Laboratorio Traiettorie. Riceve le sessioni gia' filtrate
// dalla finestra temporale globale; il selettore atleta vive dentro
// ManeuverFootprint perche' lavora sulla logica del catalogo di manovre.
export default function Lab({ sessions, flyThreshold, onFlyThresholdChange, isWindEstimated }: LabProps) {
  return (
    <div className="px-6 lg:px-12 py-8 max-w-[1500px] mx-auto w-full">
      <header className="pb-5">
        {/* Eyebrow cockpit: label mono uppercase + filo --line che corre
            fino al margine destro. Stesso pattern di Manovre, applicato
            qui per allineare il linguaggio visivo del Laboratorio. */}
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
            Laboratorio
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        </div>
        <h1 className="font-serif italic text-h2 text-ink leading-none">Traiettorie</h1>
        <p className="text-caption text-ink-muted mt-3 max-w-2xl">
          Seleziona una manovra dal catalogo per analizzare la radiografia XY
          della curva e la velocità istante-per-istante.
        </p>
      </header>

      <div className="rule-brass mb-5" />

      <div className="bg-surface-1 border border-border rounded-lg shadow-card overflow-hidden">
        <ManeuverFootprint
          sessions={sessions}
          flyThreshold={flyThreshold}
          onFlyThresholdChange={onFlyThresholdChange}
          isWindEstimated={isWindEstimated}
        />
      </div>
    </div>
  );
}
