'use strict';
/**
 * Interface de revue de la phase 0.
 *
 * Elle ne sert qu'a une chose : juger les propositions. Chaque verdict enrichit
 * les exemples transmis au modele, et les deux taux affiches en haut disent si
 * la phase 1 peut s'ouvrir.
 */
let csrf = '';
let labels = [];
let vue = 'attente';
let choisi = null;
let ecritureAutorisee = false;

const $ = (s) => document.querySelector(s);
const el = (t, cls, texte) => {
  const n = document.createElement(t);
  if (cls) n.className = cls;
  if (texte !== undefined) n.textContent = texte;
  return n;
};

function toast(message, duree = 3200) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, duree);
}

async function api(chemin, options = {}) {
  const r = await fetch(`/api${chemin}`, {
    // Ceinture et bretelles : le serveur interdit deja la mise en cache.
    cache: 'no-store',
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.body ? { 'x-csrf-token': csrf } : {}),
      ...options.headers,
    },
  });
  if (r.status === 401) return (location.href = '/login'), null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}

const dateCourte = (iso) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

/* ------------------------------------------------------------------ mesures */

async function chargerMesures() {
  const s = await api('/inbox/stats');
  if (!s) return;

  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);
  const m = $('#mesures');
  m.textContent = '';

  const cases = [
    ['Messages relevés', s.imap.total, `dont ${s.imap.sensibles} confidentiel(s)`],
    ['Tri juste', pct(s.tri.taux), `${s.tri.justes}/${s.tri.juges} jugés · ${s.tri.enAttente} en attente`],
    ['Brouillons gardés', pct(s.brouillons.taux), `${s.brouillons.gardes} gardés · ${s.brouillons.corriges} corrigés · ${s.brouillons.rejetes} rejetés`],
    ['Boîte', s.imap.connected ? 'connectée' : 'hors ligne', s.imap.lastSyncAt ? `relevé ${dateCourte(s.imap.lastSyncAt)}` : 'jamais relevée'],
  ];
  for (const [titre, valeur, sous] of cases) {
    const d = el('div', 'mesure');
    d.append(el('span', null, titre), el('b', null, String(valeur)), el('span', null, sous));
    m.append(d);
  }

  ecritureAutorisee = Boolean(s.ecritureAutorisee);

  const badge = $('#phase');
  badge.textContent = s.ecritureAutorisee ? 'Phase 1 — écriture autorisée' : 'Phase 0 — lecture seule';
  badge.className = `badge ${s.ecritureAutorisee ? 'ecriture' : 'lecture'}`;
}

/* -------------------------------------------------------------------- liste */

async function chargerListe() {
  const q = vue === 'attente' ? '?attente=1' : '';
  const j = await api(`/inbox${q}`);
  if (!j) return;

  const liste = $('#liste');
  liste.textContent = '';

  if (!j.messages.length) {
    liste.append(el('li', 'discret', vue === 'attente' ? 'Rien à juger. Relève la boîte.' : 'Aucun message.'));
    return;
  }

  for (const m of j.messages) {
    const li = el('li');
    li.dataset.id = m.id;
    if (m.id === choisi) li.classList.add('choisi');

    li.append(el('div', 'de', m.from_name || m.from_email), el('div', 'objet', m.subject));
    const bas = el('div', 'bas');
    bas.append(el('span', 'puce', m.label || 'non trié'));
    if (m.priorite === 'haute') bas.append(el('span', 'puce haute', 'haute'));
    if (m.repondre) bas.append(el('span', 'puce repondre', 'à répondre'));
    if (m.sensible) bas.append(el('span', 'puce confidentiel', 'confidentiel'));
    if (m.draft_id) bas.append(el('span', 'puce', 'brouillon'));
    bas.append(el('span', 'puce', dateCourte(m.received_at)));
    li.append(bas);

    li.addEventListener('click', () => ouvrir(m.id));
    liste.append(li);
  }
}

/* ------------------------------------------------------------------- detail */

