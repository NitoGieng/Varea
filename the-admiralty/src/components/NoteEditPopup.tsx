import { useEffect, useRef, useState } from 'react';

interface Props {
  // Posizione assoluta in pixel rispetto al container relative del chiamante.
  // Il chiamante e' responsabile del clamp dentro i bounds del container —
  // qui ci limitiamo a settare left/top.
  x: number;
  y: number;
  // Stringa orario gia' formattata (es. "00:12:34" o "14:38:28"). La
  // formattazione vive nel chiamante perche' dipende dall'inizio della
  // sessione che il popup non possiede.
  timestampDisplay: string;
  initialText: string;
  // Modifica vs nuova nota: cambia label header e abilita il pulsante
  // Elimina. Se editing=true ma onDelete e' assente, Elimina non appare
  // (caso difensivo: callback dimenticato in qualche call site).
  isEditing: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

// Popup inline per creare/modificare una nota allenatore. Posizionato in
// assoluto sopra grafico o mappa. Auto-focus del textarea, Esc = annulla,
// Cmd/Ctrl+Enter = salva. Salvare un testo vuoto in modalita' modifica
// equivale a eliminare (coerente con l'aspettativa "ho cancellato tutto");
// in modalita' creazione equivale ad annullare per non lasciare residui.
export default function NoteEditPopup({
  x,
  y,
  timestampDisplay,
  initialText,
  isEditing,
  onSave,
  onCancel,
  onDelete,
}: Props) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    // Cursore in fondo per consentire append immediato in modalita' modifica
    // senza dover cliccare nel testo gia' presente.
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  const handleSave = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      if (isEditing && onDelete) onDelete();
      else onCancel();
      return;
    }
    onSave(trimmed);
  };

  return (
    <div
      role="dialog"
      aria-label={isEditing ? 'Modifica nota' : 'Nuova nota'}
      className="absolute z-50 w-72 bg-surface-1 border border-gold/60 rounded-md shadow-card-md p-3"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono tabular text-eyebrow text-gold">
          {timestampDisplay}
        </span>
        <span className="eyebrow text-ink-muted">
          {isEditing ? 'Modifica' : 'Nuova'}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSave();
          }
        }}
        placeholder="Scrivi un'osservazione…"
        className="w-full h-20 bg-bg border border-border rounded p-2 text-body text-ink placeholder:text-ink-muted resize-none focus:outline-none focus:border-gold transition-colors duration-220"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleSave}
          className="bg-gold text-[#0a1428] hover:bg-gold/85 px-3 py-1 rounded text-eyebrow uppercase tracking-eyebrow font-semibold transition-colors duration-220"
        >
          Salva
        </button>
        <button
          onClick={onCancel}
          className="text-ink-muted hover:text-ink px-3 py-1 rounded text-eyebrow uppercase tracking-eyebrow transition-colors duration-220"
        >
          Annulla
        </button>
        {isEditing && onDelete && (
          <button
            onClick={onDelete}
            className="ml-auto text-ink-muted hover:text-terra px-3 py-1 rounded text-eyebrow uppercase tracking-eyebrow transition-colors duration-220"
          >
            Elimina
          </button>
        )}
      </div>
    </div>
  );
}
