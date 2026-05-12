import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';

interface Props {
  // Punto di click in pixel relativi al container .relative del chiamante.
  // Il popup si posiziona da solo: il chiamante NON deve preconvertire il
  // click in coordinate "popup top-left" — fornisce la pura ancora del click.
  anchorX: number;
  anchorY: number;
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

// Margine fra popup e punto di click (gap visibile fra cursore e popup).
const ANCHOR_GAP_PX = 12;
// Margine minimo fra popup e bordi del viewport.
const VIEWPORT_EDGE_PX = 8;

// Popup inline per creare/modificare una nota allenatore. Posizionato in
// assoluto sopra grafico o mappa. Auto-focus del textarea, Esc = annulla,
// Cmd/Ctrl+Enter = salva. Salvare un testo vuoto in modalita' modifica
// equivale a eliminare (coerente con l'aspettativa "ho cancellato tutto");
// in modalita' creazione equivale ad annullare per non lasciare residui.
//
// PLACEMENT VIEWPORT-AWARE — usa un'iterazione due-pass via useLayoutEffect:
//   1° render off-screen (visibility:hidden) per misurare le dimensioni reali,
//   2° render alla posizione calcolata. La regola di placement:
//     - default SOPRA il click (= il pulsante Salva resta sempre lontano dal
//       bordo basso del viewport, che e' il caso piu' comune di tagliato),
//     - SOTTO se sopra non c'e' spazio,
//     - position:fixed centrato se nessuna delle due fitta (grafico molto
//       piccolo o anchor su un viewport ridotto).
//   L'asse orizzontale clampa il popup dentro il viewport con margine fisso,
//   coprendo gli edge case "click vicino al bordo destro" e specchio.
export default function NoteEditPopup({
  anchorX,
  anchorY,
  timestampDisplay,
  initialText,
  isEditing,
  onSave,
  onCancel,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Style finale del wrapper. Inizialmente off-screen + invisible: il primo
  // paint avviene fuori dal viewport, l'utente vede solo il 2° paint con la
  // posizione calcolata. Niente flash della posizione provvisoria.
  const [placedStyle, setPlacedStyle] = useState<CSSProperties>({
    position: 'absolute',
    left: -9999,
    top: -9999,
    visibility: 'hidden',
  });

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    // Cursore in fondo per consentire append immediato in modalita' modifica
    // senza dover cliccare nel testo gia' presente.
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  useLayoutEffect(() => {
    const computePlacement = () => {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const popupW = rect.width;
      const popupH = rect.height;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // L'offsetParent di un absolute e' il primo antenato positioned: il
      // container .relative del chiamante. getBoundingClientRect ci da' la
      // posizione del container in coordinate viewport, indispensabile per
      // verificare il fit dei lati senza dipendere dallo scroll della pagina.
      const parent = el.offsetParent as HTMLElement | null;
      const parentRect = parent ? parent.getBoundingClientRect() : null;
      const parentLeft = parentRect ? parentRect.left : 0;
      const parentTop = parentRect ? parentRect.top : 0;

      // Conversione anchor: container-local → viewport.
      const anchorClientX = parentLeft + anchorX;
      const anchorClientY = parentTop + anchorY;

      // ---- Verticale ----
      // Tentativo 1: SOPRA il click (preferito).
      const aboveTopClient = anchorClientY - popupH - ANCHOR_GAP_PX;
      const fitsAbove = aboveTopClient >= VIEWPORT_EDGE_PX;
      // Tentativo 2: SOTTO il click.
      const belowTopClient = anchorClientY + ANCHOR_GAP_PX;
      const fitsBelow = belowTopClient + popupH <= vh - VIEWPORT_EDGE_PX;

      let usingFixed = false;
      let topClient: number;
      if (fitsAbove) {
        topClient = aboveTopClient;
      } else if (fitsBelow) {
        topClient = belowTopClient;
      } else {
        // Nessuno dei due lati ha abbastanza spazio: position:fixed e
        // centriamo verticalmente nel viewport. Edge case: grafico molto
        // piccolo o viewport ridotto (mobile landscape su display corto).
        usingFixed = true;
        topClient = Math.max(VIEWPORT_EDGE_PX, (vh - popupH) / 2);
      }

      // ---- Orizzontale ----
      // Default: popup centrato orizzontalmente sull'anchor. Quando l'anchor
      // e' vicino al bordo destro o sinistro, il clamp viewport-aware lo fa
      // scorrere lateralmente cosi' resta sempre interamente visibile (=
      // "specchio" verso il lato opposto, come richiesto).
      const desiredLeftClient = anchorClientX - popupW / 2;
      const leftClient = Math.max(
        VIEWPORT_EDGE_PX,
        Math.min(vw - popupW - VIEWPORT_EDGE_PX, desiredLeftClient)
      );

      if (usingFixed) {
        // Centrato orizzontalmente in viewport quando va in fallback.
        const fixedLeft = Math.max(VIEWPORT_EDGE_PX, (vw - popupW) / 2);
        setPlacedStyle({
          position: 'fixed',
          left: fixedLeft,
          top: topClient,
          visibility: 'visible',
        });
      } else {
        // Posizionamento absolute: convertiamo le coordinate viewport
        // calcolate in coordinate container-local sottraendo il rect del parent.
        setPlacedStyle({
          position: 'absolute',
          left: leftClient - parentLeft,
          top: topClient - parentTop,
          visibility: 'visible',
        });
      }
    };

    computePlacement();
    // Resize del viewport o scroll possono cambiare il fit (in particolare
    // su mobile con la rotazione). Ricomputiamo per mantenere la visibilita'.
    window.addEventListener('resize', computePlacement);
    window.addEventListener('scroll', computePlacement, true);
    return () => {
      window.removeEventListener('resize', computePlacement);
      window.removeEventListener('scroll', computePlacement, true);
    };
  }, [anchorX, anchorY]);

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
      ref={wrapperRef}
      role="dialog"
      aria-label={isEditing ? t('notes.editAria') : t('notes.newAria')}
      className="z-50 w-72 bg-surface-1 border border-gold/60 rounded-md shadow-card-md p-3"
      style={placedStyle}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono tabular text-eyebrow text-gold">
          {timestampDisplay}
        </span>
        <span className="eyebrow text-ink-muted">
          {isEditing ? t('notes.edit') : t('notes.new')}
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
        placeholder={t('notes.placeholder')}
        className="w-full h-20 bg-bg border border-border rounded p-2 text-body text-ink placeholder:text-ink-muted resize-none focus:outline-none focus:border-gold transition-colors duration-220"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleSave}
          className="bg-gold text-[#0a1428] hover:bg-gold/85 px-3 py-1 rounded text-eyebrow uppercase tracking-eyebrow font-semibold transition-colors duration-220"
        >
          {t('notes.save')}
        </button>
        <button
          onClick={onCancel}
          className="text-ink-muted hover:text-ink px-3 py-1 rounded text-eyebrow uppercase tracking-eyebrow transition-colors duration-220"
        >
          {t('notes.cancel')}
        </button>
        {isEditing && onDelete && (
          <button
            onClick={onDelete}
            className="ml-auto text-ink-muted hover:text-terra px-3 py-1 rounded text-eyebrow uppercase tracking-eyebrow transition-colors duration-220"
          >
            {t('notes.delete')}
          </button>
        )}
      </div>
    </div>
  );
}
