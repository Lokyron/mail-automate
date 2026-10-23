'use strict';
/**
 * Catalogue des reglages modifiables depuis l'interface.
 *
 * UNE SEULE LISTE, et tout en decoule : les champs affiches, leur type, leur
 * validation, l'endroit de `config` qu'ils alimentent, et le service a
 * redemarrer quand ils changent. Ajouter un reglage, c'est ajouter une ligne
 * ici — pas toucher a la route, ni au gabarit, ni au formulaire.
 *
 * CE QUI N'EST PAS ICI NE SE REGLE PAS DEPUIS L'INTERFACE, et c'est delibere :
 *
 *  - `WRITE_ENABLED` (le verrou d'ecriture) reste dans le `.env`. Ouvrir
 *    l'ecriture sur une boite mail est une decision qui se prend sur la
 *    machine, pas un interrupteur a portee de clic dans une page web — c'est la
 *    promesse centrale du projet, et elle ne doit pas dependre d'une session
 *    ouverte quelque part. L'interface l'AFFICHE, en lecture seule.
 *  - `SESSION_SECRET`, `ADMIN_*`, `HOST`, `PORT`, `DB_PATH`, `TRUSTED_PROXIES`,
 *    `UPDATE_*` : ils gouvernent l'acces, le reseau ou la mise a jour
 *    elle-meme. Un reglage qui peut couper la main qui le regle n'a rien a
 *    faire dans une interface.
 */
const { config, bool, int, list } = require('../../config');

/* ------------------------------------------------- acces a un chemin pointe */

const lirePath = (objet, chemin) => chemin.split('.').reduce((o, k) => (o == null ? o : o[k]), objet);

function poserPath(objet, chemin, valeur) {
  const parties = chemin.split('.');
  const derniere = parties.pop();
  const cible = parties.reduce((o, k) => o[k], objet);
  cible[derniere] = valeur;
}

/* ------------------------------------------------------------------- types */

/** Convertit la chaine rangee en base vers ce que `config` attend. */
const CONVERSIONS = {
  texte: (v) => String(v),
  'texte-long': (v) => String(v),
  secret: (v) => String(v),
  booleen: (v) => bool(v),
  nombre: (v) => int(v, 0),
  decimal: (v) => Number(v),
  liste: (v) => list(v),
  choix: (v) => String(v),
};

/** Remet une valeur de `config` sous la forme d'une chaine, pour l'affichage. */
const AFFICHAGES = {
  booleen: (v) => (v ? 'true' : 'false'),
  liste: (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? '')),
};
const pourAffichage = (type, valeur) => (AFFICHAGES[type] || ((v) => String(v ?? '')))(valeur);

/* -------------------------------------------------------------- validations */

const entrePositif = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return `doit etre un nombre entre ${min} et ${max}`;
  return null;
};
const adresse = (v) => (!v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v)) ? null : 'adresse e-mail attendue');
const nonVide = (v) => (String(v || '').trim() ? null : 'valeur attendue');

/* -------------------------------------------------------------- le catalogue */

const GROUPES = [
  { id: 'boite', titre: 'Boîte mail (lecture)', aide: "Un mot de passe d'APPLICATION Google, pas celui du compte : compte Google › Sécurité › Validation en deux étapes › Mots de passe des applications." },
  { id: 'modele', titre: 'Modèle de langage', aide: "Le modèle qui trie et rédige. Deux fournisseurs interchangeables ; seule la clef du fournisseur actif est utilisée." },
  { id: 'envoi', titre: 'Envoi (SMTP)', aide: "Sert à envoyer les réponses. À défaut, les identifiants de lecture ci-dessus sont repris : le mot de passe d'application Google ouvre aussi l'envoi." },
  { id: 'tri', titre: 'Tri et brouillons', aide: 'Ce que l’application fait d’elle-même à l’arrivée d’un message.' },
  { id: 'confidentiel', titre: 'Courrier hors de portée du modèle', aide: "Un message dont l'expéditeur ou l'objet correspond est enregistré, mais son contenu ne sort JAMAIS vers une API. Le joker « * » est accepté (ex. *@mabanque.fr)." },
  { id: 'salon', titre: 'Salon Telegram', aide: "Optionnel. Le salon est une liste blanche : le bot reste muet pour tout identifiant absent." },
];

