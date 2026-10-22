'use strict';
/** Libelles et regles deterministes. */
const express = require('express');
const rules = require('../services/rules');

const router = express.Router();

router.get('/', (req, res) => res.json({ regles: rules.toutes(), labels: rules.labels() }));

router.post('/', (req, res) => {
  const { champ, operateur, valeur, label } = req.body || {};
  const champsValides = ['from_email', 'subject', 'body_text', 'to_text', 'list_id'];
  const operateursValides = ['contient', 'commence', 'finit', 'egal', 'regex'];

  if (!champsValides.includes(champ)) return res.status(400).json({ error: `Champ invalide : ${champ}` });
  if (!operateursValides.includes(operateur)) return res.status(400).json({ error: `Operateur invalide : ${operateur}` });
  if (!valeur) return res.status(400).json({ error: 'Valeur attendue.' });
  if (!rules.labels().some((l) => l.nom === label)) return res.status(400).json({ error: `Libelle inconnu : ${label}` });

  const id = rules.ajouter({ ...req.body, champ });
  res.status(201).json({ id });
});

router.patch('/:id', (req, res) =>
  res.json({ ok: rules.basculer(Number(req.params.id), Boolean(req.body?.actif)) })
);

router.delete('/:id', (req, res) => res.json({ ok: rules.supprimer(Number(req.params.id)) }));

module.exports = router;
