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

test("une empreinte aux « $ » dedoubles est ramenee a sa forme normale", () => {
  // docker compose mange les `$` d'un env_file : on les ecrit dedoubles, et la
  // configuration les ramene. Les deux formes doivent ouvrir.
  const vraie = bcrypt.hashSync('un-mot-de-passe-de-test', 10);
  delete require.cache[require.resolve('../src/config')];
  process.env.ADMIN_PASSWORD_HASH = vraie.replace(/\$/g, '$$$$');
  const { config, validate } = require('../src/config');
  assert.equal(config.admin.passwordHash, vraie);
  assert.ok(!validate().some((f) => /bcrypt/.test(f)), 'la forme doit etre jugee valide');
});

test('une empreinte abimee fait refuser le demarrage, avec le bon motif', () => {
  delete require.cache[require.resolve('../src/config')];
  // Exactement ce que produit l'interpolation : « $2b$12$yuIjJo7x... » ampute
  // de son sel.
  process.env.ADMIN_PASSWORD_HASH = '$2b$12.AkmC0VEj0Ug7OBGVUu6lrN';
  const { validate } = require('../src/config');
  const motifs = validate().join(' ');
  assert.match(motifs, /empreinte bcrypt/);
  assert.match(motifs, /dedoubler|\$\$/i, 'le message doit dire comment corriger');
});

test("aucune reponse d'API ne doit etre mise en cache", async () => {
  // Le defaut observe en production : un /api/auth/me mis en cache par le
  // navigateur redemandait indefiniment le changement de mot de passe, alors
  // que le serveur ne le demandait plus. L'en-tete est donc verifie ici.
  process.env.SESSION_SECRET = 'x'.repeat(40);
  const app = require('../src/server');
  const { createServer } = require('node:http');
  const serveur = createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const port = serveur.address().port;
  try {
    for (const chemin of ['/api/health', '/api/auth/me']) {
      const r = await fetch(`http://127.0.0.1:${port}${chemin}`);
      assert.equal(r.headers.get('cache-control'), 'no-store', `${chemin} doit interdire le cache`);
    }
  } finally {
    serveur.close();
  }
});

test("les fichiers de l'interface sont revalides, jamais gardes en cache", async () => {
  // Une application qui se met a jour seule ne doit pas laisser un navigateur
  // servir le app.js de la version precedente : c'est ainsi qu'une interface
  // d'hier parle a un serveur d'aujourd'hui.
  const app = require('../src/server');
  const { createServer } = require('node:http');
  const serveur = createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const port = serveur.address().port;
  try {
    for (const chemin of ['/js/app.js', '/css/app.css']) {
      const r = await fetch(`http://127.0.0.1:${port}${chemin}`);
      assert.equal(r.status, 200, `${chemin} doit etre servi`);
      assert.equal(r.headers.get('cache-control'), 'no-cache', `${chemin} doit etre revalide`);
    }
  } finally {
    serveur.close();
  }
});
