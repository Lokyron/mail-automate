'use strict';
/**
 * Authentification locale : un compte administrateur unique.
 * - mot de passe verifie contre un hash bcrypt (ADMIN_PASSWORD_HASH)
 * - session opaque stockee en base (invalidable, persistante apres redemarrage)
 * - cookie HttpOnly + SameSite=Strict (+ Secure derriere le reverse proxy TLS)
 * - protection CSRF par jeton double-submit lie a la session
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { config } = require('../config');
const { db, getState, setState, nowIso } = require('../db');
const log = require('../utils/logger');

/**
 * Le mot de passe est d'abord celui de la BASE, et seulement a defaut celui du
 * .env.
 *
 * Pourquoi : le .env est pose a l'installation et le conteneur tourne en
 * lecture seule — l'application ne peut pas le reecrire, donc elle ne pourrait
 * pas changer son propre mot de passe. L'empreinte vit donc en base des le
 * premier changement, et celle du .env ne sert plus que d'amorce.
 *
 * Consequence voulue : tant que rien n'est en base, le mot de passe en service
 * est celui que l'installateur a pose, et l'interface impose d'en choisir un
 * autre.
 */
const ETAT_HASH = 'admin_password_hash';

const empreinteCourante = () => getState(ETAT_HASH) || config.admin.passwordHash;

/** Vrai tant que le mot de passe d'amorce n'a pas ete remplace. */
const motDePasseAChanger = () => !getState(ETAT_HASH);

const COOKIE = config.session.cookieName;

const randomId = () => crypto.randomBytes(32).toString('hex');

/** Jeton CSRF derive de l'id de session (pas de stockage supplementaire). */
function csrfFor(sessionId) {
  return crypto.createHmac('sha256', config.session.secret).update(`csrf:${sessionId}`).digest('hex');
}

function createSession(req, res) {
  const id = randomId();
  const expires = new Date(Date.now() + config.session.ttlHours * 3600_000);
  db.prepare(
    'INSERT INTO sessions (id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)'
  ).run(id, nowIso(), expires.toISOString(), String(req.get('user-agent') || '').slice(0, 200), req.ip);

  res.cookie(COOKIE, id, {
    httpOnly: true,
    sameSite: 'strict',
    // `Secure` des que la requete arrive en HTTPS (directement ou via le reverse
    // proxy, X-Forwarded-Proto faisant foi). En HTTP direct sur le LAN, le drapeau
    // est omis : sinon le navigateur jetterait le cookie et la connexion echouerait
    // silencieusement. L'usage normal passe par le vhost HTTPS.
    secure: req.secure,
    expires,
    path: '/',
  });
  return { id, csrf: csrfFor(id) };
}

function destroySession(req, res) {
  const id = req.cookies?.[COOKIE];
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  res.clearCookie(COOKIE, { path: '/' });
}

function currentSession(req) {
  const id = req.cookies?.[COOKIE];
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  return row;
}

function verifyPassword(password) {
  if (!password) return false;
  const empreinte = empreinteCourante();
  // Une empreinte absente n'est pas une erreur a journaliser a chaque tentative :
  // c'est une configuration incomplete, que `validate()` signale au demarrage.
  if (!empreinte) return false;
  try {
    return bcrypt.compareSync(password, empreinte);
  } catch (e) {
    log.error('Verification du mot de passe impossible :', e.message);
    return false;
  }
}

const LONGUEUR_MINIMALE = 12;

/**
 * Remplace le mot de passe.
 *
 * Les AUTRES sessions tombent ; celle qui fait le changement SURVIT. La version
 * precedente fermait tout, y compris la sienne, et renvoyait vers l'ecran de
 * connexion : il fallait alors se reconnecter juste apres avoir change son mot
 * de passe. Toute erreur a ce moment-la — un cache, une saisie de l'ancien mot
 * de passe — ramenait a la case depart, et l'utilisateur tournait en rond.
 *
 * On garde la propriete utile (ce qui a ete ouvert avec l'ancien mot de passe
 * ne vaut plus) sans la consequence genante.
 */
function changePassword({ actuel, nouveau, sessionCourante = null }) {
  if (!verifyPassword(actuel))
    throw Object.assign(new Error('Mot de passe actuel incorrect.'), { status: 403 });

  const mot = String(nouveau || '');
  if (mot.length < LONGUEUR_MINIMALE)
    throw Object.assign(new Error(`Le nouveau mot de passe doit faire ${LONGUEUR_MINIMALE} caracteres au moins.`), { status: 400 });
  if (mot === actuel)
    throw Object.assign(new Error("Le nouveau mot de passe doit differer de l'ancien."), { status: 400 });

  setState(ETAT_HASH, bcrypt.hashSync(mot, 12));
  const tombees = sessionCourante
    ? db.prepare('DELETE FROM sessions WHERE id != ?').run(sessionCourante).changes
    : db.prepare('DELETE FROM sessions').run().changes;
  log.info(`Mot de passe change ; ${tombees} autre(s) session(s) fermee(s).`);
  return { ok: true, sessionsFermees: tombees, sessionGardee: Boolean(sessionCourante) };
}

