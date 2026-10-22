'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// Base jetable : les tests ne doivent jamais toucher la base de travail.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-agent-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SENSITIVE_SENDERS = '*@mabanque.fr,*@*credit*,contact@ameli.fr';
process.env.SENSITIVE_SUBJECTS = 'releve de compte,rib';

const { test } = require('node:test');
const assert = require('node:assert');
const rules = require('../src/services/rules');

test('correspond : chaque operateur fait ce qu il annonce', () => {
  assert.equal(rules.correspond('Facture Janvier', 'contient', 'facture'), true);
  assert.equal(rules.correspond('noreply@github.com', 'commence', 'noreply'), true);
  assert.equal(rules.correspond('bob@github.com', 'finit', '@github.com'), true);
  assert.equal(rules.correspond('A repondre', 'egal', 'a repondre'), true);
  assert.equal(rules.correspond('Re: devis', 'regex', '^(re|tr)\\s*:'), true);
  assert.equal(rules.correspond('devis', 'regex', '^(re|tr)\\s*:'), false);
});

test('correspond : une regex invalide est ignoree, pas propagee', () => {
  // Une expression fautive saisie dans l'interface ne doit pas faire tomber le
  // tri de toute la boite.
  assert.doesNotThrow(() => rules.correspond('test', 'regex', '('));
  assert.equal(rules.correspond('test', 'regex', '('), false);
});

test('correspondJoker : le joker couvre les sous-domaines', () => {
  assert.equal(rules.correspondJoker('service@mabanque.fr', '*@mabanque.fr'), true);
  assert.equal(rules.correspondJoker('info@ma-credit-agricole.com', '*@*credit*'), true);
  assert.equal(rules.correspondJoker('bob@example.com', '*@mabanque.fr'), false);
});

test('estSensible : expediteur ou objet suffit', () => {
  assert.equal(rules.estSensible({ from_email: 'alerte@mabanque.fr', subject: 'Bonjour' }), true);
  assert.equal(rules.estSensible({ from_email: 'bob@example.com', subject: 'Votre releve de compte' }), true);
  assert.equal(rules.estSensible({ from_email: 'bob@example.com', subject: 'Dejeuner jeudi ?' }), false);
});

test('evaluer : les regles livrees rangent le courrier automatique', () => {
  const notif = rules.evaluer({ from_email: 'noreply@service.com', subject: 'Votre commande' });
  assert.equal(notif.label, 'Notifications');
  assert.equal(notif.source, 'regle');

  const suite = rules.evaluer({ from_email: 'lucie@example.com', subject: 'Re: ton devis' });
  assert.equal(suite.label, 'A repondre');
  assert.equal(suite.repondre, 1);

  const inconnu = rules.evaluer({ from_email: 'lucie@example.com', subject: 'Dejeuner jeudi ?' });
  assert.equal(inconnu, null, 'un message ordinaire doit partir au modele');
});
