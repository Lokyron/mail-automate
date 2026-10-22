'use strict';
const form = document.getElementById('form');
const erreur = document.getElementById('erreur');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erreur.hidden = true;
  const data = Object.fromEntries(new FormData(form));
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Connexion impossible.');
    const next = new URLSearchParams(location.search).get('next') || '/';
    location.href = next.startsWith('/') ? next : '/';
  } catch (ex) {
    erreur.textContent = ex.message;
    erreur.hidden = false;
  }
});
