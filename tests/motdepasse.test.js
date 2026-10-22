'use strict';
const aide = require('./aide');
aide.baseJetable();
const bcrypt = require('bcryptjs');
// Mot de passe d'amorce, celui que l'installation pose dans le .env.
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('motdepasse-amorce', 10);
process.env.SESSION_SECRET = 'x'.repeat(40);

const { test } = require('node:test');
const assert = require('node:assert');
const { db, nowIso } = require('../src/db');
const auth = require('../src/middleware/auth');

const session = (id) =>
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)')
    .run(id, nowIso(), new Date(Date.now() + 3600_000).toISOString());

test("avant tout changement, c'est le mot de passe du .env qui ouvre", () => {
  assert.equal(auth.verifyPassword('motdepasse-amorce'), true);
  assert.equal(auth.verifyPassword('autre chose'), false);
  assert.equal(auth.motDePasseAChanger(), true, "l'interface doit imposer le changement");
});

test('un mauvais mot de passe actuel ne permet pas le changement', () => {
  assert.throws(() => auth.changePassword({ actuel: 'faux', nouveau: 'unmotdepasseassezlong' }), /incorrect/);
});

test('un nouveau mot de passe trop court est refuse', () => {
  assert.throws(() => auth.changePassword({ actuel: 'motdepasse-amorce', nouveau: 'court' }), /12 caracteres/);
});

test('reprendre le meme mot de passe est refuse', () => {
  assert.throws(
    () => auth.changePassword({ actuel: 'motdepasse-amorce', nouveau: 'motdepasse-amorce' }),
    /differer/
  );
});

test('le changement remplace l amorce et ferme toutes les sessions', () => {
  session('a'.repeat(64));
  session('b'.repeat(64));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 2);

  const r = auth.changePassword({ actuel: 'motdepasse-amorce', nouveau: 'mon-nouveau-mot-de-passe' });
  assert.equal(r.sessionsFermees, 2, 'un changement qui laisse les sessions ouvertes ne protege de rien');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);

  // L'empreinte vit desormais en base : le .env n'ouvre plus.
  assert.equal(auth.verifyPassword('mon-nouveau-mot-de-passe'), true);
  assert.equal(auth.verifyPassword('motdepasse-amorce'), false, "l'ancien mot de passe ne doit plus ouvrir");
  assert.equal(auth.motDePasseAChanger(), false, "l'interface ne doit plus imposer le changement");
});

test('le changement survit a un redemarrage (il est en base, pas en memoire)', () => {
  delete require.cache[require.resolve('../src/middleware/auth')];
  const auth2 = require('../src/middleware/auth');
  assert.equal(auth2.verifyPassword('mon-nouveau-mot-de-passe'), true);
  assert.equal(auth2.motDePasseAChanger(), false);
});
