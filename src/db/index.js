'use strict';
/** Connexion SQLite unique, partagee par l'application. */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../config');
const log = require('../utils/logger');

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * Migrations additives.
 * `CREATE TABLE IF NOT EXISTS` ne fait rien sur une table deja creee : les
 * colonnes ajoutees apres coup doivent l'etre explicitement.
 */
function addColumnIfMissing(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (exists) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info(`Migration : colonne ${table}.${column} ajoutee.`);
}
// Phase 1 : suivi de ce qui a reellement ete ecrit dans la boite.
addColumnIfMissing('drafts', 'sent_at', 'TEXT');
addColumnIfMissing('drafts', 'gmail_uid', 'INTEGER');
addColumnIfMissing('drafts', 'gmail_folder', "TEXT DEFAULT ''");
addColumnIfMissing('triages', 'applied_folder', "TEXT DEFAULT ''");
// Destinataire explicite : utile pour un message compose de zero, la ou une
// reponse deduit l'adresse du message d'origine.
addColumnIfMissing('drafts', 'destinataire', "TEXT DEFAULT ''");
/**
 * En-tete List-Id, dans sa propre colonne.
 *
 * Elle manquait, et son absence faussait le tri de toute la boite : la regle
 * livree « list_id contient @ » — censee reconnaitre une diffusion a son en-tete
 * List-Id — lisait a defaut `thread_refs`, c'est-a-dire l'en-tete References.
 * Or les References d'une reponse contiennent les identifiants des messages
 * precedents, qui portent tous un « @ ». Autrement dit : TOUTE reponse dans un
 * fil etait classee « Infolettres », par la premiere regle, sans jamais
 * atteindre le modele.
 */
addColumnIfMissing('inbox_messages', 'list_id', "TEXT DEFAULT ''");

/**
 * Libelles et regles de depart.
 *
 * Ce jeu initial n'est pas un exemple a adapter plus tard : c'est le point de
 * depart reel du tri, concu pour une boite personnelle. Les regles ci-dessous
 * sont deterministes et gratuites ; elles retirent le gros du bruit avant que le
 * modele ne soit sollicite. Rien n'est ecrit si la table contient deja quelque
 * chose : une correction faite dans l'interface n'est jamais ecrasee.
 */
const LABELS = [
  ['A repondre',   'Demande une reponse de ma part.',                     'A repondre',   '#dc2626', 10],
  ['A faire',      'Une action a mener, sans reponse a ecrire.',          'A faire',      '#ea580c', 20],
  ['A lire',       'Interessant, sans urgence ni action.',                'A lire',       '#2563eb', 30],
  ['Administratif','Factures, impots, banque, assurances, contrats.',     'Administratif','#7c3aed', 40],
  ['Projets',      'Developpement, Home Lab, associations.',              'Projets',      '#0d9488', 50],
  ['Notifications','Messages automatiques de services (CI, alertes...).', 'Notifications','#64748b', 60],
  ['Infolettres',  'Lettres d information et contenus suivis.',           'Infolettres',  '#94a3b8', 70],
  ['Demarchage',   'Sollicitation commerciale non demandee.',             'Demarchage',   '#a1a1aa', 80],
  ['A verifier',   'Le tri n a pas su trancher : a regarder a la main.',  'A verifier',   '#f59e0b', 90],
];

const RULES = [
  // Le courrier automatique se reconnait a ses en-tetes, pas a son sens : aucune
  // raison de payer un appel au modele pour le classer.
  [10,  'list_id',    'renseigne', '',                   'Infolettres',   'basse',   0, 'Tout message portant un en-tete List-Id est une diffusion.'],
  [20,  'from_email', 'commence',  'noreply',            'Notifications', 'basse',   0, ''],
  [21,  'from_email', 'commence',  'no-reply',           'Notifications', 'basse',   0, ''],
  [22,  'from_email', 'commence',  'ne-pas-repondre',    'Notifications', 'basse',   0, ''],
  [30,  'from_email', 'finit',     '@github.com',        'Notifications', 'basse',   0, ''],
  [31,  'from_email', 'finit',     '@notifications.google.com', 'Notifications', 'basse', 0, ''],
  // Administratif : range sans etre lu par le modele quand l'expediteur suffit.
  [40,  'from_email', 'contient',  'impots.gouv.fr',     'Administratif', 'haute',   0, ''],
  [41,  'from_email', 'contient',  'ameli.fr',           'Administratif', 'haute',   0, ''],
  [42,  'from_email', 'contient',  'urssaf',             'Administratif', 'haute',   0, ''],
  [50,  'subject',    'contient',  'facture',            'Administratif', 'normale', 0, ''],
  // Projets : les services du Home Lab et les depots.
  [60,  'from_email', 'contient',  'helloasso',          'Projets',       'normale', 0, ''],
  [70,  'subject',    'regex',     '^(re|tr|fwd)\\s*:',  'A repondre',    'normale', 1, 'Une reponse dans un fil engage merite presque toujours une suite.'],
];

(() => {
  if (db.prepare('SELECT COUNT(*) AS n FROM labels').get().n === 0) {
    const ins = db.prepare('INSERT INTO labels (nom, description, gmail_folder, couleur, ordre) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => LABELS.forEach((l) => ins.run(...l)))();
    log.info(`Libelles initialises (${LABELS.length}).`);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM rules').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO rules (ordre, champ, operateur, valeur, label, priorite, repondre, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    db.transaction(() => RULES.forEach((r) => ins.run(...r)))();
    log.info(`Regles de tri initialisees (${RULES.length}).`);
  }
})();

/**
 * Correction de la regle List-Id deja en base.
 *
 * Elle y est ecrite « list_id contient @ », et cette forme ne vaut rien : la
 * valeur d'un List-Id ne suit aucune regle fixe et beaucoup de listes
 * s'annoncent « <lettre.unservice.com> », sans arobase. La regle laissait donc
 * passer la moitie des diffusions. Ce qu'on voulait dire est « ce message
 * PORTE un en-tete List-Id » : c'est l'operateur « renseigne ». Seule la regle
 * livree telle quelle est corrigee — une regle retouchee a la main ne l'est
 * pas.
 */
(() => {
  const r = db
    .prepare(
      `UPDATE rules SET operateur = 'renseigne', valeur = ''
        WHERE champ = 'list_id' AND operateur = 'contient' AND valeur = '@'`
    )
    .run();
  if (r.changes) log.info('Migration : la regle List-Id teste desormais la presence de l en-tete.');
})();

const getState = (key, def = null) => {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  return row ? row.value : def;
};

const setState = (key, value) =>
  value === null
    ? db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
    : db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

const nowIso = () => new Date().toISOString();

module.exports = { db, getState, setState, nowIso };
