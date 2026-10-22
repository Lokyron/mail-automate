'use strict';
/**
 * Ecriture dans la boite (phase 1).
 *
 * C'est le SEUL module autorise a modifier la boite, et chacune de ses
 * fonctions commence par `exigerEcriture()`. `imap.js` reste en lecture seule :
 * les deux responsabilites ne se melangent pas, pour qu'une relecture du relevé
 * ne laisse aucun doute sur ce qu'il fait.
 *
 * Trois faits sur Gmail en IMAP, qui expliquent la forme de ce fichier :
 *
 *  1. UN LIBELLE GMAIL EST UN DOSSIER IMAP. Poser un libelle sans sortir le
 *     message de la boite de reception, c'est une COPIE (`COPY`). Un
 *     DEPLACEMENT (`MOVE`) pose le libelle ET archive. Les deux gestes sont
 *     distincts et exposes separement.
 *
 *  2. LE DOSSIER DES BROUILLONS N'A PAS DE NOM FIXE. Il s'appelle
 *     « [Gmail]/Brouillons » sur un compte en francais, « [Gmail]/Drafts » en
 *     anglais. Le coder en dur marche sur une machine et echoue sur la suivante :
 *     il est donc DECOUVERT par son attribut special `\Drafts`.
 *
 *  3. UN BROUILLON EST UN MESSAGE COMPLET AJOUTE PAR `APPEND`, avec le drapeau
 *     `\Draft`. Avec les en-tetes `In-Reply-To` et `References`, Gmail le range
 *     dans le bon fil et l'affiche comme une reponse en cours — y compris dans
 *     l'application du telephone.
 *
 * Une connexion COURTE est ouverte pour chaque ecriture, au lieu de reutiliser
 * celle du relevé : cette derniere tient un verrou en lecture seule sur la
 * boite, et la melanger a des ecritures reviendrait a jongler avec deux etats
 * sur la meme connexion. Les ecritures sont rares (quelques dizaines par jour) :
 * le cout d'une connexion est sans importance face au risque de confusion.
 */
const { ImapFlow } = require('imapflow');
const MailComposer = require('nodemailer/lib/mail-composer');
const { config } = require('../config');
const { db, nowIso } = require('../db');
const log = require('../utils/logger');
const { exigerEcriture } = require('./guard');
const events = require('./events');

/** Connexion courte, en lecture-ecriture. */
async function avecClient(fn) {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
    emitLogs: false,
  });
  try {
    await client.connect();
  } catch (e) {
    // Sans cette traduction, un mot de passe d'application revoque ressort en
    // « erreur interne » cote interface, et on cherche le probleme du mauvais
    // cote. Le message dit quoi corriger.
    const auth = /authenticat|invalid credentials|login failed|AUTHENTICATIONFAILED/i.test(e.message || '');
    throw Object.assign(
      new Error(
        auth
          ? "La boite a refuse les identifiants d'ecriture. Verifier IMAP_USER / IMAP_PASS (mot de passe d'application Google)."
          : `Boite injoignable pour ecrire : ${e.message}`
      ),
      { status: 502 }
    );
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch { /* deja ferme */ }
  }
}

/**
 * Dossier portant un attribut special (`\Drafts`, `\Sent`, `\Trash`).
 * Le nom litteral depend de la langue du compte : il ne doit jamais etre devine.
 */
async function dossierSpecial(client, attribut) {
  const liste = await client.list();
  const trouve = liste.find((b) => b.specialUse === attribut);
  if (trouve) return trouve.path;

  // Repli : certains serveurs n'annoncent pas SPECIAL-USE. On tente les noms
  // usuels plutot que d'echouer, mais on le dit dans le journal.
  const replis = {
    '\\Drafts': ['[Gmail]/Brouillons', '[Gmail]/Drafts', 'Drafts', 'Brouillons'],
    '\\Sent': ['[Gmail]/Messages envoyés', '[Gmail]/Sent Mail', 'Sent'],
    '\\Trash': ['[Gmail]/Corbeille', '[Gmail]/Trash', 'Trash'],
  }[attribut] || [];
  const connus = new Set(liste.map((b) => b.path));
  const repli = replis.find((p) => connus.has(p));
  if (repli) {
    log.warn(`IMAP : attribut ${attribut} non annonce par le serveur, repli sur « ${repli} ».`);
    return repli;
  }
  throw Object.assign(new Error(`Aucun dossier ${attribut} trouve sur ce compte.`), { status: 502 });
}

