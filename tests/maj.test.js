'use strict';
const aide = require('./aide');
const dossier = aide.baseJetable();
process.env.UPDATE_ENABLED = 'true';
process.env.UPDATE_REPO = 'Lokyron/mail-automate';
process.env.UPDATE_BRANCH = 'main';
process.env.UPDATE_BETA_BRANCH = 'beta';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const maj = require('../src/services/update');

test('les deux canaux sont offerts, stable en premier', () => {
  const c = maj.canaux();
  assert.deepEqual(c.map((x) => x.id), ['stable', 'beta']);
  assert.equal(maj.brancheDe('stable'), 'main');
  assert.equal(maj.brancheDe('beta'), 'beta');
  assert.equal(maj.canalCourant(), 'stable', 'stable par defaut');
});

test('un canal inconnu est refuse', () => {
  assert.throws(() => maj.choisirCanal('production'), /Canal inconnu/);
  assert.throws(() => maj.choisirCanal('../../etc'), /Canal inconnu/);
  assert.equal(maj.canalCourant(), 'stable', 'le canal courant n a pas bouge');
});

test('la demande ne porte QUE le nom du canal, jamais une branche', () => {
  maj.choisirCanal('beta');
  const canal = maj.demander();
  assert.equal(canal, 'beta');

  const demande = fs.readFileSync(maj.FICHIER_DEMANDE, 'utf8');
  assert.match(demande, /^channel=beta$/m);
  // C'EST LE TEST DE SECURITE : si un nom de branche, un chemin ou une
  // reference arbitraire entrait dans ce fichier, le cote non privilegie
  // pourrait diriger l'executeur root ou il veut.
  assert.ok(!/branch|refs\/|http|\.\.|\//i.test(demande), `le fichier de demande en dit trop : ${demande}`);
  assert.deepEqual(
    demande.trim().split('\n').map((l) => l.split('=')[0]).sort(),
    ['at', 'channel']
  );
});

test("l'etat passe a « running » des la demande", () => {
  assert.equal(maj.etat().state, 'running');
  // Et une seconde demande est refusee tant que la premiere tourne : deux
  // executeurs en parallele sur le meme dossier, c'est la panne assuree.
  assert.throws(() => maj.demander(), /deja en cours/);
});

test("l'executeur n'accepte que des noms de canal inoffensifs", () => {
  // L'expression est extraite du script lui-meme : si elle y change, ce test
  // suit, au lieu de verifier une copie perimee.
  const script = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'inbox-agent-update.sh'), 'utf8');
  const ligne = script.split('\n').find((l) => l.includes("sed -n 's/^channel="));
  assert.ok(ligne, 'ligne d extraction du canal introuvable dans l executeur');
  const expression = ligne.match(/sed -n '([^']+)'/)[1];

  const extraire = (contenu) => {
    const f = path.join(dossier, 'demande');
    fs.writeFileSync(f, contenu);
    return execFileSync('sed', ['-n', expression, f], { encoding: 'utf8' }).split('\n')[0];
  };

  assert.equal(extraire('channel=beta\n'), 'beta');
  assert.equal(extraire('channel=stable\n'), 'stable');
  // Tout le reste ne ressort pas : l'executeur retombera sur stable.
  for (const hostile of [
    'channel=../../etc/passwd\n',
    'channel=main;rm -rf /\n',
    'channel=$(whoami)\n',
    'channel=refs/heads/main\n',
    'channel=BETA\n',
    'channel=beta extra\n',
    'channel=unnomdecanalbeaucouptroplong\n',
    'branch=main\nchannel=beta ; echo pwn\n',
  ]) {
    assert.equal(extraire(hostile), '', `accepte a tort : ${JSON.stringify(hostile)}`);
  }
});

test('la version installee est lue dans le dossier de donnees', () => {
  const data = path.dirname(process.env.DB_PATH);
  fs.writeFileSync(
    path.join(data, 'VERSION'),
    JSON.stringify({ commit: 'a'.repeat(40), branch: 'beta', channel: 'beta', installedAt: '2026-10-21T00:00:00Z' })
  );
  const v = maj.versionInstallee();
  assert.equal(v.commit, 'a'.repeat(40));
  assert.equal(v.canal, 'beta');
  assert.equal(v.version, require('../package.json').version);
});
