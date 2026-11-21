# Architettura (bozza approvata il 21-11-2026)

Interfaccia web (React) <-> server (Node.js/TypeScript) <-> database PostgreSQL.

## Moduli
- **Stanza**: messaggi e partecipanti, mittente sempre identificato.
- **Coordinatore**: ordine dei turni, limiti di turni e durata, rilevamento ripetizioni, richieste di decisione all'utente, stop e ripresa, chiusura della sessione.
- **Adattatori** (intercambiabili): ChatGPT (accesso con il piano ChatGPT dell'utente, se consentito), Claude (API a chiave), Finto (per test gratuiti).
- **Riassunto**: separa fatti verificati, ipotesi e decisioni dell'utente; approvato dall'utente prima di essere condiviso.
- **Controllo spesa**: tetto settimanale, blocco automatico.
- **Archivio**: esportazioni e backup su Google Drive; registro delle operazioni.

## Cartelle
- `apps/web`: interfaccia
- `apps/server`: server
- `packages/orchestrator`: coordinatore
- `packages/adapters`: adattatori
- `tests`: test
- `docs`: documentazione

Le scelte tecnologiche vanno validate prima dell'implementazione definitiva.
