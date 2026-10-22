'use strict';
/**
 * Chargement et validation centralises de la configuration.
 * Toute valeur sensible provient exclusivement de l'environnement (.env).
 */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const root = path.join(__dirname, '..');
const dbPath = path.isAbsolute(process.env.DB_PATH || '')
  ? process.env.DB_PATH
  : path.join(root, process.env.DB_PATH || './data/inbox-agent.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const config = {
  root,
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 8090),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8090').replace(/\/+$/, ''),
  trustedProxies: String(process.env.TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  dbPath,

  session: {
    secret: process.env.SESSION_SECRET || '',
    ttlHours: int(process.env.SESSION_TTL_HOURS, 168),
    cookieName: 'ia_session',
  },

  admin: {
    user: process.env.ADMIN_USER || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
  },

  /**
   * INTERRUPTEUR DE PHASE. C'est la garantie centrale de l'application.
   *
   * A false, AUCUN module n'a le droit d'ecrire dans la boite : ni libelle, ni
   * brouillon, ni marquage lu, ni envoi. Le verrou n'est pas declaratif : il est
   * verifie dans `services/guard.js`, appele par tout code qui s'appreterait a
   * modifier la boite. Tant que la phase 0 n'a pas fait ses preuves sur une
   * semaine de courrier reel, ce drapeau reste a false.
   */
  ecriture: {
    autorisee: bool(process.env.WRITE_ENABLED, false),
  },

  imap: {
    enabled: bool(process.env.IMAP_ENABLED, false),
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: int(process.env.IMAP_PORT, 993),
    secure: bool(process.env.IMAP_SECURE, true),
    user: process.env.IMAP_USER || '',
    pass: process.env.IMAP_PASS || '',
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    pollSeconds: int(process.env.IMAP_POLL_SECONDS, 120),
    // Taille maximale telechargee pour UNE partie de texte. Les pieces jointes ne
    // sont jamais telechargees, quelle que soit leur taille.
    maxBodyBytes: int(process.env.IMAP_MAX_BODY_BYTES, 512 * 1024),
    // Au premier demarrage : nombre de jours de courrier deja present a reprendre.
    // 0 = ne reprendre que les messages arrivant APRES la mise en service. Pour la
    // phase 0 on veut au contraire du materiau : une semaine donne de quoi juger.
    rattrapageJours: int(process.env.IMAP_BACKFILL_DAYS, 7),
  },

  /**
   * Modele de langage. Deux fournisseurs interchangeables derriere la meme
   * interface (`services/llm.js`) : l'un peut tomber sans emporter l'autre, et le
   * choix se fait par reglage, pas par modification du code.
   */
  llm: {
    provider: (process.env.LLM_PROVIDER || 'claude').toLowerCase(),
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 60000),
    // Plafond journalier d'appels, toutes taches confondues : aucune boucle ne
    // peut faire exploser la facture.
    dailyCallLimit: int(process.env.LLM_DAILY_CALL_LIMIT, 400),
    // En deca de ce seuil, le message part en « A verifier » plutot qu'en tri ferme.
    confidenceThreshold: Number(process.env.LLM_CONFIDENCE_THRESHOLD || 0.7),
    maxBodyChars: int(process.env.LLM_MAX_BODY_CHARS, 6000),

    claude: {
      apiKey: process.env.CLAUDE_API_KEY || '',
      apiBase: (process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, ''),
      version: process.env.CLAUDE_API_VERSION || '2023-06-01',
      // Classer est une tache simple et volumineuse : le modele le plus economique
      // suffit. Rediger demande de la finesse : le modele intermediaire.
      classifyModel: process.env.CLAUDE_CLASSIFY_MODEL || 'claude-haiku-5-5',
      draftModel: process.env.CLAUDE_DRAFT_MODEL || 'claude-sonnet-5-5',
    },

    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      apiBase: (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
      apiRevision: process.env.GEMINI_API_REVISION || '2026-05-20',
      classifyModel: process.env.GEMINI_CLASSIFY_MODEL || 'gemini-3.5-flash-lite',
      draftModel: process.env.GEMINI_DRAFT_MODEL || 'gemini-3.5-flash',
    },
  },

  tri: {
    // Classer chaque message des son arrivee.
    auto: bool(process.env.TRIAGE_AUTO, true),
    // Nombre de corrections passees rappelees au modele. C'est tout l'interet de
    // la phase 0 : chaque fois qu'on corrige un tri, l'exemple sert aux suivants.
    exemples: int(process.env.TRIAGE_EXAMPLES, 12),
  },

  brouillons: {
    // Rediger un brouillon des qu'un message est juge « a repondre ».
    auto: bool(process.env.DRAFTS_AUTO, true),
    signature: process.env.DRAFTS_SIGNATURE || '',
    // Ce plafond couvre AUSSI les jetons de raisonnement : trop serre, le JSON
    // s'arrete au milieu et le brouillon est perdu.
    maxOutputTokens: int(process.env.DRAFTS_MAX_OUTPUT_TOKENS, 3000),
    temperature: Number(process.env.DRAFTS_TEMPERATURE || 0.3),
    timeoutMs: int(process.env.DRAFTS_TIMEOUT_MS, 120000),
  },

  /**
   * Envoi (SMTP). Un envoi n'est JAMAIS declenche par un texte : il exige une
   * confirmation explicite — un bouton dans l'interface ou dans le salon — et
   * le verrou d'ecriture ouvert. Gmail enregistre lui-meme le message dans
   * « Envoyes » quand on passe par son SMTP : rien a recopier a la main, et
   * c'est tant mieux, car c'est precisement la que les outils generiques
   * trebuchent et renvoient deux fois le meme message.
   */
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: int(process.env.SMTP_PORT, 465),
    secure: bool(process.env.SMTP_SECURE, true),
    // A defaut, les identifiants de lecture : le mot de passe d'application
    // Google ouvre aussi bien la lecture que l'envoi.
    user: process.env.SMTP_USER || process.env.IMAP_USER || '',
    pass: process.env.SMTP_PASS || process.env.IMAP_PASS || '',
    fromName: process.env.MAIL_FROM_NAME || '',
    fromEmail: process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER || process.env.IMAP_USER || '',
    // Plafond quotidien propre a l'application, independant de celui de Gmail.
    dailyLimit: int(process.env.SMTP_DAILY_LIMIT, 50),
  },

  /**
   * Salon de discussion (Telegram).
   *
   * Trois choix de conception sont figes ici :
   *  - `chatId` est une LISTE BLANCHE. Tout message venant d'ailleurs est
   *    rejete et journalise : le salon est une porte d'entree vers une boite
   *    mail, elle ne s'ouvre pas a qui connait le nom du bot.
   *  - `corpsDansLeSalon` est faux par defaut : les cartes portent expediteur,
   *    objet et resume, pas le contenu du courrier. Telegram n'est pas chiffre
   *    de bout en bout pour les discussions ordinaires ; le salon transporte
   *    des decisions, pas de la correspondance. Le corps reste accessible a la
   *    demande, par un bouton.
   *  - le releve se fait en long polling : aucun port entrant a ouvrir, aucun
   *    certificat, rien a exposer depuis le Home Lab.
   */
  bot: {
    plateforme: (process.env.BOT_PLATFORM || 'telegram').toLowerCase(),
    enabled: bool(process.env.BOT_ENABLED, false),
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: list(process.env.TELEGRAM_CHAT_ID),
    corpsDansLeSalon: bool(process.env.BOT_BODY_IN_CHAT, false),
    // Les libelles confidentiels ne sortent jamais autrement qu'en metadonnees,
    // quel que soit le reglage ci-dessus.
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    pollSeconds: int(process.env.BOT_POLL_SECONDS, 30),
  },

  /**
   * Mise a jour depuis le depot GitHub.
   *
   * L'application ne met JAMAIS a jour son propre code : elle depose une
   * demande dans son dossier de donnees, et un executeur exterieur — lance par
   * systemd, en dehors du conteneur — fait le travail. Voir services/update.js.
   *
   * `UPDATE_REPO` et les branches sont declares ici pour l'AFFICHAGE et la
   * verification de version. La correspondance canal -> branche qui fait foi est
   * celle de l'executeur, cote hote : l'application ne peut donc pas le diriger
   * vers une reference de son choix.
   */
  maj: {
    enabled: bool(process.env.UPDATE_ENABLED, false),
    repo: process.env.UPDATE_REPO || 'Lokyron/mail-automate',
    branche: process.env.UPDATE_BRANCH || 'main',
    // Vide = ne proposer que le canal stable.
    brancheBeta: process.env.UPDATE_BETA_BRANCH === undefined ? 'beta' : process.env.UPDATE_BETA_BRANCH,
    // Age maximal d'une verification avant d'en refaire une (heures).
    verifHeures: int(process.env.UPDATE_CHECK_HOURS, 24),
    // Dossier de donnees : c'est la que passent la demande, l'etat et le
    // fichier VERSION ecrit par l'executeur.
    dataDir: path.dirname(dbPath),
  },

  /** Conversation avec l'agent (boucle a outils). */
  chat: {
    enabled: bool(process.env.CHAT_ENABLED, true),
    // Tours gardes en contexte. Au-dela, les plus anciens sont oublies.
    historique: int(process.env.CHAT_HISTORY_TURNS, 12),
    // Nombre maximal d'allers-retours d'outils pour UNE question. Garde-fou
    // contre une boucle qui s'appellerait indefiniment.
    maxOutils: int(process.env.CHAT_MAX_TOOL_CALLS, 8),
    maxOutputTokens: int(process.env.CHAT_MAX_OUTPUT_TOKENS, 2000),
  },

  /**
   * Courrier mis hors de portee du modele.
   *
   * Un message dont l'expediteur figure ici est enregistre (expediteur, objet,
   * date) mais son CORPS n'est jamais transmis au modele, jamais resume, et aucun
   * brouillon n'est redige. C'est le garde-fou decide avant d'ecrire la premiere
   * ligne : banque, administration, sante restent entre la boite et l'humain.
   * Les motifs acceptent le joker « * » (ex. « *@mabanque.fr »).
   */
  confidentiel: {
    expediteurs: list(process.env.SENSITIVE_SENDERS),
    // Mots de l'objet qui suffisent a mettre le message hors de portee.
    motsObjet: list(process.env.SENSITIVE_SUBJECTS),
  },
};

