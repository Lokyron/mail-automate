# Deploiement d'Inbox Agent

## Installation

Sur la machine cible, en root :

```bash
git clone https://github.com/Lokyron/mail-automate.git /opt/inbox-agent
cd /opt/inbox-agent
./install.sh
```

`install.sh` fait le reste : image, `.env`, secrets, conteneur. Il propose
aussi d'installer le dispositif de mise a jour decrit ci-dessous.

## Mise a jour depuis l'interface

Trois fichiers, et une regle : **l'application n'ecrit jamais son propre code.**

| Fichier | Role |
|---|---|
| `inbox-agent-update.sh` | l'executeur, en root, sur l'hote |
| `inbox-agent-update.path` | surveille `update.request` et declenche le service |
| `inbox-agent-update.service` | lance l'executeur une fois ; porte la correspondance canal -> branche |

Installation manuelle :

```bash
install -m 755 deploy/inbox-agent-update.sh /usr/local/bin/inbox-agent-update
install -m 644 deploy/inbox-agent-update.{path,service} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now inbox-agent-update.path
```

Puis `UPDATE_ENABLED=true` dans le `.env`, et `docker compose up -d`.

### Pourquoi l'application ne fait pas le travail elle-meme

Elle depose un fichier, c'est tout. L'unite `path` le voit apparaitre et lance
l'executeur en root, qui telecharge la branche, construit l'image, remplace le
dossier, recree le conteneur, **attend la sonde de sante**, et remet la version
precedente si elle ne vient pas.

Deux proprietes a ne pas perdre de vue si ce dispositif est retouche :

1. **Le conteneur ne voit jamais le socket Docker.** La facon paresseuse de
   mettre a jour un conteneur serait de lui monter `/var/run/docker.sock`. Or ce
   socket, c'est root sur l'hote : on offrirait a une application exposee au
   courrier entrant le moyen de prendre la machine. L'executeur tourne dehors.

2. **La demande porte un nom de CANAL, jamais un nom de branche.** La
   correspondance `beta -> <branche>` vit dans l'environnement du service root.
   Le cote non privilegie ne peut donc pas faire installer une reference
   arbitraire — y compris s'il etait lui-meme compromis.

### Chemins attendus

| | Defaut | Pourquoi |
|---|---|---|
| `APP_DIR` | `/opt/inbox-agent` | remplace par un renommage a chaque mise a jour |
| `DATA_DIR` | `/var/lib/inbox-agent` | **hors** de `APP_DIR`, sinon la base partirait avec |
| uid du dossier de donnees | `1000` | l'utilisateur `node` de l'image |

`DATA_DIR` est un **montage lie** et non un volume nomme : l'unite `path` doit
pouvoir voir le fichier de demande apparaitre.

### Etat et retour arriere

L'executeur ecrit sa progression dans `$DATA_DIR/update.status`, que l'onglet
« Mises a jour » relit. En cas d'echec :

- l'ancien dossier revient depuis `$APP_DIR.precedent` ;
- l'ancienne image revient depuis l'etiquette `inbox-agent:precedent` ;
- le dossier fautif est garde en `$APP_DIR.echec` pour l'autopsie.

### Journal

```bash
journalctl -u inbox-agent-update -n 50        # l'executeur
docker compose logs -f app                    # l'application
cat /var/lib/inbox-agent/update.status        # le dernier etat
```

## Sans Docker

`inbox-agent.service` fait tourner l'application directement avec Node (service
non privilegie, `ProtectSystem=strict`, `UMask=0077`). L'executeur de mise a
jour ci-dessus est ecrit pour Docker ; une installation directe se met a jour
par `git pull && npm ci --omit=dev && systemctl restart inbox-agent`.
