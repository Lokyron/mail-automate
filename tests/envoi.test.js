'use strict';
const aide = require('./aide');
aide.baseJetable();
process.env.WRITE_ENABLED = 'true';
// Aucun test ne doit sortir sur le reseau : le port 1 refuse immediatement, ce
// qui fait echouer l'envoi reel sans attendre un delai de connexion.
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'moi@exemple.fr';
process.env.SMTP_PASS = 'motdepasse-application';
process.env.MAIL_FROM_EMAIL = 'moi@exemple.fr';

const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const mailer = require('../src/services/mailer');

test('un envoi sans confirmation est refuse', async () => {
  const m = aide.message(db);
  const d = aide.brouillon(db, m);
  // C'est LE test de securite du module : sans etre passe par le
  // recapitulatif, rien ne part, meme avec le bon identifiant de brouillon.
  await assert.rejects(() => mailer.envoyer(d, 'jeton-invente'), /Confirmation absente ou expiree/);
});

test('le jeton ne sert qu une fois', async () => {
  const m = aide.message(db);
  const d = aide.brouillon(db, m);
  const prep = mailer.preparerEnvoi(d);
  assert.ok(prep.jeton);
  assert.equal(prep.recapitulatif.destinataire, 'lucie@exemple.fr');

  // Premiere tentative : le jeton est consomme avant meme l'appel SMTP, donc
  // l'envoi echoue ici sur le reseau — mais le jeton est bien depense.
  await mailer.envoyer(d, prep.jeton).catch(() => {});
  await assert.rejects(() => mailer.envoyer(d, prep.jeton), /Confirmation absente ou expiree/);
});

test('un jeton ne vaut que pour son brouillon', async () => {
  const m1 = aide.message(db);
  const d1 = aide.brouillon(db, m1);
  const m2 = aide.message(db);
  const d2 = aide.brouillon(db, m2);
  const prep = mailer.preparerEnvoi(d1);
  await assert.rejects(() => mailer.envoyer(d2, prep.jeton), /ne porte pas sur ce brouillon/);
});

test('un texte modifie apres la confirmation invalide la confirmation', async () => {
  const m = aide.message(db);
  const d = aide.brouillon(db, m);
  const prep = mailer.preparerEnvoi(d);
  // Quelqu un (ou quelque chose) reecrit le brouillon entre l'affichage du
  // recapitulatif et le clic : ce n'est plus ce que j'ai relu.
  db.prepare('UPDATE drafts SET corps_corrige = ? WHERE id = ?').run('Autre texte', d);
  await assert.rejects(() => mailer.envoyer(d, prep.jeton), /a change depuis la confirmation/);
});

test('le courrier confidentiel ne se prepare pas', () => {
  const m = aide.message(db, { sensible: 1, from_email: 'alerte@mabanque.fr' });
  const d = aide.brouillon(db, m);
  assert.throws(() => mailer.preparerEnvoi(d), /confidentiel/);
});

test('un brouillon deja envoye ne repart pas', () => {
  const m = aide.message(db);
  const d = aide.brouillon(db, m, { sent_at: '2026-10-20T10:00:00.000Z' });
  assert.throws(() => mailer.preparerEnvoi(d), /deja ete envoye/);
});
