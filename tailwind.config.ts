import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral greys on true black (tvOS-like materials)
        ink: { 950: '#000000', 900: '#161618', 800: '#232326', 700: '#2f2f33', 600: '#45454a', 400: '#98989f', 200: '#e6e6eb' },
        accent: { DEFAULT: '#ffffff', soft: '#ffffff1f' },
        on: '#30d158',
        uhd: '#b48cff',
        fhd: '#4ab3e8',
        hd: '#30d158',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"SF Pro Text"', 'Inter', 'system-ui', 'sans-serif'],
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
