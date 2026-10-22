'use strict';
const aide = require('./aide');
aide.baseJetable();
process.env.WRITE_ENABLED = 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const imapWrite = require('../src/services/imapWrite');
const mailer = require('../src/services/mailer');

test('en phase 0, aucune ecriture ne passe', async () => {
  const m = aide.message(db);
  const d = aide.brouillon(db, m);

  // Le refus vient du verrou, avant toute connexion : aucune de ces fonctions
  // ne doit pouvoir toucher la boite tant que WRITE_ENABLED est faux.
  await assert.rejects(() => imapWrite.poserLibelle(m, 'A repondre'), /lecture seule/);
  await assert.rejects(() => imapWrite.marquerLu(m), /lecture seule/);
  await assert.rejects(() => imapWrite.deposerBrouillon(d), /lecture seule/);
  assert.throws(() => mailer.preparerEnvoi(d), /lecture seule/);
  await assert.rejects(() => mailer.envoyer(d, 'x'), /lecture seule/);
});

test('le message compose porte les en-tetes qui le rattachent au fil', async () => {
  const m = aide.message(db, {
    message_id: '<origine@exemple.fr>',
    thread_refs: '<ancien@exemple.fr>',
  });
  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(m);
  const mime = (await imapWrite.composer(message, { objet: 'Re: test', corps: 'Bonjour' })).toString('utf8');

  // Sans In-Reply-To ni References, Gmail ouvre une conversation separee et le
  // brouillon parait surgir de nulle part.
  assert.match(mime, /In-Reply-To: <origine@exemple\.fr>/);
  assert.match(mime, /References:.*<ancien@exemple\.fr>/s);
  assert.match(mime, /References:.*<origine@exemple\.fr>/s);
  assert.match(mime, /To: Lucie <lucie@exemple\.fr>/);
});

test('corpsRetenu prefere ma version a celle du modele', () => {
  assert.equal(imapWrite.corpsRetenu({ corps: 'modele', corps_corrige: 'moi' }), 'moi');
  assert.equal(imapWrite.corpsRetenu({ corps: 'modele', corps_corrige: '   ' }), 'modele');
  assert.equal(imapWrite.corpsRetenu({ corps: 'modele', corps_corrige: null }), 'modele');
});
