'use strict';
/**
 * Reglages modifiables depuis l'interface.
 *
 * La route est montee sous `/api`, donc derriere la session ET le jeton CSRF :
 * ces champs portent un mot de passe de boite mail et des clefs d'API, ils
 * n'ont pas d'autre garde a inventer que celle qui protege deja tout le reste.
 *
 * Aucune reponse de ce fichier ne contient la valeur d'un secret. Jamais, sous
 * aucune forme — pas meme « pour reafficher le champ ». Un champ de secret part
 * vide et ne se remplit que pour etre remplace.
 */
const express = require('express');
const reglages = require('../services/reglages');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', (req, res) => res.json(reglages.etat()));

/**
 * Enregistre un lot. Une chaine vide rend le reglage au `.env` : c'est le seul
 * moyen de defaire, et il doit rester a portee de main.
 */
router.put('/', asyncRoute(async (req, res) => res.json(await reglages.enregistrer(req.body?.valeurs || {}))));

module.exports = router;
