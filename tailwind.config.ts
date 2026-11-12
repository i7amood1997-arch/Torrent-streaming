import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#07080b', 900: '#0d0f14', 800: '#151821', 700: '#1f2330', 600: '#2c3142', 400: '#7d8499', 200: '#c9cdd8' },
        accent: { DEFAULT: '#e8b04a', soft: '#e8b04a22' },
        uhd: '#b48cff',
        fhd: '#4ab3e8',
        hd: '#5fd38d',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        arabic: ['Cairo', 'Tajawal', 'system-ui', 'sans-serif'],
      },
      spacing: {
        'safe-t': 'env(safe-area-inset-top)',
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-l': 'env(safe-area-inset-left)',
        'safe-r': 'env(safe-area-inset-right)',
      },
    },
  },
  plugins: [],
} satisfies Config;
