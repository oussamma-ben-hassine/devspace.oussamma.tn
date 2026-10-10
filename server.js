import express from 'express';
import session from 'cookie-session';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFile, spawn, execSync } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import { WebSocketServer } from 'ws';

const execFileAsync = promisify(execFile);
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// GESTION DU BINAIRE GIT ET DU PATH D'EXÉCUTION
// =============================================================================
export function getExecEnv() {
  const extraPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/nix/var/nix/profiles/default/bin',
    '/root/.nix-profile/bin',
  ];
  const sep = process.platform === 'win32' ? ';' : ':';
  const currentPath = process.env.PATH || '';
  return {
    ...process.env,
    PATH: `${currentPath}${sep}${extraPaths.join(sep)}`,
  };
}

let GIT_BIN = 'git';

function resolveGitBinary() {
  const candidates = [
    'git',
    '/usr/bin/git',
    '/usr/local/bin/git',
    '/bin/git',
    '/nix/var/nix/profiles/default/bin/git',
    '/root/.nix-profile/bin/git',
  ];

  for (const bin of candidates) {
    try {
      execSync(`${bin} --version`, { env: getExecEnv(), stdio: 'ignore' });
      GIT_BIN = bin;
      console.log(`✓ Binaire Git détecté : ${bin}`);
      return true;
    } catch (_) {}
  }
  return false;
}

// Détection / installation automatique au démarrage
if (!resolveGitBinary()) {
  console.warn('⚠️ Git introuvable dans le PATH standard. Tentative d\'installation automatique...');
  try {
    execSync('apk add --no-cache git bash', { env: getExecEnv(), stdio: 'inherit' });
    resolveGitBinary();
  } catch (_) {}
  if (GIT_BIN === 'git') {
    try {
      execSync('apt-get update && apt-get install -y git', { env: getExecEnv(), stdio: 'inherit' });
      resolveGitBinary();
    } catch (_) {}
  }
}

// Configuration globale Git pour safe.directory et branch main
try {
  execFile(GIT_BIN, ['config', '--global', '--add', 'safe.directory', '*'], { env: getExecEnv() }, () => {});
  execFile(GIT_BIN, ['config', '--global', 'init.defaultBranch', 'main'], { env: getExecEnv() }, () => {});
  execFile(GIT_BIN, ['config', '--global', 'user.name', 'DevSpace'], { env: getExecEnv() }, () => {});
  execFile(GIT_BIN, ['config', '--global', 'user.email', 'dev@oussamma.tn'], { env: getExecEnv() }, () => {});
} catch (_) {}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || 'https://devspace.oussamma.tn').replace(/\/$/, '');

// =============================================================================
// CONFIGURATION SSO & LLM
// =============================================================================
const SSO_BASE_URL = (process.env.SSO_BASE_URL || 'https://sso-a.oussamma.tn').replace(/\/$/, '');
const SSO_CLIENT_ID = process.env.SSO_CLIENT_ID || 'client_424090bad2dcadc34cdda40f';
const SSO_CLIENT_SECRET = process.env.SSO_CLIENT_SECRET || 'sec_RGhuA2Qsxu5YDZ_7NT4j8wNeWnGrd3l8E9dbeko0QcM';
const SSO_REDIRECT_URI = process.env.SSO_REDIRECT_URI || `${APP_URL}/auth/callback`;
const SSO_SCOPES = process.env.SSO_SCOPES || 'openid profile email';

const SSO_AUTH_ENDPOINT = `${SSO_BASE_URL}/oauth/authorize`;
const SSO_TOKEN_ENDPOINT = `${SSO_BASE_URL}/oauth/token`;
const SSO_USERINFO_ENDPOINT = `${SSO_BASE_URL}/oauth/userinfo`;
const SSO_LOGOUT_ENDPOINT = `${SSO_BASE_URL}/oauth/logout`;
const SSO_GATEWAY_CONFIG_ENDPOINT = `${SSO_BASE_URL}/api/v1/integrations/ai/gateway-config`;

const DEFAULT_LITELLM_BASE_URL = (process.env.LITELLM_BASE_URL || 'https://ai.oussamma.tn/v1').replace(/\/+$/, '');
const DEFAULT_LITELLM_API_KEY = process.env.LITELLM_API_KEY || 'sk-oussamma-master-gateway-2026';
const DEFAULT_LITELLM_MODEL = process.env.LITELLM_DEFAULT_MODEL || 'gemini/gemini-3.1-flash-lite-preview';