async function ouvrir(id) {
  choisi = id;
  document.querySelectorAll('#liste li').forEach((li) => li.classList.toggle('choisi', Number(li.dataset.id) === id));

  const j = await api(`/inbox/${id}`);
  if (!j) return;

  const { message, pieces, triages, brouillon } = j;
  const d = $('#detail');
  d.className = 'detail';
  d.textContent = '';

  // En-tete
  const entete = el('div', 'entete');
  entete.append(
    el('div', 'objet', message.subject),
    el('div', 'discret', `${message.from_name ? `${message.from_name} ` : ''}<${message.from_email}> · ${dateCourte(message.sent_at || message.received_at)}`)
  );
  if (message.sensible) {
    entete.append(el('div', 'puce confidentiel', 'Courrier confidentiel : son contenu n\'est pas transmis au modèle.'));
  }
  if (pieces.length) {
    entete.append(el('div', 'discret', `Pièces jointes : ${pieces.map((p) => p.filename || '(sans nom)').join(', ')} — jamais téléchargées.`));
  }
  d.append(entete);

  // Corps. Le HTML du message est rendu dans une iframe sandbox vide : ni
  // script, ni formulaire, ni navigation. Le texte brut suffit le plus souvent.
  const corps = el('div', 'bloc');
  corps.append(el('h2', null, 'Message'));
  if (message.body_html) {
    const frame = el('iframe', 'html-recu');
    frame.setAttribute('sandbox', '');
    frame.srcdoc = message.body_html;
    corps.append(frame);
  } else {
    corps.append(el('div', 'corps', message.body_text || '(corps vide)'));
  }
  d.append(corps);

  d.append(blocTri(message, triages[0]));
  d.append(blocBrouillon(message, brouillon));
}

function blocTri(message, triage) {
  const bloc = el('div', 'bloc');
  bloc.append(el('h2', null, 'Tri proposé'));

  if (!triage) {
    const b = el('button', 'secondaire', 'Trier ce message');
    b.addEventListener('click', () => action(b, `/inbox/${message.id}/classer`, 'POST', {}, 'Trié.'));
    bloc.append(b);
    return bloc;
  }

  bloc.append(
    el('div', null, `${triage.label} · priorité ${triage.priorite} · ${triage.repondre ? 'à répondre' : 'aucune réponse attendue'}`),
    el('p', 'motif', `${triage.source === 'regle' ? 'Règle' : `Modèle (confiance ${Number(triage.confiance).toFixed(2)})`} — ${triage.motif || 'sans motif'}`)
  );
  if (triage.resume) bloc.append(el('p', 'motif', `Résumé : ${triage.resume}`));

  if (triage.applied_at) {
    bloc.append(el('p', 'motif', `🏷 Libellé posé dans Gmail (${triage.applied_folder || ''}).`));
  }

  if (triage.verdict) {
    bloc.append(
      el('p', 'motif', triage.verdict === 'ok'
        ? 'Validé tel quel.'
        : `Corrigé en « ${triage.label_corrige} ».`)
    );
    if (ecritureAutorisee && !triage.applied_at) bloc.append(rangeeLibelle(message, triage));
    return bloc;
  }

  const rangee = el('div', 'rangee');
  const ok = el('button', null, 'Le tri est juste');
  ok.addEventListener('click', () =>
    action(ok, `/inbox/triages/${triage.id}/verdict`, 'POST', { verdict: 'ok' }, 'Validé.')
  );

  const select = el('select');
  for (const l of labels) {
    const o = el('option', null, l.nom);
    o.value = l.nom;
    if (l.nom === triage.label) o.selected = true;
    select.append(o);
  }
  const corriger = el('button', 'secondaire', 'Corriger');
  corriger.addEventListener('click', () => {
    if (select.value === triage.label) return toast('Choisis un autre libellé pour corriger.');
    action(corriger, `/inbox/triages/${triage.id}/verdict`, 'POST',
      { verdict: 'corrige', labelCorrige: select.value }, 'Correction enregistrée, elle servira d\'exemple.');
  });

  rangee.append(ok, select, corriger);
  bloc.append(rangee);
  if (ecritureAutorisee && !triage.applied_at) bloc.append(rangeeLibelle(message, triage));
  return bloc;
}

/** Phase 1 : poser le libellé dans Gmail, en gardant ou non le message en boîte. */
function rangeeLibelle(message, triage) {
  const rangee = el('div', 'rangee');
  const poser = el('button', 'secondaire', `🏷 Poser « ${triage.label_corrige || triage.label} » dans Gmail`);
  poser.addEventListener('click', () =>
    action(poser, `/inbox/${message.id}/libelle`, 'POST',
      { label: triage.label_corrige || triage.label }, 'Libellé posé.')
  );
  const archiver = el('button', 'discret-btn', 'Poser et archiver');
  archiver.addEventListener('click', () =>
    action(archiver, `/inbox/${message.id}/libelle`, 'POST',
      { label: triage.label_corrige || triage.label, archiver: true }, 'Posé et archivé.')
  );
  rangee.append(poser, archiver);
  return rangee;
}

