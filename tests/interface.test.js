'use strict';
/**
 * « hidden » doit cacher. C'est tout ce que verifie ce fichier, et il a ete
 * ecrit apres une journee perdue.
 *
 * L'attribut HTML `hidden` n'agit que par la regle `[hidden] { display: none }`
 * de la feuille du NAVIGATEUR. Une regle de la feuille de l'AUTEUR l'emporte
 * toujours sur celle du navigateur : il a suffi d'ecrire `.ecran { display:
 * grid }` pour que `element.hidden = true` ne fasse plus rien. Le panneau de
 * mot de passe s'affichait alors des l'ouverture de l'application et ne se
 * refermait jamais — ni par « Annuler », ni par Echap, ni apres un changement
 * reussi.
 *
 * POURQUOI UN TEST DE PLUS. Il en existait deja un, « l'interface ne contient
 * plus aucun ecran bloquant » : il cherchait le mot « obligatoire » dans le
 * JavaScript et la presence d'un bandeau dans le HTML. Il passait au vert
 * pendant que l'interface etait inutilisable, parce qu'il lisait du TEXTE au
 * lieu de verifier un COMPORTEMENT, et parce qu'il ne regardait pas la feuille
 * de style. Trois commits ont tente de reparer « l'ecran bloquant » sans jamais
 * l'ouvrir. Un test qui ne peut pas echouer pour la vraie raison est pire que
 * pas de test : il rassure.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', 'public', ...p), 'utf8');
const css = lire('css', 'app.css');
const html = lire('index.html');
const js = lire('js', 'app.js');

/** Les declarations `display` de la feuille, par selecteur. */
function selecteursQuiPosentUnDisplay(feuille) {
  const sansCommentaires = feuille.replace(/\/\*[\s\S]*?\*\//g, '');
  const trouves = [];
  for (const bloc of sansCommentaires.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selecteur = bloc[1].trim();
    const corps = bloc[2];
    if (/(^|;)\s*display\s*:/.test(corps)) trouves.push({ selecteur, corps: corps.trim() });
  }
  return trouves;
}

test('la feuille remet « hidden » au-dessus de toute regle de display', () => {
  const regle = selecteursQuiPosentUnDisplay(css).find((r) => /\[hidden\]/.test(r.selecteur));
  assert.ok(regle, 'il manque une regle [hidden] : l attribut ne cachera rien');
  assert.match(regle.corps, /display\s*:\s*none/, '[hidden] doit poser display: none');
  // Sans `!important`, la premiere classe qui pose un `display` reprend la main
  // — et c'est exactement ce qui est arrive.
  assert.match(regle.corps, /!important/, '[hidden] doit l emporter sur toute classe');
});

test('tout element que l interface cache est bien couvert', () => {
  // Les identifiants que le JavaScript cache ou montre par `.hidden`.
  const caches = [...js.matchAll(/\$\('#([\w-]+)'\)\.hidden\s*=/g)].map((m) => m[1]);
  assert.ok(caches.length >= 3, `on s attend a plusieurs elements caches, trouve ${caches.length}`);

  for (const id of new Set(caches)) {
    // 1. l identifiant existe vraiment dans la page (garde contre une coquille,
    //    qui ne leve aucune erreur : `$('#typo')` vaut null et `.hidden` explose
    //    silencieusement dans un gestionnaire asynchrone).
    assert.match(html, new RegExp(`id="${id}"`), `#${id} est cache par le JS mais absent du HTML`);
  }

  // 2. et aucune classe ne peut leur reprendre la main, puisque [hidden] est
  //    `!important`. On le redit ici en nommant les coupables potentiels, pour
  //    que l echec soit lisible si quelqu un retire le `!important`.
  const avecDisplay = selecteursQuiPosentUnDisplay(css)
    .filter((r) => !/\[hidden\]/.test(r.selecteur))
    .map((r) => r.selecteur);
  const regleHidden = selecteursQuiPosentUnDisplay(css).find((r) => /\[hidden\]/.test(r.selecteur));
  assert.ok(
    /!important/.test(regleHidden?.corps || ''),
    `ces selecteurs posent un display et passeraient devant « hidden » : ${avecDisplay.join(', ')}`
  );
});

test('le panneau de mot de passe part cache, et peut toujours se refermer', () => {
  // Il est ferme dans la page livree...
  assert.match(html, /id="ecran-mdp"[^>]*\shidden/, 'le panneau doit partir ferme');
  // ...il a un bouton pour sortir...
  assert.match(html, /id="annuler-mdp"/, 'le panneau doit toujours etre annulable');
  // ...Echap le referme...
  assert.match(js, /Escape/, 'Echap doit refermer le panneau');
  // ...et le changement reussi le referme aussi, sans renvoyer a la connexion.
  assert.match(js, /fermerMdp\(\);?\s*\n\s*\$\('#bandeau-mdp'\)\.hidden = true;/, 'un changement reussi doit refermer');
});