const CATALOGUE = [
  /* --- boite ------------------------------------------------------------ */
  { cle: 'IMAP_ENABLED', chemin: 'imap.enabled', groupe: 'boite', type: 'booleen',
    libelle: 'Relever la boîte', aide: 'Tant que c’est éteint, rien n’est relevé et l’application tourne à vide.', redemarrer: 'imap' },
  { cle: 'IMAP_USER', chemin: 'imap.user', groupe: 'boite', type: 'texte',
    libelle: 'Adresse de la boîte', exemple: 'moi@gmail.com', verifier: adresse, redemarrer: 'imap' },
  { cle: 'IMAP_PASS', chemin: 'imap.pass', groupe: 'boite', type: 'secret',
    libelle: "Mot de passe d'application", aide: 'Seize caractères, généré par Google. Jamais le mot de passe du compte.', redemarrer: 'imap' },
  { cle: 'IMAP_HOST', chemin: 'imap.host', groupe: 'boite', type: 'texte',
    libelle: 'Serveur IMAP', verifier: nonVide, avance: true, redemarrer: 'imap' },
  { cle: 'IMAP_PORT', chemin: 'imap.port', groupe: 'boite', type: 'nombre',
    libelle: 'Port', verifier: entrePositif(1, 65535), avance: true, redemarrer: 'imap' },
  { cle: 'IMAP_MAILBOX', chemin: 'imap.mailbox', groupe: 'boite', type: 'texte',
    libelle: 'Dossier relevé', verifier: nonVide, avance: true, redemarrer: 'imap' },
  { cle: 'IMAP_POLL_SECONDS', chemin: 'imap.pollSeconds', groupe: 'boite', type: 'nombre',
    libelle: 'Relève de sécurité (secondes)', aide: 'Filet si le serveur ne signale pas les arrivées. Minimum appliqué : 30 s.',
    verifier: entrePositif(30, 86400), avance: true, redemarrer: 'imap' },
  { cle: 'IMAP_BACKFILL_DAYS', chemin: 'imap.rattrapageJours', groupe: 'boite', type: 'nombre',
    libelle: 'Rattrapage initial (jours)', aide: 'Au premier démarrage seulement : combien de jours de courrier déjà présent reprendre. 0 = rien.',
    verifier: entrePositif(0, 365), avance: true, redemarrer: 'imap' },

  /* --- modele ----------------------------------------------------------- */
  { cle: 'LLM_PROVIDER', chemin: 'llm.provider', groupe: 'modele', type: 'choix',
    libelle: 'Fournisseur', choix: ['claude', 'gemini'],
    verifier: (v) => (['claude', 'gemini'].includes(String(v)) ? null : 'claude ou gemini') },
  { cle: 'CLAUDE_API_KEY', chemin: 'llm.claude.apiKey', groupe: 'modele', type: 'secret',
    libelle: 'Clef d’API Anthropic', aide: 'console.anthropic.com › API keys.' },
  { cle: 'CLAUDE_CLASSIFY_MODEL', chemin: 'llm.claude.classifyModel', groupe: 'modele', type: 'texte',
    libelle: 'Modèle de tri (Claude)', aide: 'Trier est une tâche simple et volumineuse : le modèle le plus économique suffit.', avance: true },
  { cle: 'CLAUDE_DRAFT_MODEL', chemin: 'llm.claude.draftModel', groupe: 'modele', type: 'texte',
    libelle: 'Modèle de rédaction (Claude)', avance: true },
  { cle: 'GEMINI_API_KEY', chemin: 'llm.gemini.apiKey', groupe: 'modele', type: 'secret',
    libelle: 'Clef d’API Google', avance: true },
  { cle: 'GEMINI_CLASSIFY_MODEL', chemin: 'llm.gemini.classifyModel', groupe: 'modele', type: 'texte',
    libelle: 'Modèle de tri (Gemini)', avance: true },
  { cle: 'GEMINI_DRAFT_MODEL', chemin: 'llm.gemini.draftModel', groupe: 'modele', type: 'texte',
    libelle: 'Modèle de rédaction (Gemini)', avance: true },
  { cle: 'LLM_DAILY_CALL_LIMIT', chemin: 'llm.dailyCallLimit', groupe: 'modele', type: 'nombre',
    libelle: 'Plafond d’appels par jour', aide: 'Garde-fou de facture : aucune boucle ne peut le dépasser.',
    verifier: entrePositif(1, 100000) },
  { cle: 'LLM_CONFIDENCE_THRESHOLD', chemin: 'llm.confidenceThreshold', groupe: 'modele', type: 'decimal',
    libelle: 'Seuil de confiance', aide: 'En deçà, le message part en « À vérifier » plutôt qu’en tri fermé.',
    verifier: entrePositif(0, 1) },

  /* --- envoi ------------------------------------------------------------ */
  { cle: 'SMTP_HOST', chemin: 'smtp.host', groupe: 'envoi', type: 'texte', libelle: 'Serveur SMTP', verifier: nonVide },
  { cle: 'SMTP_PORT', chemin: 'smtp.port', groupe: 'envoi', type: 'nombre', libelle: 'Port', verifier: entrePositif(1, 65535) },
  { cle: 'SMTP_USER', amorceEnv: true, chemin: 'smtp.user', groupe: 'envoi', type: 'texte',
    libelle: 'Compte d’envoi', aide: 'Vide = reprend l’adresse de la boîte.', verifier: adresse },
  { cle: 'SMTP_PASS', amorceEnv: true, chemin: 'smtp.pass', groupe: 'envoi', type: 'secret',
    libelle: 'Mot de passe d’envoi', aide: 'Vide = reprend le mot de passe d’application ci-dessus.' },
  { cle: 'MAIL_FROM_NAME', chemin: 'smtp.fromName', groupe: 'envoi', type: 'texte', libelle: 'Nom affiché' },
  { cle: 'MAIL_FROM_EMAIL', amorceEnv: true, chemin: 'smtp.fromEmail', groupe: 'envoi', type: 'texte',
    libelle: 'Adresse d’expédition', verifier: adresse },
  { cle: 'SMTP_DAILY_LIMIT', chemin: 'smtp.dailyLimit', groupe: 'envoi', type: 'nombre',
    libelle: 'Plafond d’envois par jour', verifier: entrePositif(1, 1000) },

  /* --- tri -------------------------------------------------------------- */
  { cle: 'TRIAGE_AUTO', chemin: 'tri.auto', groupe: 'tri', type: 'booleen',
    libelle: 'Trier à l’arrivée', aide: 'Classer chaque message dès qu’il est relevé.' },
  { cle: 'TRIAGE_EXAMPLES', chemin: 'tri.exemples', groupe: 'tri', type: 'nombre',
    libelle: 'Corrections rappelées au modèle', aide: 'Chaque tri corrigé sert d’exemple aux suivants.',
    verifier: entrePositif(0, 100) },
  { cle: 'DRAFTS_AUTO', chemin: 'brouillons.auto', groupe: 'tri', type: 'booleen',
    libelle: 'Rédiger les brouillons', aide: 'Dès qu’un message est jugé « à répondre ».' },
  { cle: 'DRAFTS_SIGNATURE', chemin: 'brouillons.signature', groupe: 'tri', type: 'texte-long',
    libelle: 'Signature', aide: 'Laissée vide, le modèle ne signe pas.' },

  /* --- confidentiel ----------------------------------------------------- */
  { cle: 'SENSITIVE_SENDERS', chemin: 'confidentiel.expediteurs', groupe: 'confidentiel', type: 'liste',
    libelle: 'Expéditeurs', exemple: '*@mabanque.fr, *@*impots*, contact@ameli.fr' },
  { cle: 'SENSITIVE_SUBJECTS', chemin: 'confidentiel.motsObjet', groupe: 'confidentiel', type: 'liste',
    libelle: 'Mots de l’objet', exemple: 'relevé de compte, rib, bulletin de salaire' },

  /* --- salon ------------------------------------------------------------ */
  { cle: 'BOT_ENABLED', chemin: 'bot.enabled', groupe: 'salon', type: 'booleen',
    libelle: 'Activer le salon', redemarrer: 'bot' },
  { cle: 'TELEGRAM_BOT_TOKEN', chemin: 'bot.token', groupe: 'salon', type: 'secret',
    libelle: 'Jeton du bot', aide: 'Créé auprès de @BotFather.', redemarrer: 'bot' },
  { cle: 'TELEGRAM_CHAT_ID', chemin: 'bot.chatId', groupe: 'salon', type: 'liste',
    libelle: 'Salons autorisés', aide: 'Liste blanche. Relever le sien auprès de @userinfobot.', redemarrer: 'bot' },
  { cle: 'BOT_BODY_IN_CHAT', chemin: 'bot.corpsDansLeSalon', groupe: 'salon', type: 'booleen',
    libelle: 'Montrer le corps des messages', aide: 'Laissé éteint, le salon transporte des décisions, pas de la correspondance.', redemarrer: 'bot' },
];

