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

  active = p;
  events.abonner(`bot:${p.nom}`, (event) => p.surEvenement(event));
  p.demarrer().catch((e) => log.error(`Bot : demarrage impossible : ${e.message}`));
}

async function arreter() {
  if (active) await active.arreter();
  active = null;
}

const status = () => ({
  enabled: config.bot.enabled,
  plateforme: config.bot.plateforme,
  actif: Boolean(active),
  salons: config.bot.chatId.length,
  corpsDansLeSalon: config.bot.corpsDansLeSalon,
});

module.exports = { demarrer, arreter, status };
