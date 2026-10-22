'use strict';
/**
 * Serveur Inbox Agent.
 *
 * Par defaut il n'ecoute que sur 127.0.0.1 : l'acces se fait par un reverse
 * proxy (Caddy ou nginx) qui porte le TLS. Une application qui detient les
 * identifiants d'une boite mail personnelle n'a rien a faire sur 0.0.0.0.
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { config, validate } = require('./config');
const log = require('./utils/logger');
const auth = require('./middleware/auth');
const { entetes, limiteApi } = require('./middleware/security');
const imap = require('./services/imap');
const bot = require('./services/bot');
const mailer = require('./services/mailer');
const { ecritureAutorisee } = require('./services/guard');

const fatals = validate();
if (fatals.length) {
  for (const f of fatals) log.error(`Configuration : ${f}`);
  log.error('Demarrage interrompu. Corriger le fichier .env (voir .env.example).');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (config.trustedProxies.length) app.set('trust proxy', config.trustedProxies);

app.use(entetes);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

/**
 * Point de sante, SANS authentification.
 *
 * Il sert au healthcheck du conteneur, qui n'a pas de session. Il ne divulgue
 * donc que le strict necessaire : vivant, et quelle version. Ni etat de la
 * boite, ni compteurs, ni phase — ces informations sont derriere la session.
 */
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    version: require('../package.json').version,
    // Le commit installe, quand l'executeur en a ecrit un : c'est ce qui permet
    // de verifier apres coup QUELLE revision tourne reellement.
    commit: require('./services/update').versionInstallee().commit,
  })
);

// Pages
app.get('/login', (req, res) => res.sendFile(path.join(config.root, 'public', 'login.html')));
app.get('/', auth.requireAuthPage, (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

app.use('/api/auth', limiteApi, require('./routes/auth'));

// Tout le reste de l'API exige une session et un jeton CSRF sur les methodes mutantes.
const api = express.Router();
api.use(limiteApi, auth.requireAuth, auth.csrfProtect);
api.use('/inbox', require('./routes/inbox'));
api.use('/rules', require('./routes/rules'));
api.use('/system', require('./routes/system'));
api.use('/chat', require('./routes/chat'));
api.use('/update', require('./routes/update'));
app.use('/api', api);

app.use(express.static(path.join(config.root, 'public'), { index: false, maxAge: '1h' }));

app.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));

/**
 * Gestionnaire d'erreurs.
 *
 * Regle : un message n'est montre que s'il a ETE REDIGE pour l'etre. En
 * pratique, toute erreur portant un `status` explicite vient de l'application
 * et dit quoi corriger (« la boite a refuse les identifiants », « confirmation
 * expiree ») ; une erreur sans `status` est un imprevu, dont le detail reste au
 * journal. Masquer aussi les 502 rediges reviendrait a repondre « erreur
 * interne » a un mot de passe d'application revoque, et a chercher la panne du
 * mauvais cote.
 */
app.use((err, req, res, _next) => {
  const redige = Number.isInteger(err.status);
  const status = redige ? err.status : 500;
  if (status >= 500) log.error(`${req.method} ${req.path} :`, err);
  else log.warn(`${req.method} ${req.path} : ${err.message}`);
  res.status(status).json({ error: redige ? err.message : 'Erreur interne.' });
});

const server = app.listen(config.port, config.host, () => {
  log.info(`Inbox Agent sur http://${config.host}:${config.port} (${config.env}).`);
  log.info(
    ecritureAutorisee()
      ? 'PHASE 1 : l\'ecriture dans la boite est AUTORISEE.'
      : 'PHASE 0 : lecture seule, la boite Gmail n\'est jamais modifiee.'
  );
  imap.start();
  bot.demarrer();
});

// Purge des sessions expirees, une fois par heure, et des confirmations
// d'envoi perimees, toutes les cinq minutes.
const purge = setInterval(() => auth.purgeExpiredSessions(), 3600_000);
purge.unref();
const purgeJetons = setInterval(() => mailer.purger(), 300_000);
purgeJetons.unref();

async function arret(signal) {
  log.info(`${signal} recu, arret en cours.`);
  clearInterval(purge);
  clearInterval(purgeJetons);
  await bot.arreter();
  await imap.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => arret('SIGTERM'));
process.on('SIGINT', () => arret('SIGINT'));

module.exports = app;
