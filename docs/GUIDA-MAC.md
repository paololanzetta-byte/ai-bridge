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