// Dossier racine des workspaces
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_DIR || path.join(__dirname, 'workspace'));
if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

// Détection de proxy pour Coolify / Traefik
app.set('trust proxy', true);

// Redirection automatique stricte vers HTTPS + HSTS
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  const protoHeader = req.headers['x-forwarded-proto'];
  const isHttp = protoHeader === 'http' || (protoHeader && !protoHeader.includes('https')) || (!protoHeader && req.protocol === 'http');

  if (isHttp && !req.path.startsWith('/health') && !req.path.startsWith('/api/health')) {
    const host = req.headers.host || 'devspace.oussamma.tn';
    return res.redirect(301, `https://${host}${req.originalUrl || req.url}`);
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Sessions serveur sécurisées
const SESSION_SECRET = process.env.SESSION_SECRET || 'devspace-oussamma-super-secret-key-2026-prod';
const sessionMiddleware = session({
  name: 'devspace_session',
  keys: [SESSION_SECRET],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  secure: false, // Fonctionne avec le reverse-proxy Coolify
  sameSite: 'lax',
  httpOnly: true,
});
app.use(sessionMiddleware);

// =============================================================================
// HELPER PKCE & STATE
// =============================================================================
function generateOidcStateAndPKCE() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(`state:${nonce}`).digest('hex');
  const state = `${nonce}.${signature}`;
  const code_verifier = crypto.createHmac('sha256', SESSION_SECRET).update(`pkce:${nonce}`).digest('base64url').substring(0, 64);
  const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
  return { state, code_verifier, code_challenge };
}

function verifyOidcState(stateParam) {
  if (!stateParam || typeof stateParam !== 'string' || !stateParam.includes('.')) return false;
  const [nonce, signature] = stateParam.split('.');
  if (!nonce || !signature) return false;
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(`state:${nonce}`).digest('hex');
  try {
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSignature, 'hex');
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// =============================================================================
// GESTION DU REPERTOIRE WORKSPACE & ISOLATION STRICTE PAR PROJET
// =============================================================================
function sanitizeProjectName(name) {
  if (!name || typeof name !== 'string') return null;
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  if (!clean || clean === '.' || clean === '..') return null;
  return clean;
}

function getProjectDirectory(projectName) {
  const cleanName = sanitizeProjectName(projectName);
  if (!cleanName) return null;
  const targetDir = path.resolve(WORKSPACE_ROOT, cleanName);
  // Protection contre le Directory Traversal
  if (!targetDir.startsWith(WORKSPACE_ROOT + path.sep) && targetDir !== WORKSPACE_ROOT) {
    return null;
  }
  return targetDir;
}

function resolveSafePath(projectDir, relativePath = '') {
  const safeRelative = (relativePath || '').replace(/\\/g, '/');
  const targetPath = path.resolve(projectDir, safeRelative.replace(/^\/+/, ''));
  if (!targetPath.startsWith(projectDir + path.sep) && targetPath !== projectDir) {
    return null;
  }
  return targetPath;
}

async function isGitRepository(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  const gitDir = path.join(dirPath, '.git');
  if (!fs.existsSync(gitDir)) return false;

  // Si le dossier .git existe et contient le fichier HEAD ou le sous-dossier objects/refs, c'est structurellement un dépôt Git
  const hasHead = fs.existsSync(path.join(gitDir, 'HEAD'));
  const hasConfig = fs.existsSync(path.join(gitDir, 'config'));
  if (hasHead || hasConfig) {
    return true;
  }

  try {
    const { stdout } = await execFileAsync(GIT_BIN, ['-c', 'safe.directory=*', 'rev-parse', '--is-inside-work-tree'], {
      cwd: dirPath,
      env: getExecEnv(),
    });
    return stdout.trim() === 'true';
  } catch (err) {
    console.warn(`isGitRepository check warning on ${dirPath}:`, err.message);
    return false;
  }
}

async function runGit(args, cwd) {
  try {
    const safeArgs = ['-c', 'safe.directory=*', ...args];
    const { stdout, stderr } = await execFileAsync(GIT_BIN, safeArgs, {
      cwd,
      env: getExecEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    console.error(`runGit [${GIT_BIN} ${args.join(' ')}] failed:`, err.stderr || err.message);
    return {
      success: false,
      stdout: err.stdout ? err.stdout.trim() : '',
      stderr: err.stderr ? err.stderr.trim() : (err.message || 'Erreur git'),
    };
  }
}

// =============================================================================
// MIDDLEWARES DE SÉCURITÉ & AUTH
// =============================================================================
function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.access_token) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Non authentifié', loginUrl: '/auth/login' });
  }
  return res.redirect('/auth/login');
}

