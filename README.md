> **Configuration actuelle : accès public sans mot de passe ni quota StreamPulse.** Les anciennes consignes de quotas dans DEPLOIEMENT.md sont obsolètes.

# StreamPulse / ONDA — lecteur IPTV privé

Lecteur Web et Smart TV en HTML/CSS/JavaScript, avec passerelle Node.js pour Vercel. **Aucune chaîne, aucun abonnement et aucun identifiant IPTV ne sont inclus.** Utilisez uniquement vos propres accès autorisés.

## Version privée, sans relais vidéo Vercel

Cette version est conçue pour **une personne** sur **Vercel Hobby**, sans mot de passe de site, ni quota ou horaire de lecture StreamPulse. Le site est accessible à toute personne connaissant son adresse.

- **Vidéo directe** du fournisseur vers le navigateur : aucun segment vidéo ne traverse Vercel. Les anciennes actions de relais répondent `410`.
- Pas de quota quotidien ou mensuel, de plage horaire ni de limite de lectures simultanées imposés par StreamPulse. Les limites du fournisseur et de Vercel restent applicables.
- Catalogue IndexedDB pendant 24 h, EPG partagé pendant 10 min, petit cache local d’EPG et ressources statiques versionnées.
- Association TV par QR code chiffré de bout en bout, stockage temporaire Redis de 5 min et suppression après lecture.
- HLS.js, MPEG-TS et Shaka DASH, navigation télécommande, recherche, favoris et défilement virtuel pour les grands catalogues.

**Important :** dans l’application Vercel, le fournisseur doit accepter la lecture web directe en **HTTPS**, avec les règles CORS nécessaires. Pour les chaînes HTTP (fréquentes en IPTV) sur une Smart TV compatible, StreamPulse propose un **lecteur TV HTTP externe** : la page est servie par raw.githack, la vidéo va directement du fournisseur à la TV, et Vercel ne transporte toujours aucun segment vidéo. Ce lecteur externe conserve les bouquets, la recherche, les chaînes précédente/suivante et la navigation entre chaînes. Aucun relais vidéo n’est réactivé en cachette.

Le site est public : toute personne qui connaît son adresse peut y accéder. Une URL déjà remise au navigateur ne peut pas être révoquée chez le fournisseur par Vercel. Le mode éco réduit la consommation du fournisseur/réseau, **pas** un transit vidéo Vercel qui n’existe plus. Les allowances Hobby sont partagées par tout le compte : surveillez également vos autres projets.

## Démarrage local

Node.js 22 est recommandé.

```bash
npm ci
npm run dev
```

Ouvrez `http://localhost:8080`. Aucun mot de passe de site n’est requis. Ce mode utilise un stockage mémoire explicitement local, jamais autorisé sur Vercel. Ne l’exposez pas comme service de production.

## Vérification et build

```bash
npm run check
npm audit
```

Le build produit uniquement les fichiers publics autorisés dans `public/`, avec des empreintes de version. Il n’expose ni les fonctions serveur, ni les tests, ni les anciennes pages/relais. Les tests couvrent les sessions, quotas, métadonnées, association QR, absence de relais vidéo et garde de lecture du navigateur simulé avec jsdom.

Pour vérifier aussi la compilation Vercel avant publication :

```bash
npx vercel build --yes
```

Cette commande nécessite un projet lié et éventuellement un accès au tableau de bord Vercel. Un essai réel avec votre abonnement et votre téléviseur reste nécessaire.

## Déploiement gratuit

Le projet Vercel préparé est **streampulse-prive**, dans l’espace Hobby **masley-3**.

1. Définissez `SESSION_SECRET` dans les variables privées Vercel. Aucun mot de passe de site n’est utilisé.
2. Installez une base **Upstash Redis Free** et connectez-la au projet. Ne choisissez pas Pay as you go.
3. Redéployez après ajout des variables.
4. Vérifiez que le domaine est accessible depuis la TV.
5. Connectez votre playlist depuis **Ma Playlist** ou le QR code, puis testez une chaîne.

Les variables, les limites, les réglages de protection et la checklist complète sont dans **[DEPLOIEMENT.md](DEPLOIEMENT.md)**. Aucun secret ne doit être commité dans GitHub. En production, une configuration manquante ou un Redis indisponible bloque la lecture par sécurité.

## Ancien relais Cloudflare

Le fichier `worker/cloudflare-stream-relay.js` est **retiré du service et exclu du build**. Il n’est plus nécessaire et ne doit pas être déployé avec cette version. Voir son en-tête pour les raisons de sécurité et de conditions d’utilisation.

---

Interface d’origine conçue par **PremiumZone**. Adaptation privée et limitation de consommation pour un usage personnel non commercial.