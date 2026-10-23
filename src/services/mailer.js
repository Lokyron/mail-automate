'use strict';
/**
 * Envoi d'une reponse.
 *
 * UN ENVOI N'EST JAMAIS DECLENCHE PAR DU TEXTE. C'est la regle de securite
 * centrale du projet, et elle est appliquee par un mecanisme, pas par une
 * convention de politesse entre modules :
 *
 *   1. `preparerEnvoi(draftId)` renvoie un jeton a usage unique, valable dix
 *      minutes, qui decrit exactement ce qui partira (destinataire, objet,
 *      empreinte du corps) ;
 *   2. `envoyer(draftId, jeton)` n'accepte que ce jeton, et verifie que le
 *      texte n'a pas change depuis.
 *
 * Concretement : l'interface comme le salon doivent AFFICHER le recapitulatif
 * (etape 1) avant de pouvoir envoyer (etape 2). Une phrase trouvee dans le
 * corps d'un courriel — « reponds-lui que c'est d'accord » — ne peut pas
 * fabriquer un jeton : elle n'a aucun moyen de passer par l'etape 1, qui
 * n'existe que sur un geste de ma part dans un canal authentifie.
 *
 * Les jetons vivent en memoire, volontairement : un redemarrage annule les
 * confirmations en attente. C'est le sens dans lequel on veut se tromper.
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { config } = require('../config');
const { db, nowIso } = require('../db');
const log = require('../utils/logger');
const { exigerEcriture } = require('./guard');
const imapWrite = require('./imapWrite');
const events = require('./events');

const TTL_MS = 10 * 60_000;
const jetons = new Map(); // jeton -> { draftId, empreinte, expire }

let transport = null;

function transporteur() {
  if (transport) return transport;
  if (!config.smtp.user || !config.smtp.pass)
    throw Object.assign(new Error('SMTP_USER / SMTP_PASS absents.'), { status: 400 });

  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transport;
}

const empreinte = (texte) => crypto.createHash('sha256').update(String(texte || '')).digest('hex').slice(0, 16);

const envoisDuJour = () =>
  db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE sent_at >= ?").get(new Date().toISOString().slice(0, 10)).n;

function brouillonComplet(draftId) {
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!d) throw Object.assign(new Error('Brouillon inconnu.'), { status: 404 });
  const m = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(d.message_id);
  if (!m) throw Object.assign(new Error('Message d origine introuvable.'), { status: 404 });
  return { brouillon: d, message: m };
}

/**
 * Premiere etape : decrire ce qui partira, et delivrer le jeton.
 * Ne modifie rien et n'envoie rien.
 */
function preparerEnvoi(draftId) {
  exigerEcriture('preparer un envoi');
  const { brouillon, message } = brouillonComplet(draftId);

  if (brouillon.sent_at) throw Object.assign(new Error('Ce brouillon a deja ete envoye.'), { status: 409 });
  if (brouillon.verdict === 'rejete')
    throw Object.assign(new Error('Ce brouillon a ete rejete : rien a envoyer.'), { status: 409 });
  if (message.sensible)
    throw Object.assign(new Error('Courrier confidentiel : aucun envoi automatise.'), { status: 403 });

  const restants = config.smtp.dailyLimit - envoisDuJour();
  if (restants <= 0)
    throw Object.assign(new Error(`Plafond d'envoi atteint (${config.smtp.dailyLimit} par jour).`), { status: 429 });

  const corps = imapWrite.corpsRetenu(brouillon);
  const jeton = crypto.randomBytes(16).toString('hex');
  jetons.set(jeton, { draftId, empreinte: empreinte(corps), expire: Date.now() + TTL_MS });

  return {
    jeton,
    expireDans: Math.round(TTL_MS / 1000),
    recapitulatif: {
      destinataire: brouillon.destinataire || message.reply_to || message.from_email,
      objet: brouillon.objet,
      corps,
      lignes: corps.split('\n').length,
      enReponseA: message.subject,
      envoisRestants: restants,
    },
  };
}

/**
 * Seconde etape : envoyer, contre le jeton remis a l'etape precedente.
 */
