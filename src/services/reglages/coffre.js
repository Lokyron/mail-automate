'use strict';
/**
 * Coffre : lecture et ecriture des reglages, avec chiffrement des secrets.
 *
 * POURQUOI LES REGLAGES VIVENT EN BASE ET NON DANS LE .env. C'est la meme
 * raison que pour l'empreinte du mot de passe : le conteneur tourne en lecture
 * seule et ne peut pas reecrire son propre `.env`. Une application qui propose
 * de se regler depuis son interface doit donc ranger ses reglages ailleurs que
 * dans le fichier qui l'a demarree.
 *
 * LE .env RESTE L'AMORCE. Ce qui est pose ici l'emporte, mais le `.env` sert de
 * valeur de depart et de repli : effacer un reglage dans l'interface, c'est
 * rendre la main au `.env`. Et — lecon deja payee avec le mot de passe —
 * l'interface DIT TOUJOURS d'ou vient la valeur en service. Une precedence
 * invisible est une precedence qui enferme.
 *
 * LES SECRETS SONT CHIFFRES, ET NE RESSORTENT JAMAIS. Un mot de passe
 * d'application Google et une clef d'API ouvrent, l'un une boite mail entiere,
 * l'autre un compte facture. Ils sont chiffres en AES-256-GCM, et aucune route
 * ne les renvoie : l'interface n'en voit que « renseigne » et les quatre
 * derniers caracteres.
 *
 * LA CLEF DE CHIFFREMENT est derivee de `SESSION_SECRET` par HKDF, avec une
 * etiquette distincte pour qu'elle ne serve a rien d'autre. Consequence a
 * connaitre : changer `SESSION_SECRET` rend les secrets deja ranges illisibles.
 * Ce n'est pas une perte de donnees (il suffit de les resaisir) et c'est dit
 * dans l'interface comme dans le README.
 */
const crypto = require('crypto');
const { config } = require('../../config');
const { db, nowIso } = require('../../db');
const log = require('../../utils/logger');

const ALGO = 'aes-256-gcm';
const ETIQUETTE = 'inbox-agent:reglages:v1';

/** Clef derivee du secret de session. Jamais ecrite nulle part. */
function clef() {
  const secret = config.session.secret;
  if (!secret || secret.length < 32) {
    throw Object.assign(
      new Error('SESSION_SECRET absent ou trop court : impossible de chiffrer les reglages.'),
      { status: 500 }
    );
  }
  return crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), ETIQUETTE, 32);
}

function chiffrer(clair) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, clef(), iv);
  const corps = Buffer.concat([c.update(String(clair), 'utf8'), c.final()]);
  // iv.corps.marqueur, en base64url : une seule chaine a ranger.
  return [iv, corps, c.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

function dechiffrer(range) {
  const [iv, corps, marqueur] = String(range).split('.');
  if (!iv || !corps || !marqueur) throw new Error('forme inattendue');
  const d = crypto.createDecipheriv(ALGO, clef(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(marqueur, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(corps, 'base64url')), d.final()]).toString('utf8');
}

/**
 * Valeur rangee pour une clef, ou null.
 *
 * Un secret illisible — typiquement apres un changement de `SESSION_SECRET` —
 * ne fait PAS tomber l'application : il est traite comme absent, le `.env`
 * reprend la main, et le journal le dit une fois. Lever ici reviendrait a
 * empecher le demarrage de toute l'application parce qu'une clef d'API est
 * devenue illisible.
 */
function lire(cle) {
  const ligne = db.prepare('SELECT valeur, secret FROM settings WHERE cle = ?').get(cle);
  if (!ligne) return null;
  if (!ligne.secret) return ligne.valeur;
  try {
    return dechiffrer(ligne.valeur);
  } catch (e) {
    log.error(
      `Reglages : « ${cle} » est illisible (${e.message}). ` +
        'Cause la plus probable : SESSION_SECRET a change. Resaisir la valeur dans Parametres.'
    );
    return null;
  }
}

function ecrire(cle, valeur, { secret = false } = {}) {
  db.prepare(
    `INSERT INTO settings (cle, valeur, secret, maj_le) VALUES (?, ?, ?, ?)
     ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur, secret = excluded.secret, maj_le = excluded.maj_le`
  ).run(cle, secret ? chiffrer(valeur) : String(valeur), secret ? 1 : 0, nowIso());
}

/** Efface un reglage : le `.env` (ou le defaut) reprend la main. */
const effacer = (cle) => db.prepare('DELETE FROM settings WHERE cle = ?').run(cle).changes > 0;

/** Les clefs posees en base, sans leurs valeurs. */
const posees = () =>
  db
    .prepare('SELECT cle, secret, maj_le FROM settings')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.cle]: { secret: Boolean(r.secret), majLe: r.maj_le } }), {});

/**
 * Ce qu'on montre d'un secret : qu'il existe, et ses quatre derniers
 * caracteres. Assez pour reconnaitre « ai-je collé la bonne clef ? », trop peu
 * pour servir a quoi que ce soit.
 */
function apercuSecret(valeur) {
  const v = String(valeur || '');
  if (!v) return '';
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

module.exports = { lire, ecrire, effacer, posees, apercuSecret, chiffrer, dechiffrer };
