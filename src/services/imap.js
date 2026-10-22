'use strict';
/**
 * Releve de la boite de reception.
 *
 * Garanties tenues par ce module :
 *  - LA BOITE N'EST JAMAIS MODIFIEE. Elle est ouverte en lecture seule
 *    (`readOnly: true`) : ni suppression, ni deplacement, ni marquage « lu ».
 *    L'application travaille sur une copie locale. La phase 1 ajoutera un module
 *    d'ecriture SEPARE, garde par `guard.js` ; ce fichier-ci restera en lecture.
 *  - AUCUNE PIECE JOINTE N'EST TELECHARGEE. Nom, type et taille proviennent de
 *    la structure du message, pas de son contenu.
 *  - AUCUN DOUBLON. Chaque message est identifie par son `Message-ID` et par le
 *    couple UIDVALIDITY/UID.
 *
 * Porte depuis Parkour Mailer, ou le piege principal a deja ete paye : voir le
 * commentaire du releve en deux temps dans `ingerer()`.
 */
const { ImapFlow } = require('imapflow');
const iconv = require('iconv-lite');
const { config } = require('../config');
const { db, getState, setState, nowIso } = require('../db');
const log = require('../utils/logger');
const { sanitizeIncomingHtml, htmlToText, sanitizeHeaderValue } = require('./sanitize');
const rules = require('./rules');
const events = require('./events');

const SNIPPET_CHARS = 280;
const RECONNECT_MIN_MS = 15_000;
const RECONNECT_MAX_MS = 10 * 60_000;

let client = null;
let pollTimer = null;
let syncing = false;
let pendingSync = false;
let stopped = true;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;

const STATE = {
  uidValidity: 'imap_uid_validity',
  baselineUid: 'imap_baseline_uid',
  lastUid: 'imap_last_uid',
  lastSyncAt: 'imap_last_sync_at',
  lastError: 'imap_last_error',
  startedAt: 'imap_started_at',
  backfillDone: 'imap_backfill_done',
};

const isConfigured = () => Boolean(config.imap.enabled && config.imap.user && config.imap.pass);

function status() {
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM inbox_messages GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
  return {
    enabled: config.imap.enabled,
    configured: isConfigured(),
    connected: Boolean(client?.usable),
    lectureSeule: true,
    host: config.imap.host,
    port: config.imap.port,
    user: config.imap.user,
    mailbox: config.imap.mailbox,
    pollSeconds: config.imap.pollSeconds,
    rattrapageJours: config.imap.rattrapageJours,
    rattrapageFait: getState(STATE.backfillDone) === '1',
    lastSyncAt: getState(STATE.lastSyncAt),
    lastError: getState(STATE.lastError),
    startedAt: getState(STATE.startedAt),
    lastUid: getState(STATE.lastUid),
    total: db.prepare('SELECT COUNT(*) AS n FROM inbox_messages').get().n,
    sensibles: db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE sensible = 1').get().n,
    counts,
  };
}

/* -------------------------------------------------------------------------- */
/*  Lecture de la structure du message                                        */
/* -------------------------------------------------------------------------- */

/**
 * Parcourt la structure MIME et separe ce qui doit etre telecharge (le texte) de
 * ce qui ne doit surtout pas l'etre (les pieces jointes).
 *
 * `node.part` est absent pour un message qui n'est pas multipart : dans ce cas la
 * partie 1 designe le corps entier (RFC 3501, section 6.4.5).
 */
function collectParts(node, acc = { text: [], attachments: [] }, isRoot = true) {
  if (!node) return acc;
  const type = String(node.type || '').toLowerCase();

  // Un message transfere en piece jointe (message/rfc822) porte lui aussi des
  // sous-parties : y descendre melangerait son texte au corps du message recu.
  const isEmbeddedMessage = type.startsWith('message/');

  if (!isEmbeddedMessage && Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) collectParts(child, acc, false);
    return acc;
  }

  const part = node.part || (isRoot ? '1' : null);
  if (!part) return acc;

  const disposition = String(node.disposition || '').toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name || '';
  const isText = type === 'text/plain' || type === 'text/html';

  if (isText && disposition !== 'attachment') {
    acc.text.push({ part, type, charset: node.parameters?.charset || 'utf-8' });
  } else {
    acc.attachments.push({
      part_id: part,
      filename: String(filename).slice(0, 300),
      content_type: type || 'application/octet-stream',
      size_bytes: Number(node.size) || 0,
      // Une image sans nom ni disposition explicite est un element du corps
      // (logo de signature, image en cid:), pas une piece jointe au sens usuel.
      inline: disposition !== 'attachment' && !filename && type.startsWith('image/') ? 1 : 0,
    });
  }
  return acc;
}

