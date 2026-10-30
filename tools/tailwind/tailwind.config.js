// Tailwind settings for app.css. These were previously set at runtime by the
// Tailwind CDN script in index.html; building ahead of time means the page
// loads no styling code from another site.
//
// Rebuild after adding or changing classes in index.html:
//   cd tools/tailwind && npm install && npm run build
// CI fails if app.css is out of date (.github/workflows/check-css.yml).

/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['../../index.html'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                felt: {
                    50: '#eef6f3',
                    100: '#d5e9e1',
                    200: '#acd3c4',
                    300: '#7db8a3',
                    400: '#5aa48b',
                    500: '#3f8a71',
                    600: '#2f705b',
                    700: '#275a4a',
                    800: '#21483c',
                    900: '#1b3b31',
                    950: '#0e211b'
                },
                mtg: {
                    bg: '#15130f',
                    card: '#211e1a',
                    border: '#37322c',
                    accent: '#3f8a71',
                    gold: '#f59e0b',
                    manaW: '#f8fafc',
                    manaU: '#3b82f6',
                    manaB: '#6b7280',
                    manaR: '#ef4444',
                    manaG: '#22c55e'
                }
            }
        }
    }
};