/** Verifications bloquantes au demarrage. */
function validate() {
  const fatals = [];
  if (!config.session.secret || config.session.secret.length < 32)
    fatals.push('SESSION_SECRET absent ou trop court (32 caracteres minimum).');
  if (!config.admin.passwordHash)
    fatals.push('ADMIN_PASSWORD_HASH absent (npm run hash pour le produire).');
  if (config.imap.enabled && (!config.imap.user || !config.imap.pass))
    fatals.push('IMAP_ENABLED=true mais IMAP_USER / IMAP_PASS absents.');
  if (!['claude', 'gemini'].includes(config.llm.provider))
    fatals.push(`LLM_PROVIDER inconnu : ${config.llm.provider} (claude ou gemini).`);

  // Un bot sans liste blanche serait une porte ouverte sur la boite mail : le
  // demarrage est refuse plutot que de laisser l'application tourner ainsi.
  if (config.bot.enabled) {
    if (!config.bot.token) fatals.push('BOT_ENABLED=true mais TELEGRAM_BOT_TOKEN absent.');
    if (!config.bot.chatId.length)
      fatals.push('BOT_ENABLED=true mais TELEGRAM_CHAT_ID absent : le salon doit etre une liste blanche.');
  }
  // L'envoi exige le verrou ouvert ET des identifiants : mieux vaut le dire au
  // demarrage que de le decouvrir au moment d'envoyer.
  if (config.ecriture.autorisee && (!config.smtp.user || !config.smtp.pass))
    fatals.push("WRITE_ENABLED=true mais SMTP_USER / SMTP_PASS absents : l'envoi serait impossible.");

  return fatals;
}

module.exports = { config, validate, bool, int, list };
