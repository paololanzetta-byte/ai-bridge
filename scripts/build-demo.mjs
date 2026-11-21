// Crea una pagina unica (dist/demo/index.html) con la simulazione già dentro.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['dist/demo/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
});

const script = (result.outputFiles[0]?.text ?? '').replace(/<\/script/gi, '<\\/script');
const template = readFileSync('demo/template.html', 'utf8');
mkdirSync('dist/demo', { recursive: true });
writeFileSync('dist/demo/index.html', template.replace('/*__SCRIPT__*/', () => script));
console.log('Creata dist/demo/index.html');
