/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // La nostra nuova palette nautica
        navy: {
          900: '#061325', // Il blu scuro della carta "Hull Efficiency"
          800: '#0a1d36',
        },
        gold: {
          DEFAULT: '#b38d56', // Il bronzo dei numeri "KTS" e dei bordi
          light: '#f2dfc2',
        },
        paper: '#f8f7f5', // Lo sfondo panna
        surface: '#ffffff', // Il bianco delle carte
      },
      fontFamily: {
        // Useremo font di sistema simili finché non importiamo Google Fonts
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}