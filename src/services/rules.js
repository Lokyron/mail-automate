'use strict';
/**
 * Regles deterministes de tri, et mise hors de portee du courrier confidentiel.
 *
 * Deux raisons de passer ici AVANT le modele :
 *  - une regle ne se trompe jamais deux fois de la meme facon, et ne coute rien ;
 *  - le courrier confidentiel ne doit pas sortir de la machine, et cette decision
 *    ne peut pas dependre d'un service distant.
 */
const { db } = require('../db');
const { config } = require('../config');

/** Compare une valeur a un motif. Les motifs sont stockes en minuscules. */
function correspond(valeur, operateur, motif) {
  const v = String(valeur || '').toLowerCase();
  const m = String(motif || '').toLowerCase();
  if (!v || !m) return false;
  switch (operateur) {
    case 'egal':     return v === m;
    case 'commence': return v.startsWith(m);
    case 'finit':    return v.endsWith(m);
    case 'contient': return v.includes(m);
    case 'regex':
      try {
        return new RegExp(m, 'i').test(v);
      } catch {
        // Une expression invalide saisie dans l'interface ne doit pas faire
        // tomber le tri de toute la boite : la regle est simplement ignoree.
        return false;
      }
    default: return false;
  }
}

/** Motif avec joker « * », utilise pour les listes d'expediteurs confidentiels. */
function correspondJoker(valeur, motif) {
  const v = String(valeur || '').toLowerCase();
  const m = String(motif || '').toLowerCase();
  if (!m) return false;
  if (!m.includes('*')) return v === m || v.endsWith(m) || v.includes(m);
  const re = new RegExp(`^${m.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(v);
}

/**
 * Le message doit-il rester hors de portee du modele ?
 *
 * Decision volontairement grossiere et large : mieux vaut un message de trop
 * garde a la main qu'une ligne de releve bancaire envoyee a une API. La reponse
 * ne depend que de la configuration locale et des en-tetes du message.
 */
function estSensible(message) {
  const from = String(message.from_email || '').toLowerCase();
  if (config.confidentiel.expediteurs.some((m) => correspondJoker(from, m))) return true;

  const objet = String(message.subject || '').toLowerCase();
  return config.confidentiel.motsObjet.some((mot) => objet.includes(mot));
}

const champ = (message, nom) => {
  if (nom === 'list_id') return message.thread_refs || message.list_id || '';
  return message[nom] || '';
};

/**
 * Premiere regle active qui s'applique, dans l'ordre. Retourne null si aucune :
 * le message part alors au modele.
 */
function evaluer(message) {
  const regles = db.prepare('SELECT * FROM rules WHERE actif = 1 ORDER BY ordre ASC, id ASC').all();
  for (const r of regles) {
    if (!correspond(champ(message, r.champ), r.operateur, r.valeur)) continue;
    return {
      label: r.label,
      priorite: r.priorite,
      repondre: r.repondre ? 1 : 0,
      resume: '',
      confiance: 1,
      motif: r.note || `Regle #${r.id} : ${r.champ} ${r.operateur} « ${r.valeur} »`,
      source: 'regle',
      modele: '',
    };
  }
  return null;
}

const toutes = () => db.prepare('SELECT * FROM rules ORDER BY ordre ASC, id ASC').all();

const labels = () => db.prepare('SELECT * FROM labels WHERE actif = 1 ORDER BY ordre ASC').all();

function ajouter({ ordre = 100, champ: ch, operateur, valeur, label, priorite = 'normale', repondre = 0, note = '' }) {
  const info = db
    .prepare(
      `INSERT INTO rules (ordre, champ, operateur, valeur, label, priorite, repondre, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ordre, ch, operateur, valeur, label, priorite, repondre ? 1 : 0, note);
  return Number(info.lastInsertRowid);
}

const supprimer = (id) => db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;

const basculer = (id, actif) => db.prepare('UPDATE rules SET actif = ? WHERE id = ?').run(actif ? 1 : 0, id).changes > 0;

module.exports = { evaluer, estSensible, correspond, correspondJoker, toutes, labels, ajouter, supprimer, basculer };
