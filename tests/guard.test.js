'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-agent-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.WRITE_ENABLED = 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const guard = require('../src/services/guard');

test('le verrou refuse toute ecriture en phase 0', () => {
  assert.equal(guard.ecritureAutorisee(), false);
  assert.throws(() => guard.exigerEcriture('poser un libelle'), /lecture seule/);
  assert.throws(() => guard.exigerEcriture('deposer un brouillon'), guard.EcritureInterdite);
});

test('le refus porte le geste refuse, pour que le journal soit lisible', () => {
  try {
    guard.exigerEcriture('marquer lu');
    assert.fail('aurait du lever');
  } catch (e) {
    assert.equal(e.geste, 'marquer lu');
    assert.equal(e.status, 409);
  }
});
