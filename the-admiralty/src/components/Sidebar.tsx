import { useState } from 'react';
import type { ComponentType } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';

export type View = 'overview' | 'maneuvers' | 'lab' | 'start';

interface Props {
  currentView: View;
  onNavigate: (v: View) => void;
}

// Le label sono ricavate via i18n al render: la chiave i18n e' stabile,
// la stringa visibile cambia con la lingua.
interface Item {
  id: View;
  i18nKey: string;
  Icon: ComponentType;
}

const items: Item[] = [
  { id: 'overview', i18nKey: 'navigation.overview', Icon: CompassIcon },
  { id: 'maneuvers', i18nKey: 'navigation.maneuvers', Icon: RotateIcon },
  { id: 'lab', i18nKey: 'navigation.lab', Icon: ScatterIcon },
  { id: 'start', i18nKey: 'navigation.start', Icon: FlagIcon },
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
  const { t } = useTranslation();

  return (
    <motion.aside
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      initial={false}
      animate={{ width: isHovered ? 240 : 56 }}
      transition={widthSpring}
      // Gradient cockpit dall'alto: il navy si scurisce verso il basso e il
      // border-right resta il filo bluastro condiviso col resto della UI.
      className="fixed left-0 top-0 bottom-0 z-50 overflow-hidden flex flex-col"
      style={{
        background: 'linear-gradient(180deg, #061529 0%, #04101f 100%)',
        borderRight: '1px solid var(--line)',
      }}
    >
      {/* BRAND — V serif italic gold + sub-label "VAREA" mono. La sub-label
          appare solo in stato espanso (al pari delle nav label). */}
      <div
        className="h-14 flex items-center px-4 shrink-0"
        style={{ borderBottom: '1px solid var(--line)' }}
      >
        <span
          className="font-serif italic leading-none w-6 text-center shrink-0"
          style={{ color: 'rgb(var(--gold))', fontSize: '1.65rem' }}
        >
          V
        </span>
        <AnimatePresence>
          {isHovered && (
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0, transition: { delay: 0.06, type: 'spring', stiffness: 320, damping: 28 } }}
              exit={{ opacity: 0, x: -8, transition: { duration: 0.12 } }}
              className="ml-3 flex flex-col leading-none whitespace-nowrap"
            >
              <span className="font-serif italic text-base text-ink">Varea</span>
              <span
                className="font-mono uppercase mt-0.5"
                style={{
                  fontSize: '7px',
                  letterSpacing: '0.22em',
                  color: 'rgb(var(--ink-4))',
                }}
              >
                Telemetry · Cockpit
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <nav className="py-3 flex-1">
        {items.map((item, i) => {
          const active = currentView === item.id;
          return (
            <motion.button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              whileHover={{ x: 2 }}
              whileTap={{ x: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className="w-full flex items-center px-2.5 py-1 mb-0.5 relative"
            >
              {/* Barra verticale gold sul bordo sinistro per lo stato active.
                  Position absolute con left:-2px cosi' tocca esattamente il
                  filo della sidebar (border-right). */}
              {active && (
                <motion.span
                  layoutId="varea-sidebar-active"
                  className="absolute top-1 bottom-1 w-0.5"
                  style={{
                    left: '-1px',
                    background: 'rgb(var(--gold))',
                    boxShadow: '0 0 8px rgba(212, 175, 110, 0.55)',
                  }}
                  transition={indicatorSpring}
                />
              )}
              {/* Tile 36x36 cockpit: bordo sottile + bg appena visibile in
                  active, completamente trasparente altrimenti. */}
              <motion.span
                whileHover={{ scale: 1.04, rotate: active ? 0 : 4 }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                className="flex items-center justify-center shrink-0 transition-colors duration-220 ease-varea"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 6,
                  border: active
                    ? '1px solid rgba(212, 175, 110, 0.18)'
                    : '1px solid transparent',
                  background: active ? 'rgba(212, 175, 110, 0.06)' : 'transparent',
                  color: active ? 'rgb(var(--gold))' : 'rgb(var(--ink-2))',
                }}
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
                    className="ml-3 font-mono whitespace-nowrap"
                    style={{
                      fontSize: '11px',
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: active ? 'rgb(var(--gold))' : 'rgb(var(--ink-2))',
                    }}
                  >
                    {t(item.i18nKey)}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </nav>

      {/* FOOTER — LED verde "live" a sinistra, toggle tema (icona luna) a
          destra. Il LED comunica che la dashboard e' connessa/attiva. */}
      <div
        className="h-14 flex items-center px-4 shrink-0 gap-3"
        style={{ borderTop: '1px solid var(--line)' }}
      >
        <span className="cockpit-led shrink-0" aria-hidden />
        <AnimatePresence>
          {isHovered && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{
                opacity: 1,
                x: 0,
                transition: { delay: 0.05, type: 'spring', stiffness: 320, damping: 28 },
              }}
              exit={{ opacity: 0, x: -8, transition: { duration: 0.12 } }}
              className="font-mono whitespace-nowrap flex-1"
              style={{
                fontSize: '10px',
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'rgb(var(--ink-3))',
              }}
            >
              {t('common.online')}
            </motion.span>
          )}
        </AnimatePresence>
        <motion.button
          whileHover={{ scale: 1.08, rotate: 14 }}
          whileTap={{ scale: 0.94 }}
          transition={{ type: 'spring', stiffness: 380, damping: 20 }}
          onClick={() => document.documentElement.classList.toggle('dark')}
          className="flex items-center justify-center shrink-0 transition-colors duration-220 ease-varea"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            color: 'rgb(var(--ink-3))',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'rgb(var(--gold))')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'rgb(var(--ink-3))')}
          title={t('topbar.themeToggle')}
          aria-label={t('topbar.themeAria')}
        >
          <ThemeIcon />
        </motion.button>
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
