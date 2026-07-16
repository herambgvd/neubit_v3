/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Dark control-room palette: near-black surfaces + subtle borders.
        base: '#0a0a0b',
        surface: '#111113',
        elevated: '#17171a',
        border: '#26262b',
        muted: '#8a8a94',
        faint: '#5a5a63',
        accent: '#3b82f6',
        'accent-dim': '#1d4ed8',
        danger: '#ef4444',
        ok: '#22c55e',
        warn: '#f59e0b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