/**
 * REPRISE EN MAIN DU MOT DE PASSE, depuis la ligne de commande.
 *
 * Ces deux fonctions existent parce qu'il manquait une porte de sortie, et que
 * son absence enferme pour de bon :
 *
 * l'empreinte en base l'emporte sur celle du .env. Des le premier changement,
 * modifier `ADMIN_PASSWORD_HASH`, rejouer `install.sh` (qui conserve un .env
 * existant) ou reconstruire l'image ne change plus RIEN. Un mot de passe mal
 * tape une fois — ou simplement oublie — et il n'y a plus aucun moyen d'entrer,
 * alors que la machine est a portee de main. Une application auto-hebergee doit
 * toujours laisser une porte a qui a l'acces root de l'hote.
 *
 * Le choix d'une porte EN LIGNE DE COMMANDE, et non d'un reglage du .env : un
 * `ADMIN_PASSWORD_RESET=true` oublie dans un fichier remettrait le mot de passe
 * d'amorce a chaque redemarrage, sans que personne ne s'en apercoive.
 *
 * Voir `scripts/motdepasse.js`, et la section « Mot de passe oublie » du README.
 */
function oublierMotDePasse() {
  setState(ETAT_HASH, null);
  const tombees = db.prepare('DELETE FROM sessions').run().changes;
  log.warn(`Mot de passe : empreinte en base effacee, celle du .env reprend la main ; ${tombees} session(s) fermee(s).`);
  return { ok: true, source: 'env', sessionsFermees: tombees };
}

/**
 * Pose un mot de passe SANS demander l'ancien. Reserve a la ligne de commande :
 * aucune route HTTP n'appelle cette fonction, et c'est le point important.
 */
function definirMotDePasse(nouveau) {
  const mot = String(nouveau || '');
  if (mot.length < LONGUEUR_MINIMALE)
    throw Object.assign(new Error(`Le mot de passe doit faire ${LONGUEUR_MINIMALE} caracteres au moins.`), { status: 400 });

  setState(ETAT_HASH, bcrypt.hashSync(mot, 12));
  const tombees = db.prepare('DELETE FROM sessions').run().changes;
  log.warn(`Mot de passe redefini en ligne de commande ; ${tombees} session(s) fermee(s).`);
  return { ok: true, source: 'base', sessionsFermees: tombees };
}

/** Garde d'acces pour les routes d'API (repond en JSON). */
function requireAuth(req, res, next) {
  const s = currentSession(req);
  if (!s) return res.status(401).json({ error: 'Non authentifie' });
  req.session = s;
  next();
}

/**
 * Garde d'acces pour les pages HTML (redirige vers /login).
 *
 * La page demandee est passee en « next » pour que la connexion y ramene. Seul
 * un chemin interne CONNU est accepte : un « next » libre serait une redirection
 * ouverte offerte a qui sait fabriquer un lien. La liste ne contient donc que
 * les pages reellement servies par le serveur — une entree pour une page qui
 * n'existe pas renverrait vers un 404.
 */
const PAGES = ['/'];

function requireAuthPage(req, res, next) {
  const s = currentSession(req);
  if (!s) {
    const cible = PAGES.includes(req.path) ? req.path : '/';
    return res.redirect(cible === '/' ? '/login' : `/login?next=${encodeURIComponent(cible)}`);
  }
  req.session = s;
  next();
}

/** Verification CSRF sur toutes les methodes mutantes. */
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = csrfFor(req.session.id);
  const provided = req.get('x-csrf-token') || req.body?._csrf || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Jeton CSRF invalide' });
  }
  next();
}

/** Purge periodique des sessions expirees. */
function purgeExpiredSessions() {
  const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  if (r.changes) log.debug(`${r.changes} session(s) expiree(s) purgee(s)`);
}

module.exports = {
  changePassword,
  oublierMotDePasse,
  definirMotDePasse,
  motDePasseAChanger,
  LONGUEUR_MINIMALE,
  createSession,
  destroySession,
  currentSession,
  verifyPassword,
  requireAuth,
  requireAuthPage,
  csrfProtect,
  csrfFor,
  purgeExpiredSessions,
};