/** Cree le dossier s'il manque. Un dossier deja present n'est pas une erreur. */
async function assurerDossier(client, chemin) {
  try {
    await client.mailboxCreate(chemin);
    log.info(`IMAP : dossier « ${chemin} » cree.`);
  } catch (e) {
    // ALREADYEXISTS est le cas normal : le libelle existe deja dans Gmail.
    if (!/alreadyexists|already exists/i.test(e.message || '')) throw e;
  }
}

const messageOuLeve = (id) => {
  const m = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(id);
  if (!m) throw Object.assign(new Error('Message inconnu.'), { status: 404 });
  return m;
};

/**
 * Pose un libelle sur un message.
 *
 * @param {number} messageId
 * @param {string} label        nom du libelle (table `labels`)
 * @param {object} [options]
 * @param {boolean} [options.archiver]  true = retirer de la boite de reception
 */
async function poserLibelle(messageId, label, { archiver = false } = {}) {
  exigerEcriture(`poser le libelle « ${label} »`);
  const message = messageOuLeve(messageId);

  const ligne = db.prepare('SELECT * FROM labels WHERE nom = ?').get(label);
  if (!ligne) throw Object.assign(new Error(`Libelle inconnu : ${label}`), { status: 400 });
  const dossier = ligne.gmail_folder || ligne.nom;

  const resultat = await avecClient(async (client) => {
    await assurerDossier(client, dossier);
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      // COPY pose le libelle en laissant le message dans la boite de reception.
      // MOVE le pose et archive. Deux gestes differents, jamais confondus.
      return archiver
        ? await client.messageMove(String(message.uid), dossier, { uid: true })
        : await client.messageCopy(String(message.uid), dossier, { uid: true });
    } finally {
      lock.release();
    }
  });

  const triage = db.prepare('SELECT * FROM triages WHERE message_id = ? ORDER BY id DESC LIMIT 1').get(messageId);
  if (triage) {
    db.prepare('UPDATE triages SET applied_at = ?, applied_folder = ? WHERE id = ?')
      .run(nowIso(), dossier, triage.id);
  }

  log.info(`IMAP : libelle « ${dossier} » pose sur « ${message.subject} »${archiver ? ' (archive)' : ''}.`);
  return { dossier, archive: archiver, resultat: resultat || null };
}

/** Marque un message comme lu. */
async function marquerLu(messageId) {
  exigerEcriture('marquer un message comme lu');
  const message = messageOuLeve(messageId);
  await avecClient(async (client) => {
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  });
  log.info(`IMAP : message « ${message.subject} » marque lu.`);
  return { ok: true };
}

/**
 * Compose le message MIME d'une reponse.
 * `In-Reply-To` et `References` rattachent la reponse au bon fil : sans eux,
 * Gmail ouvre une conversation separee et le brouillon parait surgir de nulle
 * part.
 */
function composer(message, { objet, corps }) {
  const original = String(message.message_id || '').trim();
  const entre = (v) => (v && !v.startsWith('<') ? `<${v}>` : v);
  const refs = [
    ...String(message.thread_refs || '').split(/\s+/).filter(Boolean),
    entre(original),
  ].filter(Boolean);

  const destinataire = message.reply_to || `${message.from_name ? `${message.from_name} ` : ''}<${message.from_email}>`;
  const expediteur = config.smtp.fromName
    ? `${config.smtp.fromName} <${config.smtp.fromEmail}>`
    : config.smtp.fromEmail;

  return new MailComposer({
    from: expediteur,
    to: destinataire,
    subject: objet,
    text: corps,
    inReplyTo: entre(original),
    references: refs.join(' '),
    date: new Date(),
  })
    .compile()
    .build();
}

