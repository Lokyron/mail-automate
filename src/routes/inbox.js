'use strict';
/** Boite de reception : consultation, tri, brouillons, verdicts. */
const express = require('express');
const { db } = require('../db');
const imap = require('../services/imap');
const classifier = require('../services/classifier');
const drafter = require('../services/drafter');
const imapWrite = require('../services/imapWrite');
const mailer = require('../services/mailer');
const { ecritureAutorisee } = require('../services/guard');

const router = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Liste des messages, avec leur derniere proposition de tri.
 * Le corps n'est pas renvoye ici : la liste doit rester legere.
 */
router.get('/', (req, res) => {
  const { label, statut, repondre, attente, limit = 100, offset = 0 } = req.query;
  const where = [];
  const params = {};

  if (label) {
    where.push('t.label = @label');
    params.label = label;
  }
  if (statut) {
    where.push('m.status = @statut');
    params.statut = statut;
  }
  if (repondre === '1') where.push('t.repondre = 1');
  // « attente » : ce qui n'a pas encore ete juge. C'est la vue de travail.
  if (attente === '1') where.push('(t.id IS NULL OR t.verdict IS NULL)');

  const lignes = db
    .prepare(
      `SELECT m.id, m.from_name, m.from_email, m.subject, m.snippet, m.received_at,
              m.attachments, m.truncated, m.status, m.sensible,
              t.id AS triage_id, t.label, t.priorite, t.repondre, t.resume,
              t.confiance, t.motif, t.source, t.verdict, t.label_corrige, t.applied_at,
              d.id AS draft_id, d.verdict AS draft_verdict, d.confiance AS draft_confiance
         FROM inbox_messages m
    LEFT JOIN triages t ON t.id = (SELECT id FROM triages WHERE message_id = m.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN drafts  d ON d.id = (SELECT id FROM drafts  WHERE message_id = m.id ORDER BY id DESC LIMIT 1)
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.received_at DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: Math.min(Number(limit) || 100, 300), offset: Number(offset) || 0 });

  res.json({ messages: lignes, ecritureAutorisee: ecritureAutorisee() });
});

/** Tableau de bord : les mesures qui disent si la phase 1 peut s'ouvrir. */
router.get('/stats', (req, res) => {
  const parLabel = db
    .prepare(
      `SELECT t.label, COUNT(*) AS n
         FROM triages t
        WHERE t.id = (SELECT id FROM triages WHERE message_id = t.message_id ORDER BY id DESC LIMIT 1)
        GROUP BY t.label ORDER BY n DESC`
    )
    .all();
  res.json({
    tri: classifier.justesse(),
    brouillons: drafter.qualite(),
    parLabel,
    imap: imap.status(),
    ecritureAutorisee: ecritureAutorisee(),
  });
});

router.post('/sync', asyncRoute(async (req, res) => res.json(await imap.syncNow())));

router.post('/brouillons/en-attente', asyncRoute(async (req, res) =>
  res.json(await drafter.redigerEnAttente({ limit: Math.min(Number(req.body?.limit) || 10, 50) }))
));

/** Un message et tout ce qui s'y rattache. */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(id);
  if (!message) return res.status(404).json({ error: 'Message inconnu.' });

  res.json({
    message,
    pieces: db.prepare('SELECT * FROM inbox_attachments WHERE message_id = ?').all(id),
    triages: db.prepare('SELECT * FROM triages WHERE message_id = ? ORDER BY id DESC').all(id),
    brouillon: drafter.pourMessage(id) || null,
  });
});

router.post('/:id/classer', asyncRoute(async (req, res) =>
  res.json(await classifier.classer(Number(req.params.id), { force: true }))
));

router.post('/:id/brouillon', asyncRoute(async (req, res) =>
  res.json(await drafter.rediger(Number(req.params.id), { force: Boolean(req.body?.force) }))
));

/** Verdict sur une proposition de tri : c'est ce qui fait progresser le tri. */
router.post('/triages/:id/verdict', (req, res) =>
  res.json(
    classifier.verdict(Number(req.params.id), {
      verdict: req.body?.verdict,
      labelCorrige: req.body?.labelCorrige,
    })
  )
);

router.post('/drafts/:id/verdict', (req, res) =>
  res.json(
    drafter.verdict(Number(req.params.id), {
      verdict: req.body?.verdict,
      corpsCorrige: req.body?.corpsCorrige,
    })
  )
);

/* -------------------------------------------------------------------------- */
/*  Phase 1 : ecriture dans la boite                                          */
/*                                                                            */
/*  Chaque route ci-dessous echoue en 409 tant que WRITE_ENABLED est faux : le */
/*  refus vient du verrou, pas d'un test fait ici.                            */
/* -------------------------------------------------------------------------- */

/** Pose le libelle propose. `archiver` retire le message de la boite. */
router.post('/:id/libelle', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const triage = db.prepare('SELECT * FROM triages WHERE message_id = ? ORDER BY id DESC LIMIT 1').get(id);
  const label = req.body?.label || triage?.label;
  if (!label) return res.status(400).json({ error: 'Aucun libelle a poser.' });
  res.json(await imapWrite.poserLibelle(id, label, { archiver: Boolean(req.body?.archiver) }));
}));

router.post('/:id/lu', asyncRoute(async (req, res) => res.json(await imapWrite.marquerLu(Number(req.params.id)))));

/** Depose le brouillon dans [Gmail]/Brouillons. */
router.post('/drafts/:id/deposer', asyncRoute(async (req, res) =>
  res.json(await imapWrite.deposerBrouillon(Number(req.params.id)))
));

/**
 * Premiere etape de l'envoi : le recapitulatif et le jeton. N'envoie rien.
 * L'interface DOIT afficher ce recapitulatif avant de pouvoir envoyer.
 */
router.post('/drafts/:id/preparer-envoi', (req, res) =>
  res.json(mailer.preparerEnvoi(Number(req.params.id)))
);

/** Seconde etape : l'envoi, contre le jeton. */
router.post('/drafts/:id/envoyer', asyncRoute(async (req, res) =>
  res.json(await mailer.envoyer(Number(req.params.id), req.body?.jeton))
));

module.exports = router;
