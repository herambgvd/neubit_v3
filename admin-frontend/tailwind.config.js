/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./web/**/*.{js,ts,jsx,tsx}",
  ],
  mode: "jit",
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic theme tokens (flip between light/dark via CSS vars in web/theme.css).
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: "var(--card)",
        "card-border": "var(--card-border)",
        muted: "var(--muted)",
        hover: "var(--hover)",
        field: "var(--field-border)",
      },
    },
  },
  plugins: [],
};
