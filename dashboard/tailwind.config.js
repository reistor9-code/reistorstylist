/**
 * Colours are mapped onto Gentelella v4's custom properties rather than
 * declared here, so the palette has exactly one home — src/index.css.
 *
 * The tokens carry rgba directly rather than bare channels, so Tailwind's
 * `/opacity` modifier does not apply to them. Upstream solves this with
 * pre-made translucent variants (`--primary-lt`, `--red-lt`), exposed below as
 * `accent-lt`, `bad-lt` and so on — use those instead of `bg-accent/10`.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        body: 'var(--body-bg)',
        card: 'var(--bg-surface)',
        muted: 'var(--bg-surface-secondary)',
        border: 'var(--border-color)',

        text: 'var(--text)',
        secondary: 'var(--text-secondary)',
        subtle: 'var(--text-muted)',

        accent: 'var(--primary)',
        'accent-dk': 'var(--primary-dk)',
        'accent-lt': 'var(--primary-lt)',

        good: 'var(--green)',
        'good-lt': 'var(--green-lt)',
        warn: 'var(--yellow)',
        'warn-lt': 'var(--yellow-lt)',
        bad: 'var(--red)',
        'bad-lt': 'var(--red-lt)',
        info: 'var(--blue)',
        'info-lt': 'var(--blue-lt)',

        sidebar: {
          DEFAULT: 'var(--sidebar-bg)',
          hover: 'var(--sidebar-hover)',
          active: 'var(--sidebar-active)',
          text: 'var(--sidebar-text)',
          'text-hover': 'var(--sidebar-text-hover)',
          'text-active': 'var(--sidebar-text-active)',
          border: 'var(--sidebar-border)',
        },
      },
      borderRadius: { DEFAULT: 'var(--radius)', lg: 'var(--radius)' },
      boxShadow: { card: 'var(--shadow-card)' },
    },
  },
  plugins: [],
};
