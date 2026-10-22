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
  res.json({ user: config.admin.user, csrf: auth.csrfFor(s.id), expiresAt: s.expires_at });
});

module.exports = router;
