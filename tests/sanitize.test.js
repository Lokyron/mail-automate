'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeIncomingHtml, htmlToText } = require('../src/services/sanitize');

test('un message recu perd ses images et ses liens cliquables', () => {
  const html = '<p>Bonjour <img src="https://pisteur.example/p.gif"> <a href="https://x.example">ici</a></p>';
  const sortie = sanitizeIncomingHtml(html);
  assert.ok(!sortie.includes('pisteur.example'), 'aucun pixel de suivi ne doit etre charge');
  assert.ok(!/href=/.test(sortie), 'un lien d un message non sollicite ne doit pas etre suivable');
});

test('aucun script ne survit', () => {
  const sortie = sanitizeIncomingHtml('<p>a</p><script>alert(1)</script>');
  assert.ok(!sortie.includes('alert'));
});

test('htmlToText ne colle pas les blocs entre eux', () => {
  assert.equal(htmlToText('<h1>Tarifs</h1><p>180 euros</p>'), 'Tarifs\n180 euros');
});
