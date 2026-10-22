'use strict';
/**
 * Passerelle Telegram.
 *
 * Choix de conception, dans l'ordre d'importance :
 *
 *  - LISTE BLANCHE. Toute mise a jour venant d'un salon absent de
 *    `TELEGRAM_CHAT_ID` est journalisee et jetee, SANS REPONSE. Un bot qui
 *    repond « acces refuse » confirme a un inconnu qu'il existe, et le nom d'un
 *    bot Telegram est public. Celui-ci est muet pour tout le monde sauf moi.
 *
 *  - LONG POLLING. `getUpdates` avec une attente de 25 s : aucun port entrant,
 *    aucun certificat, rien a exposer depuis le Home Lab. L'offset est garde en
 *    base, donc un redemarrage ne rejoue pas les actions deja traitees.
 *
 *  - EDITION EN PLACE. Apres une action, la carte est reecrite a son emplacement
 *    et ses boutons disparaissent. Sans cela le fil se remplit de boutons
 *    perimes, et c'est exactement comme on finit par envoyer deux fois.
 *
 *  - LE TEXTE NE DECIDE RIEN D'IRREVERSIBLE. Les actions passent par des
 *    boutons, dont la seule origine possible est une carte deja affichee dans
 *    le salon autorise. Un envoi exige en plus un recapitulatif et un jeton
 *    (cf. services/mailer.js).
 */
const { config } = require('../../config');
const { db, getState, setState, nowIso } = require('../../db');
const log = require('../../utils/logger');
const cartes = require('./cartes');

const OFFSET = 'telegram_offset';

let arrete = true;
let boucle = null;

const url = (methode) => `${config.bot.apiBase}/bot${config.bot.token}/${methode}`;

async function appeler(methode, corps, { timeoutMs = 40_000 } = {}) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), timeoutMs);
  try {
    const r = await fetch(url(methode), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corps || {}),
      signal: controleur.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) {
      // 403 : le bot a ete bloque par l'utilisateur. 400 : carte identique
      // (« message is not modified »), sans consequence.
      throw Object.assign(new Error(`Telegram ${methode} : ${j.description || r.status}`), { status: r.status });
    }
    return j.result;
  } finally {
    clearTimeout(minuteur);
  }
}

const autorise = (chatId) => config.bot.chatId.includes(String(chatId));

/* -------------------------------------------------------------------- envois */

async function envoyerCarte(chatId, carte, { messageId = null, draftId = null } = {}) {
  // Une carte absente n'est pas une anomalie a faire remonter en exception : le
  // message a pu etre efface de la base entre l'evenement et son affichage.
  if (!carte?.texte) return null;
  const { texte, clavier } = carte;
  const res = await appeler('sendMessage', {
    chat_id: chatId,
    text: texte,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: clavier,
  });

  if (messageId || draftId) {
    db.prepare(
      `INSERT INTO bot_cards (plateforme, chat_id, card_id, message_id, draft_id, created_at)
       VALUES ('telegram', ?, ?, ?, ?, ?)
       ON CONFLICT(plateforme, chat_id, card_id) DO NOTHING`
    ).run(String(chatId), String(res.message_id), messageId, draftId, nowIso());
  }
  return res;
}

async function reecrire(chatId, cardId, { texte, clavier }) {
  try {
    await appeler('editMessageText', {
      chat_id: chatId,
      message_id: cardId,
      text: texte,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: clavier,
    });
  } catch (e) {
    // Une carte inchangee fait repondre « message is not modified » : ce n'est
    // pas une panne, c'est un clic qui n'a rien change.
    if (!/not modified/i.test(e.message)) throw e;
  }
}

const repondreAuClic = (id, texte = '') =>
  appeler('answerCallbackQuery', { callback_query_id: id, text: texte.slice(0, 200) }).catch(() => {});

const envoyerTexte = (chatId, texte) =>
  appeler('sendMessage', {
    chat_id: chatId,
    text: texte,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });

/* ------------------------------------------------------------------ commandes */

const AIDE = [
  '<b>Inbox Agent</b>',
  '',
  '/attente — les messages à juger',
  '/etat — relevé, modèle, écriture',
  '/relever — relever la boîte maintenant',
  '/aide — ce message',
  '',
  'Tout autre message est une question posée à l\'agent :',
  '« de quoi parlait le dernier mail de Lucie ? »,',
  '« reformule le brouillon en plus court ».',
].join('\n');

