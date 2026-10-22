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

test('le changement garde MA session et ferme les autres', () => {
  session('a'.repeat(64)); // la mienne
  session('b'.repeat(64));
  session('c'.repeat(64));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 3);

  const r = auth.changePassword({
    actuel: 'motdepasse-amorce',
    nouveau: 'mon-nouveau-mot-de-passe',
    sessionCourante: 'a'.repeat(64),
  });
  // Ce qui a ete ouvert avec l'ancien mot de passe ne vaut plus...
  assert.equal(r.sessionsFermees, 2);
  // ...sauf la mienne : sans cela, changer son mot de passe renvoie a l'ecran
  // de connexion, et la moindre anicroche fait tourner en rond.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('a'.repeat(64)));

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

test("l'interface ne contient plus aucun ecran bloquant", () => {
  // La lecon de la journee : un ecran qui occupe tout et ne se ferme que si un
  // drapeau du serveur retombe peut enfermer son utilisateur dehors. On verifie
  // donc que le panneau est toujours annulable, et que rien ne depend d'un
  // « obligatoire ».
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.ok(!/obligatoire/.test(js), 'plus aucune notion de panneau obligatoire');
  assert.ok(!/annuler-mdp'\)\.hidden = /.test(js), 'le bouton Annuler ne doit jamais etre masque');
  assert.ok(/bandeau-mdp/.test(js) && /bandeau-mdp/.test(html), 'un bandeau remplace l ecran');
  assert.ok(/Escape/.test(js), 'Echap doit refermer le panneau');
  // Et le changement ne renvoie plus vers l'ecran de connexion.
  assert.ok(!/location\.href = '\/login';[\s\S]{0,80}catch/.test(js), 'pas de retour force a la connexion');
});

/* ------------------------------------------------------ reprise en main */

test("on peut rendre la main au mot de passe du .env (porte de sortie)", () => {
  // LE DEFAUT QUI ENFERMAIT : l'empreinte en base l'emporte sur celle du .env.
  // Des le premier changement, reecrire ADMIN_PASSWORD_HASH, rejouer install.sh
  // ou reconstruire l'image ne changeaient plus rien — un mot de passe mal tape
  // une fois, et il n'existait plus aucun moyen d'entrer.
  assert.equal(auth.verifyPassword('mon-nouveau-mot-de-passe'), true);

  session('d'.repeat(64));
  const r = auth.oublierMotDePasse();
  assert.equal(r.source, 'env');
  // Tout ce qui etait ouvert tombe : si quelqu'un a du reprendre la main sur le
  // mot de passe, les sessions d'avant ne valent plus.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);

  assert.equal(auth.verifyPassword('mon-nouveau-mot-de-passe'), false);
  assert.equal(auth.verifyPassword('motdepasse-amorce'), true, "le .env doit reprendre la main");
  assert.equal(auth.motDePasseAChanger(), true, "l'interface doit de nouveau inviter a changer");
});

test('on peut poser un mot de passe sans connaitre l ancien, en ligne de commande', () => {
  session('e'.repeat(64));
  const r = auth.definirMotDePasse('un-mot-de-passe-repris-en-main');
  assert.equal(r.source, 'base');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);

  assert.equal(auth.verifyPassword('un-mot-de-passe-repris-en-main'), true);
  assert.equal(auth.verifyPassword('motdepasse-amorce'), false);
  // Trop court : refuse ici aussi, la ligne de commande n'est pas une derogation.
  assert.throws(() => auth.definirMotDePasse('court'), /12 caracteres/);
});

test('aucune route HTTP ne permet de poser un mot de passe sans l ancien', async () => {
  // La porte de sortie est en ligne de commande, et elle doit y rester : une
  // route qui redefinirait le mot de passe sans l'ancien serait le defaut
  // inverse de celui qu'on repare.
  const app = require('../src/server');
  const { createServer } = require('node:http');
  const serveur = createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const port = serveur.address().port;
  try {
    for (const chemin of ['/api/auth/oublier', '/api/auth/reinitialiser', '/api/auth/definir']) {
      const r = await fetch(`http://127.0.0.1:${port}${chemin}`, { method: 'POST' });
      assert.ok(r.status === 404 || r.status === 401, `${chemin} ne doit pas exister (recu ${r.status})`);
    }
  } finally {
    serveur.close();
  }
});

test('une connexion reussie ne consomme pas le quota de tentatives', () => {
  // Le quota comptait TOUTES les requetes : se reconnecter apres un changement,
  // verifier depuis le telephone, se tromper une fois, et le serveur repondait
  // « Trop de tentatives » pendant un quart d'heure — ce qu'on lit comme un mot
  // de passe qui ne marche plus.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'security.js'), 'utf8');
  assert.match(src, /skipSuccessfulRequests:\s*true/, 'seuls les echecs doivent etre comptes');
});

test('la deconnexion exige le jeton CSRF', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.match(
    src,
    /router\.post\('\/logout',\s*auth\.requireAuth,\s*auth\.csrfProtect/,
    'une page tierce ne doit pas pouvoir fermer la session'
  );
});

test('la coquille de l interface n est jamais servie sans session', async () => {
  const app = require('../src/server');
  const { createServer } = require('node:http');
  const serveur = createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const port = serveur.address().port;
  try {
    for (const chemin of ['/', '/index.html']) {
      const r = await fetch(`http://127.0.0.1:${port}${chemin}`, { redirect: 'manual' });
      assert.ok(r.status >= 300 && r.status < 400, `${chemin} doit rediriger (recu ${r.status})`);
    }
  } finally {
    serveur.close();
  }
});
