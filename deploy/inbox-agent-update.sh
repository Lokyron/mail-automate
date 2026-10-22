#!/usr/bin/env bash
# Executeur de mise a jour d'Inbox Agent.
#
# Tourne en root, lance par inbox-agent-update.service quand l'application
# depose son fichier de demande. L'application n'execute jamais ce script et
# n'ecrit jamais dans son propre dossier : cette separation est tout l'objet du
# dispositif.
#
# Et une precision qui vaut d'etre lue : la facon paresseuse de mettre a jour un
# conteneur serait de lui donner le socket Docker. Le socket Docker, c'est root
# sur l'hote — on offrirait a une application exposee au courrier entrant le
# moyen de prendre la machine. Ici, le conteneur ne voit jamais Docker.
#
# La branche installee est celle du canal demande : stable suit UPDATE_BRANCH,
# beta suit UPDATE_BETA_BRANCH.
#
# Etapes : telecharger la branche en archive, construire l'image, echanger le
# dossier de l'application, recreer le conteneur, et revenir en arriere si la
# nouvelle version ne se declare pas en bonne sante.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/inbox-agent}
DATA_DIR=${DATA_DIR:-/var/lib/inbox-agent}
CONTENEUR=${CONTENEUR:-inbox-agent}
IMAGE=${IMAGE:-inbox-agent}
# uid de l'utilisateur « node » dans l'image : il doit pouvoir relire l'etat.
APP_UID=${APP_UID:-1000}
REPO=${UPDATE_REPO:-Lokyron/mail-automate}
BRANCH=${UPDATE_BRANCH:-main}
BETA_BRANCH=${UPDATE_BETA_BRANCH:-beta}
# Delai laisse au conteneur pour se declarer en bonne sante (secondes).
ATTENTE_SANTE=${ATTENTE_SANTE:-120}

FICHIER_DEMANDE="$DATA_DIR/update.request"
FICHIER_ETAT="$DATA_DIR/update.status"
ETAPE=depart

# `date -Is` est une extension GNU : sur BSD (macOS), elle echoue et
# l'horodatage ressortait vide dans le fichier d'etat — une degradation
# silencieuse, qui ne se voit qu'en relisant l'etat d'une mise a jour ratee.
horodatage() { date -Is 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }

etat() { # etat etape [message]
  # `local msg=${3-}` et non `${3//...}` directement : sous `set -u`, bash 5
  # refuse de developper un parametre non defini DANS une substitution, la ou
  # bash 3.2 (celui de macOS) laissait passer. Le script mourait donc des le
  # premier appel a deux arguments — « line 44: 3: unbound variable » — sans
  # meme pouvoir ecrire son fichier d'etat. Une regle a en retenir : un script
  # systeme se teste sur le shell de la CIBLE, pas sur celui du poste.
  local msg=${3-}
  printf '{"state":"%s","step":"%s","message":"%s","at":"%s"}\n' \
    "$1" "$2" "${msg//\"/}" "$(horodatage)" > "$FICHIER_ETAT"
  # Sans ce chown, le fichier appartient a root et l'application — qui tourne en
  # uid 1000 — ne peut plus le reecrire a la demande suivante.
  chown "$APP_UID" "$FICHIER_ETAT" 2>/dev/null || true
}
echec() { etat failed "$ETAPE" "$1"; exit 1; }
trap 'echec "l executeur s est arrete pendant : $ETAPE"' ERR

compose() { docker compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml" "$@"; }

# L'application ecrit le canal qu'elle veut, et seulement un NOM DE CANAL :
# c'est ici qu'un nom devient une branche, pour que le cote non privilegie ne
# puisse pas diriger l'executeur vers une autre reference. Tout ce qui sort de
# l'ordinaire retombe sur stable.
# `|| true` : une demande illisible ne doit pas declencher le piege ERR, elle
# signifie simplement stable.
CANAL=$(sed -n 's/^channel=\([a-z][a-z0-9]\{0,15\}\)$/\1/p' "$FICHIER_DEMANDE" 2>/dev/null | head -n1 || true)
case "$CANAL" in
  beta) CANAL=beta; BRANCH="$BETA_BRANCH" ;;
  *)    CANAL=stable ;;
esac

rm -f "$FICHIER_DEMANDE"

ETAPE=telechargement
etat running "$ETAPE"
# Meme systeme de fichiers que APP_DIR : l'echange final est un simple renommage.
STAGING=$(mktemp -d "${APP_DIR}.update-XXXXXX")
nettoyer() { [ -d "$STAGING" ] && rm -rf "$STAGING"; }
trap nettoyer EXIT
curl -fsSL --max-time 180 "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" \
  | tar -xz -C "$STAGING" --strip-components=1
[ -f "$STAGING/package.json" ] || echec "l archive telechargee n est pas Inbox Agent"
grep -q '"name": *"inbox-agent"' "$STAGING/package.json" || echec "l archive telechargee n est pas Inbox Agent"
[ -f "$STAGING/Dockerfile" ] || echec "l archive ne contient pas de Dockerfile"

ETAPE=version
etat running "$ETAPE"
SHA=$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/${REPO}/commits/${BRANCH}" \
      | sed -n 's/^  "sha": "\([0-9a-f]\{40\}\)".*/\1/p' | head -n1)
