#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Installation d'Inbox Agent en une commande.
#
#   ./install.sh
#
# Le script construit l'image, cree le fichier .env, demande ce qui ne peut pas
# etre devine (mot de passe, identifiants de la boite, clef d'API), puis demarre
# le conteneur et attend qu'il se declare en bonne sante.
#
# Il est REJOUABLE : relance-le apres avoir change un reglage, il reutilise le
# .env existant et ne redemande que ce qui manque.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

gras=$(printf '\033[1m'); vert=$(printf '\033[32m'); jaune=$(printf '\033[33m')
rouge=$(printf '\033[31m'); fin=$(printf '\033[0m')

titre() { printf '\n%s== %s ==%s\n' "$gras" "$1" "$fin"; }
ok()    { printf '%s✓%s %s\n' "$vert" "$fin" "$1"; }
avis()  { printf '%s!%s %s\n' "$jaune" "$fin" "$1"; }
mort()  { printf '%s✗%s %s\n' "$rouge" "$fin" "$1" >&2; exit 1; }

# --------------------------------------------------------------- prerequis
titre "Verifications"

command -v docker >/dev/null 2>&1 || mort "Docker n'est pas installe. Voir https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || mort "Le greffon « docker compose » manque (paquet docker-compose-plugin)."
docker info >/dev/null 2>&1 || mort "Le service Docker ne repond pas. Le demarrer (systemctl start docker), ou lancer Docker Desktop."
ok "Docker $(docker version --format '{{.Server.Version}}') et compose $(docker compose version --short)"

# ------------------------------------------------------------------- .env
titre "Configuration"

if [ -f .env ]; then
  ok "Fichier .env existant, il est conserve."
else
  cp .env.example .env
  chmod 600 .env
  ok "Fichier .env cree a partir de .env.example."
fi

# Ecrit une valeur dans .env, en remplacant la ligne existante (meme commentee).
# La substitution passe par l'environnement et non par un motif sed : un mot de
# passe contenant & / \ ou | ne doit pas etre interprete.
regler() {
  CLE="$1" VAL="$2" awk '
    BEGIN { cle = ENVIRON["CLE"]; val = ENVIRON["VAL"]; fait = 0 }
    !fait && $0 ~ ("^#? ?" cle "=") { print cle "=" val; fait = 1; next }
    { print }
    END { if (!fait) print cle "=" val }
  ' .env > .env.nouveau && mv .env.nouveau .env
  chmod 600 .env
}

# Valeur actuelle d'une clef (vide si absente ou commentee).
lire() { sed -n "s/^$1=//p" .env | head -1; }

# Demande une valeur, en gardant celle deja presente si l'on valide a vide.
demander() {
  local cle="$1" invite="$2" secret="${3:-non}" actuel reponse
  actuel=$(lire "$cle")
  if [ -n "$actuel" ]; then
    if [ "$secret" = "oui" ]; then
      printf '%s [deja renseigne, Entree pour garder] : ' "$invite"
    else
      printf '%s [%s] : ' "$invite" "$actuel"
    fi
  else
    printf '%s : ' "$invite"
  fi

  if [ "$secret" = "oui" ]; then
    read -rs reponse; printf '\n'
  else
    read -r reponse
  fi
  [ -n "$reponse" ] && regler "$cle" "$reponse"
}

# Secret de session : genere, jamais demande.
if [ -z "$(lire SESSION_SECRET)" ]; then
  regler SESSION_SECRET "$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  ok "SESSION_SECRET genere."
fi

# ------------------------------------------------- dossier de donnees
titre "Dossier de donnees"

demander DATA_DIR "Ou garder la base (hors du dossier de l'application sur un serveur)" non
DATA=$(lire DATA_DIR); DATA=${DATA:-./data}
mkdir -p "$DATA"

