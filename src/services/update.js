'use strict';
/**
 * Mise a jour depuis le depot GitHub, sans jamais donner a l'application le
 * droit d'ecrire son propre code.
 *
 * L'application se contente de DEPOSER UNE DEMANDE dans son dossier de
 * donnees. Une unite `path` de systemd, qui surveille ce fichier sur l'hote,
 * lance l'executeur en root : lui telecharge la nouvelle version, reconstruit
 * l'image, remplace le conteneur et ecrit sa progression dans un fichier d'etat
 * que l'application relit. Les unites sont dans `deploy/`.
 *
 * Pourquoi cette separation, et pourquoi elle compte PLUS encore ici que sur
 * une installation classique : la facon paresseuse de mettre a jour un
 * conteneur serait de lui donner acces au socket Docker. Or le socket Docker,
 * c'est root sur l'hote — on offrirait a une application exposee au courrier
 * entrant le moyen de prendre la machine. Le conteneur d'Inbox Agent ne voit
 * jamais Docker : il ecrit un fichier, et c'est tout ce qu'il peut faire.
 *
 * Deux canaux : `stable` suit la branche principale, `beta` suit la branche
 * d'essai. La demande porte UN NOM DE CANAL, jamais un nom de branche : la
 * correspondance vit dans l'environnement du service root, de sorte que le cote
 * non privilegie ne peut pas diriger l'executeur vers une autre reference.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { getState, setState } = require('../db');
const log = require('../utils/logger');

const FICHIER_DEMANDE = path.join(config.maj.dataDir, 'update.request');
const FICHIER_ETAT = path.join(config.maj.dataDir, 'update.status');
const ETAT_CANAL = 'maj_canal';

const derniereVerif = new Map(); // canal -> { at, commit, message, date }

const lireJson = (fichier) => {
  try {
    return JSON.parse(fs.readFileSync(fichier, 'utf8'));
  } catch {
    return null;
  }
};

/** Les canaux offerts par cette instance, dans l'ordre d'affichage. */
function canaux() {
  const liste = [{ id: 'stable', branche: config.maj.branche }];
  if (config.maj.brancheBeta && config.maj.brancheBeta !== config.maj.branche) {
    liste.push({ id: 'beta', branche: config.maj.brancheBeta });
  }
  return liste;
}

const estCanal = (nom) => canaux().some((c) => c.id === nom);

/** Le canal en service, ramene a stable si la beta a ete retiree depuis. */
function canalCourant() {
  const garde = getState(ETAT_CANAL);
  return garde && estCanal(garde) ? garde : 'stable';
}

function choisirCanal(nom) {
  if (!estCanal(nom)) throw Object.assign(new Error(`Canal inconnu : « ${nom} ».`), { status: 400, code: 'canal' });
  setState(ETAT_CANAL, nom);
  return nom;
}

const brancheDe = (canal) => canaux().find((c) => c.id === canal)?.branche ?? config.maj.branche;

/**
 * Ce qui est installe.
 *
 * Le fichier VERSION est ecrit par l'executeur dans le dossier de DONNEES, et
 * non dans celui de l'application : sous Docker l'image est immuable et
 * reconstruite a chaque mise a jour, un fichier depose dedans ne survivrait
 * pas. Le dossier de l'application est tout de meme consulte en second, pour
 * qu'une installation sans Docker fonctionne a l'identique.
 */
function versionInstallee() {
  const fichier =
    lireJson(path.join(config.maj.dataDir, 'VERSION')) || lireJson(path.join(config.root, 'VERSION'));
  const pkg = lireJson(path.join(config.root, 'package.json'));
  return {
    version: pkg?.version ?? null,
    commit: fichier?.commit ?? null,
    branche: fichier?.branch ?? null,
    canal: fichier?.channel ?? null,
    installeLe: fichier?.installedAt ?? null,
  };
}

/**
 * Demande a GitHub la tete de la branche d'un canal. Mis en cache par canal :
 * un onglet laisse ouvert ne doit pas marteler l'API.
 */
