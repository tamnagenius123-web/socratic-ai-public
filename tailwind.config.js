/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './public/**/*.html',
    './public/**/*.js',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          inverse: 'var(--surface-inverse)',
        },
        ink: {
          primary: 'var(--ink-primary)',
          secondary: 'var(--ink-secondary)',
          tertiary: 'var(--ink-tertiary)',
          disabled: 'var(--ink-disabled)',
          inverse: 'var(--ink-inverse)',
        },
        signal: {
          insight: 'var(--signal-insight)',
          progress: 'var(--signal-progress)',
          friction: 'var(--signal-friction)',
          thinking: 'var(--signal-thinking)',
        },
        primary: {
          50: 'var(--surface-2)',
          100: 'var(--surface-2)',
          200: 'var(--surface-2)',
          300: 'var(--surface-2)',
          400: 'var(--signal-insight)',
          500: 'var(--signal-insight)',
          600: 'var(--action-primary-hover)',
          700: 'var(--action-primary-hover)',
          800: 'var(--action-primary)',
          900: 'var(--action-primary)',
        },
        success: '#10B981',
        live: '#00B67A',
        danger: '#C0392B',
        warning: {
          DEFAULT: '#F59E0B',
          light: '#FFFBEB',
          dark: '#D97706',
          border: '#FCD34D',
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans KR', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
