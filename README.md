# ONDA — Lecteur IPTV Web & Smart TV (by PremiumZone)

**ONDA** est un lecteur média IPTV Web & Smart TV rapide, fluide et sans publicité, développé en HTML/CSS/JavaScript vanilla avec une passerelle serverless Node.js prête pour Vercel.

> **Important :** ONDA est un lecteur média neutre. Aucun flux TV, liste de chaînes ni identifiant n'est inclus dans ce dépôt. Chaque utilisateur connecte uniquement ses propres accès légaux Xtream Codes / M3U.

## Fonctionnalités clés

- **Association Smart TV par QR Code chiffrée de bout en bout (AES-256-GCM)** : scannez le QR Code affiché sur la TV avec votre téléphone, collez votre lien M3U ou vos accès Xtream, et vos chaînes s'ouvrent instantanément sur le téléviseur sans taper à la télécommande.
- **Double moteur vidéo (`HLS.js` + `mpegts.js`)** : lecture fluide des playlists `.m3u8` (avec suivi sécurisé HMAC des load-balancers externes) et bascule automatique vers le flux direct `.ts` (`MPEG-TS`).
- **Diagnostic temps réel des connexions (`max_connections`)** : détecte si votre abonnement est déjà utilisé sur un autre appareil (`1/1 active`) et optimise le zapping.
- **Navigation télécommande Smart TV** : navigation spatiale complète aux flèches directionnelles (`↑ ↓ ← →`, `Entrée`, `Retour`).
- **Protection SSRF intégrée** : filtrage strict des hôtes internes/privés sur la passerelle.

## Démarrage local

```bash
npm run dev
```

Puis ouvrez `http://localhost:8080`.

## Tests automatisés

```bash
npm test
```

## Déploiement sur Vercel

Déployez directement la racine du dépôt sur Vercel (aucune base de données requise) :
- Par défaut, chaque utilisateur peut connecter son propre serveur Xtream Codes.
- *(Optionnel)* Définissez la variable d'environnement `XTREAM_SERVER` si vous souhaitez verrouiller une instance privée sur un seul fournisseur.

---

Conçu par **PremiumZone**. Pour toute demande de licence marque blanche, intégration sur mesure ou partenariat, ouvrez une issue sur ce dépôt.
