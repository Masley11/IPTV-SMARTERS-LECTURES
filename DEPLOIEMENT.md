# Déploiement privé et maîtrise de la consommation

## Ce qui est protégé

- **Vidéo directe obligatoire** : le navigateur parle directement au fournisseur IPTV. Les anciennes actions de relais `play`, `ts` et `resource` répondent `410`. Aucun segment vidéo ne transite par les fonctions Vercel.
- **Espace privé** : mot de passe serveur, cookie signé HttpOnly/SameSite, expiration après 24 h et révocation à la déconnexion. Les identifiants IPTV vont dans des en-têtes, pas dans les URL de l’API.
- **Une lecture à la fois** : verrou atomique Redis partagé entre téléviseur, téléphone et ordinateur. Une nouvelle fenêtre attend la fin de la minute réservée par l’autre fenêtre.
- **Quotas serveur** : 120 minutes/jour, 2 700 minutes/mois (45 h), de 06:00 à minuit UTC. UTC correspond à l’heure du Burkina Faso. Les compteurs Redis sont atomiques, conservés entre les déploiements et indépendants de l’horloge du navigateur.
- **Arrêt du lecteur** à l’expiration, à la pause, en arrière-plan et à la fermeture. Pas de reprise automatique en revenant dans l’application.
- **Catalogue local 24 h**, EPG partagé 10 min/local 15 min, compte fournisseur limité à une requête toutes les 15 min. Pas de cron, télémétrie serveur, analytics payant ou optimisation d’images.
- **Fichiers statiques versionnés** et cache local du navigateur. Seules les petites métadonnées et autorisations consomment Vercel.

### Limites importantes, sans promesse trompeuse

1. Le fournisseur doit autoriser **HTTPS et la lecture web directe (CORS)**. Un fournisseur HTTP-only, limité à une application propriétaire ou interdisant CORS peut ne pas fonctionner. Le relais vidéo n’est **pas** réactivé automatiquement : cela protégerait mal le quota Vercel. Testez une chaîne avant toute utilisation prolongée.
2. Les quotas contrôlent l’autorisation et le lecteur fourni. Une URL directe déjà remise au navigateur ne peut pas être révoquée chez le fournisseur par Vercel. Un client volontairement modifié pourrait continuer à lire chez le fournisseur, **mais pas faire passer cette vidéo par Vercel**. Ce dispositif convient à un usage personnel honnête, pas à de la revente ou du DRM.
3. Le temps est réservé par blocs de 60 secondes, renouvelés 10 secondes avant expiration. Le changement de chaîne réutilise le bloc courant. Un arrêt anticipé ne rembourse pas le temps réservé : le compteur est volontairement conservateur.
4. Les quotas Redis sont en **mois calendaire UTC**, pas à la date anniversaire de votre compte Vercel. Les plafonds sont bien inférieurs aux ressources Hobby, mais les quotas Vercel sont partagés par **tous les projets du compte**. Aucun réglage applicatif ne peut garantir seul le quota d’un compte entier. Surveillez aussi les autres projets, domaines et déploiements.
5. Hobby est réservé à un usage **personnel non commercial**. Une activité commerciale nécessite un plan adapté.

## Réglages déjà fournis

`vercel.json` choisit un site statique, trois petites fonctions Node.js à Paris (`cdg1`), 20 secondes maximum, 1 Gio de mémoire et Fluid Compute. Le middleware ne s’exécute que sur le document privé et les API, pas sur chaque image ou script. Le pare-feu applicatif limite les connexions et les requêtes authentifiées. Le build publie uniquement une liste explicite de fichiers ; les sources serveur, tests, anciennes pages et anciens relais ne sont pas des fichiers publics.

## Installation gratuite du compteur Redis

Le projet a besoin d’un stockage atomique partagé. **Ne pas utiliser un compteur localStorage ni la mémoire d’une fonction serverless.**

1. Ouvrez l’intégration : <https://vercel.com/integrations/upstash>.
2. Installez Upstash, choisissez le compte `masley-3` et le projet `streampulse-prive`.
3. Créez une base Redis **Free**, pas Pay as you go, de préférence en Europe. Une base suffit.
4. Connectez-la au projet pour les environnements Production et Preview. L’intégration ajoute les variables Redis ; les noms `UPSTASH_REDIS_REST_*` et `KV_REST_API_*` sont acceptés.
5. Vérifiez que le plan de la base reste Free. Ne partagez pas cette base avec un service très fréquenté.

À raison d’une autorisation par minute, 2 h/jour pendant 31 jours représentent environ 3 720 renouvellements, plus les connexions, consultations et associations QR. Cela reste très inférieur aux 500 000 commandes mensuelles du plan Redis gratuit consulté pendant la préparation. Les conditions du fournisseur peuvent évoluer.

## Variables privées à définir dans Vercel

Dans **Project → Settings → Environment Variables** :

