'use strict';
const aide = require('./aide');
aide.baseJetable();

const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const chat = require('../src/services/chat');
const cartes = require('../src/services/bot/cartes');

test("l'agent n'a aucun outil d'envoi", () => {
  // Invariant de securite : « proposer_envoi » prepare, il n'envoie pas. Si un
  // outil d'envoi apparait un jour dans cette liste, ce test doit tomber.
  const noms = chat.OUTILS.map((o) => o.name);
  assert.ok(noms.includes('proposer_envoi'));
  for (const interdit of ['envoyer', 'envoyer_message', 'send', 'send_mail', 'poster']) {
    assert.ok(!noms.includes(interdit), `outil interdit expose : ${interdit}`);
  }
  // Et la revision est bien separee de la preparation d'envoi.
  assert.ok(noms.includes('reviser_brouillon'));
});

test('tout outil declare un schema d entree', () => {
  for (const o of chat.OUTILS) {
    assert.ok(o.input_schema?.type === 'object', `${o.name} sans schema`);
    assert.ok(o.description.length > 20, `${o.name} sans description utile`);
  }
});

test('une carte ne transporte pas le courrier par defaut', () => {
  const m = aide.message(db, { subject: 'Question sur le devis' });
  const d = aide.brouillon(db, m, { corps: 'SECRET-DU-BROUILLON' });
  void d;
  const carte = cartes.carteMessage(m);
  assert.match(carte.texte, /Question sur le devis/);
  // BOT_BODY_IN_CHAT est faux par defaut : le salon porte des decisions, pas de
  // la correspondance.
  assert.ok(!carte.texte.includes('SECRET-DU-BROUILLON'));
  assert.ok(!carte.texte.includes('devis court jusqu'));
});

test('une carte de courrier confidentiel ne montre jamais le corps', () => {
  const m = aide.message(db, { sensible: 1, body_text: 'SOLDE-BANCAIRE', subject: 'Releve' });
  const carte = cartes.carteMessage(m);
  assert.match(carte.texte, /confidentiel/i);
  assert.ok(!carte.texte.includes('SOLDE-BANCAIRE'));

  const corps = cartes.carteCorps(m);
  assert.match(corps.texte, /ne sort pas de la machine/);
  assert.ok(!corps.texte.includes('SOLDE-BANCAIRE'));

  // Et aucun bouton d'action sur le modele pour un courrier confidentiel.
  const boutons = carte.clavier.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!boutons.some((b) => b.startsWith('d:')), 'aucune redaction sur du confidentiel');
});

test('les boutons tiennent dans la limite de Telegram', () => {
  const m = aide.message(db);
  const carte = cartes.carteMessage(m);
  for (const b of carte.clavier.inline_keyboard.flat()) {
    // Telegram refuse une donnee de rappel au-dela de 64 octets.
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data} trop long`);
  }
  for (const b of cartes.clavierLibelles(1).inline_keyboard.flat()) {
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data} trop long`);
  }
});
