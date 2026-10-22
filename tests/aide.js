'use strict';
/** Outils communs aux tests : base jetable et jeux de donnees minimaux. */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** A appeler AVANT tout require de l'application. */
function baseJetable() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-agent-'));
  process.env.DB_PATH = path.join(dossier, 'test.db');
  return dossier;
}

/** Insere un message et retourne son identifiant. */
function message(db, champs = {}) {
  const row = {
    mailbox: 'INBOX',
    uid_validity: '1',
    uid: Math.floor(Math.random() * 1e6),
    message_id: `<${Math.random().toString(36).slice(2)}@exemple.fr>`,
    in_reply_to: '',
    thread_refs: '',
    from_name: 'Lucie',
    from_email: 'lucie@exemple.fr',
    to_text: 'moi@exemple.fr',
    cc_text: '',
    reply_to: '',
    subject: 'Question sur le devis',
    snippet: '',
    body_text: 'Bonjour, est-ce que le devis court jusqu a juin ?',
    body_html: '',
    size_bytes: 500,
    attachments: 0,
    truncated: 0,
    sent_at: '2026-10-20T08:00:00.000Z',
    received_at: '2026-10-20T08:00:05.000Z',
    fetched_at: '2026-10-20T08:01:00.000Z',
    sensible: 0,
    ...champs,
  };
  const info = db
    .prepare(
      `INSERT INTO inbox_messages (mailbox, uid_validity, uid, message_id, in_reply_to, thread_refs,
        from_name, from_email, to_text, cc_text, reply_to, subject, snippet, body_text, body_html,
        size_bytes, attachments, truncated, sent_at, received_at, fetched_at, status, sensible)
       VALUES (@mailbox, @uid_validity, @uid, @message_id, @in_reply_to, @thread_refs,
        @from_name, @from_email, @to_text, @cc_text, @reply_to, @subject, @snippet, @body_text, @body_html,
        @size_bytes, @attachments, @truncated, @sent_at, @received_at, @fetched_at, 'trie', @sensible)`
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

/** Insere un brouillon et retourne son identifiant. */
function brouillon(db, messageId, champs = {}) {
  const row = {
    message_id: messageId,
    destinataire: 'lucie@exemple.fr',
    objet: 'Re: Question sur le devis',
    corps: 'Bonjour Lucie,\n\nLe devis court jusqu au 30 juin.\n\nTheo',
    confiance: 0.9,
    motif: 'Question simple.',
    questions: '[]',
    modele: 'test',
    created_at: '2026-10-20T09:00:00.000Z',
    sent_at: null,
    applied_at: null,
    corps_corrige: null,
    verdict: null,
    ...champs,
  };
  const info = db
    .prepare(
      `INSERT INTO drafts (message_id, destinataire, objet, corps, confiance, motif, questions, modele,
         created_at, sent_at, applied_at, corps_corrige, verdict)
       VALUES (@message_id, @destinataire, @objet, @corps, @confiance, @motif, @questions, @modele,
         @created_at, @sent_at, @applied_at, @corps_corrige, @verdict)`
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

module.exports = { baseJetable, message, brouillon };
