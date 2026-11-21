/** Elenco delle conversazioni salvate. Uso: npm run history  oppure  npm run history -- 3 (mostra la n. 3). */
import { Store } from './store.js';

const store = new Store('data/ai-bridge.db');
const arg = process.argv[2];

if (!arg) {
  const rows = store.listSessions();
  if (rows.length === 0) console.log('Nessuna conversazione salvata.');
  for (const s of rows) {
    console.log(`#${s.id} · ${s.startedAt.slice(0, 16).replace('T', ' ')} · ${s.state} · ${s.turns} turni · £${s.spentGbp.toFixed(4)}\n   ${s.goal}`);
  }
} else {
  const s = store.getSession(Number(arg));
  if (!s) {
    console.error('Conversazione non trovata.');
    process.exitCode = 1;
  } else {
    const names: Record<string, string> = { user: 'Tu', claude: 'Claude', chatgpt: 'ChatGPT', system: 'Sistema' };
    for (const m of store.messages(s.id)) {
      if (m.kind === 'decision_request') continue;
      console.log(`\n[${names[m.from] ?? m.from}${m.tag ? ` · ${m.tag}` : ''}]\n${m.text}`);
    }
    if (s.reportText) console.log(`\n${s.reportText}`);
  }
}
store.close();
