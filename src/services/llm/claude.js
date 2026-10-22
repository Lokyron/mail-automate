'use strict';
/**
 * Fournisseur Claude (API Messages d'Anthropic).
 *
 * La sortie structuree passe par un OUTIL impose (`tool_choice`) plutot que par
 * une consigne « reponds en JSON » : le modele doit alors remplir un schema, et
 * la reponse est un objet deja valide. C'est ce qui evite la classe de pannes la
 * plus penible — un JSON tronque ou precede d'une phrase de politesse, qu'il
 * faut ensuite rattraper a l'expression reguliere.
 */
const { config } = require('../../config');
const log = require('../../utils/logger');

const OUTIL = 'repondre';

/**
 * @param {object} p
 * @param {string} p.model
 * @param {string} p.system      consignes
 * @param {string} p.input       contenu a traiter
 * @param {object} p.schema      schema JSON de la reponse attendue
 * @returns {Promise<{data:object,usage:object,model:string}>}
 */
async function askJson({ model, system, input, schema, maxOutputTokens = 1024, temperature = 0, timeoutMs }) {
  const { apiKey, apiBase, version } = config.llm.claude;
  if (!apiKey) throw Object.assign(new Error('CLAUDE_API_KEY absent.'), { status: 400 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || config.llm.timeoutMs);

  try {
    const reponse = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: input }],
        tools: [
          {
            name: OUTIL,
            description: 'Renvoie le resultat sous la forme attendue.',
            input_schema: schema,
          },
        ],
        // Force l'appel de l'outil : la reponse ne peut pas etre du texte libre.
        tool_choice: { type: 'tool', name: OUTIL },
      }),
    });

    const brut = await reponse.text();
    if (!reponse.ok) {
      // Le corps d'erreur d'Anthropic est un JSON lisible : on le remonte tel
      // quel, c'est lui qui dit si la clef est invalide ou le quota depasse.
      throw Object.assign(new Error(`Claude ${reponse.status} : ${brut.slice(0, 300)}`), {
        status: reponse.status === 429 ? 429 : 502,
      });
    }

    const payload = JSON.parse(brut);
    const bloc = (payload.content || []).find((c) => c.type === 'tool_use' && c.name === OUTIL);
    if (!bloc) {
      // Arrive si le modele s'arrete avant d'avoir appele l'outil : presque
      // toujours un max_tokens trop serre, pas une erreur de prompt.
      throw new Error(
        `Reponse sans appel d'outil (stop_reason = ${payload.stop_reason}). ` +
          'Augmenter DRAFTS_MAX_OUTPUT_TOKENS si la tache est longue.'
      );
    }

    return {
      data: bloc.input,
      model: payload.model || model,
      usage: {
        entree: payload.usage?.input_tokens || 0,
        sortie: payload.usage?.output_tokens || 0,
      },
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw Object.assign(new Error(`Claude : delai depasse (${timeoutMs || config.llm.timeoutMs} ms).`), { status: 504 });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Conversation a outils : un aller-retour par appel, l'appelant decide s'il
 * continue. La boucle n'est PAS ici, volontairement — c'est `services/chat.js`
 * qui compte les tours et execute les outils, parce que c'est lui qui sait ce
 * qu'un outil a le droit de faire.
 *
 * @param {object} p
 * @param {Array}  p.messages   historique au format Messages API
 * @param {Array}  p.tools      definitions d'outils
 * @returns {Promise<{blocs:Array,stop:string,usage:object,model:string}>}
 */
async function converser({ model, system, messages, tools, maxOutputTokens = 2000, temperature = 0.2, timeoutMs }) {
  const { apiKey, apiBase, version } = config.llm.claude;
  if (!apiKey) throw Object.assign(new Error('CLAUDE_API_KEY absent.'), { status: 400 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || config.llm.timeoutMs);
  try {
    const reponse = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': version },
      signal: controller.signal,
      body: JSON.stringify({ model, max_tokens: maxOutputTokens, temperature, system, messages, tools }),
    });
    const brut = await reponse.text();
    if (!reponse.ok)
      throw Object.assign(new Error(`Claude ${reponse.status} : ${brut.slice(0, 300)}`), {
        status: reponse.status === 429 ? 429 : 502,
      });

    const payload = JSON.parse(brut);
    return {
      blocs: payload.content || [],
      stop: payload.stop_reason,
      model: payload.model || model,
      usage: { entree: payload.usage?.input_tokens || 0, sortie: payload.usage?.output_tokens || 0 },
    };
  } catch (e) {
    if (e.name === 'AbortError')
      throw Object.assign(new Error('Claude : delai depasse pendant la conversation.'), { status: 504 });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection() {
  const { data } = await askJson({
    model: config.llm.claude.classifyModel,
    system: 'Tu reponds exactement ce qui est demande.',
    input: 'Renvoie ok = true.',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    maxOutputTokens: 256,
  });
  log.info('Claude : connexion verifiee.');
  return data;
}

const isConfigured = () => Boolean(config.llm.claude.apiKey);

module.exports = { askJson, converser, testConnection, isConfigured, nom: 'claude' };
