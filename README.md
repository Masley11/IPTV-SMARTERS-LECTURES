# ONDA — IPTV en direct

Application IPTV en HTML/CSS/JavaScript vanilla, avec HLS.js local et une fonction Node Vercel servant de passerelle HTTPS vers un fournisseur Xtream Codes HTTP. Aucune base de données n'est nécessaire.

## Tester localement

```bash
npm run dev
```

Ouvrir `http://localhost:8080`. Les identifiants de **test** sont préremplis dans `app.js`, modifiables via Paramètres et enregistrés dans le `localStorage` du navigateur. La passerelle utilise le serveur défini par `XTREAM_SERVER` (par défaut, le serveur de test). Seuls les flux auxquels vous avez le droit d'accéder doivent être utilisés.

## Déployer sur Vercel

Importer ce dépôt sur Vercel avec **Root Directory = racine du dépôt**, framework **Other** (pas le sous-dossier `frontend` historique), sans commande de build et sans Output Directory personnalisé. Le fichier `vercel.json` et la fonction `api/iptv.js` sont à la racine. Si le serveur change, définir `XTREAM_SERVER` sur Vercel (ex. `https://votre-serveur.example`), redéployer, puis changer l'adresse dans Paramètres. Il n'y a rien à créer dans Supabase ou une autre base de données.

**Attention :** les identifiants de test inscrits dans `app.js` sont publics pour toute personne qui visite le site ou lit le dépôt. Ce prototype ne doit pas être publié ouvertement avec des accès réels. Pour un usage privé, retirez ces valeurs du code et protégez le déploiement (authentification / contrôle d'accès) avant de mettre de vrais identifiants. `localStorage` n'est pas un coffre-fort. Les URL de lecture contenant les identifiants peuvent apparaître dans les journaux du proxy. Ne mettez pas ce site en production publique tel quel.

Le navigateur ne peut pas appeler directement un serveur HTTP depuis Vercel HTTPS (contenu mixte et souvent CORS). Le proxy fournit l'API Xtream et transforme les playlists HLS `.m3u8` et leurs segments vers le même domaine. Le serveur Xtream **doit fournir de vrais flux HLS** : HLS.js ne décode pas un flux `.ts` brut et continu sans playlist. Certains flux peuvent échouer selon le codec/DRM/serveur, et le proxy Vercel (durée d'exécution, bande passante, quotas gratuits) n'est **pas adapté à un usage IPTV intensif ou garanti 100 % gratuit**. Les images de logos en HTTP ne sont pas affichées sur HTTPS. Si le fournisseur ne propose que `.ts`, il faut un transcodeur/serveur vidéo approprié, pas uniquement HLS.js.

Structure : `index.html` (interface), `style.css` (style), `app.js` (catalogue/lecteur), `assets/hls.min.js` (HLS.js 1.5.20), `api/iptv.js` (passerelle Vercel), `dev-server.js` (test local), `vercel.json` (déploiement).