async function envoyer(draftId, jeton) {
  exigerEcriture('envoyer un message');

  const entree = jetons.get(String(jeton || ''));
  if (!entree)
    throw Object.assign(
      new Error('Confirmation absente ou expiree. Afficher le recapitulatif, puis confirmer.'),
      { status: 428 }
    );
  // Le jeton est consomme des la premiere tentative : un double clic, un
  // rejeu de la requete ou un bouton presse deux fois n'envoient pas deux fois.
  jetons.delete(String(jeton));

  if (entree.draftId !== Number(draftId))
    throw Object.assign(new Error('Cette confirmation ne porte pas sur ce brouillon.'), { status: 409 });
  if (entree.expire < Date.now())
    throw Object.assign(new Error('Confirmation expiree.'), { status: 428 });

  const { brouillon, message } = brouillonComplet(draftId);
  if (brouillon.sent_at) throw Object.assign(new Error('Deja envoye.'), { status: 409 });

  const corps = imapWrite.corpsRetenu(brouillon);
  if (empreinte(corps) !== entree.empreinte)
    throw Object.assign(
      new Error('Le texte a change depuis la confirmation. Relire le recapitulatif.'),
      { status: 409 }
    );

  const destinataire = brouillon.destinataire || message.reply_to || message.from_email;
  const raw = await imapWrite.composer(message, { objet: brouillon.objet, corps, destinataire });

  // Gmail enregistre lui-meme le message dans « Envoyes » quand on passe par
  // son SMTP : rien a recopier en IMAP, et surtout aucun risque de renvoyer le
  // message en croyant rattraper une copie manquante.
  let info;
  try {
    info = await transporteur().sendMail({
      envelope: { from: config.smtp.fromEmail, to: [destinataire] },
      raw,
    });
  } catch (e) {
    // Le brouillon n'est PAS marque envoye : un echec doit laisser la situation
    // telle quelle, pour qu'une nouvelle confirmation soit possible.
    const auth = /invalid login|username and password|authenticat|5\.7\.8/i.test(e.message || '');
    throw Object.assign(
      new Error(
        auth
          ? "Le serveur d'envoi a refuse les identifiants. Verifier SMTP_USER / SMTP_PASS (mot de passe d'application Google)."
          : `Envoi impossible : ${e.message}`
      ),
      { status: 502 }
    );
  }

  db.prepare('UPDATE drafts SET sent_at = ? WHERE id = ?').run(nowIso(), draftId);

  // Le brouillon depose n'a plus de raison d'etre : sans ce retrait, Gmail
  // montre la reponse partie et son brouillon cote a cote.
  if (brouillon.gmail_uid) {
    try {
      await imapWrite.retirerBrouillon(draftId);
    } catch (e) {
      log.warn(`Envoi effectue mais brouillon non retire de la boite : ${e.message}`);
    }
  }

  log.info(`Envoi : reponse a ${message.from_email} — « ${brouillon.objet} » (${info.messageId}).`);
  events.emettre({
    type: 'message_envoye',
    titre: `Reponse envoyee a ${message.from_name || message.from_email}`,
    corps: brouillon.objet,
    url: `/#message/${message.id}`,
    cle: `envoye:${draftId}`,
  });

  return { envoye: true, messageId: info.messageId, envoisRestants: config.smtp.dailyLimit - envoisDuJour() };
}

/**
 * Oublie la connexion d'envoi gardee en memoire.
 *
 * `transporteur()` met son resultat en cache : sans cet oubli, changer le
 * compte ou le mot de passe d'envoi dans Parametres ne changeait rien — les
 * messages continuaient de partir par l'ancienne connexion jusqu'au prochain
 * redemarrage.
 */
function reinitialiser() {
  if (transport) {
    try {
      transport.close();
    } catch { /* deja fermee */ }
  }
  transport = null;
  log.info('Envoi : connexion SMTP oubliee, la prochaine sera rouverte avec les reglages courants.');
}

/** Purge des jetons expires. */
function purger() {
  const maintenant = Date.now();
  for (const [j, v] of jetons) if (v.expire < maintenant) jetons.delete(j);
}

async function testConnection() {
  await transporteur().verify();
  return { ok: true, host: config.smtp.host, user: config.smtp.user };
}

function status() {
  return {
    configure: Boolean(config.smtp.user && config.smtp.pass),
    host: config.smtp.host,
    expediteur: config.smtp.fromEmail,
    plafondJournalier: config.smtp.dailyLimit,
    envoisDuJour: envoisDuJour(),
    confirmationsEnAttente: jetons.size,
  };
}

module.exports = { preparerEnvoi, envoyer, purger, reinitialiser, testConnection, status };
