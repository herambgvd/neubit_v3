module.exports = {
  plugins: {
    // Tailwind v4 ships its own vendor-prefixing (Lightning CSS), so autoprefixer
    // is no longer part of the chain.
    "@tailwindcss/postcss": {},
  },
}
