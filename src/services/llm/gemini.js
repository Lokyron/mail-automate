'use strict';
/**
 * Fournisseur Gemini (API « Interactions » de Google).
 *
 * Porte depuis Parkour Mailer, ou ces deux pieges ont deja coute du temps :
 *  - `generateContent` a ete remplace par `/interactions` ; l'en-tete
 *    `Api-Revision` est EPINGLE pour qu'une evolution du service ne change pas
 *    le comportement du tri du jour au lendemain ;
 *  - la reponse peut arriver sous trois formes selon la version du service, d'ou
 *    l'extracteur ci-dessous plutot qu'un acces direct a un champ.
 */
const { config } = require('../../config');

const fail = (message, status) => Object.assign(new Error(message), { status });

/** Extrait le texte produit, quelle que soit la forme de la reponse. */
function extractText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;

  if (Array.isArray(payload?.steps)) {
    const text = payload.steps
      .filter((s) => s?.type === 'model_output')
      .flatMap((s) => (Array.isArray(s.content) ? s.content : []))
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (text.trim()) return text;
  }

  const legacy = payload?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join('');
  return legacy?.trim() ? legacy : '';
}

/** Compteurs de jetons : trois familles de noms coexistent selon la version. */
function extractUsage(payload) {
  const u = payload?.usage || payload?.usageMetadata || {};
  const n = (...cles) => {
    for (const c of cles) {
      const v = Number(u[c]);
      if (Number.isFinite(v)) return v;
    }
    return 0;
  };
  return {
    entree: n('total_input_tokens', 'prompt_tokens', 'promptTokenCount'),
    sortie: n('total_output_tokens', 'completion_tokens', 'candidatesTokenCount'),
  };
}

async function askJson({ model, system, input, schema, maxOutputTokens = 512, temperature = 0, timeoutMs }) {
  const g = config.llm.gemini;
  if (!g.apiKey) throw fail('GEMINI_API_KEY absent.', 400);

  const delai = Number(timeoutMs) || config.llm.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), delai);

  let res;
  let payload;
  try {
    res = await fetch(`${g.apiBase}/interactions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': g.apiKey,
        'Api-Revision': g.apiRevision,
      },
      body: JSON.stringify({
        model,
        system_instruction: system,
        input,
        generation_config: { temperature, max_output_tokens: maxOutputTokens, thinking_level: 'low' },
        response_format: { type: 'text', mime_type: 'application/json', schema },
      }),
    });
    payload = await res.json().catch(() => ({}));
  } catch (e) {
    if (e.name === 'AbortError') throw fail(`Pas de reponse de Gemini en ${Math.round(delai / 1000)} s.`, 504);
    throw fail(`Appel a Gemini impossible : ${e.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const usage = extractUsage(payload);
  if (!res.ok) {
    throw fail(`Gemini a refuse l'appel : ${payload?.error?.message || `HTTP ${res.status}`}`, res.status === 429 ? 429 : 502);
  }

  const text = extractText(payload);
  if (!text) throw fail('Reponse de Gemini vide ou illisible.', 502);

  try {
    // Le schema impose du JSON, mais une cloture en bloc Markdown reste possible.
    const data = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
    return { data, model, usage };
  } catch {
    // Cas de loin le plus frequent : le plafond de jetons a ete atteint en cours
    // de route et le JSON s'arrete au milieu. Le dire, plutot que de laisser
    // chercher une malformation qui n'existe pas.
    const tronquee = !text.trimEnd().endsWith('}');
    throw fail(
      tronquee
        ? `Reponse de Gemini tronquee : plafond de ${maxOutputTokens} jetons atteint (jetons de raisonnement compris).`
        : `Reponse de Gemini non conforme : ${text.slice(0, 200)}`,
      502
    );
  }
}

async function testConnection() {
  return askJson({
    model: config.llm.gemini.classifyModel,
    system: 'Tu reponds exactement ce qui est demande.',
    input: 'Renvoie ok = true.',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    maxOutputTokens: 256,
  }).then((r) => r.data);
}

const isConfigured = () => Boolean(config.llm.gemini.apiKey);

module.exports = { askJson, testConnection, isConfigured, nom: 'gemini' };
