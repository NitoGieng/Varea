import type {
  PolarOptimum,
  PolarZoneStats,
} from '../utils/polar';

interface Props {
  upwind: PolarOptimum | null;
  downwind: PolarOptimum | null;
  zones: PolarZoneStats[];
  totalPoints: number;
}

// Colori token cockpit applicati via CSSVar perche' --violet/--cyan non
// sono esposti in tailwind.config (solo gold/sage/amber lo sono). Pattern
// gia' usato in WindRose.tsx per le cardinali della rosa.
const VIOLET = 'rgb(var(--violet))';
const CYAN = 'rgb(var(--cyan))';
const GOLD = 'rgb(var(--gold))';
const INK_2 = 'rgb(var(--ink-2))';

// Pannello laterale del Polar: tre blocchi verticali (VMG ottimali,
// distribuzione tempo, tabella zone). Stile coerente con le card della
// Panoramica: surface-1, border-border, eyebrow + valori in mono tabular.
export default function PolarStatsPanel({ upwind, downwind, zones, totalPoints }: Props) {
  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Blocco 1: VMG ottimali */}
      <section className="bg-surface-1 border border-border rounded-lg p-4">
        <h4 className="eyebrow mb-3">VMG ottimale</h4>
        <div className="grid grid-cols-2 gap-3">
          <OptimumBlock
            label="Bolina"
            optimum={upwind}
            color={VIOLET}
          />
          <OptimumBlock
            label="Lasco"
            optimum={downwind}
            color={GOLD}
          />
        </div>
      </section>

      {/* Blocco 2: Distribuzione angolare */}
      <section className="bg-surface-1 border border-border rounded-lg p-4">
        <h4 className="eyebrow mb-3">Distribuzione tempo</h4>
        <div className="space-y-2">
          {zones.map(z => (
            <ZoneBar key={z.label} zone={z} />
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-border text-caption text-ink-muted font-mono tabular flex justify-between">
          <span>Punti totali</span>
          <span className="text-ink-2">{totalPoints.toLocaleString('it-IT')}</span>
        </div>
      </section>

      {/* Blocco 3: Tabella SOG max/P90/N per zona */}
      <section className="bg-surface-1 border border-border rounded-lg p-4">
        <h4 className="eyebrow mb-3">Velocità per zona</h4>
        <table className="w-full text-caption font-mono tabular">
          <thead>
            <tr className="text-ink-muted text-eyebrow uppercase tracking-eyebrow border-b border-border">
              <th className="text-left py-1.5 font-normal">Zona</th>
              <th className="text-right py-1.5 font-normal">Max</th>
              <th className="text-right py-1.5 font-normal">P90</th>
              <th className="text-right py-1.5 font-normal">N</th>
            </tr>
          </thead>
          <tbody>
            {zones.map(z => (
              <tr key={z.label} className="border-b border-border/40 last:border-0">
                <td className="py-1.5 text-ink-2">{z.label}</td>
                <td className="py-1.5 text-right text-ink">
                  {z.count > 0 ? z.sogMax.toFixed(1) : '—'}
                </td>
                <td className="py-1.5 text-right text-gold">
                  {z.sogP90 != null ? z.sogP90.toFixed(1) : '—'}
                </td>
                <td className="py-1.5 text-right text-ink-muted">
                  {z.count.toLocaleString('it-IT')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function OptimumBlock({
  label,
  optimum,
  color,
}: {
  label: string;
  optimum: PolarOptimum | null;
  color: string;
}) {
  if (!optimum) {
    return (
      <div
        className="bg-bg border border-border rounded-md p-3"
        style={{ borderLeft: `2px solid ${color}` }}
      >
        <div className="eyebrow mb-2">{label}</div>
        <div className="text-caption text-ink-muted">Dati insufficienti</div>
      </div>
    );
  }
  return (
    <div
      className="bg-bg border border-border rounded-md p-3"
      style={{ borderLeft: `2px solid ${color}` }}
    >
      <div className="eyebrow mb-2">{label}</div>
      <div className="flex items-baseline gap-1.5 mb-1">
        <span
          className="text-2xl font-mono tabular leading-none"
          style={{ color }}
        >
          {optimum.twaDeg.toFixed(0)}
        </span>
        <span className="text-caption text-ink-muted">°TWA</span>
      </div>
      <div className="text-caption font-mono tabular text-ink-2">
        VMG <span style={{ color }}>{optimum.vmgKnots.toFixed(2)}</span>
        <span className="text-ink-muted ml-1">kts</span>
      </div>
      <div className="text-caption font-mono tabular text-ink-muted">
        SOG {optimum.sogKnots.toFixed(1)} kts
      </div>
    </div>
  );
}

// Mini-barra orizzontale: indicatore visivo della frazione tempo nella
// zona. Colori riflettono i token andatura: violet=bolina, cyan=traverso,
// gold=lasco/poppa. Inline style perche' i token violet/cyan non sono
// esposti come classi Tailwind (vivono solo come CSS var).
const ZONE_BAR_COLOR: Record<string, string> = {
  'Bolina stretta': `${VIOLET}`,
  'Bolina': `${VIOLET}`,
  'Traverso': `${CYAN}`,
  'Lasco': `${GOLD}`,
  'Poppa': `${GOLD}`,
};
const ZONE_BAR_OPACITY: Record<string, number> = {
  'Bolina stretta': 0.85,
  'Bolina': 0.55,
  'Traverso': 0.7,
  'Lasco': 0.7,
  'Poppa': 0.5,
};

function ZoneBar({ zone }: { zone: PolarZoneStats }) {
  const pct = zone.fraction * 100;
  const baseColor = ZONE_BAR_COLOR[zone.label] ?? INK_2;
  const opacity = ZONE_BAR_OPACITY[zone.label] ?? 0.6;
  return (
    <div>
      <div className="flex items-baseline justify-between text-caption font-mono tabular mb-1">
        <span className="text-ink-2">{zone.label}</span>
        <span className="text-ink">
          {pct.toFixed(1)}<span className="text-ink-muted ml-0.5">%</span>
        </span>
      </div>
      <div className="h-1.5 bg-bg border border-border/50 rounded-sm overflow-hidden">
        <div
          className="h-full transition-all duration-220"
          style={{
            width: `${Math.max(pct, 0.5)}%`,
            backgroundColor: baseColor,
            opacity,
          }}
        />
      </div>
      <div className="text-[10px] text-ink-muted font-mono tabular mt-0.5">
        {zone.rangeDeg[0]}°–{zone.rangeDeg[1]}°
      </div>
    </div>
  );
}
