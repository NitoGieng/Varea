// Backend (FastAPI) serializza i timestamp come `str(idx)` su un index pandas
// tz-aware UTC, producendo stringhe nella forma `2026-04-19 14:38:28+00:00`.
// La vecchia regola "se non finisce con Z, aggiungi Z" attaccava la `Z` alla
// stringa già `+00:00`, generando `2026-04-19T14:38:28+00:00Z` che `new Date`
// rifiuta come Invalid Date. Risultato: la finestra di Start Analysis si
// svuotava (tZeroEpoch null, tutti gli epoch NaN) e i grafici collassavano
// in una linea piatta / placeholder. Riconosciamo qualsiasi offset esplicito
// (`Z`, `+HH:MM`, `-HHMM`, ecc.) e, solo in sua assenza, trattiamo l'ISO
// come UTC.
export function parseBackendTimestamp(ts: string | undefined | null): number {
  if (!ts) return NaN;
  const norm = ts.replace(' ', 'T');
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(norm);
  return new Date(hasTz ? norm : norm + 'Z').getTime();
}
