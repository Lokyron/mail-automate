'use strict';
/**
 * Produit le hash bcrypt a coller dans ADMIN_PASSWORD_HASH.
 *
 * Deux usages :
 *   npm run hash                      (interactif, le mot de passe est demande)
 *   echo 'motdepasse' | npm run hash  (canalise, pour le script d'installation)
 *
 * Le second est indispensable : `install.sh` doit pouvoir hacher sans ouvrir de
 * dialogue dans le conteneur.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');

const MINIMUM = 12;

function produire(mdp) {
  const mot = String(mdp || '').trim();
  if (mot.length < MINIMUM) {
    console.error(`Mot de passe trop court : ${MINIMUM} caracteres minimum.`);
    process.exit(1);
  }
  // Sortie seule et sans decor quand l'entree est canalisee : le script
  // appelant peut la reprendre telle quelle.
  const hash = bcrypt.hashSync(mot, 12);
  if (process.stdin.isTTY) console.log(`\nADMIN_PASSWORD_HASH=${hash}`);
  else console.log(hash);
}

if (process.argv[2]) {
  produire(process.argv[2]);
} else if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Mot de passe : ', (mdp) => {
    rl.close();
    produire(mdp);
  });
} else {
  let entree = '';
  process.stdin.on('data', (c) => {
    entree += c;
  });
  process.stdin.on('end', () => produire(entree));
}