# L'image tourne en uid 1000 (utilisateur « node »). Un montage lie appartenant
# a root est LE piege de cette installation : l'application ne peut pas creer sa
# base, et la cause ne saute pas aux yeux.
proprietaire=$(stat -c '%u' "$DATA" 2>/dev/null || stat -f '%u' "$DATA" 2>/dev/null || echo inconnu)
if [ "$proprietaire" != "1000" ]; then
  if chown 1000:1000 "$DATA" 2>/dev/null; then
    ok "Dossier $DATA donne a l'uid 1000."
  elif sudo -n chown 1000:1000 "$DATA" 2>/dev/null; then
    ok "Dossier $DATA donne a l'uid 1000 (via sudo)."
  elif [ "$(uname)" = "Darwin" ]; then
    # Docker Desktop fait lui-meme la correspondance des uid sur macOS.
    ok "Dossier $DATA pret (macOS : Docker Desktop gere les droits)."
  else
    avis "Impossible de donner $DATA a l'uid 1000. A faire a la main :"
    echo "    sudo chown 1000:1000 $DATA"
  fi
else
  ok "Dossier $DATA deja a l'uid 1000."
fi

# ------------------------------------------------------------------ image
titre "Construction de l'image"
docker compose build --quiet
ok "Image inbox-agent:latest construite."

# ---------------------------------------------------------- mot de passe
titre "Compte d'acces a l'interface"

demander ADMIN_USER "Identifiant" non

# Le mot de passe est-il a (re)definir ? Il l'est forcement s'il n'y en a pas ;
# sinon la question est posee, et c'est une porte de sortie necessaire : des le
# premier changement fait dans l'interface, l'empreinte vit EN BASE et l'emporte
# sur celle du .env. Reecrire le .env ne suffit donc plus, et sans cette etape il
# n'existait aucun moyen de reprendre la main depuis la machine.
redefinir=non
if [ -z "$(lire ADMIN_PASSWORD_HASH)" ]; then
  redefinir=oui
else
  ok "Mot de passe deja configure."
  printf 'Redefinir le mot de passe maintenant ? [o/N] : '; read -r rep
  case "${rep:-n}" in o|O) redefinir=oui ;; esac
fi