async function verifier({ force = false, canal = canalCourant() } = {}) {
  const branche = brancheDe(canal);
  const connu = derniereVerif.get(canal);
  const ageMax = Math.max(1, config.maj.verifHeures) * 3_600_000;
  if (!force && connu && Date.now() - new Date(connu.at).getTime() < ageMax) return connu;

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), 10_000);
  try {
    const reponse = await fetch(
      `https://api.github.com/repos/${config.maj.repo}/commits/${encodeURIComponent(branche)}`,
      {
        signal: controleur.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Inbox-Agent' },
      }
    );
    // GitHub repond 422 pour une reference qu'il ne resout pas, et 404 pour un
    // depot qu'il ne voit pas. Les deux veulent dire la meme chose a qui lit le
    // panneau — et rappellent au passage que le depot doit etre PUBLIC.
    if (reponse.status === 404 || reponse.status === 422) {
      throw new Error(`Pas de branche « ${branche} » sur ${config.maj.repo}, ou depot non public.`);
    }
    if (!reponse.ok) throw new Error(`GitHub a repondu ${reponse.status}.`);

    const data = await reponse.json();
    const trouve = {
      at: new Date().toISOString(),
      canal,
      branche,
      commit: String(data.sha || '').slice(0, 40),
      message: String(data.commit?.message || '').split('\n')[0].slice(0, 120),
      date: data.commit?.committer?.date ?? null,
    };
    derniereVerif.set(canal, trouve);
    return trouve;
  } finally {
    clearTimeout(minuteur);
  }
}

function etat() {
  const e = lireJson(FICHIER_ETAT);
  return e && typeof e.state === 'string' ? e : { state: 'idle' };
}

/** Y a-t-il quelque chose a installer ? */
function enRetard(installe, dernier) {
  if (!dernier?.commit) return null;
  if (!installe.commit) return null; // installation manuelle : on ne sait pas
  return installe.commit !== dernier.commit;
}

/**
 * Depose le fichier que l'executeur surveille, en nommant le canal a installer.
 * N'ecrit rien d'autre, et surtout aucun chemin ni aucune reference.
 */
function demander() {
  if (!config.maj.enabled)
    throw Object.assign(new Error("La mise a jour depuis l'interface est desactivee sur cette instance."), {
      status: 503,
      code: 'desactive',
    });

  const encours = etat();
  if (encours.state === 'running')
    throw Object.assign(new Error('Une mise a jour est deja en cours.'), { status: 409, code: 'occupe' });

  const canal = canalCourant();
  const maintenant = new Date().toISOString();
  // L'etat est ecrit AVANT la demande : si l'executeur demarre dans la
  // milliseconde, l'interface ne doit pas afficher « au repos » pendant qu'il
  // travaille.
  fs.writeFileSync(FICHIER_ETAT, JSON.stringify({ state: 'running', step: 'demande', channel: canal, at: maintenant }));
  fs.writeFileSync(FICHIER_DEMANDE, `channel=${canal}\nat=${maintenant}\n`);
  log.info(`Mise a jour : demande deposee pour le canal « ${canal} ».`);
  return canal;
}

function reglages() {
  const canal = canalCourant();
  return {
    enabled: config.maj.enabled,
    repo: config.maj.repo,
    canal,
    canaux: canaux(),
    branche: brancheDe(canal),
    verifHeures: config.maj.verifHeures,
  };
}

/** Tableau complet : installe, disponible, et ou en est une mise a jour. */
async function rapport({ force = false } = {}) {
  const installe = versionInstallee();
  const payload = { ...reglages(), installe, etat: etat(), dernier: null, enRetard: null, erreur: null };
  try {
    payload.dernier = await verifier({ force, canal: canalCourant() });
    payload.enRetard = enRetard(installe, payload.dernier);
  } catch (e) {
    payload.erreur = e.message;
  }
  return payload;
}

module.exports = {
  canaux,
  canalCourant,
  choisirCanal,
  brancheDe,
  versionInstallee,
  verifier,
  etat,
  demander,
  reglages,
  rapport,
  FICHIER_DEMANDE,
  FICHIER_ETAT,
};
