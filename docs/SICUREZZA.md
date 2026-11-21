# Sicurezza e spesa

- Nessun segreto nel repository (pubblico). Usare `.env` locale, mai committato.
- Tetto di spesa: **5 sterline a settimana** (blocco nell'app) più un limite mensile impostato nell'account API.
- Nessuna ricarica automatica dei crediti API.
- Nessuna azione esterna senza autorizzazione esplicita dell'utente.
- Possibilità di eliminare conversazioni e documenti; registro delle operazioni rilevanti.
- Nessun accesso presunto alle chat o alla memoria personale degli account ChatGPT e Claude.

## Accesso a ChatGPT (parti non ancora verificate dal vivo)
- Il rinnovo del token e la registrazione iniziale seguono la documentazione OpenAI ma non sono ancora provati con il servizio reale.
- La firma del token di identità non viene verificata (si controllano emittente, destinatario, scadenza e nonce; il token arriva direttamente via TLS).
- I token sono in `~/.config/ai-bridge/openai.json` con permessi 0600, mai in log né in errori.
