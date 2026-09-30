# Protocole interne de l'Ads Transparency Center

Cartographie établie le 30/09/2026 en observant `adstransparency.google.com` (front-end Dart `acx-tfaar-tfaa-report-ui-frontend_auto_20260928`) et en rejouant les requêtes. Rien de tout cela n'est documenté par Google : à revérifier dès qu'un outil renvoie `UPSTREAM_CHANGED`.

## Transport

- `POST https://adstransparency.google.com/anji/_/rpc/<Service>/<Méthode>?authuser=`
- Corps `application/x-www-form-urlencoded` : `f.req=<JSON URL-encodé>`
- Réponse JSON à clés numériques (protobuf-JSON). Aucun cookie ni clé requis.
- ID inconnu : réponse 200 avec corps vide (`GetAdvertiserById`) ou `{}` (`SearchCreatives`).
- Blocage anti-robot : redirection vers `/sorry/` ou page HTML CAPTCHA.

## Régions

ID de ciblage géographique Google Ads = `2000 + code ISO 3166-1 numérique` (France 2250, Allemagne 2276, Royaume-Uni 2826, États-Unis 2840). Exception relevée : île de Man = 20340. Table générée : `src/data/regions.ts`.

## SearchService/SearchSuggestions

Requête : `{"1": "<texte>", "2": <nb annonceurs>, "3": <nb domaines>}`

Réponse `1[]` :
- `1` annonceur : `1` nom, `2` ID `AR…`, `3` pays, `4.2.1` / `4.2.2` fourchette du nombre d'annonces (toutes régions)
- `2` domaine : `1` domaine

## SearchService/SearchCreatives

Requête :

| Champ | Sens |
|---|---|
| `2` | taille de page (max 100 ; 200 renvoie une réponse vide) |
| `3.4` | format : 1 texte, 2 image, 3 vidéo |
| `3.6` | date de début AAAAMMJJ (annonces diffusées à partir de) |
| `3.7` | date de fin AAAAMMJJ **exclusive** (l'interface envoie fin + 1 jour) |
| `3.8` | `[ID région]` ; absent = toutes régions |
| `3.12` | `{"1": "<domaine>", "2": true}` ; `"1": ""` pour une recherche par annonceur |
| `3.13.1` | liste d'ID annonceurs |
| `3.14` | `[plate-forme]` : 1 Play, 2 Maps, 3 Search, 4 Shopping, 5 YouTube |
| `4` | curseur de page (champ `2` de la réponse précédente) |
| `7` | `{"1": 1, "2": 0, "3": <ID région>}` ; `{"1": 1}` pour toutes régions |

Réponse : `1[]` annonces, `2` curseur suivant, `4` / `5` fourchette du total estimé.

Annonce :
- `1` ID annonceur, `2` ID annonce `CR…`, `12` nom de l'annonceur, `14` domaine
- `4` format (1 texte, 2 image, 3 vidéo)
- `6` / `7` première / dernière diffusion `{"1": secondes, "2": nanos}` ; dates calendaires affichées en heure du Pacifique
- `13` nombre de jours de diffusion
- `3` aperçu : `3.3.2` balise `<img>` (les annonces Search sont rendues en PNG) ou `3.1.4` URL d'un script de rendu `content.js`

## LookupService/GetAdvertiserById

Requête : `{"1": "<AR…>", "3": {"1": 1}}`

Réponse `1` : `1` ID, `2` nom, `3` pays, `9.1` nom légal, `9.2` nom déclaré, `9.4` = 1 si identité vérifiée, `11` localisation.

## LookupService/GetCreativeById

Requête : `{"1": "<AR…>", "2": "<CR…>", "5": {"1": 1, "2": 0, "3": <ID région>}}`

Réponse `1` :
- `4` dernière diffusion (timestamp), `8` format, `22.1` nom de l'annonceur
- `5[]` variantes, même structure que l'aperçu (`3.2` image ou `1.4` script de rendu)
- `13.4` sélection d'audience : `1` données démographiques, `2` zones géographiques, `3` signaux contextuels, `4` centres d'intérêt, `5` listes de clients ; chaque entrée `{"1": inclus, "2": exclus}`, absente = non utilisée
- `16.1.1` thème Google (voir `src/data/topics.ts`)
- `17[]` statistiques par pays, `19` total :
  - `1` ID région, `2` / `3` fourchette d'impressions (borne basse absente = 0)
  - `4` première diffusion AAAAMMJJ (absente si antérieure au 01/03/2023), `5` dernière diffusion
  - `6` date à partir de laquelle les impressions seront publiées, `7` début du décompte (bornée au 01/03/2023)
  - `8[]` impressions par plate-forme `{"1": plate-forme, "2": bas, "3": haut}`
  - hors EEE/Turquie : seul `5` est renseigné

## Script de rendu (`content.js`)

`displayads-formats.googleusercontent.com/ads/preview/content.js?...` embarque le HTML de l'annonce dans une chaîne JS échappée (`\x3c`, `\x22`…). Après déséchappement :
- texte d'annonce Search : `"361903925":[null ×7, titre, URL affichée, description, …]` (4 annonces texte sur 100 dans l'échantillon SNCF Connect testé ; les autres ne sont exposées qu'en image)
- vidéo : ID YouTube dans l'URL de miniature `i.ytimg.com/vi/<ID>/`
- display / Demand Gen : images `tpc.googlesyndication.com/simgad/<ID>`
