import ManeuverFootprint from '../components/charts/ManeuverFootprint';
import type { LabSession } from '../components/charts/ManeuverFootprint';

interface LabProps {
  sessions: LabSession[];
}

// Pagina autonoma del Laboratorio Traiettorie. Riceve le sessioni gia' filtrate
// dalla finestra temporale globale; il selettore atleta vive dentro
// ManeuverFootprint perche' lavora sulla logica del catalogo di manovre.
export default function Lab({ sessions }: LabProps) {
  return (
    <div className="px-6 lg:px-12 py-8 max-w-[1500px] mx-auto w-full h-[calc(100vh-180px)] flex flex-col">
      <header className="pb-5 shrink-0">
        <p className="eyebrow mb-2">Laboratorio</p>
        <h1 className="font-serif italic text-h2 text-ink leading-none">Traiettorie</h1>
        <p className="text-caption text-ink-muted mt-3 max-w-2xl">
          Seleziona una manovra dal catalogo per analizzare la radiografia XY
          della curva e la velocità istante-per-istante.
        </p>
      </header>

      <div className="rule-brass mb-5 shrink-0" />

      <div className="bg-surface-1 border border-border rounded-lg shadow-card flex-1 flex flex-col overflow-hidden">
        <ManeuverFootprint sessions={sessions} />
      </div>
    </div>
  );
}
