import { useState } from 'react';
import type { SessionData } from '../types/telemetry';

interface Props {
  sessions: SessionData[];
  activeSessionId: string | null;
  onSetActive: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onRename: (id: string, newLabel: string) => void;
  onRemove: (id: string) => void;
  onAddFiles: (files: FileList) => void;
  isUploading: boolean;
}

// Barra orizzontale delle sessioni caricate. Pill: pallino colore (clic =
// attiva), label editabile on-click, toggle visibilita', X.
export default function SessionsBar({
  sessions,
  activeSessionId,
  onSetActive,
  onToggleVisible,
  onRename,
  onRemove,
  onAddFiles,
  isUploading,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  if (sessions.length === 0) return null;

  const commitRename = (id: string, fallback: string) => {
    const trimmed = editValue.trim();
    onRename(id, trimmed.length > 0 ? trimmed : fallback);
    setEditingId(null);
  };

  // Active di fatto: esplicita se impostata, altrimenti la prima ready.
  const effectiveActiveId =
    activeSessionId ??
    sessions.find(s => s.status === 'ready')?.id ??
    sessions[0]?.id ??
    null;

  return (
    <div className="bg-surface-1 border-b border-border px-6 lg:px-12 py-3">
      <div className="max-w-[1500px] mx-auto flex items-center gap-2 flex-wrap">
        <span className="eyebrow mr-2 shrink-0">
          Sessioni · {sessions.length}
        </span>

        {sessions.map((s) => {
          const isActive = s.id === effectiveActiveId;
          const editing = editingId === s.id;
          return (
            <div
              key={s.id}
              className={`flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md border font-mono text-body transition-all duration-220 ease-varea ${
                isActive
                  ? 'border-gold bg-surface-2 shadow-card'
                  : 'border-border bg-bg hover:border-ink-muted'
              } ${s.visible ? '' : 'opacity-50'}`}
            >
              <button
                onClick={() => onSetActive(s.id)}
                disabled={s.status !== 'ready'}
                className="w-2.5 h-2.5 rounded-full flex-shrink-0 disabled:cursor-not-allowed"
                style={{ backgroundColor: s.color }}
                title={s.status === 'ready' ? 'Imposta come sessione attiva' : 'Non ancora pronta'}
                aria-label="Attiva sessione"
              />

              {editing ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitRename(s.id, s.label)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id, s.label);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="bg-transparent outline-none w-28 px-1 text-ink"
                />
              ) : (
                <button
                  onClick={() => {
                    setEditingId(s.id);
                    setEditValue(s.label);
                  }}
                  className="truncate max-w-[140px] text-ink hover:text-gold transition-colors duration-220 text-left px-1"
                  title={`${s.fileName} — clic per rinominare`}
                >
                  {s.label}
                </button>
              )}

              {s.status === 'loading' && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse"
                  title="Analisi in corso"
                  aria-label="In analisi"
                />
              )}
              {s.status === 'error' && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-terra"
                  title={s.error ?? 'Errore di analisi'}
                  aria-label="Errore"
                />
              )}

              <button
                onClick={() => onToggleVisible(s.id)}
                className="text-ink-muted hover:text-ink transition-colors duration-220 p-0.5"
                title={s.visible ? 'Nascondi dai grafici' : 'Mostra nei grafici'}
                aria-label="Toggle visibilita'"
              >
                {s.visible ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.243 4.243L9.88 9.88" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => onRemove(s.id)}
                className="text-ink-muted hover:text-terra transition-colors duration-220 p-0.5"
                title="Rimuovi sessione"
                aria-label="Rimuovi"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        })}

        <label
          className={`ml-auto cursor-pointer bg-ink text-bg hover:bg-gold px-3 py-1.5 text-eyebrow uppercase tracking-eyebrow rounded-md transition-colors duration-220 ease-varea ${
            isUploading ? 'opacity-70 cursor-wait' : ''
          }`}
        >
          {isUploading ? '…' : '+ Aggiungi'}
          <input
            type="file"
            multiple
            className="hidden"
            accept=".fit,.FIT,.csv,.CSV"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onAddFiles(e.target.files);
              }
              e.target.value = '';
            }}
            disabled={isUploading}
          />
        </label>
      </div>
    </div>
  );
}
