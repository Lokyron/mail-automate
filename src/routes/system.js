'use strict';
/** Etat du systeme, tests de connexion, journal d'evenements. */
const express = require('express');
const { config } = require('../config');
const imap = require('../services/imap');
const llm = require('../services/llm');
const events = require('../services/events');
const mailer = require('../services/mailer');
const imapWrite = require('../services/imapWrite');
const bot = require('../services/bot');
const { ecritureAutorisee } = require('../services/guard');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/status', (req, res) =>
  res.json({
    version: require('../../package.json').version,
    phase: ecritureAutorisee() ? 1 : 0,
    ecritureAutorisee: ecritureAutorisee(),
    imap: imap.status(),
    modele: llm.status(),
    tri: { auto: config.tri.auto, seuil: config.llm.confidenceThreshold, exemples: config.tri.exemples },
    brouillons: { auto: config.brouillons.auto, signature: Boolean(config.brouillons.signature) },
    confidentiel: {
      expediteurs: config.confidentiel.expediteurs.length,
      motsObjet: config.confidentiel.motsObjet.length,
    },
    envoi: mailer.status(),
    ecriture: imapWrite.status(),
    bot: bot.status(),
    evenements: { nonLus: events.nonLus() },
  })
);

router.get('/test/imap', asyncRoute(async (req, res) => res.json(await imap.testConnection())));
router.get('/test/modele', asyncRoute(async (req, res) => res.json(await llm.testConnection())));
router.get('/test/smtp', asyncRoute(async (req, res) => res.json(await mailer.testConnection())));

router.get('/events', (req, res) => res.json({ events: events.recents(Number(req.query.limit) || 50) }));
router.post('/events/lues', (req, res) => res.json(events.toutMarquerLu()));

module.exports = router;