const brouillonOuLeve = (id) => {
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  if (!d) throw Object.assign(new Error('Brouillon inconnu.'), { status: 404 });
  return d;
};

/** Texte retenu pour un brouillon : ma version si je l'ai reecrite. */
const corpsRetenu = (d) => (d.corps_corrige && d.corps_corrige.trim() ? d.corps_corrige : d.corps);

/**
 * Depose le brouillon dans le dossier des brouillons de la boite. Il apparait
 * alors dans Gmail et dans l'application du telephone, pret a etre relu,
 * modifie et envoye a la main.
 */
async function deposerBrouillon(draftId) {
  exigerEcriture('deposer un brouillon dans la boite');
  const brouillon = brouillonOuLeve(draftId);
  if (brouillon.applied_at)
    throw Object.assign(new Error('Ce brouillon est deja depose dans la boite.'), { status: 409 });
  if (brouillon.sent_at)
    throw Object.assign(new Error('Ce brouillon a deja ete envoye.'), { status: 409 });

  const message = messageOuLeve(brouillon.message_id);
  const raw = await composer(message, { objet: brouillon.objet, corps: corpsRetenu(brouillon) });

  const { dossier, uid } = await avecClient(async (client) => {
    const d = await dossierSpecial(client, '\\Drafts');
    // `\Seen` en plus de `\Draft` : un brouillon que j'ai moi-meme fait rediger
    // n'a pas a se signaler comme non lu.
    const r = await client.append(d, raw, ['\\Draft', '\\Seen']);
    return { dossier: d, uid: r?.uid || null };
  });

  db.prepare('UPDATE drafts SET applied_at = ?, gmail_uid = ?, gmail_folder = ? WHERE id = ?')
    .run(nowIso(), uid, dossier, draftId);

  log.info(`IMAP : brouillon depose dans « ${dossier} » (UID ${uid}) pour « ${message.subject} ».`);
  events.emettre({
    type: 'brouillon_depose',
    titre: `Brouillon dans Gmail : ${message.from_name || message.from_email}`,
    corps: message.subject,
    url: `/#message/${message.id}`,
    cle: `depose:${draftId}`,
  });

  return { dossier, uid };
}

/**
 * Retire de la boite le brouillon depose. Appele apres un envoi : sans cela, le
 * brouillon reste dans Gmail a cote du message parti, et on ne sait plus lequel
 * fait foi.
 */
async function retirerBrouillon(draftId) {
  exigerEcriture('retirer un brouillon depose');
  const brouillon = brouillonOuLeve(draftId);
  if (!brouillon.gmail_uid || !brouillon.gmail_folder) return { retire: false, raison: 'aucun brouillon depose' };

  await avecClient(async (client) => {
    const lock = await client.getMailboxLock(brouillon.gmail_folder);
    try {
      // Suppression ciblee par UID. Aucune recherche, aucun filtre : on ne
      // supprime que ce qu'on a soi-meme depose, et on sait exactement quoi.
      await client.messageDelete(String(brouillon.gmail_uid), { uid: true });
    } finally {
      lock.release();
    }
  });

  db.prepare("UPDATE drafts SET gmail_uid = NULL, gmail_folder = '' WHERE id = ?").run(draftId);
  log.info(`IMAP : brouillon ${draftId} retire de « ${brouillon.gmail_folder} ».`);
  return { retire: true };
}

/** Etat de l'ecriture, pour l'interface. */
function status() {
  const r = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM triages WHERE applied_at IS NOT NULL) AS libelles,
         (SELECT COUNT(*) FROM drafts  WHERE applied_at IS NOT NULL) AS deposes,
         (SELECT COUNT(*) FROM drafts  WHERE sent_at   IS NOT NULL) AS envoyes`
    )
    .get();
  return { libellesPoses: r.libelles, brouillonsDeposes: r.deposes, messagesEnvoyes: r.envoyes };
}

module.exports = {
  poserLibelle,
  marquerLu,
  deposerBrouillon,
  retirerBrouillon,
  dossierSpecial,
  composer,
  corpsRetenu,
  avecClient,
  status,
};