async function commande(chatId, texte) {
  const mot = texte.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');

  if (mot === '/aide' || mot === '/start') return void (await envoyerTexte(chatId, AIDE));

  if (mot === '/etat') {
    const imap = require('../imap').status();
    const llm = require('../llm').status();
    const ecriture = require('../guard').ecritureAutorisee();
    return void (await envoyerTexte(
      chatId,
      [
        `<b>Phase ${ecriture ? '1 — écriture autorisée' : '0 — lecture seule'}</b>`,
        `Boîte : ${imap.connected ? 'connectée' : 'hors ligne'} · ${imap.total} message(s), ${imap.sensibles} confidentiel(s)`,
        `Dernier relevé : ${imap.lastSyncAt || 'jamais'}`,
        `Modèle : ${llm.fournisseur} · ${llm.appelsDuJour}/${llm.plafondJournalier} appels aujourd'hui`,
        imap.lastError ? `⚠️ ${cartes.echapper(imap.lastError)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    ));
  }

  if (mot === '/relever') {
    try {
      const r = await require('../imap').syncNow();
      return void (await envoyerTexte(chatId, `Relève faite : ${r.added} nouveau(x) message(s).`));
    } catch (e) {
      return void (await envoyerTexte(chatId, `Relève impossible : ${cartes.echapper(e.message)}`));
    }
  }

  if (mot === '/attente') {
    const enAttente = db
      .prepare(
        `SELECT m.id FROM inbox_messages m
      LEFT JOIN triages t ON t.id = (SELECT id FROM triages WHERE message_id = m.id ORDER BY id DESC LIMIT 1)
          WHERE t.id IS NULL OR t.verdict IS NULL
          ORDER BY m.received_at DESC LIMIT 8`
      )
      .all();
    if (!enAttente.length) return void (await envoyerTexte(chatId, 'Rien à juger. 🎉'));
    for (const { id } of enAttente) {
      const carte = cartes.carteMessage(id);
      if (carte) await envoyerCarte(chatId, carte, { messageId: id });
    }
    return;
  }

  await envoyerTexte(chatId, `Commande inconnue. ${AIDE}`);
}

/* --------------------------------------------------------------------- clics */

async function clic(q) {
  const chatId = q.message?.chat?.id;
  const cardId = q.message?.message_id;
  const [famille, action, ...args] = String(q.data || '').split(':');

  const rafraichir = async (messageId) => {
    const carte = cartes.carteMessage(messageId);
    if (carte) await reecrire(chatId, cardId, carte);
  };

  try {
    if (famille === 't') {
      const triage = db.prepare('SELECT * FROM triages WHERE id = ?').get(Number(args[0]));
      if (!triage) return void (await repondreAuClic(q.id, 'Proposition introuvable.'));

      if (action === 'ok') {
        require('../classifier').verdict(triage.id, { verdict: 'ok' });
        await repondreAuClic(q.id, 'Validé.');
        return void (await rafraichir(triage.message_id));
      }
      if (action === 'c') {
        await repondreAuClic(q.id, 'Quel libellé ?');
        return void (await reecrire(chatId, cardId, {
          texte: q.message.text ? cartes.echapper(q.message.text) : 'Choisis le bon libellé :',
          clavier: cartes.clavierLibelles(triage.id),
        }));
      }
      if (action === 'x') {
        await repondreAuClic(q.id);
        return void (await rafraichir(triage.message_id));
      }
      if (action === 'l') {
        const label = db.prepare('SELECT nom FROM labels WHERE id = ?').get(Number(args[1]));
        if (!label) return void (await repondreAuClic(q.id, 'Libellé introuvable.'));
        require('../classifier').verdict(triage.id, { verdict: 'corrige', labelCorrige: label.nom });
        await repondreAuClic(q.id, `Corrigé en « ${label.nom} ». Servira d'exemple.`);
        return void (await rafraichir(triage.message_id));
      }
      if (action === 'pose') {
        const r = await require('../imapWrite').poserLibelle(triage.message_id, triage.label);
        await repondreAuClic(q.id, `Libellé posé dans ${r.dossier}.`);
        return void (await rafraichir(triage.message_id));
      }
    }

    if (famille === 'd') {
      if (action === 'new') {
        const messageId = Number(args[0]);
        await repondreAuClic(q.id, 'Rédaction en cours…');
        await require('../drafter').rediger(messageId);
        return void (await rafraichir(messageId));
      }
      const draftId = Number(args[0]);
      const brouillon = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
      if (!brouillon) return void (await repondreAuClic(q.id, 'Brouillon introuvable.'));

      if (action === 'dep') {
        const r = await require('../imapWrite').deposerBrouillon(draftId);
        await repondreAuClic(q.id, `Déposé dans ${r.dossier}.`);
        return void (await rafraichir(brouillon.message_id));
      }
      if (action === 'prep') {
        const prep = require('../mailer').preparerEnvoi(draftId);
        await repondreAuClic(q.id, 'Relis puis confirme.');
        return void (await envoyerCarte(chatId, cartes.carteRecapitulatif(draftId, prep), { draftId }));
      }
      if (action === 'env') {
        const r = await require('../mailer').envoyer(draftId, args[1]);
        await repondreAuClic(q.id, 'Envoyé.');
        await reecrire(chatId, cardId, { texte: `📤 Envoyé. <i>${cartes.echapper(r.messageId || '')}</i>` });
        return void (await envoyerCarte(chatId, cartes.carteMessage(brouillon.message_id), { messageId: brouillon.message_id }));
      }
      if (action === 'ann') {
        await repondreAuClic(q.id, 'Annulé.');
        return void (await reecrire(chatId, cardId, { texte: '↩️ Envoi annulé. Rien n\'est parti.' }));
      }
    }

    if (famille === 'm' && action === 'voir') {
      const carte = cartes.carteCorps(Number(args[0]));
      await repondreAuClic(q.id);
      if (!carte?.texte) return void (await envoyerTexte(chatId, 'Message introuvable.'));
      return void (await envoyerTexte(chatId, carte.texte));
    }

    await repondreAuClic(q.id, 'Action inconnue.');
  } catch (e) {
    log.warn(`Telegram : action « ${q.data} » en echec : ${e.message}`);
    await repondreAuClic(q.id, e.message.slice(0, 190));
  }
}

/* ------------------------------------------------------------------- boucle */

async function traiter(maj) {
  const chatId = maj.message?.chat?.id ?? maj.callback_query?.message?.chat?.id;
  if (!autorise(chatId)) {
    // Muet, et journalise : le nom d'un bot est public, pas son usage.
    log.warn(`Telegram : mise a jour ignoree, salon ${chatId} hors liste blanche.`);
    return;
  }

  if (maj.callback_query) return void (await clic(maj.callback_query));

  const texte = String(maj.message?.text || '').trim();
  if (!texte) return;

  if (texte.startsWith('/')) return void (await commande(chatId, texte));

  // Tout le reste est une question posee a l'agent.
  if (!config.chat.enabled) return void (await envoyerTexte(chatId, 'La conversation est desactivee (CHAT_ENABLED).'));
  await appeler('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const reponse = await require('../chat').repondre({ plateforme: 'telegram', chatId: String(chatId), question: texte });
    await envoyerTexte(chatId, cartes.echapper(reponse.texte) || '(aucune reponse)');
    for (const id of reponse.messagesCites || []) {
      const carte = cartes.carteMessage(id);
      if (carte) await envoyerCarte(chatId, carte, { messageId: id });
    }
  } catch (e) {
    log.warn(`Telegram : conversation en echec : ${e.message}`);
    await envoyerTexte(chatId, `Je n'ai pas pu repondre : ${cartes.echapper(e.message)}`);
  }
}

async function tour() {
  const offset = Number(getState(OFFSET, '0')) || 0;
  const majs = await appeler('getUpdates', {
    offset,
    timeout: 25,
    allowed_updates: ['message', 'callback_query'],
  });

  for (const maj of majs || []) {
    // L'offset avance AVANT le traitement : une action qui echoue ne doit pas
    // etre rejouee en boucle a chaque tour.
    setState(OFFSET, String(maj.update_id + 1));
    try {
      await traiter(maj);
    } catch (e) {
      log.error('Telegram : traitement en echec :', e.message);
    }
  }
}

async function demarrer() {
  arrete = false;
  const moi = await appeler('getMe');
  log.info(`Telegram : bot « ${moi.username} » demarre, salon(s) autorise(s) : ${config.bot.chatId.join(', ')}.`);

  boucle = (async () => {
    while (!arrete) {
      try {
        await tour();
      } catch (e) {
        log.warn(`Telegram : boucle en echec (${e.message}), nouvelle tentative dans ${config.bot.pollSeconds} s.`);
        await new Promise((r) => setTimeout(r, config.bot.pollSeconds * 1000));
      }
    }
  })();
}

async function arreter() {
  arrete = true;
  await Promise.race([boucle, new Promise((r) => setTimeout(r, 1000))]).catch(() => {});
}

/**
 * Message concerne par un evenement.
 *
 * La clef d'un evenement ne porte pas toujours un identifiant de message :
 * « a_repondre:12 » designe le message 12, « brouillon:7 » designe le
 * brouillon 7. Confondre les deux afficherait la carte d'un message au hasard.
 */
function messageIdDeLEvenement(event) {
  const [famille, brut] = String(event.cle || '').split(':');
  const id = Number(brut);
  if (!Number.isFinite(id)) return null;
  if (famille === 'brouillon' || famille === 'depose' || famille === 'envoye') {
    const d = db.prepare('SELECT message_id FROM drafts WHERE id = ?').get(id);
    return d ? d.message_id : null;
  }
  return id;
}

/** Consommateur du journal d'evenements. */
async function surEvenement(event) {
  const interessants = ['a_repondre', 'brouillon_pret', 'panne'];
  if (!interessants.includes(event.type)) return;

  for (const chatId of config.bot.chatId) {
    if (event.type === 'panne') {
      await envoyerTexte(chatId, `⚠️ <b>${cartes.echapper(event.titre)}</b>\n${cartes.echapper(event.corps)}`);
      continue;
    }
    const messageId = messageIdDeLEvenement(event);
    const carte = messageId ? cartes.carteMessage(messageId) : null;
    if (carte) await envoyerCarte(chatId, carte, { messageId });
  }
}

module.exports = { demarrer, arreter, surEvenement, envoyerTexte, envoyerCarte, nom: 'telegram' };
