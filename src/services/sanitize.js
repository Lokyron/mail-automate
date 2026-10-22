'use strict';
/**
 * Assainissement du HTML produit par l'editeur WYSIWYG.
 * Objectifs :
 *  - supprimer toute surface XSS (script, on*, javascript:, iframe, object...)
 *  - ne conserver que des balises/attributs compatibles clients e-mail
 * Applique systematiquement AVANT stockage ET AVANT envoi (defense en profondeur).
 */
const sanitizeHtml = require('sanitize-html');

const OPTIONS = {
  allowedTags: [
    'p', 'br', 'hr', 'div', 'span', 'section', 'article',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
    'center', 'font',
  ],
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'dir', 'title', 'lang'],
    a: ['href', 'name', 'target', 'rel', 'style', 'class', 'title'],
    img: ['src', 'alt', 'width', 'height', 'style', 'class', 'border'],
    table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'style', 'class', 'align', 'role'],
    td: ['width', 'height', 'colspan', 'rowspan', 'bgcolor', 'valign', 'align', 'style', 'class'],
    th: ['width', 'height', 'colspan', 'rowspan', 'bgcolor', 'valign', 'align', 'style', 'class'],
    tr: ['height', 'bgcolor', 'valign', 'align', 'style', 'class'],
    font: ['color', 'face', 'size'],
    col: ['width', 'span', 'style'],
  },
  // Seuls des schemes inoffensifs : pas de javascript:, pas de vbscript:, pas de file:
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // Images : liens https uniquement. Une image base64 (data:) est bloquee par Gmail et
  // alourdit chaque envoi ; une image http declenche des alertes de contenu mixte.
  allowedSchemesByTag: { img: ['https'], a: ['http', 'https', 'mailto', 'tel'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  // `style` filtre par liste blanche de proprietes
  allowedStyles: {
    '*': {
      color: [/^.*$/],
      'background-color': [/^.*$/],
      background: [/^(?!.*url\s*\().*$/i], // interdit url() (tracking / CSS exfiltration)
      'text-align': [/^(left|right|center|justify)$/],
      'font-size': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
      'font-family': [/^[\w\s,'"-]+$/],
      'font-weight': [/^(normal|bold|bolder|lighter|\d{3})$/],
      'font-style': [/^(normal|italic|oblique)$/],
      'text-decoration': [/^[\w\s-]+$/],
      'text-transform': [/^(none|uppercase|lowercase|capitalize)$/],
      'letter-spacing': [/^-?\d+(\.\d+)?(px|pt|em|rem)$/],
      'line-height': [/^[\d.]+(px|pt|em|rem|%)?$/],
      margin: [/^[\d\s.a-z%-]+$/i],
      'margin-top': [/^[\d.]+(px|pt|em|rem|%)$/],
      'margin-bottom': [/^[\d.]+(px|pt|em|rem|%)$/],
      'margin-left': [/^[\d.]+(px|pt|em|rem|%)$/],
      'margin-right': [/^[\d.]+(px|pt|em|rem|%)$/],
      padding: [/^[\d\s.a-z%-]+$/i],
      'padding-top': [/^[\d.]+(px|pt|em|rem|%)$/],
      'padding-bottom': [/^[\d.]+(px|pt|em|rem|%)$/],
      'padding-left': [/^[\d.]+(px|pt|em|rem|%)$/],
      'padding-right': [/^[\d.]+(px|pt|em|rem|%)$/],
      border: [/^[\d\s.a-z#%(),-]+$/i],
      'border-top': [/^[\d\s.a-z#%(),-]+$/i],
      'border-right': [/^[\d\s.a-z#%(),-]+$/i],
      'border-bottom': [/^[\d\s.a-z#%(),-]+$/i],
      'border-left': [/^[\d\s.a-z#%(),-]+$/i],
      'border-radius': [/^[\d\s.a-z%]+$/i],
      'border-collapse': [/^(collapse|separate)$/],
      width: [/^(auto|[\d.]+(px|pt|em|rem|%))$/],
      'max-width': [/^[\d.]+(px|pt|em|rem|%)$/],
      height: [/^(auto|[\d.]+(px|pt|em|rem|%))$/],
      display: [/^(block|inline|inline-block|none|table|table-cell|table-row)$/],
      'vertical-align': [/^(top|middle|bottom|baseline)$/],
    },
  },
  disallowedTagsMode: 'discard',
  // Balises dont le CONTENU doit disparaitre avec elles. Par defaut sanitize-html
  // retire la balise mais garde son texte : un <title> ou un <head> colle depuis un
  // e-mail complet ressortait alors en clair tout en haut du message (l'objet
  // s'affichait en entete).
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
  // Pre-header masque (display:none) : ses styles de masquage ne survivent pas a
  // l'assainissement, il deviendrait visible en tete du message. On le retire.
  // Une image dont l'adresse a ete refusee (data:, http:...) perd son src : on retire
  // alors la balise entiere plutot que de laisser un cadre vide dans le message.
  exclusiveFilter: (frame) =>
    (frame.tag === 'div' && /display\s*:\s*none/i.test(frame.attribs?.style || '')) ||
    (frame.tag === 'img' && !frame.attribs?.src),
  transformTags: {
    // Force des liens sortants inoffensifs
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: { ...attribs, target: attribs.target || '_blank', rel: 'noopener noreferrer' },
    }),
    // Images du corps : jamais plus larges que l'ecran, sans bordure bleue (Outlook).
    img: (tagName, attribs) => {
      const style = String(attribs.style || '').trim().replace(/;+$/, '');
      const extra = [];
      if (!/(^|;)\s*max-width\s*:/i.test(style)) extra.push('max-width:100%');
      if (!/(^|;)\s*height\s*:/i.test(style)) extra.push('height:auto');
      if (!/(^|;)\s*border\s*:/i.test(style)) extra.push('border:0');
      return { tagName: 'img', attribs: { ...attribs, style: [style, ...extra].filter(Boolean).join(';') } };
    },
  },
};

/** Assainit un fragment HTML d'e-mail. */
function sanitizeEmailHtml(html) {
  return sanitizeHtml(String(html || ''), OPTIONS);
}

/**
 * Assainissement du HTML d'un e-mail RECU, destine au seul affichage dans
 * l'application. Les regles different de celles du HTML envoye :
 *
 *  - AUCUNE image n'est conservee. Une image distante dans un message entrant est
 *    un pixel de suivi en puissance : la charger signalerait au demarcheur que
 *    l'adresse est lue. La balise est remplacee par son texte alternatif.
 *  - Les liens perdent leur `href`. Rien ne doit pouvoir etre visite d'un clic
 *    depuis un message non sollicite ; l'adresse reste lisible en info-bulle.
 *  - Le rendu se fait par ailleurs dans une iframe `sandbox` vide, sans script.
 */
const INCOMING_OPTIONS = {
  ...OPTIONS,
  allowedTags: OPTIONS.allowedTags.filter((t) => t !== 'img'),
  exclusiveFilter: (frame) => frame.tag === 'div' && /display\s*:\s*none/i.test(frame.attribs?.style || ''),
  transformTags: {
    // Le lien reste visible et son adresse consultable, mais il n'est pas suivable.
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: { title: attribs.href ? `Lien : ${attribs.href}` : '', class: 'inert-link' },
    }),
    img: (tagName, attribs) => ({ tagName: 'span', attribs: { class: 'img-placeholder' },
      text: attribs.alt ? `[image : ${attribs.alt}]` : '[image non chargee]' }),
  },
};

function sanitizeIncomingHtml(html) {
  return sanitizeHtml(String(html || ''), INCOMING_OPTIONS);
}

/**
 * Texte brut approximatif tire d'un corps HTML.
 *
 * Les fins de bloc sont converties en sauts de ligne AVANT l'assainissement :
 * sans cela « <h1>Tarifs</h1><p>180 euros</p> » ressort en « Tarifs180 euros »,
 * deux mots colles qui faussent aussi bien l'extrait affiche que la recherche.
 */
const FINS_DE_BLOC = /<\/(p|div|h[1-6]|li|tr|td|th|section|article|blockquote|pre|figcaption)\s*>|<br\s*\/?>|<hr\s*\/?>/gi;

function htmlToText(html) {
  const espace = String(html || '').replace(FINS_DE_BLOC, '\n');
  return sanitizeHtml(espace, { allowedTags: [], allowedAttributes: {}, nonTextTags: OPTIONS.nonTextTags })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Echappe une valeur destinee a etre injectee dans du HTML (variables de fusion). */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Assainit un sujet d'e-mail : pas de CRLF (prevention d'injection d'en-tetes). */
function sanitizeHeaderValue(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 900);
}

module.exports = { sanitizeEmailHtml, sanitizeIncomingHtml, htmlToText, escapeHtml, sanitizeHeaderValue };