async function downloadText(uid, part, charset) {
  const { meta, content } = await client.download(uid, part, { uid: true, maxBytes: config.imap.maxBodyBytes });
  const chunks = [];
  let total = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const buffer = Buffer.concat(chunks);
  const encoding = (meta?.charset || charset || 'utf-8').toLowerCase();
  const text = iconv.encodingExists(encoding) ? iconv.decode(buffer, encoding) : buffer.toString('utf8');
  return { text, truncated: total >= config.imap.maxBodyBytes };
}

function headerValue(raw, name) {
  if (!raw) return '';
  const lines = raw.toString('utf8').split(/\r?\n(?![ \t])/);
  const hit = lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return hit ? hit.slice(name.length + 1).replace(/\s+/g, ' ').trim() : '';
}

const addressList = (list) =>
  (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(', ');

/* -------------------------------------------------------------------------- */
/*  Ingestion                                                                 */
/* -------------------------------------------------------------------------- */

const insertMessage = () =>
  db.prepare(`
    INSERT INTO inbox_messages (mailbox, uid_validity, uid, message_id, in_reply_to, thread_refs, list_id,
      from_name, from_email, to_text, cc_text, reply_to, subject, snippet, body_text, body_html,
      size_bytes, attachments, truncated, sent_at, received_at, fetched_at, status, sensible)
    VALUES (@mailbox, @uid_validity, @uid, @message_id, @in_reply_to, @thread_refs, @list_id,
      @from_name, @from_email, @to_text, @cc_text, @reply_to, @subject, @snippet, @body_text, @body_html,
      @size_bytes, @attachments, @truncated, @sent_at, @received_at, @fetched_at, 'a_trier', @sensible)
  `);

const insertAttachment = () =>
  db.prepare(`
    INSERT INTO inbox_attachments (message_id, part_id, filename, content_type, size_bytes, inline)
    VALUES (@message_id, @part_id, @filename, @content_type, @size_bytes, @inline)
  `);

function persist(row, attachments) {
  return db.transaction(() => {
    const info = insertMessage().run(row);
    const id = info.lastInsertRowid;
    for (const a of attachments) insertAttachment().run({ ...a, message_id: id });
    return Number(id);
  })();
}

/** Ligne de repli quand le corps n'a pas pu etre rapatrie. */
function minimalRow(msg, uidValidity, raison) {
  const env = msg.envelope || {};
  const from = env.from?.[0] || {};
  const row = {
    mailbox: config.imap.mailbox,
    uid_validity: uidValidity,
    uid: msg.uid,
    message_id: env.messageId ? String(env.messageId).slice(0, 500) : `no-id:${uidValidity}:${msg.uid}`,
    in_reply_to: '',
    thread_refs: '',
    list_id: headerValue(msg.headers, 'list-id').slice(0, 500),
    from_name: sanitizeHeaderValue(from.name || '').slice(0, 200),
    from_email: String(from.address || '').toLowerCase().slice(0, 320),
    to_text: '',
    cc_text: '',
    reply_to: '',
    subject: sanitizeHeaderValue(env.subject || '(sans objet)'),
    snippet: `Corps non rapatrie : ${raison}`.slice(0, SNIPPET_CHARS),
    body_text: `Le corps de ce message n'a pas pu etre lu (${raison}). Le message reste intact dans la boite Gmail.`,
    body_html: '',
    size_bytes: Number(msg.size) || 0,
    attachments: 0,
    truncated: 1,
    sent_at: env.date ? new Date(env.date).toISOString() : null,
    received_at: msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso(),
    fetched_at: nowIso(),
    sensible: 0,
  };
  row.sensible = rules.estSensible(row) ? 1 : 0;
  return row;
}

async function buildRow(msg, uidValidity) {
  const env = msg.envelope || {};
  const parts = collectParts(msg.bodyStructure);

  let bodyText = '';
  let bodyHtml = '';
  let truncated = false;

  for (const p of parts.text) {
    try {
      const { text, truncated: cut } = await downloadText(msg.uid, p.part, p.charset);
      truncated = truncated || cut;
      if (p.type === 'text/html') bodyHtml = bodyHtml ? `${bodyHtml}\n${text}` : text;
      else bodyText = bodyText ? `${bodyText}\n${text}` : text;
    } catch (e) {
      log.warn(`IMAP : partie ${p.part} du message UID ${msg.uid} illisible (${e.message}).`);
    }
  }

  const safeHtml = bodyHtml ? sanitizeIncomingHtml(bodyHtml) : '';
  const plain = bodyText || (safeHtml ? htmlToText(safeHtml) : '');
  const from = env.from?.[0] || {};
  const messageId = env.messageId ? String(env.messageId).slice(0, 500) : `no-id:${uidValidity}:${msg.uid}`;

  const row = {
    mailbox: config.imap.mailbox,
    uid_validity: uidValidity,
    uid: msg.uid,
    message_id: messageId,
    in_reply_to: env.inReplyTo ? String(env.inReplyTo).slice(0, 500) : '',
    thread_refs: headerValue(msg.headers, 'references').slice(0, 2000),
    // Releve ET STOCKE : l'en-tete etait demande au serveur depuis le debut,
    // mais jeté a l'arrivee, et la regle qui le cherchait lisait les References.
    list_id: headerValue(msg.headers, 'list-id').slice(0, 500),
    from_name: sanitizeHeaderValue(from.name || '').slice(0, 200),
    from_email: String(from.address || '').toLowerCase().slice(0, 320),
    to_text: sanitizeHeaderValue(addressList(env.to)).slice(0, 1000),
    cc_text: sanitizeHeaderValue(addressList(env.cc)).slice(0, 1000),
    reply_to: sanitizeHeaderValue(addressList(env.replyTo)).slice(0, 320),
    subject: sanitizeHeaderValue(env.subject || '(sans objet)'),
    snippet: plain.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
    body_text: plain,
    body_html: safeHtml,
    size_bytes: Number(msg.size) || 0,
    attachments: parts.attachments.filter((a) => !a.inline).length,
    truncated: truncated ? 1 : 0,
    sent_at: env.date ? new Date(env.date).toISOString() : null,
    received_at: msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso(),
    fetched_at: nowIso(),
    sensible: 0,
  };
  // Decide AVANT tout appel distant : un message confidentiel ne doit jamais
  // partir au modele, meme le temps d'un classement.
  row.sensible = rules.estSensible(row) ? 1 : 0;

  return { row, attachments: parts.attachments };
}

const CHAMPS = {
  uid: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  headers: ['references', 'list-id'],
};

/**
 * Recense puis ingere un ensemble de messages.
 *
 * LE RELEVE SE FAIT EN DEUX TEMPS, et ce n'est pas un detail : telecharger une
 * partie de message pendant que le generateur `fetch` est encore en cours
 * d'iteration revient a lancer une commande IMAP alors que la precedente n'est
 * pas terminee. Les deux s'attendent mutuellement et la connexion se fige. On
 * recense donc d'abord, on telecharge ensuite.
 */
async function ingerer(plage, uidValidity, { minUid = 0 } = {}) {
  const seen = db.prepare('SELECT 1 FROM inbox_messages WHERE mailbox = ? AND uid_validity = ? AND uid = ?');
  const seenId = db.prepare('SELECT 1 FROM inbox_messages WHERE message_id = ?');

  const nouveaux = [];
  let maxUid = minUid;
  for await (const msg of client.fetch(plage, CHAMPS, { uid: true })) {
    // « from:* » renvoie toujours au moins le dernier message de la boite, meme
    // si son UID est inferieur (particularite IMAP) : ce filtre est requis.
    if (msg.uid < minUid) continue;
    maxUid = Math.max(maxUid, msg.uid);
    if (seen.get(config.imap.mailbox, uidValidity, msg.uid)) continue;
    nouveaux.push(msg);
  }

  let added = 0;
  for (const msg of nouveaux) {
    try {
      const { row, attachments } = await buildRow(msg, uidValidity);
      if (seenId.get(row.message_id)) {
        log.debug(`IMAP : message ${row.message_id} deja en base, ignore.`);
        continue;
      }
      const id = persist(row, attachments);
      added += 1;
      log.info(`IMAP : nouveau message de ${row.from_email} — « ${row.subject} »${row.sensible ? ' [confidentiel]' : ''}`);

      if (row.sensible) {
        log.info(`IMAP : message ${id} marque confidentiel, son corps ne sera pas transmis au modele.`);
      }
      require('./classifier').classerAlArrivee(id);
    } catch (e) {
      // Un message illisible ne doit ni bloquer les suivants (le curseur
      // avancerait sans fin sur le meme message) ni disparaitre sans trace.
      log.error(`IMAP : corps du message UID ${msg.uid} illisible (${e.message}), enregistre sans contenu.`);
      try {
        persist(minimalRow(msg, uidValidity, e.message), []);
        added += 1;
      } catch (e2) {
        log.error(`IMAP : message UID ${msg.uid} non enregistre du tout (${e2.message}).`);
      }
    }
  }
  return { added, maxUid };
}

/**
 * Fixe le point de depart au premier demarrage, et le recale si le serveur a
 * reinitialise ses UID (UIDVALIDITY change : les anciens UID ne designent plus
 * les memes messages).
 */
function ensureBaseline(uidValidity, uidNext) {
  const known = getState(STATE.uidValidity);
  if (known === uidValidity) return;

  const baseline = String(Math.max(0, Number(uidNext) - 1));
  if (known === null) {
    log.info(`IMAP : mise en service (UID courant ${baseline}).`);
    setState(STATE.startedAt, nowIso());
  } else {
    log.warn(`IMAP : UIDVALIDITY change (${known} -> ${uidValidity}), reprise a partir du message courant.`);
    // Le rattrapage est refait sur la nouvelle numerotation.
    setState(STATE.backfillDone, null);
  }
  setState(STATE.uidValidity, uidValidity);
  setState(STATE.baselineUid, baseline);
  setState(STATE.lastUid, baseline);
}

/**
 * Rattrapage initial : reprend les messages des N derniers jours deja presents
 * dans la boite. Sans lui, la phase 0 attendrait une semaine avant d'avoir de
 * quoi juger la qualite du tri.
 */
async function rattraper(uidValidity) {
  const jours = config.imap.rattrapageJours;
  if (!jours || getState(STATE.backfillDone) === '1') return 0;

  const depuis = new Date(Date.now() - jours * 86_400_000);
  const uids = await client.search({ since: depuis }, { uid: true });
  if (!uids?.length) {
    setState(STATE.backfillDone, '1');
    return 0;
  }

  log.info(`IMAP : rattrapage de ${uids.length} message(s) recu(s) depuis ${depuis.toISOString().slice(0, 10)}.`);
  // Par paquets : une boite chargee peut renvoyer plusieurs centaines d'UID, et
  // un seul `fetch` sur tout l'ensemble tient la connexion trop longtemps.
  let total = 0;
  for (let i = 0; i < uids.length; i += 50) {
    const lot = uids.slice(i, i + 50);
    const { added } = await ingerer(lot.join(','), uidValidity);
    total += added;
  }
  setState(STATE.backfillDone, '1');
  log.info(`IMAP : rattrapage termine, ${total} message(s) enregistre(s).`);
  return total;
}

function signalerPanne(message) {
  events.emettre({
    type: 'panne',
    titre: 'Boite de reception injoignable',
    corps: String(message || '').slice(0, 200),
    url: '/#reglages',
    cle: `panne:imap:${String(message || '').slice(0, 120)}`,
  });
}

async function syncOnce() {
  if (!client?.usable) return 0;
  if (syncing) {
    pendingSync = true;
    return 0;
  }
  syncing = true;

  const lock = await client.getMailboxLock(config.imap.mailbox, { readOnly: true });
  let added = 0;
  try {
    const uidValidity = String(client.mailbox.uidValidity);
    ensureBaseline(uidValidity, client.mailbox.uidNext);
    if (!client.mailbox.exists) return 0;

    added += await rattraper(uidValidity);

    const lastUid = Number(getState(STATE.lastUid, '0')) || 0;
    const r = await ingerer(`${lastUid + 1}:*`, uidValidity, { minUid: lastUid + 1 });
    added += r.added;

    if (r.maxUid > lastUid) setState(STATE.lastUid, String(r.maxUid));
    setState(STATE.lastSyncAt, nowIso());
    setState(STATE.lastError, null);
  } finally {
    lock.release();
    syncing = false;
  }

  if (pendingSync) {
    pendingSync = false;
    setImmediate(() => syncOnce().catch((e) => log.error('IMAP : releve differe en echec :', e)));
  }
  return added;
}

async function syncNow() {
  if (!isConfigured()) throw Object.assign(new Error("Le releve IMAP n'est pas configure."), { status: 400 });
  if (!client?.usable) await connect();
  const added = await syncOnce();
  return { added, status: status() };
}

/* -------------------------------------------------------------------------- */
/*  Connexion                                                                 */
/* -------------------------------------------------------------------------- */

async function connect() {
  if (client?.usable) return;

  client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
    emitLogs: false,
  });

  client.on('error', (e) => {
    log.error('IMAP : erreur de connexion :', e.message);
    setState(STATE.lastError, e.message);
  });
  client.on('close', () => {
    if (!stopped) scheduleReconnect();
  });
  // Le serveur signale un nouveau message : releve immediat.
  client.on('exists', () => {
    syncOnce().catch((e) => log.error('IMAP : releve en echec :', e));
  });

  await client.connect();
  await client.mailboxOpen(config.imap.mailbox, { readOnly: true });
  reconnectDelay = RECONNECT_MIN_MS;
  log.info(`IMAP : connecte a ${config.imap.host} (${config.imap.user}), boite « ${config.imap.mailbox} » EN LECTURE SEULE.`);
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  log.warn(`IMAP : reconnexion dans ${Math.round(reconnectDelay / 1000)} s.`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      client = null;
      await connect();
      await syncOnce();
    } catch (e) {
      setState(STATE.lastError, e.message);
      signalerPanne(e.message);
      log.error('IMAP : reconnexion impossible :', e.message);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      scheduleReconnect();
    }
  }, reconnectDelay);
  reconnectTimer.unref?.();
}

