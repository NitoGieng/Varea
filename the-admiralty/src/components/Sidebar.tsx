import { useState } from 'react';
import type { ComponentType } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type View = 'overview' | 'maneuvers' | 'lab' | 'start';

interface Props {
  currentView: View;
  onNavigate: (v: View) => void;
}

interface Item {
  id: View;
  label: string;
  Icon: ComponentType;
}

const items: Item[] = [
  { id: 'overview', label: 'Panoramica', Icon: CompassIcon },
  { id: 'maneuvers', label: 'Manovre', Icon: RotateIcon },
  { id: 'lab', label: 'Laboratorio', Icon: ScatterIcon },
  { id: 'start', label: 'Start', Icon: FlagIcon },
];

// Spring fisicamente coerente: la sidebar e' un "signature moment" della UI,
// quindi merita una molla con settle visibile invece del cubic-bezier piatto.
const widthSpring = { type: 'spring' as const, stiffness: 220, damping: 32, mass: 0.85 };
const indicatorSpring = { type: 'spring' as const, stiffness: 350, damping: 30 };

const labelVariants = {
  closed: { opacity: 0, x: -8 },
  open: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: 0.05 + i * 0.04, type: 'spring' as const, stiffness: 320, damping: 28 },
  }),
};

export default function Sidebar({ currentView, onNavigate }: Props) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <motion.aside
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      initial={false}
      animate={{ width: isHovered ? 240 : 56 }}
      transition={widthSpring}
      className="fixed left-0 top-0 bottom-0 z-50 bg-surface-1 border-r border-border overflow-hidden flex flex-col"
    >
      <div className="h-14 flex items-center px-4 border-b border-border shrink-0">
        <span className="font-serif italic text-2xl text-gold leading-none w-6 text-center shrink-0">V</span>
        <AnimatePresence>
          {isHovered && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0, transition: { delay: 0.06, type: 'spring', stiffness: 320, damping: 28 } }}
              exit={{ opacity: 0, x: -8, transition: { duration: 0.12 } }}
              className="ml-3 font-serif italic text-base text-ink whitespace-nowrap"
            >
              Varea
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <nav className="py-2 flex-1">
        {items.map((item, i) => {
          const active = currentView === item.id;
          return (
            <motion.button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              whileHover={{ x: 2 }}
              whileTap={{ x: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className={`w-full h-12 flex items-center px-4 relative ${
                active ? 'text-gold' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="varea-sidebar-active"
                  className="absolute left-0 top-2 bottom-2 w-0.5 bg-gold"
                  transition={indicatorSpring}
                />
              )}
              <motion.span
                whileHover={{ scale: 1.06, rotate: active ? 0 : 4 }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                className="w-6 h-6 flex items-center justify-center shrink-0"
              >
                <item.Icon />
              </motion.span>
              <AnimatePresence>
                {isHovered && (
                  <motion.span
                    custom={i}
                    variants={labelVariants}
                    initial="closed"
                    animate="open"
                    exit={{ opacity: 0, x: -8, transition: { duration: 0.12 } }}
                    className="ml-3 text-eyebrow uppercase tracking-eyebrow whitespace-nowrap"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </nav>

      <div className="border-t border-border h-14 flex items-center px-4 shrink-0">
        <motion.button
          whileHover={{ scale: 1.08, rotate: 14 }}
          whileTap={{ scale: 0.94 }}
          transition={{ type: 'spring', stiffness: 380, damping: 20 }}
          onClick={() => document.documentElement.classList.toggle('dark')}
          className="w-6 h-6 flex items-center justify-center text-ink-muted hover:text-gold shrink-0"
          title="Inverti tema"
          aria-label="Toggle tema"
        >
          <ThemeIcon />
        </motion.button>
        <AnimatePresence>
          {isHovered && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{
                opacity: 1,
                x: 0,
                transition: { delay: 0.05 + items.length * 0.04, type: 'spring', stiffness: 320, damping: 28 },
              }}
              exit={{ opacity: 0, x: -8, transition: { duration: 0.12 } }}
              className="ml-3 text-eyebrow uppercase tracking-eyebrow text-ink-muted whitespace-nowrap"
            >
              Tema
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </motion.aside>
  );
}

// ============================================================
// ICONE — monoline 20px stroke 1.5
// ============================================================

function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <circle cx="12" cy="12" r="9" />
      <polygon points="14.5,9.5 12,15 9.5,9.5 12,4" fill="currentColor" stroke="none" opacity="0.85" />
    </svg>
  );
}

function RotateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M3 12a9 9 0 0 1 15.5-6.3M21 4v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3M3 20v-5h5" />
    </svg>
  );
}

function ScatterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M3 21h18" />
      <path d="M3 3v18" />
      <circle cx="8" cy="16" r="1.2" fill="currentColor" />
      <circle cx="13" cy="11" r="1.2" fill="currentColor" />
      <circle cx="17" cy="14" r="1.2" fill="currentColor" />
      <circle cx="19" cy="6" r="1.2" fill="currentColor" />
      <circle cx="11" cy="7" r="1.2" fill="currentColor" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" fill="currentColor" stroke="currentColor" opacity="0.85" />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}
