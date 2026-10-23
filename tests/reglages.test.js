'use strict';
/**
 * Les reglages modifiables depuis l'interface.
 *
 * Trois invariants, et le premier compte plus que les deux autres : un mot de
 * passe d'application Google ouvre une boite mail entiere, une clef d'API ouvre
 * un compte facture. Ils entrent, ils ne ressortent pas.
 */
const aide = require('./aide');
aide.baseJetable();
process.env.SESSION_SECRET = 'y'.repeat(48);
// Valeurs d'amorce, comme si elles venaient du .env.
process.env.IMAP_USER = 'amorce@exemple.fr';
process.env.IMAP_PASS = 'mot-de-passe-du-env';
process.env.CLAUDE_API_KEY = 'clef-du-env';
process.env.LLM_DAILY_CALL_LIMIT = '400';

const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../src/config');
const reglages = require('../src/services/reglages');
const coffre = require('../src/services/reglages/coffre');

reglages.appliquer();

test('sans rien en base, c’est le .env qui est en service', () => {
  assert.equal(config.imap.user, 'amorce@exemple.fr');
  const etat = reglages.etat();
  const user = etat.reglages.find((r) => r.cle === 'IMAP_USER');
  assert.equal(user.source, 'env');
  assert.equal(user.valeur, 'amorce@exemple.fr');
});

test('ce qui est posé ici l’emporte, et s’applique à chaud', async () => {
  await reglages.enregistrer({ IMAP_USER: 'pose@exemple.fr', LLM_DAILY_CALL_LIMIT: '42' });
  // `config` est le point de verite partage : tous les modules le lisent.
  assert.equal(config.imap.user, 'pose@exemple.fr');
  assert.equal(config.llm.dailyCallLimit, 42, 'un nombre doit arriver en nombre, pas en chaine');

  const user = reglages.etat().reglages.find((r) => r.cle === 'IMAP_USER');
  assert.equal(user.source, 'base', 'l’interface doit dire d’où vient la valeur');
});

test('vider un réglage rend la main au .env', async () => {
  await reglages.enregistrer({ IMAP_USER: '' });
  assert.equal(config.imap.user, 'amorce@exemple.fr');
  assert.equal(reglages.etat().reglages.find((r) => r.cle === 'IMAP_USER').source, 'env');
});

test('UN SECRET NE RESSORT JAMAIS', async () => {
  await reglages.enregistrer({ IMAP_PASS: 'mot-de-passe-tout-neuf' });
  assert.equal(config.imap.pass, 'mot-de-passe-tout-neuf', 'il doit bien être en service');

  // Ni dans l'etat complet, sous aucune forme.
  const serialise = JSON.stringify(reglages.etat());
  assert.ok(!serialise.includes('mot-de-passe-tout-neuf'), 'le secret ne doit apparaitre dans aucune reponse');
  assert.ok(!serialise.includes('mot-de-passe-du-env'), 'l’amorce non plus');
  assert.ok(!serialise.includes('clef-du-env'), 'ni la clef d’API');

  // Ce qu'on montre : qu'il existe, et de quoi le reconnaitre.
  const champ = reglages.etat().reglages.find((r) => r.cle === 'IMAP_PASS');
  assert.equal(champ.valeur, null);
  assert.equal(champ.renseigne, true);
  assert.equal(champ.apercu, '••••neuf');
});

test('un secret est chiffré en base, pas rangé en clair', () => {
  const { db } = require('../src/db');
  const ligne = db.prepare('SELECT valeur, secret FROM settings WHERE cle = ?').get('IMAP_PASS');
  assert.equal(ligne.secret, 1);
  assert.ok(!ligne.valeur.includes('mot-de-passe-tout-neuf'), 'le clair ne doit pas etre en base');
  assert.equal(coffre.dechiffrer(ligne.valeur), 'mot-de-passe-tout-neuf', 'et doit se relire');
});

test('un secret illisible n’empêche pas l’application de tourner', () => {
  const { db, nowIso } = require('../src/db');
  // Exactement ce que produit un changement de SESSION_SECRET.
  db.prepare('UPDATE settings SET valeur = ? WHERE cle = ?').run('abimé.abimé.abimé', 'IMAP_PASS');
  assert.doesNotThrow(() => coffre.lire('IMAP_PASS'));
  assert.equal(coffre.lire('IMAP_PASS'), null, 'illisible se lit comme absent');
  // ...et le .env reprend la main plutot que de tout bloquer.
  reglages.appliquer();
  assert.equal(config.imap.pass, 'mot-de-passe-du-env');
  db.prepare('DELETE FROM settings WHERE cle = ?').run('IMAP_PASS');
  void nowIso;
});

