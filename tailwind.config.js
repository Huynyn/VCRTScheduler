/** @type {import('tailwindcss').Config} */
// Color scheme mirrors the medical/EMS web app whose CSS was provided:
// a clean semantic palette (primary / secondary / success / warning / danger),
// Inter body font, JetBrains Mono accents, rounded-lg cards and the custom
// "shadow-card". `primary` is a professional blue (also used as the supervisor
// accent colour in the PDF). To rebrand to uOttawa garnet, just swap the
// `primary` scale below — nothing else needs to change.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
          800: '#1e3a8a',
          900: '#172554',
        },
        secondary: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#475569',
          600: '#334155',
          700: '#1e293b',
          800: '#0f172a',
          900: '#020617',
        },
        success: {
          50: '#f0fdf4',
          100: '#dcfce7',
          400: '#4ade80',
          500: '#16a34a',
          600: '#15803d',
          700: '#166534',
          800: '#14532d',
        },
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          400: '#fbbf24',
          500: '#d97706',
          600: '#b45309',
          700: '#92400e',
          800: '#78350f',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          400: '#f87171',
          500: '#dc2626',
          600: '#b91c1c',
          700: '#991b1b',
          800: '#7f1d1d',
        },
        // uOttawa garnet — used for the header accent / brand bar.
        garnet: {
          500: '#8d1d2c',
          600: '#7a1726',
          700: '#5f1019',
        },
      },
      boxShadow: {
        card: '0px 0.6px 0.7px hsl(220deg 3% 15% / 0.37), 0px 1px 1.1px -0.8px hsl(220deg 3% 15% / 0.37), 0px 2.5px 2.8px -1.7px hsl(220deg 3% 15% / 0.37), 0px 6.2px 7px -2.5px hsl(220deg 3% 15% / 0.37)',
      },
    },
  },
  plugins: [],
};
