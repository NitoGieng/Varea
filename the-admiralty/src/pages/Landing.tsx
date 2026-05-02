import { motion } from 'framer-motion';
import { BackgroundPaths } from '../components/BackgroundPaths';

interface Props {
  // File[] anziche' FileList: il reset implicito dell'input al unmount
  // della Landing puo' svuotare la FileList live prima che React committi
  // lo state in App, mentre File[] e' uno snapshot stabile.
  onEnter: (files: File[]) => void;
}

// Landing page: prima schermata che il visitatore vede. Il CTA apre
// direttamente il file picker; la selezione di un .FIT/.CSV avvia subito
// l'analisi nel Dashboard (vedi App.tsx + Dashboard.initialFiles), cosi' c'e'
// un solo click fra "voglio iniziare" e l'analisi reale.
export default function Landing({ onEnter }: Props) {
  const title = 'Varea';

  return (
    <div className="relative min-h-screen w-full flex items-center justify-center overflow-hidden bg-gradient-to-b from-[#02060f] via-[#0a1d36] to-[#0e2a4d]">
      {/* Strato 1: gradiente radiale di luce per "alba in mare" */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 50% 35%, rgba(201,161,105,0.18), transparent 55%), radial-gradient(ellipse at 50% 100%, rgba(10,29,54,0.85), transparent 60%)',
        }}
      />

      {/* Strato 2: onde animate (SVG paths curvi) */}
      <BackgroundPaths />

      {/* Contenuto */}
      <div className="relative z-20 container mx-auto px-4 md:px-6 text-center">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.6 }}
          className="max-w-4xl mx-auto"
        >
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-eyebrow uppercase tracking-eyebrow text-[#c9a169] mb-6"
          >
            Telemetry analytics
          </motion.p>

          <h1 className="font-serif italic text-5xl sm:text-7xl md:text-8xl text-[#f5f1e6] leading-none mb-6 tracking-tighter">
            {title.split('').map((letter, i) => (
              <motion.span
                key={i}
                initial={{ y: 80, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{
                  delay: 0.35 + i * 0.06,
                  type: 'spring',
                  stiffness: 160,
                  damping: 24,
                }}
                className="inline-block"
              >
                {letter}
              </motion.span>
            ))}
          </h1>

          {/* Filo brass: stesso pattern del rule-brass del design system,
              ma centrato e corto perche' qui e' decorativo. */}
          <motion.div
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: 1 }}
            transition={{ duration: 0.9, delay: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
            className="mx-auto h-px w-24 bg-gradient-to-r from-transparent via-[#c9a169] to-transparent mb-8 origin-center"
          />

          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.05 }}
            className="text-base sm:text-lg text-[#f5f1e6]/70 max-w-xl mx-auto mb-12 font-sans leading-relaxed"
          >
            Analisi avanzata di sessioni di vela e windsurf da telemetria GPS.
            Vento reale, andature, manovre, VMG.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.25 }}
          >
            <label
              className="group inline-flex items-center gap-3 px-8 py-4 bg-[#c9a169] hover:bg-[#e8cea0] text-[#0a1428] text-eyebrow uppercase tracking-eyebrow rounded-md transition-all duration-220 ease-varea hover:-translate-y-0.5 shadow-card-md cursor-pointer"
            >
              <span>Inizia l'analisi</span>
              <span className="transition-transform duration-220 ease-varea group-hover:translate-x-1">
                →
              </span>
              <input
                type="file"
                multiple
                accept=".fit,.FIT,.csv,.CSV"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onEnter(Array.from(e.target.files));
                  }
                }}
              />
            </label>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

