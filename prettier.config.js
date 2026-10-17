/** @type {import('prettier').Config} */
export default {
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindStylesheet: './apps/web/src/styles/globals.css',
  tailwindFunctions: ['cn', 'cva'],
};
