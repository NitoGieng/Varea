// Palette fissa ad alto contrasto per distinguere le sessioni nei grafici
// multi-atleta. L'ordine conta: il primo slot (navy) riproduce il colore
// storico della UI single-session, quindi caricare un solo file lascia
// l'aspetto invariato.

export const SESSION_PALETTE: string[] = [
  '#061325', // navy — storico Varea
  '#ef4444', // red
  '#10b981', // emerald
  '#f59e0b', // amber
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