function blocBrouillon(message, brouillon) {
  const bloc = el('div', 'bloc');
  bloc.append(el('h2', null, 'Brouillon de réponse'));

  if (message.sensible) {
    bloc.append(el('p', 'motif', 'Aucun brouillon : ce courrier est hors de portée du modèle.'));
    return bloc;
  }

  if (!brouillon) {
    const b = el('button', 'secondaire', 'Rédiger un brouillon');
    b.addEventListener('click', () => action(b, `/inbox/${message.id}/brouillon`, 'POST', {}, 'Brouillon rédigé.'));
    bloc.append(b);
    return bloc;
  }

  bloc.append(el('div', 'discret', `Objet : ${brouillon.objet}`));

  const manques = JSON.parse(brouillon.questions || '[]');
  if (manques.length) {
    bloc.append(el('p', 'motif', `Informations manquantes signalées : ${manques.join(' · ')}`));
  }
  bloc.append(el('p', 'motif', `Confiance ${Number(brouillon.confiance).toFixed(2)} — ${brouillon.motif || ''}`));

  if (brouillon.sent_at) {
    bloc.append(el('div', 'corps', brouillon.corps_corrige || brouillon.corps));
    bloc.append(el('p', 'motif', `📤 Envoyé le ${dateCourte(brouillon.sent_at)}.`));
    return bloc;
  }
  if (brouillon.applied_at) {
    bloc.append(el('p', 'motif', `📥 Déposé dans ${brouillon.gmail_folder || 'les brouillons Gmail'} : relis-le dans Gmail.`));
  }

  if (brouillon.verdict) {
    bloc.append(el('div', 'corps', brouillon.corps_corrige || brouillon.corps));
    bloc.append(el('p', 'motif', { ok: 'Gardé tel quel.', corrige: 'Réécrit.', rejete: 'Rejeté.' }[brouillon.verdict]));
    if (ecritureAutorisee) bloc.append(rangeeEnvoi(brouillon));
    return bloc;
  }

  const zone = el('textarea');
  zone.value = brouillon.corps;
  bloc.append(zone);

  const rangee = el('div', 'rangee');
  const garder = el('button', null, 'Bon tel quel');
  garder.addEventListener('click', () =>
    action(garder, `/inbox/drafts/${brouillon.id}/verdict`, 'POST', { verdict: 'ok' }, 'Noté.')
  );
  const corrige = el('button', 'secondaire', 'Enregistrer ma version');
  corrige.addEventListener('click', () => {
    if (zone.value.trim() === brouillon.corps.trim()) return toast('Le texte est inchangé : utilise « Bon tel quel ».');
    action(corrige, `/inbox/drafts/${brouillon.id}/verdict`, 'POST',
      { verdict: 'corrige', corpsCorrige: zone.value }, 'Version enregistrée.');
  });
  const rejete = el('button', 'danger', 'Inutile');
  rejete.addEventListener('click', () =>
    action(rejete, `/inbox/drafts/${brouillon.id}/verdict`, 'POST', { verdict: 'rejete' }, 'Rejeté.')
  );
  const refaire = el('button', 'discret-btn', 'Refaire');
  refaire.addEventListener('click', () =>
    action(refaire, `/inbox/${message.id}/brouillon`, 'POST', { force: true }, 'Nouveau brouillon.')
  );

  rangee.append(garder, corrige, rejete, refaire);
  bloc.append(rangee);
  if (ecritureAutorisee) bloc.append(rangeeEnvoi(brouillon));
  return bloc;
}

/**
 * Phase 1 : dépôt dans Gmail et envoi.
 *
 * L'envoi se fait en deux temps, et l'interface ne peut pas sauter le premier :
 * « Envoyer… » demande le récapitulatif au serveur, qui délivre un jeton à
 * usage unique. Le bouton de confirmation n'existe qu'après, et porte ce jeton.
 */
