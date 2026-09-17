/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0F0F11',
        surface: '#1A1A1F',
        'surface-2': '#212128',
        border: '#2E2E38',
        primary: { DEFAULT: '#7C3AED', soft: '#8B5CF6' },
        ai: { DEFAULT: '#06B6D4', soft: '#22D3EE' },
        success: '#22C55E',
        danger: '#EF4444',
        warning: '#F59E0B',
        text: '#F4F4F5',
        muted: '#71717A',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: '14px',
        input: '9px',
        chip: '999px',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(6,182,212,0.35), 0 0 24px -4px rgba(6,182,212,0.45)',
        'glow-violet': '0 0 0 1px rgba(124,58,237,0.35), 0 0 24px -4px rgba(124,58,237,0.45)',
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'pop-in': { '0%': { opacity: '0', transform: 'scale(0.96)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
        pulse-glow: {
          '0%,100%': { boxShadow: '0 0 0 0 rgba(6,182,212,0.0)' },
          '50%': { boxShadow: '0 0 24px -2px rgba(6,182,212,0.55)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out',
        'slide-in': 'slide-in 0.28s cubic-bezier(0.22,1,0.36,1)',
        'pop-in': 'pop-in 0.2s ease-out',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
