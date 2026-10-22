'use strict';
/**
 * Mise en forme des cartes envoyees dans le salon.
 *
 * Une carte dit l'essentiel et porte des boutons ; elle ne transporte PAS le
 * courrier. Par defaut (`BOT_BODY_IN_CHAT=false`) elle se limite a
 * l'expediteur, l'objet, le libelle propose et le resume d'une phrase : le
 * salon transporte des decisions, pas de la correspondance. Le corps reste
 * accessible a la demande, par un bouton.
 *
 * Un courrier marque confidentiel ne sort JAMAIS autrement qu'en metadonnees,
 * quel que soit le reglage.
 */
const { config } = require('../../config');
const { db } = require('../../db');

const echapper = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const couper = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const PRIORITES = { haute: '🔴', normale: '🔵', basse: '⚪️' };

/** Le corps peut-il figurer dans le salon ? */
const corpsAutorise = (message) => config.bot.corpsDansLeSalon && !message.sensible;

/** Carte d'un message : son tri propose et, s'il existe, son brouillon. */
function carteMessage(messageId) {
  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(messageId);
  if (!message) return null;
  const triage = db.prepare('SELECT * FROM triages WHERE message_id = ? ORDER BY id DESC LIMIT 1').get(messageId);
  const brouillon = db.prepare('SELECT * FROM drafts WHERE message_id = ? ORDER BY id DESC LIMIT 1').get(messageId);

  const lignes = [
    `<b>${echapper(couper(message.from_name || message.from_email, 60))}</b>`,
    echapper(couper(message.subject, 120)),
  ];

  if (message.sensible) {
    lignes.push('', '🔒 Courrier confidentiel : contenu non transmis au modèle.');
  } else if (triage) {
    const p = PRIORITES[triage.priorite] || '';
    lignes.push(
      '',
      `${p} ${echapper(triage.label)}${triage.repondre ? ' · à répondre' : ''}` +
        (triage.source === 'modele' ? ` · confiance ${Number(triage.confiance).toFixed(2)}` : ' · règle'),
    );
    if (triage.resume) lignes.push(`<i>${echapper(couper(triage.resume, 200))}</i>`);
  } else {
    lignes.push('', '⏳ Pas encore trié.');
  }

  if (triage?.applied_at) lignes.push(`✅ Libellé posé dans Gmail (${echapper(triage.applied_folder)}).`);

  if (brouillon) {
    lignes.push('', `✍️ Brouillon prêt (confiance ${Number(brouillon.confiance).toFixed(2)})`);
    const manques = JSON.parse(brouillon.questions || '[]');
    if (manques.length) lignes.push(`❓ Manque : ${echapper(couper(manques.join(' · '), 160))}`);
    if (corpsAutorise(message)) {
      lignes.push('', `<pre>${echapper(couper(brouillon.corps_corrige || brouillon.corps, 700))}</pre>`);
    }
    if (brouillon.sent_at) lignes.push('📤 Envoyé.');
    else if (brouillon.applied_at) lignes.push('📥 Déposé dans les brouillons Gmail.');
  }

  return { texte: lignes.join('\n'), clavier: clavierMessage(message, triage, brouillon) };
}

/**
 * Boutons d'une carte. Ils dependent de l'etat : une action deja faite ne
 * reapparait pas, et l'envoi n'est jamais offert directement — il passe par un
 * recapitulatif.
 */
function clavierMessage(message, triage, brouillon) {
  const rangees = [];

  if (!message.sensible && triage && !triage.verdict) {
    rangees.push([
      { text: '✅ Tri juste', callback_data: `t:ok:${triage.id}` },
      { text: '✏️ Corriger', callback_data: `t:c:${triage.id}` },
    ]);
  }

  if (!message.sensible) {
    const r = [];
    if (!brouillon) r.push({ text: '✍️ Rédiger', callback_data: `d:new:${message.id}` });
    if (brouillon && !brouillon.sent_at) {
      if (!brouillon.applied_at) r.push({ text: '📥 Dans Gmail', callback_data: `d:dep:${brouillon.id}` });
      r.push({ text: '📤 Envoyer…', callback_data: `d:prep:${brouillon.id}` });
    }
    if (r.length) rangees.push(r);
  }

  const bas = [{ text: '👁 Voir', callback_data: `m:voir:${message.id}` }];
  if (triage && !triage.applied_at && !message.sensible) {
    bas.push({ text: '🏷 Poser le libellé', callback_data: `t:pose:${triage.id}` });
  }
  rangees.push(bas);

  return { inline_keyboard: rangees };
}

/** Clavier de choix du libelle, affiche apres « Corriger ». */
function clavierLibelles(triageId) {
  const labels = db.prepare('SELECT id, nom FROM labels WHERE actif = 1 ORDER BY ordre').all();
  const rangees = [];
  for (let i = 0; i < labels.length; i += 2) {
    rangees.push(
      labels.slice(i, i + 2).map((l) => ({ text: l.nom, callback_data: `t:l:${triageId}:${l.id}` }))
    );
  }
  rangees.push([{ text: '← Annuler', callback_data: `t:x:${triageId}` }]);
  return { inline_keyboard: rangees };
}

/** Corps du message, a la demande. Jamais pour un courrier confidentiel. */
function carteCorps(messageId) {
  const m = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(messageId);
  if (!m) return null;
  if (m.sensible)
    return { texte: '🔒 Courrier confidentiel : son contenu ne sort pas de la machine. À lire dans Gmail.' };

  const pj = db
    .prepare('SELECT filename FROM inbox_attachments WHERE message_id = ? AND inline = 0')
    .all(messageId)
    .map((a) => a.filename || '(sans nom)');

  return {
    texte: [
      `<b>${echapper(m.subject)}</b>`,
      `${echapper(m.from_name || '')} &lt;${echapper(m.from_email)}&gt;`,
      pj.length ? `📎 ${echapper(pj.join(', '))} (jamais téléchargées)` : '',
      '',
      `<pre>${echapper(couper(m.body_text, 3200))}</pre>`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Recapitulatif avant envoi : ce qui partira, mot pour mot. */
function carteRecapitulatif(draftId, prep) {
  const r = prep.recapitulatif;
  return {
    texte: [
      '<b>À envoyer — relis avant de confirmer</b>',
      '',
      `À : ${echapper(r.destinataire)}`,
      `Objet : ${echapper(r.objet)}`,
      '',
      `<pre>${echapper(couper(r.corps, 2800))}</pre>`,
      '',
      `<i>Confirmation valable ${Math.round(prep.expireDans / 60)} min · ${r.envoisRestants} envoi(s) restant(s) aujourd'hui.</i>`,
    ].join('\n'),
    clavier: {
      inline_keyboard: [
        [
          { text: '📤 Confirmer l\'envoi', callback_data: `d:env:${draftId}:${prep.jeton}` },
          { text: '← Annuler', callback_data: `d:ann:${draftId}` },
        ],
      ],
    },
  };
}

module.exports = { carteMessage, clavierMessage, clavierLibelles, carteCorps, carteRecapitulatif, echapper, couper };
