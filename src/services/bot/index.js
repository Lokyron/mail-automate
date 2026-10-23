'use strict';
/**
 * Facade du salon de discussion.
 *
 * Les services (relevé, tri, redaction) ne connaissent pas le bot : ils
 * emettent des evenements. Le bot s'abonne a ce journal, exactement comme
 * l'interface web. C'est ce qui permet d'ajouter Discord demain sans toucher
 * une ligne du relevé ni du tri — et ce qui garantit que les deux surfaces
 * montrent le meme etat, puisqu'elles lisent la meme base.
 */
const { config } = require('../../config');
const log = require('../../utils/logger');
const events = require('../events');

const passerelles = {
  telegram: require('./telegram'),
};

let active = null;
/**
 * L'abonnement au journal d'evenements se pose UNE SEULE FOIS, pour la vie du
 * processus. Le reposer a chaque demarrage — ce qui arrive des qu'on regle le
 * salon depuis Parametres — ferait partir deux cartes par evenement, puis
 * trois : un consommateur s'ajoute, il ne se remplace pas.
 */
let abonne = false;

function demarrer() {
  if (!config.bot.enabled) {
    log.info('Bot : desactive (BOT_ENABLED).');
    return;
  }
  const p = passerelles[config.bot.plateforme];
  if (!p) {
    log.error(`Bot : plateforme inconnue « ${config.bot.plateforme} ».`);
    return;
  }

  /**
   * La liste blanche est une CONDITION DE DEMARRAGE, pas un avertissement.
   *
   * Elle etait verifiee par `validate()`, qui arretait tout le processus. Ce
   * n'etait plus tenable une fois le salon reglable depuis l'interface : vider
   * la liste par megarde aurait empeche l'application de redemarrer. La garde
   * descend donc ici, ou elle protege exactement ce qu'il faut — le bot ne
   * demarre pas — sans rien condamner d'autre. Un bot sans liste blanche serait
   * une porte ouverte sur une boite mail personnelle.
   */
  if (!config.bot.token) {
    log.error('Bot : jeton absent, le salon ne demarre pas.');
    return;
  }
  if (!config.bot.chatId.length) {
    log.error('Bot : aucun salon autorise, le salon ne demarre pas (la liste blanche est obligatoire).');
    return;
  }

  active = p;
  if (!abonne) {
    // Le consommateur interroge `active` au moment de l'evenement : il suit
    // donc l'etat courant, y compris apres un arret.
    events.abonner('bot', (event) => (active ? active.surEvenement(event) : undefined));
    abonne = true;
  }
  p.demarrer().catch((e) => log.error(`Bot : demarrage impossible : ${e.message}`));
}

async function arreter() {
  if (active) await active.arreter();
  active = null;
}

/** Reprend le salon avec les reglages courants. */
async function redemarrer() {
  await arreter();
  demarrer();
}

const status = () => ({
  enabled: config.bot.enabled,
  plateforme: config.bot.plateforme,
  actif: Boolean(active),
  salons: config.bot.chatId.length,
  corpsDansLeSalon: config.bot.corpsDansLeSalon,
});

module.exports = { demarrer, arreter, redemarrer, status };
