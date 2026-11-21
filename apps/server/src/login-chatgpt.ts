import { execFile } from 'node:child_process';
import { OpenAIAuth } from './openai-auth.js';

const auth = new OpenAIAuth({
  openBrowser: (url) => {
    console.log('\nSto aprendo il browser per l\'accesso a ChatGPT.');
    console.log('Se non si apre da solo, copia questo indirizzo nel browser:\n');
    console.log(url + '\n');
    execFile('open', [url], () => undefined); // macOS
  },
});

try {
  await auth.login();
  console.log('Accesso a ChatGPT completato. Ora puoi usare: npm run check:chatgpt');
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Errore sconosciuto.');
  process.exitCode = 1;
}