function rangeeEnvoi(brouillon) {
  const zone = el('div');
  const rangee = el('div', 'rangee');

  if (!brouillon.applied_at) {
    const deposer = el('button', 'secondaire', '📥 Déposer dans Gmail');
    deposer.addEventListener('click', () =>
      action(deposer, `/inbox/drafts/${brouillon.id}/deposer`, 'POST', {}, 'Déposé dans les brouillons Gmail.')
    );
    rangee.append(deposer);
  }

  const preparer = el('button', null, '📤 Envoyer…');
  preparer.addEventListener('click', async () => {
    preparer.disabled = true;
    try {
      const prep = await api(`/inbox/drafts/${brouillon.id}/preparer-envoi`, { method: 'POST', body: '{}' });
      zone.querySelector('.recap')?.remove();
      zone.append(blocRecap(brouillon, prep));
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      preparer.disabled = false;
    }
  });
  rangee.append(preparer);

  zone.append(rangee);
  return zone;
}

function blocRecap(brouillon, prep) {
  const r = prep.recapitulatif;
  const bloc = el('div', 'recap');
  bloc.append(
    el('h3', null, 'À envoyer — relis avant de confirmer'),
    el('div', 'discret', `À : ${r.destinataire}`),
    el('div', 'discret', `Objet : ${r.objet}`),
    el('div', 'corps', r.corps),
    el('p', 'motif', `Confirmation valable ${Math.round(prep.expireDans / 60)} min · ${r.envoisRestants} envoi(s) restant(s) aujourd'hui.`)
  );

  const rangee = el('div', 'rangee');
  const confirmer = el('button', null, 'Confirmer l\'envoi');
  confirmer.addEventListener('click', () =>
    action(confirmer, `/inbox/drafts/${brouillon.id}/envoyer`, 'POST', { jeton: prep.jeton }, 'Envoyé.')
  );
  const annuler = el('button', 'discret-btn', 'Annuler');
  annuler.addEventListener('click', () => bloc.remove());
  rangee.append(confirmer, annuler);
  bloc.append(rangee);
  return bloc;
}

/** Appel + rafraichissement, avec le bouton desactive le temps de la reponse. */
async function action(bouton, chemin, methode, corps, message) {
  bouton.disabled = true;
  try {
    await api(chemin, { method: methode, body: JSON.stringify(corps) });
    toast(message);
    await Promise.all([chargerMesures(), chargerListe()]);
    if (choisi) await ouvrir(choisi);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    bouton.disabled = false;
  }
}

/* -------------------------------------------------------------------- regles */

