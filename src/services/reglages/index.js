'use strict';
/**
 * Application des reglages a l'objet `config`, a chaud.
 *
 * POURQUOI MUTER `config` PLUTOT QUE DE TOUT RECABLER. Chaque module fait
 * `const { config } = require('../config')` une fois, puis lit `config.imap.user`
 * au moment de s'en servir. Ecrire dans cet objet suffit donc a ce que tout le
 * monde voie la nouvelle valeur, sans recharger un seul module et sans toucher
 * a trente fichiers. L'objet est le point de verite partage ; on le tient a
 * jour, on ne le remplace pas.
 *
 * L'AMORCE EST PHOTOGRAPHIEE AVANT LA PREMIERE APPLICATION. Sans cela, effacer
 * un reglage dans l'interface ne pourrait rendre la main a rien : la valeur du
 * `.env` aurait deja ete ecrasee et serait perdue jusqu'au redemarrage.
 */
const { config, avertissements } = require('../../config');
const log = require('../../utils/logger');
const coffre = require('./coffre');
const { CATALOGUE, GROUPES, PAR_CLE, EN_LECTURE_SEULE, CONVERSIONS, pourAffichage, lirePath, poserPath } =
  require('./catalogue');

/** Valeurs issues du `.env`, photographiees avant toute modification. */
let amorce = null;

function photographierAmorce() {
  if (amorce) return;
  amorce = {};
  for (const r of CATALOGUE) {
    /**
     * `amorceEnv` : prendre la variable d'environnement BRUTE, pas la valeur
     * calculee par `config.js`.
     *
     * Trois reglages ont un repli cuit dans `config.js` (« SMTP_USER a defaut
     * IMAP_USER »). Photographier la valeur calculee y aurait fige le compte
     * de la boite au demarrage : vider le champ d'envoi dans l'interface
     * rendait alors la main a cette ancienne valeur — jamais vide, donc le
     * repli ne se redeclenchait plus jamais, et changer la boite laissait
     * l'envoi sur l'ancien compte.
     */
    amorce[r.cle] = r.amorceEnv ? String(process.env[r.cle] || '') : lirePath(config, r.chemin);
  }
}

/**
 * Replis historiques, rejoues APRES l'application des reglages.
 *
 * `config.js` les calcule au demarrage (« SMTP_USER a defaut IMAP_USER ») a
 * partir des variables d'environnement. Une fois les valeurs modifiables a
 * chaud, ce calcul doit etre refait : sans cela, renseigner la boite depuis
 * l'interface laissait l'envoi avec l'ancien compte, ou avec rien.
 */
function replis() {
  if (!config.smtp.user) config.smtp.user = config.imap.user;
  if (!config.smtp.pass) config.smtp.pass = config.imap.pass;
  if (!config.smtp.fromEmail) config.smtp.fromEmail = config.smtp.user;
}

/** Pose sur `config` l'etat courant : ce qui est en base, sinon l'amorce. */
function appliquer() {
  photographierAmorce();
  for (const r of CATALOGUE) {
    const range = coffre.lire(r.cle);
    const valeur = range === null ? amorce[r.cle] : (CONVERSIONS[r.type] || String)(range);
    poserPath(config, r.chemin, valeur);
  }
  replis();
}

/* ------------------------------------------------------- redemarrages cibles */

/**
 * Les services qui gardent un etat ouvert doivent le reprendre.
 *
 * Chargés ici et non en tete de fichier : `imap` et `bot` remontent jusqu'a
 * `reglages` par leurs dependances, et un require circulaire au chargement
 * rendrait l'un des deux vide.
 */
const REPRISES = {
  imap: async () => {
    const imap = require('../imap');
    await imap.restart();
    return 'relève de la boîte';
  },
  smtp: async () => {
    require('../mailer').reinitialiser();
    return 'connexion d’envoi';
  },
  bot: async () => {
    const bot = require('../bot');
    await bot.redemarrer();
    return 'salon de discussion';
  },
};

