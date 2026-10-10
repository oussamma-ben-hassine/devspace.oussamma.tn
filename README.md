# DevSpace (devspace.oussamma.tn)

Espace de développement personnel en ligne, sécurisé par **SSO personnel (OIDC)**, connecté directement à l'**IA/LLM du SSO**, avec **isolation stricte par projet** et **dépôt Git obligatoire**.

---

## 🌟 Fonctionnalités Principales

1. **Authentification SSO OIDC & Sécurité** :
   - Connecté au SSO `https://sso-a.oussamma.tn` avec flux sécurisé PKCE (RFC 7636) et signature HMAC des états.
   - Sessions serveurs chiffrées avec cookies `HttpOnly` sécurisés.
   - Redirection automatique stricte HTTPS et compatibilité totale avec les reverse proxies Coolify / Traefik.

2. **Isolation Stricte par Projet** :
   - Tous les projets résident dans le répertoire racine `/app/workspace`.
   - Chaque projet dispose de son sous-dossier exclusif `/app/workspace/<projet>/`.
   - L'explorateur de fichiers, le terminal et les outils sont **strictement confinés** au projet sélectionné.
   - Protection rigoureuse contre les attaques par traversée de répertoires (`../` / path traversal).

3. **Dépôt Git Obligatoire** :
   - Aucun projet ne peut exister ou être ouvert dans l'espace de développement sans être un dépôt Git valide (`.git`).
   - Lors de la création d'un projet :
     - Soit clonage direct d'un dépôt Git existant (`git clone`).
     - Soit initialisation automatique avec branche `main`, `.gitignore`, `README.md` et premier commit (`git init`).
   - Outils Git intégrés dans l'interface : statut des fichiers modifiés, logs des commits, bouton de commit avec message.

4. **Copilot IA Universel (Passerelle LiteLLM & SSO)** :
   - Intégration avec la passerelle universelle LiteLLM (`https://ai.oussamma.tn/v1`) au standard universel OpenAI (`/v1/chat/completions`).
   - 100% agnostique de fournisseur (Google Gemini, OpenAI, Anthropic Claude, DeepSeek, Mistral, Ollama, etc.).
   - Découverte dynamique des modèles (`GET /v1/models`) et configuration synchronisée via le SSO (`/api/v1/integrations/ai/gateway-config`).
   - Conscience contextuelle du fichier actif, création automatique ou en 1 clic de fichiers dans le projet, et insertion dans l'éditeur.

5. **Éditeur de Code Monaco & Terminal Web** :
   - Moteur Monaco Editor (l'éditeur de VS Code) avec coloration syntaxique complète, raccourci `Ctrl+S`, onglets multiples.
   - Terminal interactif s'exécutant directement à la racine du projet sélectionné.

---

## 🚀 Déploiement sur Coolify (`collify.oussamma.tn`)

1. Connectez-vous à votre tableau de bord **Coolify** (`https://collify.oussamma.tn`).
2. Cliquez sur **+ New Resource** > **Public / Private Repository**.
3. Sélectionnez votre dépôt GitHub : `oussamma-ben-hassine/devspace.oussamma.tn`.
4. Spécifiez la branche : `main`.
5. Coolify détectera automatiquement le `Dockerfile`.
6. Dans la section **Configuration** > **General** :
   - **Domains** : `https://devspace.oussamma.tn`
   - **Exposed Port** : `3000`
7. Dans la section **Storages** (Persistance des projets) :
   - Cliquez sur **+ Add Storage**
   - **Volume Name** : `devspace-workspace`
   - **Destination Path** : `/app/workspace`
8. Cliquez sur **Deploy** !

---

## ⚙️ Variables d'Environnement

| Variable | Description | Valeur par défaut |
| :--- | :--- | :--- |
| `PORT` | Port d'écoute interne du serveur | `3000` |
| `APP_URL` | URL publique de l'application | `https://devspace.oussamma.tn` |
| `SSO_BASE_URL` | URL de base de votre serveur SSO | `https://sso-a.oussamma.tn` |
| `SSO_CLIENT_ID` | Client ID OAuth2 fourni par le SSO | `client_424090bad2dcadc34cdda40f` |
| `SSO_CLIENT_SECRET` | Secret client OAuth2 | `sec_RGhuA2Qsxu5YDZ_7NT4j8wNeWnGrd3l8E9dbeko0QcM` |
| `SSO_REDIRECT_URI` | URL de redirection de callback | `https://devspace.oussamma.tn/auth/callback` |
| `WORKSPACE_DIR` | Répertoire où sont stockés les projets | `/app/workspace` |
| `SESSION_SECRET` | Clé secrète de signature des sessions | `devspace-oussamma-super-secret-key-2026-prod` |
