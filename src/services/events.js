'use strict';
/**
 * Journal d'evenements.
 *
 * Un seul point d'entree, `emettre()`, et plusieurs consommateurs possibles :
 * l'interface web aujourd'hui, un bot Telegram demain. Les consommateurs
 * s'abonnent, ils ne sont pas appeles nommement par les services : le jour ou
 * le bot arrive, aucun appel n'est a ajouter dans le releve ni dans le tri.
 *
 * `cle` sert a la deduplication : une boite injoignable qui reessaie toutes les
 * trente secondes ne doit produire qu'un evenement, pas deux cents.
 */
const { db, nowIso } = require('../db');
const log = require('../utils/logger');

const abonnes = [];

/** Enregistre un consommateur. Il recoit chaque evenement nouvellement cree. */
function abonner(nom, fn) {
  abonnes.push({ nom, fn });
  log.debug(`Evenements : consommateur « ${nom} » abonne.`);
}

function emettre({ type, titre, corps = '', url = '', cle = null, meta = null }) {
  const row = {
    type,
    titre: String(titre || '').slice(0, 200),
    corps: String(corps || '').slice(0, 500),
    url,
    cle,
    created_at: nowIso(),
  };

  // ON CONFLICT DO NOTHING : la cle unique absorbe les repetitions.
  const info = db
    .prepare(
      `INSERT INTO events (type, titre, corps, url, cle, created_at)
       VALUES (@type, @titre, @corps, @url, @cle, @created_at)
       ON CONFLICT(cle) DO NOTHING`
    )
    .run(row);

  if (!info.changes) return null;
  const event = { id: Number(info.lastInsertRowid), ...row, meta };

  for (const { nom, fn } of abonnes) {
    // Un consommateur en panne ne doit jamais faire echouer le geste qui a
    // produit l'evenement : un bot injoignable n'empeche pas de relever le mail.
    Promise.resolve()
      .then(() => fn(event))
      .catch((e) => log.error(`Evenements : consommateur « ${nom} » en echec :`, e.message));
  }
  return event;
}

const recents = (limit = 50) =>
  db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(Math.min(limit, 200));

const nonLus = () => db.prepare('SELECT COUNT(*) AS n FROM events WHERE lu = 0').get().n;

const marquerLu = (id) => db.prepare('UPDATE events SET lu = 1 WHERE id = ?').run(id).changes > 0;

const toutMarquerLu = () => ({ marques: db.prepare('UPDATE events SET lu = 1 WHERE lu = 0').run().changes });

module.exports = { emettre, abonner, recents, nonLus, marquerLu, toutMarquerLu };
