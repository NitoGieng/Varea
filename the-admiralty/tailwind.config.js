/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Token semantici — auto-switch light/dark via CSS vars in src/index.css.
        // Usare questi per qualsiasi nuovo componente.
        bg: 'rgb(var(--bg) / <alpha-value>)',
        'surface-1': 'rgb(var(--surface-1) / <alpha-value>)',
        'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
        'ink-muted': 'rgb(var(--ink-muted) / <alpha-value>)',
        gold: {
          DEFAULT: 'rgb(var(--gold) / <alpha-value>)',
          deep: 'rgb(var(--gold-deep) / <alpha-value>)',
          light: '#f2dfc2', // legacy — non usare in nuovi componenti
        },
        brass: 'rgb(var(--brass) / <alpha-value>)',
        sage: 'rgb(var(--sage) / <alpha-value>)',
        amber: 'rgb(var(--amber) / <alpha-value>)',
        terra: 'rgb(var(--terra) / <alpha-value>)',

        // Legacy — mantenuti finché i componenti esistenti non sono migrati.
        navy: {
          900: '#061325',
          800: '#0a1d36',
        },
        paper: '#f8f7f5',
        surface: '#ffffff',
      },
      fontFamily: {
        // DM Serif Display in cima per il look cockpit/avionics; Playfair
        // resta come fallback per sessioni offline/cache vecchia.
        serif: ['"DM Serif Display"', '"Playfair Display"', 'Georgia', 'serif'],
        sans: ['Inter', '"Inter Tight"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', '"SF Mono"', 'Consolas', 'monospace'],
      },
      fontSize: {
        eyebrow: ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.18em', fontWeight: '500' }],
        caption: ['0.75rem', { lineHeight: '1.125rem' }],
        body: ['0.875rem', { lineHeight: '1.375rem' }],
        'body-lg': ['1rem', { lineHeight: '1.5rem' }],
        h2: ['1.75rem', { lineHeight: '2.125rem', letterSpacing: '-0.01em' }],
        h1: ['3rem', { lineHeight: '3.5rem', letterSpacing: '-0.02em' }],
        display: ['4.5rem', { lineHeight: '4.75rem', letterSpacing: '-0.03em', fontWeight: '600' }],
      },
      letterSpacing: {
        eyebrow: '0.18em',
      },
      spacing: {
        '30': '7.5rem', // 120px — top della scala
      },
      borderRadius: {
        sm: '0.125rem', // 2px
        md: '0.25rem',  // 4px
        lg: '0.375rem', // 6px
        xl: '0.625rem', // 10px — massimo consentito per "foil affilato"
      },
      boxShadow: {
        card: 'var(--shadow-sm)',
        'card-md': 'var(--shadow-md)',
        brass: 'inset 0 1px 0 rgb(var(--gold) / 0.18)',
      },
      transitionTimingFunction: {
        varea: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      transitionDuration: {
        '220': '220ms',
        '260': '260ms',
      },
    },
  },
  plugins: [],
}
