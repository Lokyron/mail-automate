'use strict';
/**
 * Verrou d'ecriture.
 *
 * Toute la promesse de la phase 0 tient dans ce fichier : la boite Gmail n'est
 * PAS modifiee. Plutot que de compter sur la discipline de chaque module, le
 * verrou est centralise ici et appele par tout code qui s'appreterait a ecrire
 * (poser un libelle, deposer un brouillon, marquer lu, envoyer).
 *
 * Ce n'est pas une precaution theorique : la phase 1 ajoutera precisement ces
 * fonctions, et c'est en les ajoutant qu'on risque d'oublier qu'un reglage les
 * gouverne. En appelant `exigerEcriture()` au premier geste, un oubli devient
 * une erreur immediate et bruyante au lieu d'un libelle pose par surprise.
 */
const { config } = require('../config');
const log = require('../utils/logger');

class EcritureInterdite extends Error {
  constructor(geste) {
    super(
      `Ecriture refusee (${geste}) : la phase 0 est en lecture seule. ` +
        'Mettre WRITE_ENABLED=true pour ouvrir la phase 1.'
    );
    this.name = 'EcritureInterdite';
    this.status = 409;
    this.geste = geste;
  }
}

/** Leve si l'ecriture n'est pas autorisee. A appeler AVANT toute modification. */
function exigerEcriture(geste) {
  if (!config.ecriture.autorisee) {
    log.warn(`Verrou : tentative d'ecriture refusee (${geste}).`);
    throw new EcritureInterdite(geste);
  }
  return true;
}

const ecritureAutorisee = () => Boolean(config.ecriture.autorisee);

module.exports = { exigerEcriture, ecritureAutorisee, EcritureInterdite };
