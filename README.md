# AI Bridge

Chat room a tre partecipanti: un utente (supervisore), Claude e ChatGPT.
Le due AI possono discutere in autonomia entro limiti prestabiliti; l'utente può intervenire in qualsiasi momento.

**Stato (22-11-2026): versione funzionante in locale.** Pagina web con PIN, discussioni vere tra Claude (chiave API) e ChatGPT (piano personale), archivio SQLite, rapporto finale, foto profilo, avvisi di spesa. Gira solo sul computer dell'utente (127.0.0.1); dal telefono si usa Tailscale Serve. Il coordinatore ha tetto di spesa settimanale con prenotazione dei costi, STOP con cancellazione delle richieste, limiti di turni e rilevamento delle ripetizioni.

**Limiti noti (v0.2 in lavorazione):** contesto completo rinviato a ogni turno (nessun riassunto automatico), nessuna separazione dei messaggi privati tra le due AI, nessun nuovo tentativo automatico dopo un errore, nessuna ripresa delle discussioni dopo un riavvio.

## Usare l'app
```
npm install
npm run web:prova   # senza chiavi e senza costi, risposte simulate
npm run web         # uso vero (serve .env con la chiave Claude e l'accesso ChatGPT)
npm test            # test automatici
```
Dettagli passo passo in [docs/GUIDA-MAC.md](docs/GUIDA-MAC.md).

## Documentazione
- [Architettura](docs/ARCHITETTURA.md)
- [Piano a fasi](docs/PIANO.md)
- [Sicurezza e spesa](docs/SICUREZZA.md)

## Regola fondamentale
Questo repository è pubblico. Chiavi, token, dati e conversazioni non vanno MAI nel codice: stanno nel file `.env` locale (ignorato da Git) e nel database.