const PAR_CLE = new Map(CATALOGUE.map((r) => [r.cle, r]));

/** Reglages montres mais NON modifiables ici, avec la raison. */
const EN_LECTURE_SEULE = [
  { libelle: 'Écriture dans la boîte', valeur: () => (config.ecriture.autorisee ? 'autorisée (phase 1)' : 'interdite (phase 0)'),
    motif: 'Se règle dans le .env (WRITE_ENABLED). Ouvrir l’écriture sur une boîte mail est une décision qui se prend sur la machine, pas un interrupteur dans une page web.' },
  { libelle: 'Identifiant de connexion', valeur: () => config.admin.user,
    motif: 'Se règle dans le .env (ADMIN_USER). Le mot de passe se change par le bouton « Mot de passe ».' },
  { libelle: 'Mises à jour', valeur: () => (config.maj.enabled ? `activées · ${config.maj.repo}` : 'désactivées'),
    motif: 'Se règlent dans le .env et dans le service exécuteur, hors du conteneur.' },
  { libelle: 'Adresse d’écoute', valeur: () => `${config.host}:${config.port}`,
    motif: 'Se règle dans le .env et dans docker-compose.yml.' },
];

module.exports = {
  CATALOGUE,
  GROUPES,
  PAR_CLE,
  EN_LECTURE_SEULE,
  CONVERSIONS,
  pourAffichage,
  lirePath,
  poserPath,
};
