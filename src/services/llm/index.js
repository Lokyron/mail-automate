'use strict';
/**
 * Facade du modele de langage.
 *
 * Les services de tri et de redaction ne connaissent que ce module : ils
 * ignorent quel fournisseur repond. Trois responsabilites ici, et aucune
 * ailleurs :
 *  1. choisir le fournisseur (reglage LLM_PROVIDER) ;
 *  2. tenir les compteurs d'appels et de jetons, par jour et par tache ;
 *  3. faire respecter le plafond journalier — aucune boucle ne doit pouvoir
 *     faire exploser la facture, et une panne en boucle est exactement le genre
 *     de boucle qu'on ne voit pas venir.
 */
const { config } = require('../../config');
const { db } = require('../../db');
const log = require('../../utils/logger');

const fournisseurs = {
  claude: require('./claude'),
  gemini: require('./gemini'),
};

const actif = () => fournisseurs[config.llm.provider] || fournisseurs.claude;

const jour = () => new Date().toISOString().slice(0, 10);

function compter({ tache, modele, usage = {}, echec = false }) {
  db.prepare(
    `INSERT INTO llm_usage (jour, tache, modele, appels, echecs, jetons_entree, jetons_sortie)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(jour, tache, modele) DO UPDATE SET
       appels = appels + 1,
       echecs = echecs + excluded.echecs,
       jetons_entree = jetons_entree + excluded.jetons_entree,
       jetons_sortie = jetons_sortie + excluded.jetons_sortie`
  ).run(jour(), tache, modele, echec ? 1 : 0, usage.entree || 0, usage.sortie || 0);
}

const appelsDuJour = () =>
  db.prepare('SELECT COALESCE(SUM(appels), 0) AS n FROM llm_usage WHERE jour = ?').get(jour()).n;

const appelsRestants = () => Math.max(0, config.llm.dailyCallLimit - appelsDuJour());

/** Modele a utiliser pour une tache donnee, selon le fournisseur actif. */
function modelePour(tache) {
  const p = config.llm[actif().nom];
  return tache === 'redaction' ? p.draftModel : p.classifyModel;
}

/**
 * Un appel, une reponse JSON conforme au schema.
 * `tache` sert aux compteurs : « tri », « redaction », « conversation ».
 */
async function askJson({ tache, system, input, schema, maxOutputTokens, temperature, timeoutMs, model }) {
  const f = actif();
  if (!f.isConfigured())
    throw Object.assign(new Error(`Le fournisseur « ${f.nom} » n'est pas configure (clef d'API absente).`), { status: 400 });

  if (appelsRestants() <= 0)
    throw Object.assign(
      new Error(`Plafond journalier atteint (${config.llm.dailyCallLimit} appels). Rien n'est envoye jusqu'a demain.`),
      { status: 429 }
    );

  const modele = model || modelePour(tache);
  try {
    const r = await f.askJson({ model: modele, system, input, schema, maxOutputTokens, temperature, timeoutMs });
    compter({ tache, modele, usage: r.usage });
    return r.data;
  } catch (e) {
    // Un appel rate est facture quand meme la plupart du temps : il doit
    // apparaitre dans les compteurs, sinon le plafond ne protege de rien.
    compter({ tache, modele, echec: true });
    log.warn(`Modele : ${tache} en echec (${modele}) : ${e.message}`);
    throw e;
  }
}

/**
 * Un tour de conversation a outils. Seul Claude l'implemente pour l'instant :
 * plutot qu'une emulation approximative cote Gemini, l'erreur est explicite.
 */
async function converser({ system, messages, tools, maxOutputTokens, temperature, timeoutMs, model }) {
  const f = actif();
  if (typeof f.converser !== 'function')
    throw Object.assign(
      new Error(`Le fournisseur « ${f.nom} » ne gere pas la conversation a outils. Passer LLM_PROVIDER=claude.`),
      { status: 501 }
    );
  if (!f.isConfigured())
    throw Object.assign(new Error(`Le fournisseur « ${f.nom} » n'est pas configure.`), { status: 400 });
  if (appelsRestants() <= 0)
    throw Object.assign(new Error(`Plafond journalier atteint (${config.llm.dailyCallLimit} appels).`), { status: 429 });

  const modele = model || modelePour('redaction');
  try {
    const r = await f.converser({ model: modele, system, messages, tools, maxOutputTokens, temperature, timeoutMs });
    compter({ tache: 'conversation', modele, usage: r.usage });
    return r;
  } catch (e) {
    compter({ tache: 'conversation', modele, echec: true });
    throw e;
  }
}

/** Le fournisseur actif sait-il tenir une conversation a outils (l'agent) ? */
const gereLAgent = () => typeof actif().converser === 'function';

function status() {
  const f = actif();
  const lignes = db
    .prepare('SELECT tache, modele, appels, echecs, jetons_entree, jetons_sortie FROM llm_usage WHERE jour = ?')
    .all(jour());
  return {
    fournisseur: f.nom,
    configure: f.isConfigured(),
    modeles: { tri: modelePour('tri'), redaction: modelePour('redaction') },
    gereLAgent: gereLAgent(),
    plafondJournalier: config.llm.dailyCallLimit,
    appelsDuJour: appelsDuJour(),
    appelsRestants: appelsRestants(),
    detail: lignes,
  };
}

const testConnection = () => actif().testConnection();
const isConfigured = () => actif().isConfigured();

module.exports = { askJson, converser, status, testConnection, isConfigured, appelsRestants, modelePour, gereLAgent };
