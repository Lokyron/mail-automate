-- Schema de Inbox Agent. Chaque bloc est idempotent (CREATE ... IF NOT EXISTS) :
-- le fichier est rejoue a chaque demarrage, les migrations additives vivent dans
-- db/index.js.

PRAGMA foreign_keys = ON;

-- Sessions d'interface (identifiant opaque, invalidable, persistant)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Copie locale des messages releves. La boite Gmail n'est jamais modifiee.
CREATE TABLE IF NOT EXISTS inbox_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox       TEXT NOT NULL,
  uid_validity  TEXT NOT NULL,
  uid           INTEGER NOT NULL,
  message_id    TEXT NOT NULL UNIQUE,
  in_reply_to   TEXT DEFAULT '',
  thread_refs   TEXT DEFAULT '',
  from_name     TEXT DEFAULT '',
  from_email    TEXT DEFAULT '',
  to_text       TEXT DEFAULT '',
  cc_text       TEXT DEFAULT '',
  reply_to      TEXT DEFAULT '',
  subject       TEXT DEFAULT '',
  snippet       TEXT DEFAULT '',
  body_text     TEXT DEFAULT '',
  body_html     TEXT DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  attachments   INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT,
  received_at   TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  -- a_trier : releve, pas encore examine
  -- trie     : une proposition de tri existe
  -- vu       : l'humain a tranche (valide ou corrige)
  status        TEXT NOT NULL DEFAULT 'a_trier',
  -- 1 = courrier mis hors de portee du modele (cf. config.confidentiel).
  -- Le corps reste en base locale mais ne sort jamais vers une API.
  sensible      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (mailbox, uid_validity, uid)
);
CREATE INDEX IF NOT EXISTS idx_msg_status   ON inbox_messages(status);
CREATE INDEX IF NOT EXISTS idx_msg_recu     ON inbox_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from     ON inbox_messages(from_email);

-- Pieces jointes : metadonnees seules, le contenu n'est JAMAIS telecharge.
CREATE TABLE IF NOT EXISTS inbox_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  part_id      TEXT NOT NULL,
  filename     TEXT DEFAULT '',
  content_type TEXT DEFAULT '',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  inline       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_att_message ON inbox_attachments(message_id);

-- Libelles cibles. `gmail_folder` est le dossier IMAP correspondant, utilise a
-- la phase 1 seulement : en phase 0 la colonne est renseignee mais jamais suivie.
CREATE TABLE IF NOT EXISTS labels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nom          TEXT NOT NULL UNIQUE,
  description  TEXT DEFAULT '',
  gmail_folder TEXT DEFAULT '',
  couleur      TEXT DEFAULT '#6b7280',
  ordre        INTEGER NOT NULL DEFAULT 100,
  actif        INTEGER NOT NULL DEFAULT 1
);

-- Regles deterministes, evaluees AVANT le modele. Une regle qui tranche evite
-- un appel facture et ne se trompe jamais deux fois de la meme facon.
CREATE TABLE IF NOT EXISTS rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ordre     INTEGER NOT NULL DEFAULT 100,
  actif     INTEGER NOT NULL DEFAULT 1,
  champ     TEXT NOT NULL,            -- from_email | subject | body_text | to_text | list_id
  operateur TEXT NOT NULL,            -- contient | commence | finit | egal | regex
  valeur    TEXT NOT NULL,
  label     TEXT NOT NULL,
  priorite  TEXT NOT NULL DEFAULT 'normale',  -- haute | normale | basse
  repondre  INTEGER NOT NULL DEFAULT 0,       -- 1 = merite une reponse
  note      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rules_ordre ON rules(ordre);

