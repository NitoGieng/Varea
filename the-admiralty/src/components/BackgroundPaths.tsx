import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

// Onde animate sullo sfondo della landing: due strati speculari di path
// curvi che ricordano la scia di una barca / il moto ondoso dell'acqua.
// I path sono volutamente sottili e a bassa opacita' per non competere col
// CTA. Colori espliciti (avorio + brass) perche' la landing forza un
// contesto "mare scuro" indipendente dal tema attivo.
function FloatingPaths({ position }: { position: number }) {
  const { t } = useTranslation();
  const paths = Array.from({ length: 36 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${
      380 - i * 5 * position
    } -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${
      152 - i * 5 * position
    } ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${
      684 - i * 5 * position
    } ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
    width: 0.5 + i * 0.03,
  }));

  return (
    <div className="absolute inset-0 pointer-events-none">
      <svg
        className="w-full h-full"
        viewBox="0 0 696 316"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <title>{t('landing.backgroundTitle')}</title>
        {paths.map((path) => (
          <motion.path
            key={path.id}
            d={path.d}
            // Mix avorio caldo (foam) + brass tenue: alterno per dare
            // profondita' senza far diventare lo sfondo "righe colorate".
            stroke={path.id % 3 === 0 ? '#c9a169' : '#f5f1e6'}
            strokeWidth={path.width}
            strokeOpacity={0.06 + path.id * 0.012}
            initial={{ pathLength: 0.3, opacity: 0.6 }}
            animate={{
              pathLength: 1,
              opacity: [0.25, 0.55, 0.25],
              pathOffset: [0, 1, 0],
            }}
            transition={{
              duration: 22 + Math.random() * 10,
              repeat: Number.POSITIVE_INFINITY,
              ease: 'linear',
            }}
          />
        ))}
      </svg>
    </div>
  );
}

export function BackgroundPaths() {
  return (
    <div className="absolute inset-0">
      <FloatingPaths position={1} />
      <FloatingPaths position={-1} />
    </div>
  );
}
