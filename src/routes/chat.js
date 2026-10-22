'use strict';
/** Conversation avec l'agent depuis l'interface web. */
const express = require('express');
const { config } = require('../config');
const chat = require('../services/chat');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    if (!config.chat.enabled) return res.status(503).json({ error: 'Conversation desactivee (CHAT_ENABLED).' });
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Question attendue.' });
    // Le salon « web » a son propre fil, distinct de celui de Telegram.
    res.json(await chat.repondre({ plateforme: 'web', chatId: 'interface', question }));
  } catch (e) {
    next(e);
  }
});

router.delete('/', (req, res) => res.json({ oublies: chat.oublier('web', 'interface') }));

module.exports = router;
