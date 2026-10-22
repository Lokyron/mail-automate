'use strict';
/**
 * Le tri, sur ce qu'il avait de casse : l'en-tete List-Id.
 *
 * La regle livree « list_id contient @ » doit reconnaitre une DIFFUSION. Elle
 * lisait a defaut l'en-tete References, faute de colonne — et les References
 * d'une reponse contiennent les identifiants des messages precedents, tous
 * porteurs d'un « @ ». Autrement dit, toute reponse dans un fil etait rangee en
 * « Infolettres » par la premiere regle, sans jamais atteindre le modele.
 */
const aide = require('./aide');
aide.baseJetable();

const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const rules = require('../src/services/rules');

test('la colonne list_id existe', () => {
  const colonnes = db.prepare('PRAGMA table_info(inbox_messages)').all().map((c) => c.name);
  assert.ok(colonnes.includes('list_id'), 'le releve doit avoir ou ranger l en-tete List-Id');
});

test('une reponse dans un fil n est PAS prise pour une infolettre', () => {
  const reponse = {
    from_email: 'lucie@exemple.fr',
    subject: 'Le point sur le devis',
    // Ce que porte une reponse : les identifiants des messages precedents.
    thread_refs: '<abc123@mail.gmail.com> <def456@exemple.fr>',
    list_id: '',
  };
  const r = rules.evaluer(reponse);
  assert.notEqual(r?.label, 'Infolettres', 'les References ne sont pas un List-Id');
  assert.equal(r, null, 'un echange ordinaire doit partir au modele');
});

test('une vraie diffusion est reconnue a son List-Id', () => {
  const infolettre = {
    from_email: 'news@unservice.com',
    subject: 'Les nouveautes du mois',
    thread_refs: '',
    list_id: 'Nouveautes <news.unservice.com>',
  };
  const r = rules.evaluer(infolettre);
  assert.equal(r?.label, 'Infolettres');
  assert.equal(r.source, 'regle');
});

test("un objet « Re: » reste reconnu comme a repondre", () => {
  // La regle qui suivait celle du List-Id ne recevait plus jamais la main : on
  // verifie qu'elle tranche desormais.
  const r = rules.evaluer({
    from_email: 'lucie@exemple.fr',
    subject: 'Re: ton devis',
    thread_refs: '<abc123@mail.gmail.com>',
    list_id: '',
  });
  assert.equal(r?.label, 'A repondre');
  assert.equal(r.repondre, 1);
});

test('le releve sait enregistrer un List-Id', () => {
  const id = aide.message(db, { list_id: 'Nouveautes <news.unservice.com>' });
  const ligne = db.prepare('SELECT list_id FROM inbox_messages WHERE id = ?').get(id);
  assert.equal(ligne.list_id, 'Nouveautes <news.unservice.com>');
});