| Variable | Valeur |
|---|---|
| `APP_ACCESS_PASSWORD` | Votre mot de passe personnel, au moins 12 caractères ; idéalement 16+ généré par un gestionnaire de mots de passe. Ne le mettez pas dans GitHub ou dans le chat. |
| `SESSION_SECRET` | Secret aléatoire indépendant d’au moins 32 caractères. |
| `UPSTASH_REDIS_REST_URL` | Fournie par l’intégration Redis. |
| `UPSTASH_REDIS_REST_TOKEN` | Fournie par l’intégration Redis ; secrète. |
| `XTREAM_SERVER` | Recommandé : origine HTTPS de votre seul fournisseur, sans identifiant ni chemin. Facultatif pour choisir le fournisseur depuis Ma Playlist. |
| `DAILY_WATCH_MINUTES` | `120` par défaut. |
| `MONTHLY_WATCH_MINUTES` | `2700` par défaut. |
| `WATCH_START_HOUR_UTC` | `6` par défaut. |
| `WATCH_END_HOUR_UTC` | `24` par défaut (minuit). |

Pour générer un secret **sur votre propre ordinateur**, sans le transmettre à un tiers :

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Ne réutilisez pas le mot de passe comme secret de session. Redéployez après modification des variables. En l’absence de Redis, de mot de passe valide ou de secret valide, la production refuse la connexion/lecture : **pas de contournement gratuit non sécurisé**.

## Protection du domaine et accès TV

Le mot de passe de l’application protège les API dans tous les cas. Le réglage Vercel **Deployment Protection / Vercel Authentication** peut ajouter un écran de connexion Vercel avant l’application. Pour utiliser le lecteur sur une TV avec le seul mot de passe de l’application, désactivez cette protection Vercel **pour le domaine de production concerné**, pas les protections applicatives. Gardez les previews protégées. Les liens `vercel.app` peuvent rester soumis à la protection par défaut de l’équipe ; vérifiez ce réglage dans le tableau de bord. Ne désactivez pas le mot de passe applicatif.

## Pare-feu Vercel supplémentaire recommandé

Dans **Project → Firewall**, Hobby permet **trois règles personnalisées au total, dont une seule règle de rate limiting**. Configuration recommandée :

1. **Deny** : bloquer `/api/iptv` lorsque le paramètre `action` vaut `play`, `ts` ou `resource`. Cela arrête les anciens clients avant même la fonction.
2. **Rate Limit** : limiter `/api/auth` à **10 requêtes par IP sur 10 minutes**, puis répondre `429`. C’est l’unique règle de rate limiting du projet.
3. Gardez la troisième règle en réserve pour un abus réellement observé ; n’ajoutez pas de blocage géographique ou de rate limit supplémentaire par défaut.

Le code possède déjà des limites Redis plus fines sur `/api/access` et les sessions ; le pare-feu constitue une couche supplémentaire. Ne bloquez pas les méthodes POST nécessaires à la connexion et aux quotas. N’ajoutez pas de règle géographique sans vérifier votre réseau mobile : les IP peuvent changer.

## Vérification mensuelle

Dans **Usage**, contrôlez Fast Data Transfer, Fast Origin Transfer, CDN Requests, Active CPU, Provisioned Memory et Function Invocations. Les vidéos directes ne doivent pas augmenter significativement Fast Origin Transfer pendant la lecture. Si cela arrive, vérifiez qu’aucune ancienne version n’est encore servie et qu’aucun autre projet ne relaie de vidéo.

Sur Hobby, le dépassement suspend généralement la ressource concernée au lieu de facturer un dépassement, mais peut interrompre le site. Ce projet ne désactive pas les quotas de Vercel et ne prétend pas offrir un « illimité gratuit ».

## Validation avant mise en service

```bash
npm ci
npm run check
npx vercel build --yes
```

Le dernier essai nécessite un projet Vercel lié et éventuellement un accès réseau au tableau de bord. Il compile localement, **sans publier**. Les tests automatisés vérifient notamment : session, révocation, absence de relais vidéo, atomicité du verrou dans l’adaptateur de test, plafonds, horaires, QR distribué, caches, garde de lecture Xtream/M3U et formulaire de connexion. Ils ne remplacent pas un essai avec votre fournisseur IPTV réel.

Checklist sur votre appareil :

- Connexion avec le mot de passe privé, puis Ma Playlist avec votre abonnement légal.
- Lecture d’une chaîne HTTPS, changement de chaîne, pause/reprise.
- Deuxième fenêtre : elle doit refuser la lecture simultanée.
- Fermeture/veille : les téléchargements doivent cesser.
- Après une modification de quota, redéploiement puis vérification du badge du lecteur.
- Déconnexion via le bouton de quota : l’ancienne session API doit être refusée.

## Références consultées

- [Vercel Hobby](https://vercel.com/docs/plans/hobby)
- [Règles d’usage équitable](https://vercel.com/docs/limits/fair-use-guidelines)
- [Middleware Vercel](https://vercel.com/docs/routing-middleware)
- [Pare-feu Vercel](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules)
- [Upstash Redis sur Vercel](https://upstash.com/docs/redis/howto/vercelintegration)
- [Tarifs Upstash Redis](https://upstash.com/pricing/redis)
