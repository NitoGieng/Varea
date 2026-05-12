import { useTranslation } from 'react-i18next';
import type { CoachNote } from '../utils/notes';

interface Props {
  notes: CoachNote[];
  // Indice 1-based dell'ordine cronologico (vedi useCoachNotes.numberOf).
  numberOf: (id: string) => number;
  // Formattatore del timestamp da secondi a stringa display. Iniettato dal
  // chiamante perche' la conversione dipende dalla data di inizio sessione
  // (informazione che il pannello non possiede direttamente).
  formatTimestamp: (timestampSec: number) => string;
  onEdit: (note: CoachNote) => void;
  onDelete: (id: string) => void;
  // Click su una riga: il chiamante flasha i marker corrispondenti su
  // grafico e mappa, cosi' l'utente capisce dove si colloca la nota.
  onHighlight: (id: string) => void;
}

// Pannello "Note allenatore" sotto il grafico velocita' della Panoramica.
// Mostra cronologicamente le annotazioni (numero, timestamp, testo) con
// azioni inline modifica/elimina. Empty state guida al gesto di creazione
// (clic sul grafico o sulla mappa).
export default function NotesPanel({
  notes,
  numberOf,
  formatTimestamp,
  onEdit,
  onDelete,
  onHighlight,
}: Props) {
  const { t } = useTranslation();
  return (
    <section className="bg-surface-1 border border-border rounded-lg shadow-card overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <h3 className="eyebrow">{t('notes.panelTitle')}</h3>
        {notes.length > 0 && (
          <span className="text-caption text-ink-muted font-mono tabular">
            {notes.length}
          </span>
        )}
      </div>
      {notes.length === 0 ? (
        <div className="px-6 py-6">
          <p className="text-body text-ink-muted italic">
            {t('notes.empty')}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {notes.map((n) => (
            <li
              key={n.id}
              className="group flex items-start gap-3 px-6 py-3 hover:bg-surface-2 cursor-pointer transition-colors duration-150"
              onClick={() => onHighlight(n.id)}
            >
              <span
                className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center font-mono text-[0.7rem] font-semibold tabular text-[#0a1428]"
                style={{ backgroundColor: n.color ?? '#c9a169' }}
                aria-hidden
              >
                {numberOf(n.id)}
              </span>
              <span className="font-mono tabular text-eyebrow text-gold shrink-0 w-20 mt-0.5">
                {formatTimestamp(n.timestampSec)}
              </span>
              <p className="flex-1 text-body text-ink whitespace-pre-wrap break-words">
                {n.text}
              </p>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(n);
                  }}
                  className="text-ink-muted hover:text-gold p-1 rounded transition-colors duration-220"
                  title={t('notes.edit')}
                  aria-label={t('notes.editAria')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                  </svg>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(n.id);
                  }}
                  className="text-ink-muted hover:text-terra p-1 rounded transition-colors duration-220"
                  title={t('notes.delete')}
                  aria-label={t('notes.deleteTitle')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
