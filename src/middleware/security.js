'use strict';
/** En-tetes de securite et limitation de debit. */
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

/**
 * CSP volontairement stricte : aucun script distant, aucune feuille de style
 * distante. L'application n'a pas de dependance front, tout est servi en local.
 * `frame-src 'self'` autorise l'iframe sandbox qui affiche le HTML des messages
 * recus — seul endroit ou du HTML etranger est rendu.
 */
const entetes = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
});

/** Limite les tentatives de connexion : 10 par quart d'heure et par adresse. */
const limiteConnexion = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Reessayer dans quinze minutes.' },
});

/** Limite generale de l'API, large : un seul utilisateur. */
const limiteApi = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { entetes, limiteConnexion, limiteApi };
