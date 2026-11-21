import type { AdapterReply } from '../../orchestrator/src/index.js';

/** Obiettivo della conversazione dimostrativa. */
export const DEMO_GOAL = 'Scegliere il database per la prima versione di AI Bridge.';

/**
 * Battute SCRITTE A MANO per la simulazione: non sono risposte di Claude né di ChatGPT.
 * Mostrano come il coordinatore gestisce disaccordo, informazioni non verificate,
 * richiesta di decisione all'utente e conclusione.
 */
export const DEMO_CLAUDE: AdapterReply[] = [
  {
    text: 'Propongo PostgreSQL gestito: messaggi e sessioni sono dati relazionali e reggono bene più dispositivi. Ipotizzo che il piano gratuito di un servizio gestito basti per un solo utente.',
    tag: 'non_verificato',
  },
  {
    text: 'Questo dipende da un dato che non ho: da dove userai AI Bridge all\'inizio. Lo chiedo all\'utente.',
    needsUser: 'Userai AI Bridge solo dal Mac nelle prime settimane, o anche dal telefono?',
  },
  {
    text: 'Accetto: partiamo con SQLite in locale e teniamo lo schema compatibile, così la migrazione a PostgreSQL resta semplice.',
    tag: 'accordo',
    done: true,
  },
];

export const DEMO_CHATGPT: AdapterReply[] = [
  {
    text: 'Per la prima versione preferirei SQLite in locale: costo zero e nessun servizio da configurare. PostgreSQL si aggiunge quando l\'app va online.',
    tag: 'disaccordo',
  },
  {
    text: 'Se l\'uso iniziale è solo sul Mac, il mio punto regge. Se serve anche il telefono, ha ragione Claude e conviene il database in rete.',
  },
  {
    text: 'Concordo: SQLite in locale per ora, con uno schema che si possa spostare su PostgreSQL senza riscriverlo.',
    tag: 'accordo',
    done: true,
  },
];