-- Propositions de tri. Une ligne par message et par passage ; la derniere fait foi.
CREATE TABLE IF NOT EXISTS triages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  priorite    TEXT NOT NULL DEFAULT 'normale',
  repondre    INTEGER NOT NULL DEFAULT 0,
  resume      TEXT DEFAULT '',
  confiance   REAL NOT NULL DEFAULT 0,
  motif       TEXT DEFAULT '',
  source      TEXT NOT NULL,          -- regle | modele | humain
  modele      TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  -- Verdict de l'humain : NULL = pas encore regarde, ok = proposition juste,
  -- corrige = label_corrige fait foi. C'est la matiere premiere de la phase 0.
  verdict        TEXT,
  label_corrige  TEXT,
  verdict_at     TEXT,
  -- Phase 1 : instant ou le libelle a reellement ete pose dans Gmail.
  -- En phase 0 cette colonne reste NULL, par construction.
  applied_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_triage_message ON triages(message_id);
CREATE INDEX IF NOT EXISTS idx_triage_verdict ON triages(verdict);

-- Brouillons proposes. En phase 0 ils ne quittent pas la base.
CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  objet       TEXT DEFAULT '',
  corps       TEXT DEFAULT '',
  confiance   REAL NOT NULL DEFAULT 0,
  motif       TEXT DEFAULT '',
  questions   TEXT DEFAULT '',        -- JSON : questions reperees dans le message
  modele      TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  -- NULL = en attente, ok = garde tel quel, corrige = reecrit, rejete = inutile
  verdict     TEXT,
  corps_corrige TEXT,
  verdict_at  TEXT,
  -- Phase 1 : instant du depot dans [Gmail]/Brouillons. NULL en phase 0.
  applied_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_draft_message ON drafts(message_id);
CREATE INDEX IF NOT EXISTS idx_draft_verdict ON drafts(verdict);

-- Journal d'evenements, consomme par l'interface aujourd'hui et par le bot demain.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  titre      TEXT NOT NULL,
  corps      TEXT DEFAULT '',
  url        TEXT DEFAULT '',
  cle        TEXT UNIQUE,            -- deduplication : une panne ne sonne qu'une fois
  lu         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_lu ON events(lu, created_at DESC);

-- Compteurs d'appels au modele, par jour et par tache.
CREATE TABLE IF NOT EXISTS llm_usage (
  jour     TEXT NOT NULL,
  tache    TEXT NOT NULL,
  modele   TEXT NOT NULL,
  appels   INTEGER NOT NULL DEFAULT 0,
  echecs   INTEGER NOT NULL DEFAULT 0,
  jetons_entree INTEGER NOT NULL DEFAULT 0,
  jetons_sortie INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (jour, tache, modele)
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Cartes envoyees dans un salon de discussion (Telegram...). Sert a reecrire la
-- carte en place apres une action, plutot que de laisser un fil encombre de
-- boutons perimes.
CREATE TABLE IF NOT EXISTS bot_cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plateforme  TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  card_id     TEXT NOT NULL,          -- identifiant du message cote plateforme
  message_id  INTEGER REFERENCES inbox_messages(id) ON DELETE CASCADE,
  draft_id    INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (plateforme, chat_id, card_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_message ON bot_cards(message_id);

-- Fil de conversation avec l'agent, par salon. Garde le contexte entre deux
-- questions sans jamais retenir le corps des messages confidentiels.
CREATE TABLE IF NOT EXISTS chat_turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plateforme TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL,           -- user | assistant
  contenu    TEXT NOT NULL,           -- JSON : blocs de contenu du tour
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_salon ON chat_turns(plateforme, chat_id, id DESC);

-- Reglages modifiables depuis l'interface.
--
-- Ils vivent EN BASE et non dans le .env, pour la meme raison que l'empreinte du
-- mot de passe : le conteneur tourne en lecture seule et ne peut pas reecrire son
-- propre .env. Le .env reste l'amorce ; ce qui est pose ici l'emporte.
--
-- `secret = 1` : la valeur est chiffree (AES-256-GCM). Elle n'est JAMAIS renvoyee
-- a l'interface, dans aucune reponse, sous aucune forme.
CREATE TABLE IF NOT EXISTS settings (
  cle     TEXT PRIMARY KEY,
  valeur  TEXT NOT NULL,
  secret  INTEGER NOT NULL DEFAULT 0,
  maj_le  TEXT NOT NULL
);
