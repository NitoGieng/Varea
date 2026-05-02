// Classificatore unico FLY/TOUCH condiviso tra Registro Manovre e
// Laboratorio Traiettorie. Prima viveva in due posti con regole diverse:
// Maneuvers usava una soglia singola (12 kts), ManeuverFootprint usava
// soglie type-dependent (8.5 virata / 12 strambata). Stessa manovra a
// 9 kts: FLY in Lab, TOUCH in Registro. Verdetti contraddittori.
// Ora un solo classificatore, una sola soglia, scelta dall'utente.

export type FoilingLabel = 'FLY' | 'TOUCH';

export interface FoilingStatus {
  label: FoilingLabel;
  color: string;
  bg: string;
  border: string;
}

export const FLY_STATUS: FoilingStatus = {
  label: 'FLY',
  color: 'text-sage',
  bg: 'bg-sage/10',
  border: 'border-sage/40',
};

export const TOUCH_STATUS: FoilingStatus = {
  label: 'TOUCH',
  color: 'text-amber',
  bg: 'bg-amber/10',
  border: 'border-amber/40',
};

// Default 12 kts: velocita' tipica di stacco dei foil su windsurf/wing
// foiling. L'utente puo' modificarla dal controllo in Manovre/Laboratorio.
export const DEFAULT_FLY_THRESHOLD = 12.0;

export function getFoilingStatus(sogMin: number, threshold: number): FoilingStatus {
  return sogMin >= threshold ? FLY_STATUS : TOUCH_STATUS;
}