async function reprendre(services) {
  const faits = [];
  for (const nom of services) {
    try {
      faits.push(await REPRISES[nom]());
    } catch (e) {
      // Un service qui refuse de repartir ne doit pas faire echouer
      // l'enregistrement : le reglage est pose, et l'erreur est dite.
      log.error(`Reglages : reprise de « ${nom} » impossible : ${e.message}`);
      faits.push(`${nom} (en échec : ${e.message})`);
    }
  }
  return faits;
}

/* --------------------------------------------------------------- ecriture */

/**
 * Enregistre un lot de reglages.
 *
 * TOUT EST VALIDE AVANT QUE QUOI QUE CE SOIT NE SOIT ECRIT : un formulaire a
 * moitie applique laisserait l'application dans un etat que personne n'a voulu.
 */
async function enregistrer(valeurs = {}) {
  const entrees = Object.entries(valeurs);
  if (!entrees.length) throw Object.assign(new Error('Aucun reglage fourni.'), { status: 400 });

  const refus = [];
  const aEcrire = [];

  for (const [cle, brut] of entrees) {
    const r = PAR_CLE.get(cle);
    if (!r) {
      refus.push({ cle, motif: 'reglage inconnu' });
      continue;
    }
    const valeur = typeof brut === 'string' ? brut.trim() : brut;

    // Chaine vide = « revenir a la valeur du .env ». C'est le seul moyen de
    // defaire un reglage, et il doit rester simple.
    if (valeur === '' || valeur === null || valeur === undefined) {
      aEcrire.push({ r, effacer: true });
      continue;
    }
    const motif = r.verifier ? r.verifier(valeur) : null;
    if (motif) {
      refus.push({ cle, motif: `${r.libelle} : ${motif}` });
      continue;
    }
    aEcrire.push({ r, valeur: String(valeur) });
  }

  if (refus.length) {
    throw Object.assign(new Error(refus.map((x) => x.motif).join(' · ')), { status: 400, refus });
  }

  const services = new Set();
  for (const { r, valeur, effacer } of aEcrire) {
    if (effacer) coffre.effacer(r.cle);
    else coffre.ecrire(r.cle, valeur, { secret: r.type === 'secret' });
    if (r.redemarrer) services.add(r.redemarrer);
    // Les valeurs ne sont jamais journalisees : un secret n'a pas a transiter
    // par le journal, meme masque.
    log.info(`Reglage « ${r.cle} » ${effacer ? 'rendu au .env' : 'modifie'}.`);
  }

  appliquer();
  const repris = await reprendre(services);
  return { enregistres: aEcrire.length, repris, etat: etat() };
}

/* ---------------------------------------------------------------- lecture */

/**
 * L'etat montre a l'interface.
 *
 * AUCUNE VALEUR SECRETE N'EN SORT : un secret se resume a « renseigne » et aux
 * quatre derniers caracteres de ce qui est EN SERVICE — assez pour reconnaitre
 * une clef collee de travers, trop peu pour s'en servir.
 */
function etat() {
  photographierAmorce();
  const posees = coffre.posees();

  const reglages = CATALOGUE.map((r) => {
    const enBase = Object.prototype.hasOwnProperty.call(posees, r.cle);
    const effective = lirePath(config, r.chemin);
    const commun = {
      cle: r.cle,
      groupe: r.groupe,
      type: r.type,
      libelle: r.libelle,
      aide: r.aide || '',
      exemple: r.exemple || '',
      choix: r.choix || null,
      avance: Boolean(r.avance),
      source: enBase ? 'base' : 'env',
      majLe: enBase ? posees[r.cle].majLe : null,
    };
    if (r.type === 'secret') {
      return { ...commun, renseigne: Boolean(effective), apercu: coffre.apercuSecret(effective), valeur: null };
    }
    return { ...commun, valeur: pourAffichage(r.type, effective) };
  });

  return {
    groupes: GROUPES,
    // Ce qui empeche un service de tourner. Un service a l'arret doit dire
    // pourquoi, a l'endroit ou cela se corrige — pas se taire.
    avertissements: avertissements(),
    reglages,
    lectureSeule: EN_LECTURE_SEULE.map((x) => ({ libelle: x.libelle, valeur: x.valeur(), motif: x.motif })),
  };
}

module.exports = { appliquer, enregistrer, etat, coffre };