[ -n "$SHA" ] || echec "impossible de lire le commit de ${BRANCH} sur GitHub"

ETAPE=construction
etat running "$ETAPE"
# Le .env est repris AVANT la construction : docker compose en a besoin pour
# resoudre ses variables, et il porte les secrets de la boite mail.
[ -f "$APP_DIR/.env" ] && cp -a "$APP_DIR/.env" "$STAGING/.env"
docker build -t "${IMAGE}:nouveau" "$STAGING" >/dev/null

# Etiquette de secours : c'est elle qui permet le retour arriere, et elle est
# posee AVANT que « latest » ne bouge.
if docker image inspect "${IMAGE}:latest" >/dev/null 2>&1; then
  docker tag "${IMAGE}:latest" "${IMAGE}:precedent"
fi

ETAPE=echange
etat running "$ETAPE"
chown -R root:root "$STAGING"
# mktemp donne 0700, ou le service ne peut meme pas entrer : on redonne a
# l'arborescence la forme d'une installation normale, lisible par tous et
# modifiable par root seul.
chmod -R a+rX,go-w "$STAGING"
# Le .env est recopie apres, en gardant son mode restrictif : il contient le mot
# de passe d'application de la boite mail.
[ -f "$APP_DIR/.env" ] && cp -a "$APP_DIR/.env" "$STAGING/.env"

# VERSION va dans le dossier de DONNEES, pas dans celui de l'application :
# l'image est reconstruite a chaque fois, un fichier depose dedans ne
# survivrait pas. Lisible par tous, le conteneur doit pouvoir le relire.
printf '{"commit":"%s","branch":"%s","channel":"%s","installedAt":"%s"}\n' \
  "$SHA" "$BRANCH" "$CANAL" "$(horodatage)" > "$DATA_DIR/VERSION"
chmod 644 "$DATA_DIR/VERSION"

PRECEDENT="${APP_DIR}.precedent"
rm -rf "$PRECEDENT"
mv "$APP_DIR" "$PRECEDENT"
mv "$STAGING" "$APP_DIR"
trap - EXIT

ETAPE=redemarrage
etat running "$ETAPE"
docker tag "${IMAGE}:nouveau" "${IMAGE}:latest"
# `--force-recreate`, et le service nomme pour ne pas toucher a Caddy.
#
# Sans cela, une mise a jour pouvait se declarer REUSSIE sans avoir rien
# remplace : `compose up -d` compare la configuration du service, pas
# l'identifiant de l'image derriere l'etiquette. Quand la configuration n'a pas
# bouge, il repond « Container inbox-agent Running » et laisse l'ANCIEN
# conteneur en place — puis la sonde de sante le trouve evidemment en bonne
# sante, et l'executeur ecrit « termine ». Observe en vrai : VERSION annoncait
# le nouveau commit, l'etiquette `latest` pointait une nouvelle image, et le
# processus qui tournait etait celui d'avant.
compose up -d --force-recreate app >/dev/null

# On attend la SONDE DE SANTE, pas le simple fait que le conteneur tourne : un
# processus qui demarre puis refuse sa configuration serait « running » une
# seconde, et la mise a jour passerait pour un succes.
ETAPE=verification
etat running "$ETAPE"
SANTE=inconnue
for _ in $(seq 1 $((ATTENTE_SANTE / 3))); do
  SANTE=$(docker inspect --format '{{.State.Health.Status}}' "$CONTENEUR" 2>/dev/null || echo inconnue)
  [ "$SANTE" = "healthy" ] && break
  sleep 3
done

# La sonde ne dit que « ce conteneur repond ». Elle ne dit pas QUEL code il
# porte : c'est la lecon de la ligne ci-dessus, et elle se verifie plutot que de
# se supposer. On compare donc l'image du conteneur qui tourne a celle qu'on
# vient de construire.
IMAGE_VOULUE=$(docker image inspect --format '{{.Id}}' "${IMAGE}:nouveau" 2>/dev/null || echo inconnue)
IMAGE_SERVIE=$(docker inspect --format '{{.Image}}' "$CONTENEUR" 2>/dev/null || echo inconnue)
if [ "$SANTE" = "healthy" ] && [ "$IMAGE_VOULUE" != "$IMAGE_SERVIE" ]; then
  SANTE="image-non-remplacee"
fi

if [ "$SANTE" != "healthy" ]; then
  ETAPE=retour_arriere
  etat running "$ETAPE"
  rm -rf "${APP_DIR}.echec"
  mv "$APP_DIR" "${APP_DIR}.echec"
  mv "$PRECEDENT" "$APP_DIR"
  if docker image inspect "${IMAGE}:precedent" >/dev/null 2>&1; then
    docker tag "${IMAGE}:precedent" "${IMAGE}:latest"
  fi
  compose up -d --force-recreate app >/dev/null || true
  if [ "$SANTE" = "image-non-remplacee" ]; then
    echec "le conteneur n a pas ete remplace par la nouvelle image, la precedente a ete remise"
  fi
  echec "la nouvelle version ne s est pas declaree en bonne sante, la precedente a ete remise"
fi

etat done termine "canal ${CANAL} installe : ${BRANCH} en ${SHA:0:7}"
rm -rf "$PRECEDENT"
docker image rm "${IMAGE}:nouveau" >/dev/null 2>&1 || true