test('une valeur invalide est refusée, et RIEN n’est écrit', async () => {
  const avant = config.llm.dailyCallLimit;
  await assert.rejects(
    () => reglages.enregistrer({ LLM_DAILY_CALL_LIMIT: '-5', IMAP_MAILBOX: 'INBOX' }),
    /nombre entre/
  );
  assert.equal(config.llm.dailyCallLimit, avant, 'le lot entier doit etre refuse');
  // Le reglage valide du meme lot ne doit pas etre passe non plus : un
  // formulaire a moitie applique laisse un etat que personne n'a voulu.
  assert.equal(reglages.etat().reglages.find((r) => r.cle === 'IMAP_MAILBOX').source, 'env');
});

test('une clef inconnue est refusée', async () => {
  await assert.rejects(() => reglages.enregistrer({ RM_RF: 'slash' }), /inconnu/);
});

test('les réglages dangereux ne sont PAS modifiables ici', () => {
  const modifiables = new Set(reglages.etat().reglages.map((r) => r.cle));
  for (const interdit of [
    'WRITE_ENABLED',      // le verrou d'ecriture est une decision, pas un clic
    'SESSION_SECRET',     // il chiffre les secrets et signe les sessions
    'ADMIN_PASSWORD_HASH',
    'ADMIN_USER',
    'DB_PATH',
    'TRUSTED_PROXIES',
    'UPDATE_REPO',        // diriger la mise a jour ailleurs depuis le web
    'UPDATE_BRANCH',
    'HOST',
    'PORT',
  ]) {
    assert.ok(!modifiables.has(interdit), `${interdit} ne doit pas etre reglable depuis l'interface`);
  }
  // ...mais le verrou d'ecriture est MONTRE, avec la raison.
  const montres = reglages.etat().lectureSeule.map((x) => x.libelle).join(' ');
  assert.match(montres, /criture dans la bo/, 'la phase doit rester visible');
});

test('l’envoi reprend les identifiants de la boîte quand il n’a pas les siens', async () => {
  // `config.js` fait ce repli au demarrage, a partir du .env. Une fois les
  // valeurs modifiables a chaud, il doit etre rejoue : sans cela, renseigner la
  // boite depuis l'interface laissait l'envoi avec l'ancien compte.
  await reglages.enregistrer({ IMAP_USER: 'nouvelle@exemple.fr', SMTP_USER: '', SMTP_PASS: '' });
  assert.equal(config.smtp.user, 'nouvelle@exemple.fr');
  assert.equal(config.smtp.pass, config.imap.pass);
});

test('une interface de réglages ne doit jamais pouvoir se condamner elle-même', async () => {
  // Le piège que cette fonctionnalité introduisait : activer la relève puis
  // vider le mot de passe — deux clics dans la page — et `validate()` refusait
  // le redémarrage. L'application devenait injoignable, donc impossible à
  // corriger par la page même qui sert à cela.
  const { validate, avertissements } = require('../src/config');
  await reglages.enregistrer({ IMAP_ENABLED: 'true', IMAP_PASS: '', IMAP_USER: '' });

  // On ne regarde QUE les motifs de service : ce fichier ne pose pas
  // d'ADMIN_PASSWORD_HASH, et celui-la doit rester fatal.
  const bloquants = validate().filter((f) => /IMAP|SMTP|TELEGRAM|BOT_/.test(f));
  assert.deepEqual(bloquants, [], 'un reglage de service incomplet ne doit PAS bloquer le demarrage');
  // Et l'incomplet doit etre DIT, la ou il se corrige. (Vider un champ rend la
  // main au .env, qui est renseigne dans ce fixture : on met donc la valeur
  // effective a vide pour eprouver le contrat de `avertissements()`.)
  const garde = config.imap.pass;
  config.imap.pass = '';
  try {
    assert.ok(
      avertissements().some((a) => a.service === 'Boîte mail' && /manque/.test(a.message)),
      'un service incomplet doit dire pourquoi il ne tourne pas'
    );
    // Et l'onglet Parametres les porte.
    assert.ok(reglages.etat().avertissements.length, 'l’interface doit les montrer');
  } finally {
    config.imap.pass = garde;
  }
});

test('un salon sans liste blanche ne démarre pas, mais ne bloque rien', async () => {
  const { validate } = require('../src/config');
  await reglages.enregistrer({ BOT_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'jeton-de-test', TELEGRAM_CHAT_ID: '' });
  // La garde de securite tient : un bot sans liste blanche serait une porte
  // ouverte sur une boite mail. Elle a seulement change d'endroit.
  assert.deepEqual(
    validate().filter((f) => /TELEGRAM|BOT_/.test(f)),
    [],
    'le processus ne doit plus mourir pour cela'
  );
  const bot = require('../src/services/bot');
  assert.equal(bot.status().actif, false, 'le salon ne doit pas tourner sans liste blanche');
  await reglages.enregistrer({ BOT_ENABLED: 'false' });
});