async function chargerRegles() {
  const j = await api('/rules');
  if (!j) return;
  labels = j.labels;

  const select = $('#labels-regle');
  select.textContent = '';
  for (const l of labels) {
    const o = el('option', null, l.nom);
    o.value = l.nom;
    select.append(o);
  }

  const t = $('#table-regles');
  t.textContent = '';
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Ordre', 'Si', 'Alors', 'Priorité', 'Réponse', 'Note', '']) hr.append(el('th', null, h));
  thead.append(hr);
  t.append(thead);

  const tbody = el('tbody');
  for (const r of j.regles) {
    const tr = el('tr', r.actif ? '' : 'inactive');
    tr.append(
      el('td', null, String(r.ordre)),
      el('td', null, `${r.champ} ${r.operateur} « ${r.valeur} »`),
      el('td', null, r.label),
      el('td', null, r.priorite),
      el('td', null, r.repondre ? 'oui' : 'non'),
      el('td', null, r.note || '')
    );
    const td = el('td');
    const bascule = el('button', 'discret-btn', r.actif ? 'Désactiver' : 'Activer');
    bascule.addEventListener('click', async () => {
      await api(`/rules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ actif: !r.actif }) });
      chargerRegles();
    });
    const sup = el('button', 'danger', 'Supprimer');
    sup.addEventListener('click', async () => {
      await api(`/rules/${r.id}`, { method: 'DELETE', body: JSON.stringify({}) });
      chargerRegles();
    });
    td.append(bascule, sup);
    tr.append(td);
    tbody.append(tr);
  }
  t.append(tbody);
}

$('#form-regle').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/rules', {
      method: 'POST',
      body: JSON.stringify({
        champ: f.get('champ'),
        operateur: f.get('operateur'),
        valeur: f.get('valeur'),
        label: f.get('label'),
        priorite: f.get('priorite'),
        repondre: f.get('repondre') ? 1 : 0,
      }),
    });
    e.target.reset();
    toast('Règle ajoutée. Elle s\'appliquera aux prochains messages.');
    chargerRegles();
  } catch (ex) {
    toast(ex.message, 6000);
  }
});

/* --------------------------------------------------------------------- agent */

function tour(classe, texte) {
  const d = el('div', `tour ${classe}`, texte);
  $('#fil-agent').append(d);
  d.scrollIntoView({ block: 'nearest' });
  return d;
}

$('#form-agent').addEventListener('submit', async (e) => {
  e.preventDefault();
  const champ = e.target.question;
  const question = champ.value.trim();
  if (!question) return;
  champ.value = '';
  tour('moi', question);
  const attente = tour('agent', '…');

  try {
    const r = await api('/chat', { method: 'POST', body: JSON.stringify({ question }) });
    attente.textContent = r.texte || '(aucune réponse)';
    // Les messages cités sont ouverts à la demande : un numéro entre crochets
    // ne sert à rien si on ne peut pas aller voir le message.
    if (r.messagesCites?.length) {
      const rangee = el('div', 'rangee');
      for (const id of r.messagesCites) {
        const b = el('button', 'discret-btn', `Ouvrir [${id}]`);
        b.addEventListener('click', () => {
          document.querySelector('.onglets button[data-vue="attente"]').click();
          ouvrir(id);
        });
        rangee.append(b);
      }
      attente.append(rangee);
    }
  } catch (ex) {
    attente.textContent = `Échec : ${ex.message}`;
  }
});

$('#oublier').addEventListener('click', async () => {
  await api('/chat', { method: 'DELETE', body: '{}' });
  $('#fil-agent').textContent = '';
  toast('Fil oublié.');
});

/* --------------------------------------------------------------- mises a jour */

let sondeMaj = null;

async function chargerMaj({ verifier = false } = {}) {
  const carte = $('#carte-maj');
  const r = await api(`/update${verifier ? '?verifier=1' : ''}`);
  if (!r) return;
  carte.textContent = '';

  const ligne = (titre, valeur) => {
    const d = el('div', 'maj-ligne');
    d.append(el('span', 'discret', titre), el('b', null, valeur));
    carte.append(d);
  };

  const court = (c) => (c ? c.slice(0, 7) : '—');
  ligne('Dépôt', r.repo);
  ligne('Canal', `${r.canal} (branche ${r.branche})`);
  ligne('Version installée', `${r.installe.version || '—'} · ${court(r.installe.commit)}`);
  ligne('Installée le', r.installe.installeLe ? dateCourte(r.installe.installeLe) : 'installation manuelle');
  ligne('Dernier commit du canal', r.dernier ? `${court(r.dernier.commit)} — ${r.dernier.message}` : '—');

  // L'état de l'exécuteur, tel qu'il l'a écrit dans son fichier.
  if (r.etat.state !== 'idle') {
    const e = el('div', `maj-etat ${r.etat.state}`);
    e.textContent =
      { running: 'Mise à jour en cours', failed: 'La dernière mise à jour a échoué', done: 'Mise à jour terminée' }[
        r.etat.state
      ] || r.etat.state;
    if (r.etat.step) e.textContent += ` — étape « ${r.etat.step} »`;
    if (r.etat.message) e.append(el('div', 'motif', r.etat.message));
    carte.append(e);
  }

  if (r.erreur) carte.append(el('p', 'erreur', r.erreur));
  if (!r.enabled) {
    carte.append(el('p', 'motif', 'La mise à jour depuis l\'interface est désactivée (UPDATE_ENABLED).'));
  } else if (r.enRetard === false) {
    carte.append(el('p', 'motif', 'Cette instance est à jour.'));
  } else if (r.enRetard === null && !r.erreur) {
    carte.append(el('p', 'motif', 'Installation manuelle : la révision installée est inconnue, une mise à jour la fixera.'));
  }

  const rangee = el('div', 'rangee');

  const select = el('select');
  for (const c of r.canaux) {
    const o = el('option', null, `${c.id} — ${c.branche}`);
    o.value = c.id;
    if (c.id === r.canal) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', async () => {
    try {
      await api('/update/canal', { method: 'POST', body: JSON.stringify({ canal: select.value }) });
      toast(`Canal « ${select.value} ».`);
      chargerMaj();
    } catch (e) {
      toast(e.message, 6000);
    }
  });
  rangee.append(select);

  const verif = el('button', 'secondaire', 'Vérifier maintenant');
  verif.addEventListener('click', async () => {
    verif.disabled = true;
    try {
      await chargerMaj({ verifier: true });
      toast('Vérifié.');
    } finally {
      verif.disabled = false;
    }
  });
  rangee.append(verif);

  if (r.enabled && r.etat.state !== 'running') {
    const lancer = el('button', null, r.enRetard ? 'Installer la mise à jour' : 'Réinstaller le canal');
    lancer.addEventListener('click', async () => {
      lancer.disabled = true;
      try {
        await api('/update/lancer', { method: 'POST', body: '{}' });
        // Le serveur va redémarrer sous nos pieds : on suit l'état par sondage,
        // en tolérant les erreurs réseau que ce redémarrage provoque.
        toast('Mise à jour lancée. L\'application va redémarrer.', 8000);
        suivreMaj();
      } catch (e) {
        toast(e.message, 6000);
        lancer.disabled = false;
      }
    });
    rangee.append(lancer);
  }

  carte.append(rangee);
  carte.append(
    el('p', 'motif',
      'L\'application n\'écrit jamais son propre code : elle dépose une demande, ' +
      'et un exécuteur extérieur à elle fait le travail puis revient en arrière si la nouvelle version ne démarre pas.')
  );
}

/** Suit une mise à jour en cours, en acceptant que le serveur disparaisse. */
function suivreMaj() {
  clearInterval(sondeMaj);
  let restant = 60; // 5 minutes a 5 s
  sondeMaj = setInterval(async () => {
    restant -= 1;
    if (restant <= 0) return clearInterval(sondeMaj);
    try {
      const r = await fetch('/api/update', { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null));
      if (!r) return; // redemarrage en cours, on retente
      if (r.etat.state !== 'running') {
        clearInterval(sondeMaj);
        await chargerMaj();
        toast(r.etat.state === 'failed' ? 'Mise à jour en échec, version précédente remise.' : 'Mise à jour terminée.', 8000);
      }
    } catch {
      /* le serveur redemarre : c'est attendu */
    }
  }, 5000);
}

/* ----------------------------------------------------------------- reglages */

/**
 * Onglet Parametres.
 *
 * Deux regles tenues ici, et elles se voient a l'ecran :
 *  - UN CHAMP DE SECRET NE REAFFICHE JAMAIS SA VALEUR. Le serveur ne l'envoie
 *    pas ; le champ part vide et ne sert qu'a remplacer. On montre seulement
 *    « renseigne » et les quatre derniers caracteres, de quoi reconnaitre une
 *    clef collee de travers.
 *  - ON DIT TOUJOURS D'OU VIENT LA VALEUR EN SERVICE. Une pastille « .env » ou
 *    « modifié ici » sur chaque champ : la lecon du mot de passe, ou une
 *    precedence invisible avait enferme son utilisateur dehors.
 */
function champReglage(r) {
  const ligne = el('div', 'reglage');

  const entete = el('div', 'reglage-entete');
  entete.append(el('label', null, r.libelle));
  const pastille = el('span', `pastille ${r.source === 'base' ? 'modifie' : 'env'}`,
    r.source === 'base' ? 'modifié ici' : '.env');
  pastille.title = r.source === 'base'
    ? `Posé depuis cette page${r.majLe ? ` le ${dateCourte(r.majLe)}` : ''}. Vider le champ pour rendre la main au .env.`
    : 'Valeur du fichier .env. Elle sert tant que rien n’est posé ici.';
  entete.append(pastille);
  ligne.append(entete);

  let saisie;
  if (r.type === 'booleen') {
    saisie = el('input');
    saisie.type = 'checkbox';
    saisie.checked = r.valeur === 'true';
    const etiquette = el('label', 'case');
    etiquette.append(saisie, el('span', null, saisie.checked ? 'activé' : 'désactivé'));
    saisie.addEventListener('change', () => {
      etiquette.lastChild.textContent = saisie.checked ? 'activé' : 'désactivé';
    });
    ligne.append(etiquette);
  } else if (r.type === 'choix') {
    saisie = el('select');
    for (const c of r.choix) {
      const o = el('option', null, c);
      o.value = c;
      if (c === r.valeur) o.selected = true;
      saisie.append(o);
    }
    ligne.append(saisie);
  } else if (r.type === 'texte-long') {
    saisie = el('textarea');
    saisie.value = r.valeur || '';
    saisie.style.minHeight = '5rem';
    ligne.append(saisie);
  } else {
    saisie = el('input');
    saisie.type = r.type === 'secret' ? 'password' : r.type === 'nombre' || r.type === 'decimal' ? 'number' : 'text';
    if (r.type === 'decimal') saisie.step = '0.05';
    if (r.type === 'secret') {
      saisie.value = '';
      saisie.autocomplete = 'new-password';
      saisie.placeholder = r.renseigne ? `renseigné (${r.apercu}) — saisir pour remplacer` : 'non renseigné';
    } else {
      saisie.value = r.valeur || '';
      if (r.exemple) saisie.placeholder = r.exemple;
    }
    ligne.append(saisie);
  }

  saisie.name = r.cle;
  saisie.dataset.type = r.type;
  if (r.aide) ligne.append(el('p', 'motif', r.aide));
  return ligne;
}

async function chargerReglages() {
  const carte = $('#carte-reglages');
  carte.replaceChildren(el('p', 'discret', 'Chargement…'));
  const etat = await api('/reglages');
  if (!etat) return;

  const form = el('form', 'reglages');
  const avances = [];

  // Ce qui empeche un service de tourner, en tete : un service a l'arret doit
  // le dire a l'endroit ou cela se corrige.
  if (etat.avertissements?.length) {
    const avis = el('section', 'carte avis-reglages');
    avis.append(el('h2', null, 'À régler pour que tout fonctionne'));
    const liste = el('ul', 'liste-avis');
    for (const a of etat.avertissements) {
      const li = el('li');
      li.append(el('b', null, `${a.service} — `), document.createTextNode(a.message));
      liste.append(li);
    }
    avis.append(liste);
    form.append(avis);
  }

  for (const g of etat.groupes) {
    const dedans = etat.reglages.filter((r) => r.groupe === g.id);
    if (!dedans.length) continue;

    const bloc = el('section', 'carte groupe-reglage');
    bloc.append(el('h2', null, g.titre));
    if (g.aide) bloc.append(el('p', 'motif', g.aide));

    for (const r of dedans.filter((x) => !x.avance)) bloc.append(champReglage(r));

    const cachesIci = dedans.filter((x) => x.avance);
    if (cachesIci.length) {
      const repli = el('details', 'avance');
      repli.append(el('summary', null, `Réglages avancés (${cachesIci.length})`));
      for (const r of cachesIci) repli.append(champReglage(r));
      bloc.append(repli);
      avances.push(repli);
    }

    // Les essais de connexion existent deja cote serveur : on les offre la ou
    // ils servent, a cote des champs qu'ils eprouvent.
    const essai = { boite: '/system/test/imap', modele: '/system/test/modele', envoi: '/system/test/smtp' }[g.id];
    if (essai) {
      const b = el('button', 'secondaire', 'Tester la connexion');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const avant = b.textContent;
        b.textContent = 'Essai…';
        try {
          const r = await api(essai);
          toast(`${g.titre} : connexion établie. ${JSON.stringify(r).slice(0, 120)}`, 6000);
        } catch (ex) {
          toast(`${g.titre} : ${ex.message}`, 9000);
        } finally {
          b.disabled = false;
          b.textContent = avant;
        }
      });
      const rangee = el('div', 'rangee');
      rangee.append(b);
      bloc.append(rangee);
    }
    form.append(bloc);
  }

  // Ce qui se montre sans se regler, avec la raison : une page de parametres
  // qui tait ce qu'elle ne peut pas faire laisse chercher un interrupteur qui
  // n'existe pas.
  if (etat.lectureSeule?.length) {
    const bloc = el('section', 'carte groupe-reglage');
    bloc.append(el('h2', null, 'Réglé en dehors de l’interface'));
    const table = el('table', 'table');
    for (const x of etat.lectureSeule) {
      const tr = el('tr');
      tr.append(el('td', null, x.libelle));
      tr.append(el('td', null, x.valeur));
      tr.append(el('td', 'discret', x.motif));
      table.append(tr);
    }
    bloc.append(table);
    form.append(bloc);
  }

  const barre = el('div', 'carte barre-reglages');
  const enregistrer = el('button', null, 'Enregistrer');
  enregistrer.type = 'submit';
  barre.append(enregistrer);
  barre.append(el('span', 'discret',
    'Vider un champ le rend à la valeur du .env. Les secrets ne sont jamais réaffichés.'));
  form.append(barre);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const valeurs = {};
    for (const champ of form.querySelectorAll('[name]')) {
      const type = champ.dataset.type;
      if (type === 'booleen') valeurs[champ.name] = champ.checked ? 'true' : 'false';
      else if (type === 'secret') {
        // Un champ de secret laisse vide ne veut PAS dire « efface-le » : il
        // veut dire « je n'y touche pas ». Sans cette distinction, ouvrir la
        // page et enregistrer effacerait le mot de passe de la boite.
        if (champ.value) valeurs[champ.name] = champ.value;
      } else valeurs[champ.name] = champ.value;
    }

    enregistrer.disabled = true;
    enregistrer.textContent = 'Enregistrement…';
    try {
      const r = await api('/reglages', { method: 'PUT', body: JSON.stringify({ valeurs }) });
      const repris = r.repris?.length ? ` Repris : ${r.repris.join(', ')}.` : '';
      toast(`Réglages enregistrés.${repris}`, 7000);
      await chargerReglages();
      await chargerMesures();
    } catch (ex) {
      toast(ex.message, 9000);
    } finally {
      enregistrer.disabled = false;
      enregistrer.textContent = 'Enregistrer';
    }
  });

  carte.replaceChildren(form);
}

/* ------------------------------------------------------------- mot de passe */

function ouvrirMdp() {
  $('#titre-mdp').textContent = 'Changer le mot de passe';
  $('#motif-mdp').textContent = 'Les autres sessions ouvertes seront fermées. Celle-ci reste ouverte.';
  $('#erreur-mdp').hidden = true;
  $('#form-mdp').reset();
  $('#ecran-mdp').hidden = false;
  $('#form-mdp').actuel.focus();
}

const fermerMdp = () => { $('#ecran-mdp').hidden = true; };

$('#motdepasse').addEventListener('click', ouvrirMdp);
$('#bandeau-changer').addEventListener('click', ouvrirMdp);
$('#annuler-mdp').addEventListener('click', fermerMdp);
$('#bandeau-plus-tard').addEventListener('click', () => { $('#bandeau-mdp').hidden = true; });
// Échap ferme toujours : aucune fenêtre de cette application ne retient qui que ce soit.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerMdp(); });

$('#form-mdp').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const erreur = $('#erreur-mdp');
  erreur.hidden = true;

  if (f.nouveau.value !== f.repeter.value) {
    erreur.textContent = 'Les deux saisies diffèrent.';
    erreur.hidden = false;
    return;
  }
  try {
    await api('/auth/motdepasse', {
      method: 'POST',
      body: JSON.stringify({ actuel: f.actuel.value, nouveau: f.nouveau.value }),
    });
    // La session courante survit : pas de retour a l'ecran de connexion, donc
    // aucun risque de tourner en rond.
    fermerMdp();
    $('#bandeau-mdp').hidden = true;
    toast('Mot de passe changé. Les autres sessions ont été fermées.', 6000);
  } catch (ex) {
    erreur.textContent = ex.message;
    erreur.hidden = false;
  }
});

/* -------------------------------------------------------------- navigation */

document.querySelectorAll('.onglets button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.onglets button').forEach((x) => x.classList.remove('actif'));
    b.classList.add('actif');
    vue = b.dataset.vue;
    $('#vue-regles').hidden = vue !== 'regles';
    $('#vue-agent').hidden = vue !== 'agent';
    $('#vue-maj').hidden = vue !== 'maj';
    $('#vue-reglages').hidden = vue !== 'reglages';
    $('#vue-messages').hidden = ['regles', 'agent', 'maj', 'reglages'].includes(vue);
    if (vue === 'regles') chargerRegles();
    else if (vue === 'maj') chargerMaj();
    else if (vue === 'reglages') chargerReglages();
    else if (vue !== 'agent') chargerListe();
  });
});

$('#relever').addEventListener('click', (e) =>
  action(e.target, '/inbox/sync', 'POST', {}, 'Relève lancée.')
);
$('#rediger').addEventListener('click', (e) =>
  action(e.target, '/inbox/brouillons/en-attente', 'POST', { limit: 10 }, 'Rédaction lancée.')
);
$('#deconnexion').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  location.href = '/login';
});

(async function demarrer() {
  const me = await fetch('/api/auth/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
  if (!me) return void (location.href = '/login');
  csrf = me.csrf;

  // Le mot de passe de l'installation est signale par un bandeau, et rien de
  // plus : l'interface reste utilisable quoi qu'il arrive.
  $('#bandeau-mdp').hidden = !me.doitChanger;

  await chargerRegles();
  await Promise.all([chargerMesures(), chargerListe()]);
})();
