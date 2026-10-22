'use strict';
/**
 * Version et mise a jour. Lancer une mise a jour ne fait qu'ecrire un fichier
 * de demande : le travail se passe dehors, en root, dans le service executeur.
 */
const express = require('express');
const maj = require('../services/update');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncRoute(async (req, res) => res.json(await maj.rapport({ force: req.query.verifier === '1' }))));

/**
 * Changer de canal regarde aussitot ce que la branche contient : tout l'interet
 * du changement est de voir s'il y a quelque chose a essayer.
 */
router.post('/canal', asyncRoute(async (req, res) => {
  maj.choisirCanal(String(req.body?.canal || ''));
  res.json(await maj.rapport({ force: true }));
}));

router.post('/lancer', (req, res) => {
  const canal = maj.demander();
  res.json({ ok: true, canal, etat: maj.etat() });
});

module.exports = router;
