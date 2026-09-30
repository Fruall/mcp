# ads-transparency-mcp-server

Serveur MCP pour le **Centre de transparence publicitaire Google** (Google Ads Transparency Center). Il permet à Claude de retrouver les comptes annonceurs d'une marque, de mesurer leur volume d'annonces par format et par plate-forme, de lister et de lire leurs annonces, et d'exporter des inventaires complets.

Le serveur interroge les endpoints internes du site `adstransparency.google.com` (Google ne publie pas d'API officielle pour les annonces commerciales). Voir [Limites](#limites).

## Outils

| Outil | Rôle |
|---|---|
| `gatc_search_advertisers` | Marque, société ou domaine → comptes annonceurs (`AR…`), pays, volume estimé, domaines associés |
| `gatc_get_advertiser` | Fiche d'un annonceur : nom légal, localisation, vérification, volume d'annonces dans un pays, répartition par format et plate-forme, annonces vues sur 30 jours |
| `gatc_compare_advertisers` | Tableau comparatif de 2 à 6 annonceurs ou domaines sur les mêmes indicateurs |
| `gatc_list_creatives` | Liste des annonces (200 par appel au plus) avec filtres pays, format, plate-forme, dates, `new_since` (nouvelles annonces), tri, pagination |
| `gatc_get_creative` | Détail d'une annonce : thème Google, impressions par pays et par plate-forme, critères d'audience, variantes (texte, vidéo YouTube, images), images renvoyées à Claude |
| `gatc_view_creatives` | Jusqu'à 12 annonces renvoyées en image pour que Claude lise les messages, offres et accroches |
| `gatc_export_creatives` | Export CSV ou JSON (jusqu'à 5 000 annonces ; 150 avec enrichissement impressions, thème et audience) |

Filtres communs : `region` (code pays ISO, `FR` par défaut, ou `anywhere`), `format` (`text`, `image`, `video`), `platform` (`search`, `youtube`, `shopping`, `maps`, `play`), `date_from` / `date_to` (AAAA-MM-JJ).

## Installation

Prérequis : Node.js 20 ou plus récent.

```bash
npm install
npm run build
npm test        # 37 tests sur des réponses réelles enregistrées
```

### Claude Desktop

Dans `claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "ads-transparency": {
      "command": "node",
      "args": ["/chemin/vers/ads-transparency-mcp-server/dist/index.js"],
      "env": { "GATC_DEFAULT_REGION": "FR" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add ads-transparency -e GATC_DEFAULT_REGION=FR -- node /chemin/vers/ads-transparency-mcp-server/dist/index.js
```

### Serveur distant (HTTP)

```bash
MCP_AUTH_TOKEN=un-secret-long PORT=3000 HOST=0.0.0.0 \
PUBLIC_BASE_URL=https://ads.exemple.com node dist/index.js --http
```

- Endpoint MCP : `POST /mcp` (Streamable HTTP sans état), en-tête `Authorization: Bearer <MCP_AUTH_TOKEN>`
- `GET /health` pour la supervision
- Avec `PUBLIC_BASE_URL`, les exports sont téléchargeables sur `/exports/<fichier>` (noms aléatoires, rien d'autre n'est servi)
- Sans `MCP_AUTH_TOKEN`, garder `HOST=127.0.0.1`

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `GATC_DEFAULT_REGION` | `FR` | Pays utilisé quand `region` n'est pas précisé |
| `GATC_LANG` | `fr` | Langue des libellés de thèmes et de pays (`fr` ou `en`) |
| `GATC_MIN_INTERVAL_MS` | `300` | Délai minimal entre deux appels à Google |
| `GATC_CONCURRENCY` | `2` | Appels simultanés vers Google |
| `GATC_TIMEOUT_MS` | `20000` | Délai d'expiration d'un appel |
| `GATC_EXPORT_DIR` | `~/gatc-exports` | Dossier des exports |
| `TRANSPORT` | `stdio` | `http` équivaut à `--http` |
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Écoute en mode HTTP |
| `MCP_AUTH_TOKEN` | aucun | Jeton exigé en mode HTTP |
| `PUBLIC_BASE_URL` | aucun | URL publique pour les liens d'export |

Derrière un proxy d'entreprise, renseigner `HTTPS_PROXY` et ajouter `NODE_USE_ENV_PROXY=1` dans `env` (vérifié avec Node 22.22).

## Exemples de demandes

- « Quels comptes annonceurs utilise SNCF et combien d'annonces chacun diffuse en France ? »
- « Compare l'empreinte publicitaire de sncf-connect.com, trainline.com et ouigo.com en France. »
- « Quelles nouvelles annonces parcasterix.fr a-t-il lancées depuis le 1er septembre ? Montre-les-moi et résume les accroches. »
- « Pour cette annonce, dans quels pays a-t-elle été diffusée et avec quels critères d'audience ? »
- « Exporte toutes les annonces vidéo YouTube de l'annonceur AR10288591614947360769 en France. »

## Données renvoyées

- **Volumes** : fourchettes arrondies par Google (« 4 000–5 000 »), reprises telles quelles. Une annonce peut tourner sur plusieurs plates-formes : les volumes par plate-forme se recoupent.
- **Recherche par domaine** : renvoie les annonces de tous les annonceurs qui pointent vers le domaine, agences comprises (les annonces de parcasterix.fr sont déclarées par CARAT FRANCE SAS).
- **Impressions** : fourchettes par pays et par plate-forme, publiées uniquement pour les pays de l'EEE et la Turquie, avec environ 90 jours de décalage. Hors de ces pays, seules les dates de diffusion sont connues.
- **Dates** : calendrier en heure du Pacifique, comme dans l'interface. Dans le détail d'une annonce, les dates sont bornées au 01/03/2023 (début du décompte) ; la vraie date de première diffusion des annonces plus anciennes figure dans `gatc_list_creatives`.
- **Texte des annonces Search** : Google l'expose en texte pour une minorité d'annonces (4 sur 100 dans l'échantillon SNCF Connect testé). Pour les autres, seule une image du rendu existe : le serveur la renvoie à Claude, qui la lit.
- **Vidéos** : ID et lien YouTube, miniature renvoyée en image.

## Limites

- Endpoints internes non documentés : Google peut les modifier sans préavis. Un changement se traduit par une erreur `UPSTREAM_CHANGED` ; la cartographie des champs est dans [docs/protocol.md](docs/protocol.md).
- Google peut limiter les volumes de requêtes venant d'une même adresse IP (CAPTCHA, HTTP 429). Le serveur espace les appels, met en cache les réponses (30 min pour les listes, 6 h pour les détails) et renvoie un message explicite en cas de blocage. Les IP de datacenter y sont plus exposées qu'un poste de travail.
- L'usage des données relève des conditions d'utilisation de Google et des conditions complémentaires du Centre de transparence publicitaire.
- Les annonces soumises à une limite d'âge ne sont pas visibles sans connexion Google.
- Pas de filtre « Display » dans l'API : utiliser `format: "image"` sans plate-forme.

## Développement

```
src/
  index.ts            transports stdio et HTTP
  server.ts           enregistrement des outils
  services/           client HTTP (limiteur, reprises), décodeurs RPC, scripts de rendu, cache
  tools/              un fichier par famille d'outils
  data/               pays et thèmes
test/
  fixtures/           réponses réelles enregistrées le 30/09/2026
  live/               point d'entrée pour tester le cœur dans un navigateur
docs/protocol.md      cartographie des champs
evaluation.xml        10 questions d'évaluation
```

`npm run gen:regions` régénère la table des pays.
