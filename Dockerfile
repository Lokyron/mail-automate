# ---------------------------------------------------------------------------
# Inbox Agent — image de production.
#
# Deux etapes : la premiere compile better-sqlite3 (module natif, qui exige
# python3 et un compilateur), la seconde ne garde que le resultat. L'image finale
# n'embarque donc aucune chaine de compilation — moins de surface, et une image
# trois fois plus petite.
# ---------------------------------------------------------------------------
FROM node:22.12-alpine AS build

# better-sqlite3 se compile depuis les sources sur Alpine (musl) : sans ces
# paquets, l'installation echoue sur « gyp ERR! find Python ».
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` et non `npm install` : la version installee est exactement celle du
# verrou, aujourd'hui comme dans six mois.
RUN npm ci --omit=dev


FROM node:22.12-alpine

# Le module natif compile a l'etape precedente est lie a libstdc++.
RUN apk add --no-cache libstdc++ tzdata
ENV TZ=Europe/Paris

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Le dossier de donnees appartient a l'utilisateur non privilegie AVANT que le
# volume ne soit monte : Docker reprend les droits du dossier de l'image quand
# il initialise un volume vide. Sans cela, le volume appartient a root et
# l'application ne peut pas creer sa base — panne au premier demarrage, et dont
# la cause ne saute pas aux yeux.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Jamais root. L'utilisateur « node » des images officielles porte l'uid 1000.
USER node

# A l'interieur du conteneur, il FAUT ecouter sur toutes les interfaces, sinon
# la redirection de port ne mene nulle part. La protection est reportee sur
# l'hote, ou le port n'est publie que sur 127.0.0.1 (cf. docker-compose.yml).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090 \
    DB_PATH=/app/data/inbox-agent.db

EXPOSE 8090

# wget est fourni par busybox : pas besoin d'ajouter curl pour une sonde.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/api/health || exit 1

CMD ["node", "src/server.js"]
