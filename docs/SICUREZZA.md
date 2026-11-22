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

## Pagina web
- PIN a 4 cifre salvato con scrypt (mai in chiaro), blocco progressivo dopo 5 errori; cookie di sessione HttpOnly/SameSite=Strict, 12 ore.
- Il server ascolta solo su 127.0.0.1 e rifiuta di aprirsi alla rete (serve `AIBRIDGE_ALLOW_LAN=1`). Dal telefono si usa Tailscale Serve (HTTPS, solo dispositivi del tuo account). Un PIN di 4 cifre è debole: la pagina non va mai esposta a Internet (niente Funnel). Fuori da 127.0.0.1 il cookie di sessione ha il flag Secure.
- Controllo Origin sulle richieste che modificano dati, CSP restrittiva, foto verificate dal contenuto (PNG/JPG/WebP, max 2 MB).

## Spesa
Registro unico in SQLite; prenotazione atomica del costo massimo prima di ogni chiamata (transazione esclusiva); spesa della discussione separata dal totale settimanale; prenotazioni orfane dopo un crash contate come spese. Limite onesto: è un tetto interno basato sui prezzi dichiarati, non un blocco sul conto del fornitore.
