import { useTranslation } from 'react-i18next';

interface Props {
  value: number;
  onChange: (v: number) => void;
  // Etichetta opzionale: il Registro mostra "Soglia Fly", il Laboratorio
  // ha gia' un toggle FLY/TOUCH a sinistra quindi puo' usare un eyebrow piu'
  // descrittivo. Default = "Soglia Fly".
  label?: string;
}

// Input numerico con unita' "kts" coerente coi controlli del FilterBar.
// Usato sia in Manovre che in Laboratorio: la soglia e' sollevata in
// Dashboard, quindi entrambe le pagine modificano lo stesso valore e i
// badge FLY/TOUCH restano coerenti.
export default function FlyThresholdControl({ value, onChange, label }: Props) {
  const { t } = useTranslation();
  const finalLabel = label ?? t('flyThreshold.label');
  return (
    <div className="flex items-center gap-2" title={t('flyThreshold.tooltip')}>
      <span className="eyebrow">{finalLabel}</span>
      <div className="flex items-center bg-bg border border-border rounded-md overflow-hidden px-2 focus-within:border-gold transition-colors duration-220">
        <input
          type="number"
          step="0.5"
          min={0}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) onChange(n);
          }}
          className="w-12 py-1.5 text-body font-mono tabular text-ink outline-none text-right bg-transparent"
          aria-label={t('flyThreshold.aria')}
        />
        <span className="text-caption text-ink-muted pl-1 pr-2">kts</span>
      </div>
    </div>
  );
}
