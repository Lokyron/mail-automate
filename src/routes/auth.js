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

router.post('/logout', (req, res) => {
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

/** Changement de mot de passe. Toutes les sessions tombent ensuite. */
router.post('/motdepasse', auth.requireAuth, auth.csrfProtect, (req, res) => {
  const r = auth.changePassword({ actuel: req.body?.actuel, nouveau: req.body?.nouveau });
  auth.destroySession(req, res);
  res.json(r);
});

module.exports = router;
