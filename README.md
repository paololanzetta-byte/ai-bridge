# AI Bridge

Chat room a tre partecipanti: un utente (supervisore), Claude e ChatGPT.
Le due AI possono discutere in autonomia entro limiti prestabiliti; l'utente può intervenire in qualsiasi momento.

**Stato (21-11-2026): fase di progettazione. Nessuna funzione è ancora implementata.**

## Documentazione
- [Architettura](docs/ARCHITETTURA.md)
- [Piano a fasi](docs/PIANO.md)
- [Sicurezza e spesa](docs/SICUREZZA.md)

## Regola fondamentale
Questo repository è pubblico. Chiavi, token, dati e conversazioni non vanno MAI nel codice: stanno nel file `.env` locale (ignorato da Git) e nel database.
