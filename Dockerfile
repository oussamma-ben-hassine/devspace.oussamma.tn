FROM node:22-alpine

# Installation de Git, Bash et outils de base (strictement nécessaires pour les dépôts Git et le terminal)
RUN apk add --no-cache git bash curl wget python3 make g++

# Répertoire de travail
WORKDIR /app

# Copie des dépendances
COPY package.json ./

# Installation des paquets npm en mode production
RUN npm install --omit=dev

# Copie des fichiers sources
COPY . .

# Création du dossier workspace pour persistance (volume Coolify)
RUN mkdir -p /app/workspace

# Configuration globale minimale de Git pour le conteneur
RUN git config --system --add safe.directory "*" && \
    git config --system user.name "DevSpace" && \
    git config --system user.email "dev@oussamma.tn" && \
    git config --system init.defaultBranch main

# Exposition du port d'écoute
EXPOSE 3000

# Variables d'environnement intégrées (configurées pour Coolify)
ENV PORT=3000 \
    NODE_ENV=production \
    APP_URL=https://devspace.oussamma.tn \
    SSO_BASE_URL=https://sso-a.oussamma.tn \
    SSO_CLIENT_ID=client_424090bad2dcadc34cdda40f \
    SSO_CLIENT_SECRET=sec_RGhuA2Qsxu5YDZ_7NT4j8wNeWnGrd3l8E9dbeko0QcM \
    SSO_REDIRECT_URI=https://devspace.oussamma.tn/auth/callback \
    SSO_SCOPES="openid profile email" \
    WORKSPACE_DIR=/app/workspace \
    SESSION_SECRET=devspace-oussamma-super-secret-key-2026-prod

CMD ["node", "server.js"]
