'use strict';
/** Journalisation minimaliste, sortie stdout/stderr (captee par systemd/journald). */
const { config } = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[config.logLevel] ?? LEVELS.info;

/** Masque les valeurs sensibles eventuellement presentes dans un message. */
function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(password|pass|secret|token|authorization)("?\s*[:=]\s*"?)([^\s",}]+)/gi, '$1$2***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer ***');
}

function emit(level, args) {
  if (LEVELS[level] > current) return;
  const line = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .map(redact)
    .join(' ');
  const stamp = new Date().toISOString();
  const out = `${stamp} [${level.toUpperCase()}] ${line}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

module.exports = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
};