if [ "$redefinir" = "oui" ]; then
  while : ; do
    printf 'Mot de passe (12 caracteres minimum) : '; read -rs mdp; printf '\n'
    printf 'Repeter                             : '; read -rs mdp2; printf '\n'
    [ "$mdp" = "$mdp2" ] || { avis "Les deux saisies different."; continue; }
    [ ${#mdp} -ge 12 ] || { avis "Trop court."; continue; }
    break
  done
  # Le hachage se fait DANS l'image : aucune dependance Node n'est requise sur
  # l'hote. Le mot de passe passe par l'entree standard, jamais par un argument
  # de ligne de commande (visible dans la liste des processus).
  hash=$(printf '%s' "$mdp" | docker compose run --rm --no-deps -T --entrypoint node app scripts/hash-password.js | tr -d '\r\n')
  unset mdp mdp2
  [ -n "$hash" ] || mort "Le hachage du mot de passe a echoue."
  # Les `$` sont dedoubles : docker compose interprete ceux d'un env_file, et
  # une empreinte bcrypt en contient trois. Sans cela, l'empreinte arrive
  # tronquee dans le conteneur et la connexion echoue sans explication.
  regler ADMIN_PASSWORD_HASH "${hash//\$/\$\$}"
  ok "Mot de passe enregistre (hash bcrypt)."
  # L'empreinte en base l'emporte sur celle du .env : il faut l'effacer, sinon
  # le mot de passe qu'on vient de poser n'ouvrirait rien. Le conteneur n'est
  # pas forcement demarre a ce stade — l'echec est donc tolere, et rattrape par
  # la meme commande plus bas dans le script.
  if docker compose exec -T app node scripts/motdepasse.js --oublier >/dev/null 2>&1; then
    ok "Ancien mot de passe de l'interface efface : celui-ci prend effet."
  else
    oublier_au_demarrage=oui
  fi
fi

# --------------------------------------------------------------- la boite
titre "Boite mail (lecture)"
echo "Mot de passe d'APPLICATION Google, pas celui du compte :"
echo "  compte Google > Securite > Validation en deux etapes > Mots de passe des applications"
demander IMAP_USER "Adresse de la boite" non
demander IMAP_PASS "Mot de passe d'application" oui
[ -n "$(lire IMAP_USER)" ] && [ -n "$(lire IMAP_PASS)" ] && regler IMAP_ENABLED true

# --------------------------------------------------------------- le modele
titre "Modele de langage"
demander CLAUDE_API_KEY "Clef d'API Anthropic (console.anthropic.com)" oui

# --------------------------------------------------------------------- bot
titre "Salon Telegram (optionnel)"
printf 'Brancher un bot Telegram maintenant ? [o/N] : '; read -r rep
if [ "${rep:-n}" = "o" ] || [ "${rep:-n}" = "O" ]; then
  echo "Creer le bot aupres de @BotFather, puis relever ton identifiant via @userinfobot."
  demander TELEGRAM_BOT_TOKEN "Jeton du bot" oui
  demander TELEGRAM_CHAT_ID "Ton identifiant de salon (liste blanche)" non
  if [ -n "$(lire TELEGRAM_BOT_TOKEN)" ] && [ -n "$(lire TELEGRAM_CHAT_ID)" ]; then
    regler BOT_ENABLED true
    ok "Bot active."
  else
    avis "Jeton ou identifiant manquant : le bot reste desactive."
  fi
else
  ok "Bot laisse desactive (BOT_ENABLED=false). Rejouer ce script pour l'ajouter."
fi

# --------------------------------------------------------------------- TLS
titre "Acces distant (optionnel)"
printf 'Ajouter un HTTPS local (Caddy, certificat auto-signe) ? [o/N] : '; read -r rep
profil=()
if [ "${rep:-n}" = "o" ] || [ "${rep:-n}" = "O" ]; then
  profil=(--profile tls)
  # Sans cela, l'application ne voit pas que la requete est arrivee en HTTPS et
  # n'appose pas le drapeau Secure sur son cookie de session.
  regler TRUSTED_PROXIES "172.16.0.0/12"
  # Et sans CADDY_SITE, le certificat auto-signe ne peut pas etre delivre : le
  # navigateur annonce « site inaccessible » et rien dans l'application ne le
  # laisse deviner. On le demande donc plutot que de le supposer.
  defaut=$(hostname -I 2>/dev/null | awk '{print $1}')
  demander CADDY_SITE "Adresse par laquelle tu joindras l'interface (IP ou nom)${defaut:+, p. ex. $defaut}" non
  [ -n "$(lire CADDY_SITE)" ] || { [ -n "$defaut" ] && regler CADDY_SITE "$defaut"; }
  ok "Profil tls active pour $(lire CADDY_SITE), proxys Docker declares de confiance."
fi

# ------------------------------------------------------- mises a jour
titre "Mises a jour depuis l'interface (optionnel)"

echo "L'application depose une demande, un executeur lance par systemd fait le"
echo "travail en root, HORS du conteneur, et revient en arriere si la nouvelle"
echo "version ne demarre pas. Le conteneur ne voit jamais le socket Docker."
printf 'Installer ce dispositif ? [o/N] : '; read -r rep

if [ "${rep:-n}" = "o" ] || [ "${rep:-n}" = "O" ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    avis "systemd absent : dispositif indisponible sur cette machine (macOS, par exemple)."
    avis "Il s'installera sur le serveur. UPDATE_ENABLED reste a false ici."
  else
    APP_DIR=$(pwd)
    DATA_ABS=$(cd "$DATA" && pwd)

    if [ "${DATA_ABS#"$APP_DIR"}" != "$DATA_ABS" ]; then
      # L'executeur remplace le dossier de l'application par un renommage : une
      # base rangee dedans partirait avec, a la premiere mise a jour.
      mort "DATA_DIR ($DATA_ABS) est dans le dossier de l'application ($APP_DIR). Le mettre ailleurs, par exemple /var/lib/inbox-agent."
    fi

    demander UPDATE_REPO "Depot GitHub (il doit etre PUBLIC)" non
    DEPOT=$(lire UPDATE_REPO)

    # Fonctionne aussi bien lance en root (cas d'un conteneur LXC) que par un
    # utilisateur ordinaire.
    en_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

    en_root install -m 755 deploy/inbox-agent-update.sh /usr/local/bin/inbox-agent-update
    # Les chemins reels sont graves dans les unites : l'executeur ne doit rien
    # deviner de l'endroit ou il travaille.
    sed -e "s|^PathExists=.*|PathExists=${DATA_ABS}/update.request|" \
        deploy/inbox-agent-update.path | en_root tee /etc/systemd/system/inbox-agent-update.path >/dev/null
    sed -e "s|^Environment=APP_DIR=.*|Environment=APP_DIR=${APP_DIR}|" \
        -e "s|^Environment=DATA_DIR=.*|Environment=DATA_DIR=${DATA_ABS}|" \
        -e "s|^Environment=UPDATE_REPO=.*|Environment=UPDATE_REPO=${DEPOT}|" \
        deploy/inbox-agent-update.service | en_root tee /etc/systemd/system/inbox-agent-update.service >/dev/null
    en_root systemctl daemon-reload
    en_root systemctl enable --now inbox-agent-update.path
    regler UPDATE_ENABLED true
    ok "Dispositif installe et surveille : ${DATA_ABS}/update.request"
    ok "Depot suivi : ${DEPOT} (canaux stable/beta)"
  fi
else
  # Repondre « non » ne DESACTIVE rien : le script n'installe pas le dispositif,
  # il ne le retire pas. Si celui-ci est deja en place — installation
  # precedente, ou conteneur prepare a l'avance — annoncer qu'il est desactive
  # serait faux, et c'est le genre de message qu'on croit sur parole des mois
  # plus tard. On rapporte donc l'etat reel plutot qu'une supposition.
  if [ "$(lire UPDATE_ENABLED)" = "true" ] && [ -x /usr/local/bin/inbox-agent-update ]; then
    unite=$(systemctl is-enabled inbox-agent-update.path 2>/dev/null || echo "absente")
    ok "Mises a jour DEJA en place, rien n'a change (depot $(lire UPDATE_REPO), unite path : ${unite})."
  else
    ok "Mises a jour non installees. Rejouer ce script pour les ajouter."
  fi
fi

# ------------------------------------------------------------- demarrage
titre "Demarrage"

# La phase 0 est le defaut, et le script ne la leve JAMAIS tout seul : ouvrir
# l'ecriture sur une boite mail est une decision, pas une etape d'installation.
if [ "$(lire WRITE_ENABLED)" != "false" ]; then
  avis "WRITE_ENABLED n'est pas a false : l'application pourra ecrire dans la boite."
fi

docker compose ${profil[@]+"${profil[@]}"} up -d
ok "Conteneur demarre."

printf 'Attente de la sonde de sante'
for i in $(seq 1 30); do
  etat=$(docker inspect --format '{{.State.Health.Status}}' inbox-agent 2>/dev/null || echo inconnu)
  [ "$etat" = "healthy" ] && break
  printf '.'
  sleep 2
done
printf '\n'

# Rattrapage : si l'effacement de l'empreinte en base n'a pas pu se faire plus
# haut (conteneur pas encore demarre), il se fait maintenant qu'il repond.
if [ "${oublier_au_demarrage:-non}" = "oui" ]; then
  if docker compose exec -T app node scripts/motdepasse.js --oublier >/dev/null 2>&1; then
    ok "Ancien mot de passe de l'interface efface : le nouveau prend effet."
  else
    avis "Mot de passe de l'interface : effacement impossible. A faire a la main :"
    echo "    docker compose exec app node scripts/motdepasse.js --oublier"
  fi
fi

if [ "$etat" = "healthy" ]; then
  port=$(sed -n 's/^PORT_HOTE=//p' .env | head -1); port=${port:-8090}
  ok "Inbox Agent repond sur http://127.0.0.1:${port}"
  printf '\n%sPhase 0 : la boite Gmail n est jamais modifiee.%s\n' "$gras" "$fin"
  echo "Bascule WRITE_ENABLED=true dans .env, puis « docker compose up -d », quand"
  echo "le taux « Tri juste » affiche dans l interface te convient."
  printf '\nJournal  : docker compose logs -f app\nArret    : docker compose down\n'
  if [ "$(lire UPDATE_ENABLED)" = "true" ]; then
    printf 'MAJ      : onglet « Mises a jour » de l interface\n'
    printf 'Executeur: journalctl -u inbox-agent-update -f\n'
  fi
else
  mort "Le conteneur ne se declare pas en bonne sante. Voir : docker compose logs app"
fi
