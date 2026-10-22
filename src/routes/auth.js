'use strict';
const express = require('express');
const { config } = require('../config');
const auth = require('../middleware/auth');
const { limiteConnexion } = require('../middleware/security');
const log = require('../utils/logger');

const router = express.Router();

router.post('/login', limiteConnexion, (req, res) => {
  const { user, password } = req.body || {};
  if (String(user || '') !== config.admin.user || !auth.verifyPassword(password)) {
    log.warn(`Connexion refusee pour « ${String(user || '').slice(0, 60)} » depuis ${req.ip}.`);
    return res.status(401).json({ error: 'Identifiants invalides.' });
  }
  const { csrf } = auth.createSession(req, res);
  log.info(`Connexion acceptee depuis ${req.ip}.`);
  res.json({ ok: true, csrf });
});

/**
 * Deconnexion. Protegee par le jeton CSRF comme toute methode mutante : sans
 * cela, une page tierce ouverte dans le meme navigateur pouvait fermer la
 * session a distance. Une session deja expiree repond 401, et l'interface sait
 * deja quoi faire d'un 401 — elle va a l'ecran de connexion, qui est la ou on
 * voulait aller.
 */
router.post('/logout', auth.requireAuth, auth.csrfProtect, (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const s = auth.currentSession(req);
  if (!s) return res.status(401).json({ error: 'Non authentifie' });
  res.json({
    user: config.admin.user,
    csrf: auth.csrfFor(s.id),
    expiresAt: s.expires_at,
    // Tant que le mot de passe d'amorce n'a pas ete remplace, l'interface
    // impose d'en choisir un autre avant de laisser faire quoi que ce soit.
    doitChanger: auth.motDePasseAChanger(),
    longueurMinimale: auth.LONGUEUR_MINIMALE,
  });
});

/**
 * Changement de mot de passe. Les autres sessions tombent, celle-ci reste :
 * on ne renvoie pas quelqu'un vers l'ecran de connexion juste apres lui avoir
 * fait choisir un mot de passe.
 */
router.post('/motdepasse', auth.requireAuth, auth.csrfProtect, (req, res) => {
  res.json(
    auth.changePassword({
      actuel: req.body?.actuel,
      nouveau: req.body?.nouveau,
      sessionCourante: req.session.id,
    })
  );
});

module.exports = router;
