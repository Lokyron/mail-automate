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

/**
 * Limite les tentatives de connexion : 20 ECHECS par quart d'heure et par
 * adresse.
 *
 * `skipSuccessfulRequests` n'est pas un detail de confort. La version
 * precedente comptait TOUTES les requetes, succes compris : quelqu'un qui vient
 * de changer son mot de passe, se reconnecte, verifie depuis son telephone, se
 * trompe une fois, recommence, epuisait le quota en quelques minutes. Le
 * serveur repondait alors « Trop de tentatives » pendant un quart d'heure — un
 * message qu'on lit comme une panne, et qui ressemble a s'y meprendre a un mot
 * de passe qui ne fonctionnerait plus. Compter les echecs seuls protege tout
 * autant d'une attaque par force brute, et n'enferme pas dehors celui qui
 * connait son mot de passe.
 */
const limiteConnexion = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives infructueuses. Reessayer dans quinze minutes.' },
});

/** Limite generale de l'API, large : un seul utilisateur. */
const limiteApi = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { entetes, limiteConnexion, limiteApi };
