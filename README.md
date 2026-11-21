# AI Bridge

Chat room a tre partecipanti: un utente (supervisore), Claude e ChatGPT.
Le due AI possono discutere in autonomia entro limiti prestabiliti; l'utente può intervenire in qualsiasi momento.

**Stato (21-11-2026): Fase 2, prototipo con adattatori FINTI.** Il coordinatore (turni, limiti, ripetizioni, pausa e ripresa, richieste di decisione, tetto di spesa, rapporto finale) è scritto e provato con test automatici. Nessun servizio AI reale è ancora collegato: ChatGPT e Claude sono simulati con battute scritte a mano.

## Provare il prototipo
```
npm install
npm test        # 16 test automatici
npm run demo    # crea dist/demo/index.html, la simulazione in una pagina sola
```

## Documentazione
- [Architettura](docs/ARCHITETTURA.md)
- [Piano a fasi](docs/PIANO.md)
- [Sicurezza e spesa](docs/SICUREZZA.md)

## Regola fondamentale
Questo repository è pubblico. Chiavi, token, dati e conversazioni non vanno MAI nel codice: stanno nel file `.env` locale (ignorato da Git) e nel database.
