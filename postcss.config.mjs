/**
 * Tailwind CSS v4 wiring.
 *
 * The design came from Figma Make, which standardised on Tailwind v4 through a
 * PostCSS plugin. Next.js picks this file up automatically, so the ported
 * component markup keeps its utility classes verbatim.
 */

const config = {
  plugins: {
    '@tailwindcss/postcss': {}
  }
};

export default config;
