'use strict';
const form = document.getElementById('form');
const erreur = document.getElementById('erreur');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erreur.hidden = true;
  const data = Object.fromEntries(new FormData(form));
  try {
    const r = await fetch('/api/auth/login', {
      cache: 'no-store',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    // La reponse n'est pas toujours du JSON : pendant un redemarrage, c'est le
    // reverse proxy qui repond, et sa page d'erreur est du HTML. Sans ce filet,
    // l'ecran affichait « Unexpected token < », ce qui ne dit rien a personne et
    // laisse croire a un mot de passe refuse.
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(
        j.error ||
          (r.status >= 500
            ? `L'application ne repond pas correctement (erreur ${r.status}). Reessayer dans un instant.`
            : `Connexion impossible (erreur ${r.status}).`)
      );
    }
    const next = new URLSearchParams(location.search).get('next') || '/';
    location.href = next.startsWith('/') ? next : '/';
  } catch (ex) {
    erreur.textContent = ex.message;
    erreur.hidden = false;
  }
});