// Healthcheck pour Coolify
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// =============================================================================
// ROUTES SSO AUTHENTIFICATION
// =============================================================================
app.get('/auth/login', (req, res) => {
  const { state, code_verifier, code_challenge } = generateOidcStateAndPKCE();
  req.session.pkce_code_verifier = code_verifier;

  const authUrl = new URL(SSO_AUTH_ENDPOINT);
  authUrl.searchParams.set('client_id', SSO_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', SSO_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SSO_SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', code_challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.redirect(authUrl.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('Erreur retournée par le SSO:', error, error_description);
    return res.redirect(`/auth/login?error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect('/auth/login?error=code_manquant');
  }

  if (!verifyOidcState(state)) {
    console.warn('Paramètre state OIDC invalide');
    return res.redirect('/auth/login?error=state_invalide');
  }

  const nonce = state.split('.')[0];
  const derivedVerifier = crypto.createHmac('sha256', SESSION_SECRET).update(`pkce:${nonce}`).digest('base64url').substring(0, 64);
  const code_verifier = req.session?.pkce_code_verifier || derivedVerifier;

  try {
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: SSO_CLIENT_ID,
      client_secret: SSO_CLIENT_SECRET,
      code: code.toString(),
      redirect_uri: SSO_REDIRECT_URI,
      code_verifier: code_verifier,
    });

    const tokenRes = await fetch(SSO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: tokenParams,
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Erreur échange token SSO:', tokenRes.status, errBody);
      return res.redirect('/auth/login?error=echange_token_echoue');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;

    if (!accessToken) {
      return res.status(502).send('Jeton access_token non fourni par le SSO.');
    }

    // Récupérer le profil utilisateur
    let profile = null;
    try {
      const userRes = await fetch(SSO_USERINFO_ENDPOINT, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });
      if (userRes.ok) {
        profile = await userRes.json();
      }
    } catch (e) {
      console.warn('Impossible de récupérer /oauth/userinfo:', e.message);
    }

    const userRoles = profile?.roles || [];
    const isSuperAdmin = Boolean(
      profile?.is_superadmin ||
      userRoles.includes('super_admin') ||
      (profile?.email && profile.email.toLowerCase() === 'oussammabenhassine@gmail.com')
    );

    req.session.access_token = accessToken;
    req.session.refresh_token = refreshToken;
    req.session.user = {
      id: profile?.sub || profile?.id || 'sso-user',
      name: profile?.name || profile?.username || profile?.email || 'Développeur',
      email: profile?.email || 'user@oussamma.tn',
      avatar: profile?.picture || profile?.avatar || null,
      roles: userRoles,
      is_superadmin: isSuperAdmin,
    };

    delete req.session.pkce_code_verifier;
    res.redirect('/');
  } catch (err) {
    console.error('Erreur callback SSO:', err);
    res.status(500).send('Erreur lors de la finalisation de la connexion SSO.');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect(`${SSO_LOGOUT_ENDPOINT}?redirect_uri=${encodeURIComponent(APP_URL + '/auth/login')}`);
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    authenticated: true,
    user: req.session.user,
    ssoUrl: SSO_BASE_URL,
    workspaceRoot: WORKSPACE_ROOT,
  });
});

// =============================================================================
// API PROJETS (ISOLATION STRICTE ET GIT OBLIGATOIRE)
// =============================================================================
app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const entries = await fs.promises.readdir(WORKSPACE_ROOT, { withFileTypes: true });
    const projectList = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectName = entry.name;
        const projectDir = path.join(WORKSPACE_ROOT, projectName);
        const hasGit = await isGitRepository(projectDir);

        let branch = null;
        let lastCommit = null;
        let isDirty = false;
        let remoteUrl = null;

        if (hasGit) {
          const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
          branch = branchRes.success ? branchRes.stdout : 'unknown';

          const commitRes = await runGit(['log', '-1', '--format=%h - %s (%cr)'], projectDir);
          lastCommit = commitRes.success ? commitRes.stdout : 'Aucun commit';

          const statusRes = await runGit(['status', '--porcelain'], projectDir);
          isDirty = statusRes.success && statusRes.stdout.length > 0;

          const remoteRes = await runGit(['remote', 'get-url', 'origin'], projectDir);
          remoteUrl = remoteRes.success ? remoteRes.stdout : null;
        }

        projectList.push({
          name: projectName,
          path: projectDir,
          isGit: hasGit,
          branch,
          lastCommit,
          isDirty,
          remoteUrl,
        });
      }
    }

    res.json({ projects: projectList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Création d'un projet avec Git OBLIGATOIRE
app.post('/api/projects/create', requireAuth, async (req, res) => {
  const { name, type, gitUrl, description } = req.body;
  const cleanName = sanitizeProjectName(name);

  if (!cleanName) {
    return res.status(400).json({ error: 'Nom de projet invalide (lettres, chiffres, tirets uniquement).' });
  }

  const projectDir = getProjectDirectory(cleanName);
  if (!projectDir) {
    return res.status(400).json({ error: 'Chemin de projet non autorisé.' });
  }

  if (fs.existsSync(projectDir)) {
    return res.status(400).json({ error: `Le projet "${cleanName}" existe déjà.` });
  }

  try {
    if (type === 'clone') {
      if (!gitUrl || typeof gitUrl !== 'string' || !gitUrl.trim()) {
        return res.status(400).json({ error: 'URL Git obligatoire pour cloner un projet.' });
      }
      console.log(`Clonage du repo Git dans ${projectDir} : ${gitUrl}`);
      const cloneRes = await runGit(['clone', gitUrl.trim(), projectDir], WORKSPACE_ROOT);
      if (!cloneRes.success) {
        // En cas d'erreur de clonage, supprimer le dossier résiduel
        if (fs.existsSync(projectDir)) {
          await fs.promises.rm(projectDir, { recursive: true, force: true });
        }
        return res.status(400).json({ error: `Échec du clonage Git: ${cloneRes.stderr}` });
      }
    } else {
      // Type 'init' : initialisation obligatoire d'un dépôt Git
      await fs.promises.mkdir(projectDir, { recursive: true });

      // 1. Initialisation Git avec branche main
      const initRes = await runGit(['init', '-b', 'main'], projectDir);
      if (!initRes.success) {
        // Fallback sans -b si git plus ancien
        const initFallback = await runGit(['init'], projectDir);
        if (!initFallback.success) {
          console.error('git init failed:', initFallback.stderr);
          await fs.promises.rm(projectDir, { recursive: true, force: true });
          return res.status(500).json({ error: `Échec git init: ${initFallback.stderr}` });
        }
        await runGit(['checkout', '-b', 'main'], projectDir);
      }

      // 2. Configuration git de base pour les commits locaux
      const authorName = req.session?.user?.name || 'DevSpace User';
      const authorEmail = req.session?.user?.email || 'dev@oussamma.tn';
      await runGit(['config', 'user.name', authorName], projectDir);
      await runGit(['config', 'user.email', authorEmail], projectDir);

      // 3. Fichiers par défaut
      const readmeContent = `# ${cleanName}\n\n${description || 'Projet créé dans DevSpace.'}\n\n---\n*Espace de développement personnel DevSpace - Dépôt Git initialisé.*`;
      await fs.promises.writeFile(path.join(projectDir, 'README.md'), readmeContent, 'utf8');

      const gitignoreContent = `node_modules/\n.env\n*.log\n.DS_Store\n__pycache__/\nbuild/\ndist/\n`;
      await fs.promises.writeFile(path.join(projectDir, '.gitignore'), gitignoreContent, 'utf8');

      // 4. Commit initial obligatoire avec fallback auteur explicite
      await runGit(['add', '.'], projectDir);
      const commitRes = await runGit([
        '-c', `user.name=${authorName}`,
        '-c', `user.email=${authorEmail}`,
        'commit', '-m', 'chore: initial commit (devspace)'
      ], projectDir);
      if (!commitRes.success) {
        console.warn('Warning commit initial:', commitRes.stderr);
      }
    }

    // Vérification finale de sécurité : le dossier doit ABSOLUMENT être un dépôt Git
    const verifyGit = await isGitRepository(projectDir);
    if (!verifyGit) {
      console.error(`Validation Git finale échouée sur ${projectDir}`);
      await fs.promises.rm(projectDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'Échec de la validation Git obligatoire.' });
    }

    res.json({
      success: true,
      message: `Projet "${cleanName}" créé et initialisé avec succès en tant que dépôt Git.`,
      project: {
        name: cleanName,
        isGit: true,
        branch: 'main',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forcer l'initialisation Git pour un dossier existant non-git
app.post('/api/projects/:name/init-git', requireAuth, async (req, res) => {
  const projectDir = getProjectDirectory(req.params.name);
  if (!projectDir || !fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Projet introuvable.' });
  }

  try {
    await runGit(['init', '-b', 'main'], projectDir);
    await runGit(['config', 'user.name', req.session.user.name || 'DevSpace User'], projectDir);
    await runGit(['config', 'user.email', req.session.user.email || 'dev@oussamma.tn'], projectDir);
    await runGit(['add', '.'], projectDir);
    await runGit(['commit', '-m', 'chore: initialize git repository for devspace'], projectDir);

    res.json({ success: true, message: 'Dépôt Git initialisé avec succès.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// API FICHIERS (ISOLÉE STRICTEMENT AU PROJET SÉLECTIONNÉ)
// =============================================================================

// Middleware pour valider et restreindre au projet
async function checkProjectScope(req, res, next) {
  const projectDir = getProjectDirectory(req.params.name);
  if (!projectDir || !fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Projet introuvable ou chemin non autorisé.' });
  }

  // Règle stricte : Le projet DOIT être un dépôt Git pour pouvoir être ouvert
  const isGit = await isGitRepository(projectDir);
  if (!isGit) {
    return res.status(403).json({
      error: 'ACCÈS REFUSÉ : Ce dossier n\'est pas un dépôt Git. Tout projet DevSpace doit obligatoirement être un dépôt Git.',
      requiresGitInit: true,
      projectName: req.params.name,
    });
  }

  req.projectDir = projectDir;
  req.projectName = sanitizeProjectName(req.params.name);
  next();
}

// Lister récursivement l'arborescence du projet (et UNIQUEMENT de ce projet)
app.get('/api/projects/:name/tree', requireAuth, checkProjectScope, async (req, res) => {
  try {
    async function buildTree(dirPath, relativeDir = '') {
      const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const nodes = [];

      for (const item of items) {
        if (item.name === '.git' && relativeDir === '') {
          continue; // Masquer le dossier technique .git par défaut dans l'explorateur
        }

        const itemRelPath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
        const itemFullPath = path.join(dirPath, item.name);

        if (item.isDirectory()) {
          // Exclure les énormes dossiers pour la performance
          const isNodeModules = item.name === 'node_modules';
          nodes.push({
            name: item.name,
            path: itemRelPath,
            type: 'directory',
            children: isNodeModules ? [] : await buildTree(itemFullPath, itemRelPath),
          });
        } else {
          nodes.push({
            name: item.name,
            path: itemRelPath,
            type: 'file',
            size: (await fs.promises.stat(itemFullPath)).size,
          });
        }
      }

      // Trier : dossiers d'abord, puis fichiers par ordre alphabétique
      nodes.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
      });

      return nodes;
    }

    const tree = await buildTree(req.projectDir);
    res.json({ project: req.projectName, tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lire un fichier
app.get('/api/projects/:name/file', requireAuth, checkProjectScope, async (req, res) => {
  const filePath = resolveSafePath(req.projectDir, req.query.path);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Fichier introuvable ou accès refusé.' });
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Le chemin cible est un dossier.' });
    }
    if (stats.size > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Fichier trop volumineux (> 10 Mo).' });
    }

    const content = await fs.promises.readFile(filePath, 'utf8');
    res.json({ path: req.query.path, content, size: stats.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Écrire / Sauvegarder un fichier
app.post('/api/projects/:name/file', requireAuth, checkProjectScope, async (req, res) => {
  const { path: reqPath, content } = req.body;
  const filePath = resolveSafePath(req.projectDir, reqPath);
  if (!filePath) {
    return res.status(403).json({ error: 'Chemin de fichier interdit (évasion de sandbox).' });
  }

  try {
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
      await fs.promises.mkdir(parentDir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, content || '', 'utf8');
    res.json({ success: true, message: 'Fichier sauvegardé avec succès.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Créer un nouveau fichier ou dossier
app.post('/api/projects/:name/new-item', requireAuth, checkProjectScope, async (req, res) => {
  const { path: reqPath, type } = req.body; // type = 'file' | 'folder'
  const targetPath = resolveSafePath(req.projectDir, reqPath);
  if (!targetPath) {
    return res.status(403).json({ error: 'Chemin interdit.' });
  }

  if (fs.existsSync(targetPath)) {
    return res.status(400).json({ error: 'Cet élément existe déjà.' });
  }

  try {
    if (type === 'folder') {
      await fs.promises.mkdir(targetPath, { recursive: true });
    } else {
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }
      await fs.promises.writeFile(targetPath, '', 'utf8');
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un élément
app.delete('/api/projects/:name/item', requireAuth, checkProjectScope, async (req, res) => {
  const targetPath = resolveSafePath(req.projectDir, req.query.path);
  if (!targetPath || !fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'Élément introuvable.' });
  }
  if (targetPath === req.projectDir) {
    return res.status(400).json({ error: 'Impossible de supprimer la racine du projet via cet endpoint.' });
  }

  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// API GIT DU PROJET
// =============================================================================
app.get('/api/projects/:name/git/status', requireAuth, checkProjectScope, async (req, res) => {
  const statusRes = await runGit(['status', '--porcelain=v1'], req.projectDir);
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], req.projectDir);
  const logRes = await runGit(['log', '-10', '--pretty=format:%h|%an|%ad|%s', '--date=short'], req.projectDir);

  const rawLines = statusRes.stdout ? statusRes.stdout.split('\n').filter(Boolean) : [];
  const files = rawLines.map(line => {
    const code = line.substring(0, 2);
    const filePath = line.substring(3).trim();
    return { code, path: filePath };
  });

  const commits = (logRes.stdout || '').split('\n').filter(Boolean).map(line => {
    const [hash, author, date, message] = line.split('|');
    return { hash, author, date, message };
  });

  res.json({
    branch: branchRes.stdout || 'main',
    files,
    commits,
  });
});

app.post('/api/projects/:name/git/commit', requireAuth, checkProjectScope, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message de commit obligatoire.' });
  }

  await runGit(['config', 'user.name', req.session.user.name || 'DevSpace User'], req.projectDir);
  await runGit(['config', 'user.email', req.session.user.email || 'dev@oussamma.tn'], req.projectDir);

  const addRes = await runGit(['add', '-A'], req.projectDir);
  if (!addRes.success) {
    return res.status(500).json({ error: `Erreur git add: ${addRes.stderr}` });
  }

  const commitRes = await runGit(['commit', '-m', message.trim()], req.projectDir);
  if (!commitRes.success) {
    return res.status(400).json({ error: `Erreur git commit: ${commitRes.stderr}` });
  }

  res.json({ success: true, message: commitRes.stdout });
});

// =============================================================================
// API CONSOLE / TERMINAL (STRICTEMENT DANS LE DOSSIER DU PROJET)
// =============================================================================
app.post('/api/projects/:name/exec', requireAuth, checkProjectScope, (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'Commande invalide.' });
  }

  // Exécution strictement bornée au répertoire du projet
  const child = spawn(command, {
    cwd: req.projectDir,
    shell: true,
    env: {
      ...getExecEnv(),
      PROJECT_DIR: req.projectDir,
    },
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', data => {
    stdout += data.toString();
  });

  child.stderr.on('data', data => {
    stderr += data.toString();
  });

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    res.status(408).json({ error: 'Délai d\'exécution dépassé (timeout 60s)', stdout, stderr });
  }, 60000);

  child.on('close', code => {
    clearTimeout(timeout);
    res.json({ exitCode: code, stdout, stderr });
  });

  child.on('error', err => {
    clearTimeout(timeout);
    res.status(500).json({ error: err.message, stdout, stderr });
  });
});

// =============================================================================
// PASSERELLE IA UNIVERSELLE LITELLM & SSO (STANDARD OPENAI)
// =============================================================================

// Helper pour récupérer la configuration de la passerelle IA (dynamique via SSO ou variables d'environnement)
async function getAiGatewayConfig(userAccessToken) {
  let gatewayUrl = DEFAULT_LITELLM_BASE_URL;
  let apiKey = DEFAULT_LITELLM_API_KEY;
  let defaultModel = DEFAULT_LITELLM_MODEL;

  // Récupération dynamique depuis le SSO (recommandé si authentifié)
  if (userAccessToken) {
    try {
      const ssoRes = await fetch(SSO_GATEWAY_CONFIG_ENDPOINT, {
        headers: {
          'Authorization': `Bearer ${userAccessToken}`,
          'Accept': 'application/json',
        },
      });

      if (ssoRes.ok) {
        const configData = await ssoRes.json();
        if (configData.gateway_url) {
          const rawUrl = String(configData.gateway_url).replace(/\/+$/, '');
          gatewayUrl = rawUrl.endsWith('/v1') ? rawUrl : `${rawUrl}/v1`;
        }
        if (configData.api_key) {
          apiKey = String(configData.api_key).trim();
        }
        if (configData.default_model) {
          defaultModel = String(configData.default_model).trim();
        }
      }
    } catch (err) {
      console.warn('Impossible de récupérer la gateway-config SSO, repli sur les variables d\'environnement:', err.message);
    }
  }

  if (!gatewayUrl.endsWith('/v1')) {
    gatewayUrl = `${gatewayUrl}/v1`;
  }

  return { gatewayUrl, apiKey, defaultModel };
}

// Étape 1 : Liste dynamique des modèles via GET /v1/models de LiteLLM
app.get('/api/ai/models', requireAuth, async (req, res) => {
  const userAccessToken = req.session?.access_token;
  const { gatewayUrl, apiKey, defaultModel } = await getAiGatewayConfig(userAccessToken);

  try {
    const response = await fetch(`${gatewayUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json();
      const modelsList = (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
        description: m.owned_by ? `Fournisseur : ${m.owned_by}` : 'LiteLLM Model',
      }));

      // Si le modèle par défaut est présent, le placer en tête de liste
      if (defaultModel) {
        const defaultIndex = modelsList.findIndex(m => m.id === defaultModel);
        if (defaultIndex > -1) {
          const [def] = modelsList.splice(defaultIndex, 1);
          modelsList.unshift(def);
        } else if (modelsList.length === 0) {
          modelsList.unshift({ id: defaultModel, name: defaultModel, description: 'Modèle par défaut' });
        }
      }

      return res.json({ models: modelsList, defaultModel });
    } else {
      const errText = await response.text();
      console.warn(`Erreur récupération modèles LiteLLM (${response.status}):`, errText);
    }
  } catch (err) {
    console.warn('Erreur appel LiteLLM /models:', err.message);
  }

  // Repli gracieux si la passerelle est momentanément indisponible
  res.json({
    models: [
      { id: defaultModel, name: defaultModel, description: 'Modèle par défaut' },
    ],
    defaultModel,
  });
});

// Étape 2 : Appels LLM au format standard universel OpenAI via POST /v1/chat/completions
app.post('/api/ai/prompt', requireAuth, async (req, res) => {
  const { prompt, currentFile, fileContent, projectName, model, conversationHistory } = req.body;
  const userAccessToken = req.session?.access_token;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt vide.' });
  }

  const { gatewayUrl, apiKey, defaultModel } = await getAiGatewayConfig(userAccessToken);
  const targetModel = model || defaultModel;

  // Instructions système riches et adaptées au devspace
  let systemPrompt = `Tu es l'assistant de programmation intelligent de DevSpace, un IDE Web moderne.\n`;
  systemPrompt += `Projet actif: ${projectName || 'inconnu'}\n`;
  if (currentFile) {
    systemPrompt += `Fichier en cours d'édition: ${currentFile}\n`;
    if (fileContent) {
      systemPrompt += `\n--- CONTENU ACTUEL DU FICHIER (${currentFile}) ---\n${fileContent}\n--- FIN DU CONTENU ---\n\n`;
    }
  }
  systemPrompt += `Consigne importante: Quand tu génères du code pour un fichier ou que le développeur demande de créer un fichier (ex: index.html, style.css, script.js), indique TOUJOURS son nom précis avant le bloc au format [FICHIER: nom_du_fichier] suivi du bloc de code complet markdown \`\`\`lang ... \`\`\`.\n`;
  systemPrompt += `Fournis une réponse claire, complète et directement utilisable.`;

  // Construction des messages selon le standard OpenAI
  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  // Intégration de l'historique conversationnel si disponible
  if (Array.isArray(conversationHistory)) {
    for (const msg of conversationHistory) {
      if (msg && msg.role && msg.content) {
        messages.push({ role: msg.role, content: String(msg.content) });
      }
    }
  }

  messages.push({ role: 'user', content: prompt });

  try {
    const response = await fetch(`${gatewayUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: targetModel,
        messages: messages,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      let errorMsg = '';
      try {
        const errJson = await response.json();
        errorMsg = errJson.error?.message || errJson.detail || JSON.stringify(errJson);
      } catch (_) {
        errorMsg = await response.text();
      }
      console.error(`Erreur LiteLLM (${response.status}):`, errorMsg);
      return res.status(response.status).json({
        error: `Erreur passerelle IA LiteLLM (${response.status}) : ${errorMsg}`,
      });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '';

    res.json({
      reply,
      model: targetModel,
      usage: data.usage,
    });
  } catch (err) {
    console.error('Erreur appel passerelle LiteLLM:', err);
    res.status(500).json({ error: `Erreur de communication avec la passerelle IA LiteLLM : ${err.message}` });
  }
});

// =============================================================================
// SERVIR L'INTERFACE UTILISATEUR FRONTEND
// =============================================================================
app.use(express.static(path.join(__dirname, 'public')));

// Toute route Web retourne l'IDE si authentifié, sinon redirige vers /auth/login
app.get('*', (req, res) => {
  if (req.session && req.session.user && req.session.access_token) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/auth/login');
  }
});

// =============================================================================
// WEBSOCKET POUR TERMINAL EN TEMPS RÉEL (ISOLÉ AU PROJET)
// =============================================================================
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname.startsWith('/ws/terminal/')) {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const projectName = url.pathname.replace('/ws/terminal/', '').replace(/\/$/, '');
  const projectDir = getProjectDirectory(projectName);

  if (!projectDir || !fs.existsSync(projectDir)) {
    ws.send(JSON.stringify({ type: 'error', data: 'Projet introuvable ou accès refusé.\r\n' }));
    ws.close();
    return;
  }

  // Shell adapté au système hôte (sh sous Alpine/Linux, powershell sous Windows en local)
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : '/bin/sh';
  const shellArgs = isWindows ? ['-NoLogo'] : [];

  const proc = spawn(shell, shellArgs, {
    cwd: projectDir,
    env: {
      ...getExecEnv(),
      TERM: 'xterm-256color',
      PS1: `\\u@devspace:[${projectName}]$ `,
    },
  });

  ws.send(JSON.stringify({
    type: 'init',
    data: `\r\n\x1b[1;36m=== DevSpace Terminal: [${projectName}] ===\x1b[0m\r\n` +
          `\x1b[90mRépertoire isolé: ${projectDir}\x1b[0m\r\n\r\n`
  }));

  proc.stdout.on('data', data => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stdout', data: data.toString() }));
    }
  });

  proc.stderr.on('data', data => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stderr', data: data.toString() }));
    }
  });

  ws.on('message', message => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'stdin' && proc.stdin.writable) {
        proc.stdin.write(msg.data);
      }
    } catch {
      if (proc.stdin.writable) {
        proc.stdin.write(message.toString());
      }
    }
  });

  ws.on('close', () => {
    proc.kill();
  });

  proc.on('close', () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', data: '\r\nSession terminée.\r\n' }));
      ws.close();
    }
  });
});

// Démarrage du serveur
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 DevSpace opérationnel sur ${APP_URL} (Port ${PORT})`);
  console.log(`📁 Dossier Workspace : ${WORKSPACE_ROOT}`);
  console.log(`🔐 SSO Endpoint : ${SSO_BASE_URL}`);
  console.log(`🤖 LLM Endpoint : ${SSO_AI_PROMPT_ENDPOINT}`);
  console.log(`=======================================================`);
});
