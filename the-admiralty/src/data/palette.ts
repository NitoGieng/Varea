// Palette fissa ad alto contrasto per distinguere le sessioni nei grafici
// multi-atleta. Tutti i colori scelti per essere leggibili sia su paper
// (light) che su cockpit notturno (dark). Il primo slot e' oro — firma
// del brand Varea nella veste premium.

export const SESSION_PALETTE: string[] = [
  '#c9a169', // gold — firma Varea
  '#7fa885', // sage
  '#c97462', // terra
  '#e8cea0', // brass chiaro
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f43f5e', // rose
  '#84cc16', // lime
];

// Assegna il primo colore libero dalla palette. Robusta a rimozioni:
// se una sessione viene tolta, il prossimo upload riprende il suo slot.
// Oltre 8 sessioni cicla (soft limit — la UI non è progettata per così
// tanti atleti, ma non crasha).
export function assignColor(usedColors: string[]): string {
  for (const c of SESSION_PALETTE) {
    if (!usedColors.includes(c)) return c;
  }
  return SESSION_PALETTE[usedColors.length % SESSION_PALETTE.length];
}
