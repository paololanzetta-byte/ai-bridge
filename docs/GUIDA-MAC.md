# Guida per il Mac: prova di collegamento a Claude

Serve per verificare che la chiave API funzioni. Costo della prova: frazioni di centesimo.

## Prima volta
1. **Installa Node.js.** Su nodejs.org scarica la versione "LTS" per macOS (file .pkg), aprila e segui le schermate.
2. **Scarica il progetto.** Su github.com/paololanzetta-byte/ai-bridge tocca **Code**, poi **Download ZIP**. Apri lo ZIP in Documenti: nasce la cartella `ai-bridge-main`.
3. **Apri il Terminale** (Cmd+Spazio, scrivi "Terminale", Invio).
4. Scrivi `cd ` (con lo spazio), trascina la cartella `ai-bridge-main` nella finestra del Terminale e premi Invio.
5. Scrivi `npm install` e premi Invio. Aspetta che finisca.
6. Scrivi `cp .env.example .env` e premi Invio, poi `open -e .env`: si apre il file in TextEdit.
7. Dopo `ANTHROPIC_API_KEY=` incolla la tua chiave, senza spazi né virgolette. Salva con Cmd+S e chiudi.
8. Scrivi `npm run check:claude` e premi Invio.

Se va bene vedrai: "Risposta di Claude: collegamento riuscito", il costo della prova e la spesa della settimana.

## Regole sulla chiave
- La chiave sta solo nel file `.env`, che non viene mai caricato su GitHub.
- Non incollarla in chat, in email o in altri documenti.
- Se pensi che qualcuno l'abbia vista, cancellala nella Console Anthropic e creane una nuova.
- Il tetto di spesa è di 5 sterline a settimana: il programma si ferma da solo e non fa nessuna chiamata oltre il tetto.

# Accesso a ChatGPT con il tuo piano

Il costo in denaro è zero: l'uso conta sulla quota del tuo abbonamento ChatGPT. Funzione in anteprima presso OpenAI: potrebbe non essere disponibile per la tua app (in quel caso c'è il piano B con le API a consumo, sempre dentro il tetto di 5 sterline).

1. Se hai riscaricato il progetto, copia il vecchio file `.env` nella nuova cartella (tasto Cmd+C / Cmd+V in Finder; il file è nascosto: Cmd+Maiusc+. per mostrarlo).
2. Nel Terminale, nella cartella del progetto: `npm install` e poi `npm run login:chatgpt`.
3. Si apre il browser: accedi a ChatGPT e conferma. Poi torna al Terminale.
4. `npm run check:chatgpt` fa una prova minuscola e mostra i modelli disponibili.
5. Prima conversazione reale: `npm run chat -- "Quale database scegliere per AI Bridge?"` (massimo 6 turni, si ferma al tetto di spesa, salva il rapporto in `data/reports`).

I dati di accesso restano nel file `~/.config/ai-bridge/openai.json` sul tuo Mac (non viene mai caricato su GitHub).

# Archivio delle conversazioni
Ogni conversazione di `npm run chat` viene salvata in `data/ai-bridge.db` (un file SQLite, gratuito, solo sul tuo Mac).
- `npm run history` mostra l'elenco.
- `npm run history -- 3` rilegge la conversazione n. 3 con il suo rapporto.

## La pagina web (PIN, foto, telefono)

1. Prova senza chiavi e senza costi: `npm run web:prova`, poi apri http://127.0.0.1:3000 (risposte simulate, dati in `data-prova`).
2. Uso vero: `npm run web` (servono il file `.env` con la chiave Claude e l'accesso ChatGPT già fatto).
3. Al primo avvio scegli un PIN di 4 cifre. Dopo 5 errori la pagina si blocca per 5, poi 15, poi 60 minuti.
4. Dal profilo (in basso a sinistra, o "Profilo" sul telefono) cambi nome, PIN e le foto tue, di Claude e di ChatGPT. Le foto restano in `data/avatars`, mai su GitHub.
5. Dal telefono con Tailscale Serve: il server resta SEMPRE su 127.0.0.1 (visibile solo dal Mac). Installa Tailscale su Mac e iPhone con lo stesso account, attiva i certificati HTTPS dal pannello di amministrazione di Tailscale, poi nel Terminale `tailscale serve --bg 3000`. Tailscale mostra un indirizzo `https://<nome-del-mac>.<rete>.ts.net` raggiungibile solo dai tuoi dispositivi: aprilo da Safari sull'iPhone. Per spegnere: `tailscale serve off`. Il server rifiuta `HOST=0.0.0.0` (serve `AIBRIDGE_ALLOW_LAN=1`, sconsigliato).
6. Il rapporto si scarica dal Riepilogo. Il salvataggio su Drive parte solo se lo chiedi, ogni volta.

## Avvio automatico
Dentro la cartella del progetto: `sh scripts/avvio-automatico.sh` (prima ferma il server acceso a mano con Ctrl+C). Per toglierlo: `sh scripts/avvio-automatico.sh togli`. Il registro è in `~/Library/Logs/ai-bridge.log`. Dopo un aggiornamento del codice: `npm run build` e poi `launchctl kickstart -k gui/$(id -u)/com.aibridge.web`.

## Spesa e budget
Tutte le discussioni usano un unico registro nell'archivio (`data/ai-bridge.db`). Prima di ogni chiamata a Claude si riserva il costo massimo possibile; se supera il tetto settimanale la chiamata non parte. Gli avvisi al 50% e all'80% contano speso più prenotato. Il tetto è calcolato dall'app su prezzi noti: la fattura del fornitore resta separata, quindi controlla anche il suo pannello. STOP annulla la richiesta in corso; se il costo reale è ignoto si conta il massimo riservato.