function start() {
  if (!config.imap.enabled) {
    log.info('IMAP : releve desactive (IMAP_ENABLED).');
    return;
  }
  if (!isConfigured()) {
    log.warn('IMAP : releve actif mais identifiants absents, rien ne sera releve.');
    return;
  }
  stopped = false;

  connect()
    .then(() => syncOnce())
    .catch((e) => {
      setState(STATE.lastError, e.message);
      signalerPanne(e.message);
      log.error('IMAP : connexion initiale impossible :', e.message);
      scheduleReconnect();
    });

  // Filet de securite si le serveur ne signale pas l'arrivee des messages.
  pollTimer = setInterval(() => {
    if (!client?.usable) return scheduleReconnect();
    syncOnce().catch((e) => log.error('IMAP : releve periodique en echec :', e));
  }, Math.max(30, config.imap.pollSeconds) * 1000);
  pollTimer.unref?.();
}

async function stop() {
  stopped = true;
  clearInterval(pollTimer);
  clearTimeout(reconnectTimer);
  pollTimer = reconnectTimer = null;
  try {
    await client?.logout();
  } catch { /* connexion deja tombee */ }
  client = null;
}

async function restart() {
  await stop();
  reconnectDelay = RECONNECT_MIN_MS;
  start();
}

/** Verifie les identifiants sans rien relever. */
async function testConnection() {
  if (!config.imap.user || !config.imap.pass)
    throw Object.assign(new Error('Identifiants IMAP absents.'), { status: 400 });

  const probe = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });
  try {
    await probe.connect();
    const box = await probe.mailboxOpen(config.imap.mailbox, { readOnly: true });
    return { mailbox: box.path, messages: box.exists, uidNext: Number(box.uidNext) };
  } finally {
    try {
      await probe.logout();
    } catch { /* deja ferme */ }
  }
}

module.exports = { start, stop, restart, status, syncNow, testConnection, isConfigured };
