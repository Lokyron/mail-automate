'use strict';
/**
 * Reprise en main du mot de passe d'acces, depuis la machine.
 *
 * POURQUOI CE SCRIPT EXISTE. Des le premier changement, l'empreinte du mot de
 * passe vit en base et l'emporte sur celle du `.env` — il faut bien, puisque le
 * conteneur tourne en lecture seule et ne peut pas reecrire son propre `.env`.
 * Mais la consequence n'avait pas de porte de sortie : un mot de passe mal tape
 * une fois, et modifier `ADMIN_PASSWORD_HASH`, rejouer `install.sh` (qui
 * conserve un `.env` existant) ou reconstruire l'image ne changeaient plus
 * rien. Plus aucun moyen d'entrer, sur une machine pourtant a portee de main.
 *
 * Usage (en Docker) :
 *   docker compose exec app node scripts/motdepasse.js            # saisie
 *   docker compose exec app node scripts/motdepasse.js --oublier   # retour au .env
 *   echo 'mon-mot-de-passe' | docker compose exec -T app node scripts/motdepasse.js
 *
 * Sans Docker, remplacer « docker compose exec app » par « node » depuis le
 * dossier de l'application.
 *
 * Dans tous les cas TOUTES les sessions tombent : si quelqu'un a du reprendre la
 * main sur le mot de passe, ce qui etait ouvert avant ne doit plus valoir.
 */
const readline = require('readline');
const auth = require('../src/middleware/auth');
const { config } = require('../src/config');

const MINIMUM = auth.LONGUEUR_MINIMALE;

function oublier() {
  const r = auth.oublierMotDePasse();
  console.log(`\nEmpreinte en base effacee. ${r.sessionsFermees} session(s) fermee(s).`);
  console.log(
    config.admin.passwordHash
      ? "Le mot de passe en service est de nouveau celui du .env (ADMIN_PASSWORD_HASH).\n" +
          "L'interface invitera a en choisir un autre a la prochaine connexion."
      : "ATTENTION : le .env ne porte aucune empreinte (ADMIN_PASSWORD_HASH absent).\n" +
          "Plus aucun mot de passe n'ouvre. Relancer ce script en posant un mot de passe,\n" +
          'ou renseigner ADMIN_PASSWORD_HASH (npm run hash) avant de redemarrer.'
  );
}

function poser(mdp) {
  const mot = String(mdp || '').trim();
  if (mot.length < MINIMUM) {
    console.error(`Mot de passe trop court : ${MINIMUM} caracteres minimum.`);
    process.exit(1);
  }
  const r = auth.definirMotDePasse(mot);
  console.log(`\nMot de passe redefini. ${r.sessionsFermees} session(s) fermee(s).`);
  console.log(`Identifiant : ${config.admin.user}`);
}

const argument = process.argv[2];

if (argument === '--oublier' || argument === '--reinitialiser') {
  oublier();
} else if (argument) {
  // Un mot de passe passe en argument est visible dans la liste des processus :
  // la forme est acceptee parce qu'elle rend le script scriptable, mais elle est
  // signalee pour qu'on ne s'en serve pas par habitude.
  console.error('Avis : un mot de passe en argument est visible des autres processus. Preferer la saisie.');
  poser(argument);
} else if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`Nouveau mot de passe (${MINIMUM} caracteres minimum) : `, (mdp) => {
    rl.close();
    poser(mdp);
  });
} else {
  let entree = '';
  process.stdin.on('data', (c) => {
    entree += c;
  });
  process.stdin.on('end', () => poser(entree));
}
