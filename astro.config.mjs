// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build
export default defineConfig({
  site: 'https://gopimplantes.br',
  // emite "pagina.html" em vez de "pagina/index.html" — URLs com extensão .html
  build: { format: 'file' },
});
