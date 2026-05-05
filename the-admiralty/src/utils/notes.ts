import { useCallback, useEffect, useState } from 'react';

// Annotazione temporale aggiunta dall'allenatore. Non modifica la
// telemetria: e' uno strato applicativo memorizzato in localStorage.
export interface CoachNote {
  id: string;
  // Secondi dall'inizio della sessione, intero arrotondato. Stabile rispetto
  // a eventuali ricampionamenti del backend (resta ancorata all'istante reale
  // perche' il backend riemette il file_name uguale per la stessa sessione).
  timestampSec: number;
  text: string;
  // Override opzionale del colore di marker e linea. Default = gold.
  color?: string;
}

const STORAGE_PREFIX = 'varea_notes_';

// Sanitizza il file_name per usarlo come chiave: rimuove l'estensione .fit/.csv
// e normalizza i caratteri non sicuri (path separator, spazi, accentate). Il
// risultato e' deterministico per lo stesso file_name, cosi' caricamenti
// successivi della stessa sessione recuperano le stesse note.
const sanitizeKey = (sessionName: string): string =>
  sessionName.replace(/\.(fit|csv)$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

const loadFromStorage = (key: string): CoachNote[] => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is CoachNote =>
        typeof n === 'object' && n !== null
        && typeof (n as CoachNote).id === 'string'
        && typeof (n as CoachNote).timestampSec === 'number'
        && typeof (n as CoachNote).text === 'string'
      )
      .sort((a, b) => a.timestampSec - b.timestampSec);
  } catch {
    return [];
  }
};

const saveToStorage = (key: string, notes: CoachNote[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(notes));
  } catch (err) {
    // Quota esaurita o storage non disponibile (modalita' privata stretta):
    // ignoro l'errore. Le note restano in memoria per la sessione corrente.
    console.warn('[notes] salvataggio fallito:', err);
  }
};

const genId = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export interface UseCoachNotesResult {
  notes: CoachNote[];
  addNote: (timestampSec: number, text: string, color?: string) => CoachNote;
  updateNote: (id: string, text: string) => void;
  deleteNote: (id: string) => void;
  // Indice 1-based dell'ordine cronologico. Coerente fra grafico e mappa.
  numberOf: (id: string) => number;
}

// Hook che mantiene la lista delle note di una sessione sincronizzata con
// localStorage. La chiave e' derivata da sessionName (tipicamente file_name
// senza estensione). Quando sessionName cambia, le note vengono ricaricate
// dal nuovo slot — cosi' caricare un altro .FIT mostra solo le sue note.
export function useCoachNotes(sessionName: string | null | undefined): UseCoachNotesResult {
  const key = sessionName ? `${STORAGE_PREFIX}${sanitizeKey(sessionName)}` : null;

  const [notes, setNotes] = useState<CoachNote[]>(() => key ? loadFromStorage(key) : []);
  // "Last seen key": quando la chiave cambia (utente sceglie altra sessione)
  // ricarichiamo da storage durante il render. Pattern canonical-React per
  // derivare stato da prop senza setState-in-effect (vedi ClockInput in
  // Dashboard.tsx per lo stesso motivo).
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setNotes(key ? loadFromStorage(key) : []);
  }

  // Persist on change. Mantenere "ogni cambio di notes finisce in storage"
  // come invariante significa che future feature (import/export, undo) non
  // dovranno duplicare il salvataggio.
  useEffect(() => {
    if (key) saveToStorage(key, notes);
  }, [key, notes]);

  const addNote = useCallback((timestampSec: number, text: string, color?: string): CoachNote => {
    const note: CoachNote = {
      id: genId(),
      timestampSec: Math.round(timestampSec),
      text,
      ...(color ? { color } : {}),
    };
    setNotes(prev => {
      const next = [...prev, note];
      next.sort((a, b) => a.timestampSec - b.timestampSec);
      return next;
    });
    return note;
  }, []);

  const updateNote = useCallback((id: string, text: string) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, text } : n));
  }, []);

  const deleteNote = useCallback((id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
  }, []);

  const numberOf = useCallback((id: string): number => {
    const idx = notes.findIndex(n => n.id === id);
    return idx >= 0 ? idx + 1 : 0;
  }, [notes]);

  return { notes, addNote, updateNote, deleteNote, numberOf };
}
