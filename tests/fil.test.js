'use strict';
/**
 * L'historique rejoue a l'API doit TOUJOURS etre recevable.
 *
 * Les tours sont enregistres un par un, et une seule question qui fait
 * travailler l'agent en ecrit quatre ou cinq. La fenetre coupait donc au milieu
 * d'une boucle d'outils, et l'API refuse net : un `tool_result` sans son
 * `tool_use`, un `tool_use` sans son `tool_result`, ou deux tours de meme role
 * a la suite. Apres quelques questions, l'agent ne repondait plus — ni dans
 * l'interface, ni dans le salon — avec une erreur 400 que rien ne rattachait a
 * l'historique.
 */
const aide = require('./aide');
aide.baseJetable();

const { test } = require('node:test');
const assert = require('node:assert');
const { assainir } = require('../src/services/chat');

const question = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] });
const appel = (id, nom) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: nom, input: {} }] });
const resultat = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '{}' }] });
const reponse = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

/** Les trois regles de l'API, verifiees sur le resultat. */
function recevable(tours) {
  const vus = new Set();
  for (const t of tours) for (const b of t.content) if (b.type === 'tool_use') vus.add(b.id);

  for (const [i, t] of tours.entries()) {
    for (const b of t.content) {
      if (b.type === 'tool_result') assert.ok(vus.has(b.tool_use_id), `tool_result orphelin au tour ${i}`);
    }
    if (i > 0) assert.notEqual(t.role, tours[i - 1].role, `deux tours « ${t.role} » de suite au tour ${i}`);
  }
  const rendus = new Set();
  for (const t of tours) for (const b of t.content) if (b.type === 'tool_result') rendus.add(b.tool_use_id);
  for (const id of vus) assert.ok(rendus.has(id), `appel d outil ${id} sans resultat`);

  if (tours.length) assert.equal(tours[tours.length - 1].role, 'assistant', 'doit finir sur l assistant');
  return tours;
}

test('un echange complet passe tel quel', () => {
  const tours = [question('salut'), appel('t1', 'etat_boite'), resultat('t1'), reponse('voila')];
  const gardes = assainir(tours);
  assert.equal(gardes.length, 4);
  recevable(gardes);
});

test('une fenetre qui commence sur un resultat d outil est recoupee', () => {
  // Le cas reel : le `tool_use` est tombe hors de la fenetre, son resultat non.
  const tours = [resultat('perdu'), reponse('je disais donc'), question('et apres ?'), appel('t2', 'etat_boite'), resultat('t2'), reponse('ok')];
  const gardes = assainir(tours);
  assert.equal(gardes[0].content[0].text, 'et apres ?', 'doit commencer a une vraie question');
  recevable(gardes);
});

test('un appel d outil dont le resultat manque est coupe', () => {
  const tours = [question('cherche'), appel('t3', 'chercher_messages')];
  const gardes = assainir(tours);
  recevable(gardes);
  assert.equal(gardes.length, 0, 'une question seule sans reponse ne sert a rien');
});

test('la fenetre finit toujours sur l assistant', () => {
  const tours = [question('cherche'), appel('t4', 'chercher_messages'), resultat('t4')];
  const gardes = assainir(tours);
  recevable(gardes);
});

test('un historique sans aucune vraie question donne une fenetre vide', () => {
  assert.deepEqual(assainir([resultat('x'), reponse('texte')]), []);
  assert.deepEqual(assainir([]), []);
});

test('toutes les coupes possibles d un long fil restent recevables', () => {
  // Preuve par epuisement : quelle que soit la facon dont la fenetre tombe, ce
  // qui part a l'API respecte les trois regles.
  const complet = [
    question('un'), appel('a1', 'chercher_messages'), resultat('a1'), reponse('r1'),
    question('deux'), appel('a2', 'lire_message'), resultat('a2'), appel('a3', 'lire_brouillon'), resultat('a3'), reponse('r2'),
    question('trois'), appel('a4', 'etat_boite'), resultat('a4'), reponse('r3'),
  ];
  for (let i = 0; i < complet.length; i += 1) {
    recevable(assainir(complet.slice(i)));
  }
});
