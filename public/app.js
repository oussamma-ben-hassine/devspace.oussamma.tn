// DevSpace Web IDE Client Logic
let monacoEditor = null;
let currentProject = null;
let currentFile = null;
let openTabs = []; // { path, name, content, originalContent, isDirty }
let wsTerminal = null;
let activePanel = 'explorer';
let createProjectType = 'init';
let currentTheme = localStorage.getItem('devspace_theme') || 'dark';

// Initialisation au chargement
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  if (window.lucide) {
    lucide.createIcons();
  }

  await loadCurrentUser();
  initMonaco();
  initEventListeners();
  await loadProjects();
  await loadAiModels();
});

// =============================================================================
// GESTION DU DOUBLE THÈME (BLANC & NOIR)
// =============================================================================
function initTheme() {
  setTheme(currentTheme);
}

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('devspace_theme', theme);

  const html = document.documentElement;
  const sunIcon = document.getElementById('themeIconSun');
  const moonIcon = document.getElementById('themeIconMoon');

  if (theme === 'dark') {
    html.classList.add('dark');
    if (sunIcon) sunIcon.classList.add('hidden');
    if (moonIcon) moonIcon.classList.remove('hidden');
    if (window.monaco && monacoEditor) {
      monaco.editor.setTheme('vs-dark');
    }
  } else {
    html.classList.remove('dark');
    if (sunIcon) sunIcon.classList.remove('hidden');
    if (moonIcon) moonIcon.classList.add('hidden');
    if (window.monaco && monacoEditor) {
      monaco.editor.setTheme('vs');
    }
  }
}

// =============================================================================
// CHARGEMENT UTILISATEUR SSO
// =============================================================================
async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) {
      window.location.href = '/auth/login';
      return;
    }
    const data = await res.json();
    if (data.user) {
      document.getElementById('userName').textContent = data.user.name || data.user.email;
      if (data.user.name) {
        document.getElementById('userAvatar').textContent = data.user.name.charAt(0).toUpperCase();
      }
    }
  } catch (err) {
    console.error('Erreur chargement utilisateur SSO:', err);
  }
}

// =============================================================================
// INITIALISATION DE MONACO EDITOR
// =============================================================================
function initMonaco() {
  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], function () {
    const isDark = document.documentElement.classList.contains('dark');
    monacoEditor = monaco.editor.create(document.getElementById('monacoInstance'), {
      value: '',
      language: 'javascript',
      theme: isDark ? 'vs-dark' : 'vs',
      fontSize: 13,
      minimap: { enabled: true },
      automaticLayout: true,
      tabSize: 2,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
    });

    // Raccourci Ctrl+S / Cmd+S pour sauvegarder
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveCurrentFile();
    });

    // Redimensionnement automatique fiable sur resize de fenêtre
    window.addEventListener('resize', () => {
      if (monacoEditor) monacoEditor.layout();
    });

    // Détection des modifications pour marquer l'onglet dirty
    monacoEditor.onDidChangeModelContent(() => {
      if (!currentFile) return;
      const tab = openTabs.find(t => t.path === currentFile);
      if (tab) {
        tab.content = monacoEditor.getValue();
        tab.isDirty = tab.content !== tab.originalContent;
        renderTabs();
      }
    });

    setTimeout(() => { if (monacoEditor) monacoEditor.layout(); }, 100);
  });
}

function getLanguageForPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
      return 'typescript';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'dockerfile':
      return 'dockerfile';
    default:
      return 'plaintext';
  }
}

// =============================================================================
// GESTION DES PROJETS
// =============================================================================
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    const container = document.getElementById('projectListContainer');
    container.innerHTML = '';

    if (!data.projects || data.projects.length === 0) {
      container.innerHTML = '<div class="px-3 py-2 text-[11px] text-gray-500 text-center">Aucun projet. Créez-en un !</div>';
      return;
    }

    data.projects.forEach(p => {
      const item = document.createElement('div');
      item.className = 'px-3 py-2 hover:bg-slate-100 dark:hover:bg-gray-700/40 cursor-pointer flex items-center justify-between transition text-xs';
      item.innerHTML = `
        <div class="flex items-center space-x-2 truncate">
          <i data-lucide="${p.isGit ? 'git-branch' : 'alert-circle'}" class="w-3.5 h-3.5 ${p.isGit ? 'text-emerald-500' : 'text-amber-500'} shrink-0"></i>
          <span class="font-medium text-slate-800 dark:text-gray-200 truncate">${escapeHtml(p.name)}</span>
        </div>
        <div class="flex items-center space-x-1 shrink-0">
          ${p.isGit ? `<span class="text-[10px] px-1 py-0.2 bg-slate-200 dark:bg-gray-800 text-slate-600 dark:text-gray-400 rounded font-mono">${escapeHtml(p.branch || 'main')}</span>` : `<span class="text-[9px] px-1 py-0.2 bg-amber-500/20 text-amber-600 dark:text-amber-300 rounded">Non-Git</span>`}
          ${p.isDirty ? `<span class="w-2 h-2 rounded-full bg-amber-500" title="Changements non commités"></span>` : ''}
        </div>
      `;

      item.addEventListener('click', () => {
        selectProject(p.name);
        document.getElementById('projectDropdownMenu').classList.add('hidden');
      });

      container.appendChild(item);
    });

    if (window.lucide) lucide.createIcons();

    // Sélectionner le dernier projet utilisé ou le premier par défaut
    const savedProject = localStorage.getItem('active_project');
    if (savedProject && data.projects.some(p => p.name === savedProject)) {
      selectProject(savedProject);
    } else if (data.projects.length > 0) {
      selectProject(data.projects[0].name);
    }
  } catch (err) {
    console.error('Erreur chargement projets:', err);
  }
}

async function selectProject(projectName) {
  currentProject = projectName;
  localStorage.setItem('active_project', projectName);

  document.getElementById('activeProjectName').textContent = projectName;
  document.getElementById('terminalProjectName').textContent = `[${projectName}]`;
  document.getElementById('breadcrumbProject').textContent = projectName;

  const badge = document.getElementById('activeProjectBadge');
  badge.classList.remove('hidden');

  openTabs = [];
  currentFile = null;
  renderTabs();
  showEmptyEditorState();

  await loadFileTree();
  await loadGitStatus();
  initProjectTerminal(projectName);
}

// =============================================================================
// EXPLORATEUR DE FICHIERS (ISOLATION STRICTE AU PROJET)
// =============================================================================
async function loadFileTree() {
  if (!currentProject) return;

  const container = document.getElementById('fileTreeContainer');
  container.innerHTML = '<div class="text-slate-400 dark:text-gray-500 p-2 text-center text-xs">Chargement...</div>';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/tree`);
    if (res.status === 403) {
      const err = await res.json();
      container.innerHTML = `
        <div class="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800/40 rounded text-amber-800 dark:text-amber-200 text-xs space-y-2">
          <p><strong>⚠️ Dépôt Git obligatoire :</strong> Ce dossier n'est pas un dépôt Git.</p>
          <button id="btnForceInitGit" class="w-full py-1 bg-amber-600 hover:bg-amber-500 text-white rounded font-medium">Initialiser Git maintenant</button>
        </div>
      `;
      document.getElementById('btnForceInitGit')?.addEventListener('click', async () => {
        await fetch(`/api/projects/${encodeURIComponent(currentProject)}/init-git`, { method: 'POST' });
        await loadProjects();
        await selectProject(currentProject);
      });
      return;
    }

    const data = await res.json();
    container.innerHTML = '';

    if (!data.tree || data.tree.length === 0) {
      container.innerHTML = '<div class="text-slate-400 dark:text-gray-500 p-3 text-center text-xs">Projet vide. Créez un fichier pour démarrer.</div>';
      return;
    }

    renderTreeNodes(data.tree, container);
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    container.innerHTML = `<div class="text-rose-500 p-2 text-xs">Erreur: ${escapeHtml(err.message)}</div>`;
  }
}

function renderTreeNodes(nodes, container, level = 0) {
  nodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'tree-node flex items-center justify-between py-1 px-1.5 rounded transition text-xs';
    el.style.paddingLeft = `${level * 14 + 6}px`;

    const isFolder = node.type === 'directory';
    const iconName = isFolder ? 'folder' : getFileIcon(node.name);

    el.innerHTML = `
      <div class="flex items-center space-x-1.5 truncate flex-1">
        <i data-lucide="${iconName}" class="w-3.5 h-3.5 ${isFolder ? 'text-sky-500' : 'text-slate-400 dark:text-gray-400'} shrink-0"></i>
        <span class="truncate ${node.path === currentFile ? 'text-sky-600 dark:text-sky-400 font-semibold' : 'text-slate-700 dark:text-gray-300'}">${escapeHtml(node.name)}</span>
      </div>
      <div class="actions opacity-0 hover:opacity-100 flex items-center space-x-1 shrink-0">
        <button class="btn-delete-item p-0.5 text-slate-400 hover:text-rose-500" title="Supprimer">
          <i data-lucide="trash-2" class="w-3 h-3"></i>
        </button>
      </div>
    `;

    // Survol pour afficher les actions
    el.addEventListener('mouseenter', () => {
      const actions = el.querySelector('.actions');
      if (actions) actions.style.opacity = '1';
    });
    el.addEventListener('mouseleave', () => {
      const actions = el.querySelector('.actions');
      if (actions) actions.style.opacity = '0';
    });

    // Supprimer
    el.querySelector('.btn-delete-item').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Supprimer définitivement "${node.name}" ?`)) {
        await fetch(`/api/projects/${encodeURIComponent(currentProject)}/item?path=${encodeURIComponent(node.path)}`, { method: 'DELETE' });
        closeTab(node.path);
        await loadFileTree();
        await loadGitStatus();
      }
    });

    if (isFolder) {
      const childContainer = document.createElement('div');
      childContainer.className = 'folder-children';
      let expanded = true;

      el.addEventListener('click', () => {
        expanded = !expanded;
        childContainer.style.display = expanded ? 'block' : 'none';
        const icon = el.querySelector('i');
        if (icon) {
          icon.setAttribute('data-lucide', expanded ? 'folder-open' : 'folder');
          if (window.lucide) lucide.createIcons();
        }
      });

      container.appendChild(el);
      container.appendChild(childContainer);
      if (node.children && node.children.length > 0) {
        renderTreeNodes(node.children, childContainer, level + 1);
      }
    } else {
      el.addEventListener('click', () => {
        openFile(node.path, node.name);
      });
      container.appendChild(el);
    }
  });
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':
      return 'file-code';
    case 'json':
      return 'file-json';
    case 'md':
      return 'file-text';
    case 'css':
    case 'html':
    case 'htm':
      return 'file-code-2';
    default:
      return 'file';
  }
}

// =============================================================================
// GESTION DES FICHIERS & ÉDITEUR
// =============================================================================
async function openFile(filePath, fileName) {
  let tab = openTabs.find(t => t.path === filePath);

  if (!tab) {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        alert('Impossible de lire le fichier.');
        return;
      }
      const data = await res.json();
      tab = {
        path: filePath,
        name: fileName || filePath.split('/').pop(),
        content: data.content,
        originalContent: data.content,
        isDirty: false,
      };
      openTabs.push(tab);
    } catch (err) {
      console.error('Erreur ouverture fichier:', err);
      return;
    }
  }

  currentFile = tab.path;
  renderTabs();
  showEditor();

  if (monacoEditor) {
    const lang = getLanguageForPath(tab.path);
    const model = monaco.editor.createModel(tab.content, lang);
    monacoEditor.setModel(model);
    monacoEditor.focus();
  }

  document.getElementById('breadcrumbFile').textContent = tab.path;
  document.getElementById('breadcrumbs').classList.remove('hidden');

  // Sur mobile : fermer le tiroir pour afficher le code directement
  closeMobileSidebar();
}

function renderTabs() {
  const tabsBar = document.getElementById('tabsBar');
  tabsBar.innerHTML = '';

  openTabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = `editor-tab ${tab.path === currentFile ? 'active' : ''}`;
    tabEl.innerHTML = `
      <span class="truncate max-w-[140px]">${escapeHtml(tab.name)}</span>
      ${tab.isDirty ? '<span class="ml-1.5 text-amber-500 font-bold">●</span>' : ''}
      <button class="ml-2 text-slate-400 hover:text-slate-600 dark:hover:text-white p-0.5 rounded close-tab-btn">×</button>
    `;

    tabEl.addEventListener('click', (e) => {
      if (!e.target.classList.contains('close-tab-btn')) {
        openFile(tab.path, tab.name);
      }
    });

    tabEl.querySelector('.close-tab-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    });

    tabsBar.appendChild(tabEl);
  });
}

function closeTab(filePath) {
  const index = openTabs.findIndex(t => t.path === filePath);
  if (index === -1) return;

  const tab = openTabs[index];
  if (tab.isDirty && !confirm(`Enregistrer les modifications de "${tab.name}" avant de fermer ?`)) {
    // Annulation si pas confirmé
  }

  openTabs.splice(index, 1);

  if (currentFile === filePath) {
    if (openTabs.length > 0) {
      const nextTab = openTabs[Math.max(0, index - 1)];
      openFile(nextTab.path, nextTab.name);
    } else {
      currentFile = null;
      showEmptyEditorState();
    }
  }

  renderTabs();
}

async function saveCurrentFile() {
  if (!currentFile || !currentProject) return;
  const tab = openTabs.find(t => t.path === currentFile);
  if (!tab) return;

  const content = monacoEditor.getValue();

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content }),
    });

    if (res.ok) {
      tab.originalContent = content;
      tab.isDirty = false;
      renderTabs();

      const saveStatus = document.getElementById('saveStatus');
      saveStatus.style.opacity = '1';
      setTimeout(() => { saveStatus.style.opacity = '0'; }, 1500);

      await loadGitStatus();
    } else {
      alert('Erreur lors de l\'enregistrement du fichier.');
    }
  } catch (err) {
    console.error('Erreur sauvegarde:', err);
  }
}

function showEditor() {
  document.getElementById('emptyEditorState').classList.add('hidden');
  if (monacoEditor) {
    setTimeout(() => { monacoEditor.layout(); }, 30);
  }
}

function showEmptyEditorState() {
  document.getElementById('emptyEditorState').classList.remove('hidden');
  document.getElementById('breadcrumbFile').textContent = 'aucun fichier ouvert';
}

// =============================================================================
// GESTION GIT DU PROJET
// =============================================================================
async function loadGitStatus() {
  if (!currentProject) return;

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/git/status`);
    if (!res.ok) return;

    const data = await res.json();

    // Branche
    document.getElementById('activeProjectBadge').textContent = data.branch || 'main';

    // Fichiers modifiés
    const filesList = document.getElementById('gitFilesList');
    filesList.innerHTML = '';
    document.getElementById('gitChangesCount').textContent = data.files.length;

    if (data.files.length === 0) {
      filesList.innerHTML = '<div class="text-slate-400 dark:text-gray-500 p-2 text-center text-[10px]">Arborescence propre. Aucun changement en attente.</div>';
    } else {
      data.files.forEach(f => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between text-[11px] py-0.5 px-1 hover:bg-slate-200 dark:hover:bg-gray-800 rounded';
        row.innerHTML = `
          <span class="truncate text-slate-700 dark:text-gray-300 font-mono">${escapeHtml(f.path)}</span>
          <span class="text-[9px] px-1 bg-amber-500/20 text-amber-600 dark:text-amber-300 rounded font-mono">${escapeHtml(f.code.trim())}</span>
        `;
        filesList.appendChild(row);
      });
    }

    // Historique des commits
    const logContainer = document.getElementById('gitCommitLog');
    logContainer.innerHTML = '';

    if (!data.commits || data.commits.length === 0) {
      logContainer.innerHTML = '<div class="text-slate-400 dark:text-gray-500 text-[10px]">Aucun commit pour le moment.</div>';
    } else {
      data.commits.forEach(c => {
        const item = document.createElement('div');
        item.className = 'p-1.5 bg-slate-100 dark:bg-[#16161a] border border-slate-200 dark:border-gray-800 rounded';
        item.innerHTML = `
          <div class="flex items-center justify-between text-slate-500 dark:text-gray-400">
            <span class="text-sky-600 dark:text-sky-400 font-bold">${escapeHtml(c.hash)}</span>
            <span class="text-[9px]">${escapeHtml(c.date)}</span>
          </div>
          <div class="text-slate-800 dark:text-gray-200 mt-0.5 truncate">${escapeHtml(c.message)}</div>
        `;
        logContainer.appendChild(item);
      });
    }
  } catch (err) {
    console.error('Erreur git status:', err);
  }
}

// =============================================================================
// ASSISTANT IA (SSO LLM) AVEC CRÉATION DE FICHIERS DIRECTE
// =============================================================================
async function loadAiModels() {
  try {
    const res = await fetch('/api/ai/models');
    if (!res.ok) return;
    const data = await res.json();
    const select = document.getElementById('aiModelSelect');
    select.innerHTML = '';

    data.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      select.appendChild(opt);
    });
  } catch (err) {
    console.warn('Erreur modèles IA:', err);
  }
}

async function sendAiPrompt(promptText) {
  if (!promptText || !promptText.trim()) return;

  const messagesContainer = document.getElementById('aiChatMessages');

  // Bulle utilisateur
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-msg-user';
  userBubble.innerHTML = `<p>${escapeHtml(promptText)}</p>`;
  messagesContainer.appendChild(userBubble);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // Bulle de chargement IA
  const aiBubble = document.createElement('div');
  aiBubble.className = 'chat-msg-ai';
  aiBubble.innerHTML = `
    <div class="flex items-center space-x-2 text-sky-600 dark:text-sky-400 text-xs">
      <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i>
      <span>L'IA analyse et génère le code...</span>
    </div>
  `;
  messagesContainer.appendChild(aiBubble);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  if (window.lucide) lucide.createIcons();

  const activeTab = openTabs.find(t => t.path === currentFile);
  const currentContent = monacoEditor ? monacoEditor.getValue() : (activeTab ? activeTab.content : null);

  const selectedModel = document.getElementById('aiModelSelect').value || 'gemini';
  const isGemini = selectedModel.toLowerCase().includes('gemini') || selectedModel.toLowerCase().includes('google');

  // Construction du prompt contextuel avec consigne de nommage de fichier
  let contextualPrompt = `Tu es l'assistant de programmation intelligent de DevSpace.\n`;
  contextualPrompt += `Projet actif: ${currentProject || 'inconnu'}\n`;
  if (currentFile) {
    contextualPrompt += `Fichier en cours d'édition: ${currentFile}\n`;
    if (currentContent) {
      contextualPrompt += `\n--- CONTENU ACTUEL DU FICHIER (${currentFile}) ---\n${currentContent}\n--- FIN DU CONTENU ---\n\n`;
    }
  }
  contextualPrompt += `Consigne importante: Quand tu génères du code pour un fichier ou que le développeur demande de créer un fichier (ex: index.html, style.css, script.js), indique TOUJOURS son nom précis avant le bloc au format [FICHIER: nom_du_fichier] suivi du bloc de code complet markdown \`\`\`lang ... \`\`\`.\n`;
  contextualPrompt += `Demande du développeur:\n${promptText}\n\nFournis une réponse claire, complète et directement utilisable.`;

  try {
    let reply = '';

    // Si Gemini est choisi, appel direct depuis le navigateur pour contourner le blocage IP datacenter de Google
    if (isGemini) {
      try {
        const credRes = await fetch('/api/gemini/credentials');
        if (credRes.ok) {
          const credData = await credRes.json();
          if (credData.apiKey) {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${credData.apiKey.trim()}`;
            const gRes = await fetch(geminiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: contextualPrompt }] }],
                generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
              }),
            });

            if (gRes.ok) {
              const gData = await gRes.json();
              reply = gData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else {
              const errTxt = await gRes.text().catch(() => '');
              console.warn('Appel direct Gemini navigateur non concluant:', gRes.status, errTxt);
            }
          }
        }
      } catch (geminiErr) {
        console.warn('Appel direct Gemini navigateur échoué, repli sur le serveur:', geminiErr);
      }
    }

    // Si aucun résultat via l'appel direct, repli sur le proxy serveur
    if (!reply) {
      const res = await fetch('/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptText,
          currentFile: currentFile,
          fileContent: currentContent,
          projectName: currentProject,
          model: selectedModel,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        aiBubble.innerHTML = `<p class="text-rose-500">Erreur : ${escapeHtml(data.error || 'Erreur inconnue')}</p>`;
        return;
      }
      reply = data.reply;
    }

    const { formattedHtml, firstFile } = renderAiMarkdown(reply, promptText);

    // Détection de l'intention de création de fichier
    const userWantsCreate = /(cr[eé][eè]r|create|ajoute|g[eé]n[eè]re).*?(fichier|file|\.[a-z0-9]+)/i.test(promptText);

    let autoCreatedBanner = '';
    if (userWantsCreate && firstFile && currentProject) {
      const ok = await createProjectFile(firstFile.filename, firstFile.code);
      if (ok) {
        autoCreatedBanner = `
          <div class="p-2 mb-2 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700/60 rounded-md text-emerald-800 dark:text-emerald-200 text-xs flex items-center space-x-2">
            <i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0"></i>
            <span>Fichier <strong>${escapeHtml(firstFile.filename)}</strong> créé avec succès dans le projet et ouvert dans l'éditeur !</span>
          </div>
        `;
      }
    }

    aiBubble.innerHTML = `
      <div class="space-y-2">
        ${autoCreatedBanner}
        <div class="leading-relaxed">
          ${formattedHtml}
        </div>
      </div>
    `;

    // Attacher les gestionnaires d'actions (Créer fichier, Copier, Insérer)
    attachAiCodeEvents(aiBubble);

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    aiBubble.innerHTML = `<p class="text-rose-500">Erreur de communication : ${escapeHtml(err.message)}</p>`;
  }
}

// Fonction centrale de création / écriture de fichier dans le projet
async function createProjectFile(fileName, content) {
  if (!currentProject) {
    alert('Veuillez d\'abord sélectionner ou créer un projet.');
    return false;
  }
  if (!fileName || !fileName.trim()) return false;

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fileName.trim(), content: content || '' }),
    });

    if (res.ok) {
      await loadFileTree();
      await openFile(fileName.trim(), fileName.trim().split('/').pop());
      await loadGitStatus();
      return true;
    } else {
      const err = await res.json();
      alert(`Erreur: ${err.error || 'Impossible de créer le fichier'}`);
      return false;
    }
  } catch (e) {
    alert(`Erreur: ${e.message}`);
    return false;
  }
}

function renderAiMarkdown(text, userPrompt = '') {
  if (!text) return { formattedHtml: '', firstFile: null };

  const codeBlocks = [];
  const placeholder = '___CODE_BLOCK_PLACEHOLDER___';

  // Extraire les blocs de code
  let processed = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({ lang: lang.trim() || 'plaintext', code: code.trim() });
    return `${placeholder}${index}${placeholder}`;
  });

  // Nettoyage et formatage HTML du texte
  processed = escapeHtml(processed);

  processed = processed.replace(/^### (.*$)/gim, '<h3 class="text-sm font-bold my-1 text-sky-600 dark:text-sky-400">$1</h3>');
  processed = processed.replace(/^## (.*$)/gim, '<h2 class="text-base font-bold my-1.5 text-sky-600 dark:text-sky-400">$1</h2>');
  processed = processed.replace(/^# (.*$)/gim, '<h1 class="text-lg font-bold my-2 text-sky-600 dark:text-sky-400">$1</h1>');
  processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 dark:text-white">$1</strong>');
  processed = processed.replace(/\*(.*?)\*/g, '<em class="italic">$1</em>');
  processed = processed.replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 rounded text-[11px] font-mono bg-slate-200 dark:bg-gray-800 text-sky-700 dark:text-sky-300">$1</code>');
  processed = processed.replace(/\n\n/g, '<br><br>');

  let firstFile = null;

  // Réinsérer les blocs de code enrichis d'actions directes
  codeBlocks.forEach((item, index) => {
    let suggestedFilename = '';

    // Détection via [FICHIER: xxx]
    const fileTagMatch = text.match(/\[(?:FICHIER|FILE):\s*([a-zA-Z0-9_\-\.\/]+)\]/i);
    if (fileTagMatch) {
      suggestedFilename = fileTagMatch[1].trim();
    }

    // Détection via commentaire de première ligne
    if (!suggestedFilename) {
      const firstLine = item.code.split('\n')[0].trim();
      const commentMatch = firstLine.match(/^(?:\/\/|<!--|#|\/\*)\s*([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)/);
      if (commentMatch) {
        suggestedFilename = commentMatch[1].trim();
      }
    }

    // Détection d'après le prompt utilisateur
    if (!suggestedFilename && userPrompt) {
      const promptFileMatch = userPrompt.match(/([a-zA-Z0-9_\-]+\.(html|css|js|ts|py|json|md|sh))/i);
      if (promptFileMatch) {
        suggestedFilename = promptFileMatch[1].trim();
      }
    }

    // Déduction par défaut d'après le langage
    if (!suggestedFilename) {
      if (item.lang === 'html') suggestedFilename = 'index.html';
      else if (item.lang === 'css') suggestedFilename = 'style.css';
      else if (item.lang === 'javascript' || item.lang === 'js') suggestedFilename = 'script.js';
      else if (item.lang === 'python' || item.lang === 'py') suggestedFilename = 'app.py';
      else if (item.lang === 'json') suggestedFilename = 'data.json';
      else suggestedFilename = `fichier.${item.lang || 'txt'}`;
    }

    if (!firstFile) {
      firstFile = { filename: suggestedFilename, code: item.code };
    }

    const encodedCode = encodeURIComponent(item.code);
    const safeLang = escapeHtml(item.lang || 'code');
    const safeFileName = escapeHtml(suggestedFilename);

    const blockHtml = `
      <div class="ai-code-wrapper my-2.5 rounded-lg border border-slate-300 dark:border-gray-700 overflow-hidden shadow-xs">
        <div class="ai-code-header flex items-center justify-between px-2.5 py-1.5 bg-slate-100 dark:bg-[#1f1f23] border-b border-slate-200 dark:border-gray-700 text-xs">
          <div class="flex items-center space-x-1.5 truncate max-w-[55%]">
            <span class="font-mono font-bold text-sky-600 dark:text-sky-400 truncate">📄 ${safeFileName}</span>
            <span class="text-[9px] px-1.5 py-0.2 bg-slate-200 dark:bg-gray-800 rounded text-slate-500 dark:text-gray-400 uppercase font-mono">${safeLang}</span>
          </div>
          <div class="flex items-center space-x-1 shrink-0">
            <button data-code="${encodedCode}" data-filename="${safeFileName}" class="btn-create-ai-file px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-medium flex items-center gap-1 shadow-xs transition" title="Créer directement ce fichier dans le projet">
              <i data-lucide="file-plus-2" class="w-3 h-3"></i>
              <span>Créer fichier</span>
            </button>
            <button data-code="${encodedCode}" class="btn-copy-ai-code px-2 py-1 bg-slate-200 dark:bg-gray-800 hover:bg-slate-300 dark:hover:bg-gray-700 text-slate-700 dark:text-gray-300 rounded text-[10px] font-medium transition" title="Copier le code">
              <span>Copier</span>
            </button>
            <button data-code="${encodedCode}" class="btn-insert-ai-code px-2 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-[10px] font-medium transition" title="Insérer dans l'éditeur">
              <span>Insérer</span>
            </button>
          </div>
        </div>
        <pre class="ai-code-content p-2.5 overflow-x-auto text-[11px] font-mono whitespace-pre bg-slate-50 dark:bg-[#0d0d11] text-slate-900 dark:text-gray-100"><code>${escapeHtml(item.code)}</code></pre>
      </div>
    `;

    processed = processed.replace(`${placeholder}${index}${placeholder}`, blockHtml);
  });

  return { formattedHtml: processed, firstFile };
}

function attachAiCodeEvents(container) {
  // 1. Bouton Créer automatiquement le fichier dans le projet
  container.querySelectorAll('.btn-create-ai-file').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fileName = btn.getAttribute('data-filename') || 'index.html';
      const code = decodeURIComponent(btn.getAttribute('data-code'));
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i><span>Création...</span>';
      if (window.lucide) lucide.createIcons();

      const ok = await createProjectFile(fileName, code);
      if (ok) {
        btn.className = btn.className.replace('bg-emerald-600', 'bg-emerald-700 font-bold');
        btn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i><span>✓ Créé & Ouvert !</span>';
      } else {
        btn.innerHTML = '<i data-lucide="file-plus-2" class="w-3 h-3"></i><span>Créer fichier</span>';
      }
      btn.disabled = false;
      if (window.lucide) lucide.createIcons();
    });
  });

  // 2. Bouton Copier
  container.querySelectorAll('.btn-copy-ai-code').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = decodeURIComponent(btn.getAttribute('data-code'));
      await navigator.clipboard.writeText(code);
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ Copié !';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    });
  });

  // 3. Bouton Insérer
  container.querySelectorAll('.btn-insert-ai-code').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = decodeURIComponent(btn.getAttribute('data-code'));
      if (monacoEditor) {
        monacoEditor.trigger('keyboard', 'type', { text: code });
        closeMobileSidebar();
      }
    });
  });
}

// =============================================================================
// TERMINAL & CONSOLE DU PROJET
// =============================================================================
function initProjectTerminal(projectName) {
  const terminalOutput = document.getElementById('terminalOutput');
  terminalOutput.innerHTML = '';
  appendTerminalLine(`=== Terminal initialisé pour [${projectName}] ===`, 'text-sky-400 font-bold');
  appendTerminalLine(`Les commandes s'exécutent strictement à la racine de ce projet.`, 'text-gray-400');

  if (wsTerminal) {
    wsTerminal.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(projectName)}`;

  try {
    wsTerminal = new WebSocket(wsUrl);
    wsTerminal.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.data) {
          appendTerminalRaw(msg.data);
        }
      } catch {
        appendTerminalRaw(event.data);
      }
    };
  } catch (err) {
    console.warn('Fallback terminal HTTP');
  }
}

function appendTerminalLine(text, className = 'text-gray-300') {
  const output = document.getElementById('terminalOutput');
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
}

function appendTerminalRaw(rawText) {
  const output = document.getElementById('terminalOutput');
  const span = document.createElement('span');
  span.textContent = rawText;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

async function executeTerminalCommand(cmd) {
  if (!cmd || !cmd.trim() || !currentProject) return;

  appendTerminalLine(`$ ${cmd}`, 'text-emerald-400 font-bold mt-2');

  if (wsTerminal && wsTerminal.readyState === WebSocket.OPEN) {
    wsTerminal.send(JSON.stringify({ type: 'stdin', data: cmd + '\n' }));
    return;
  }

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });

    const data = await res.json();
    if (data.stdout) appendTerminalLine(data.stdout, 'text-gray-200');
    if (data.stderr) appendTerminalLine(data.stderr, 'text-rose-400');
  } catch (err) {
    appendTerminalLine(`Erreur d'exécution: ${err.message}`, 'text-rose-400');
  }
}

// =============================================================================
// GESTION DU TIROIR MOBILE & ÉVÉNEMENTS UI
// =============================================================================
function openMobileSidebar() {
  const sidePanel = document.getElementById('sidePanel');
  const backdrop = document.getElementById('mobileBackdrop');
  sidePanel.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

function closeMobileSidebar() {
  if (window.innerWidth < 768) {
    const sidePanel = document.getElementById('sidePanel');
    const backdrop = document.getElementById('mobileBackdrop');
    sidePanel.classList.add('hidden');
    backdrop.classList.add('hidden');
  }
}

function initEventListeners() {
  // Bascule Mode Clair / Sombre
  document.getElementById('btnToggleTheme').addEventListener('click', () => {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  // Bouton Burger Mobile
  document.getElementById('btnToggleMobileSidebar').addEventListener('click', () => {
    openMobileSidebar();
  });

  document.getElementById('mobileBackdrop').addEventListener('click', () => {
    closeMobileSidebar();
  });

  document.getElementById('btnCloseMobileDrawer')?.addEventListener('click', () => {
    closeMobileSidebar();
  });

  document.getElementById('btnCloseMobileDrawerAi')?.addEventListener('click', () => {
    closeMobileSidebar();
  });

  // Agrandir / Réduire la barre latérale IA (Wide Mode)
  document.getElementById('btnToggleAiWide')?.addEventListener('click', () => {
    const panel = document.getElementById('sidePanel');
    const icon = document.getElementById('aiWideIcon');
    panel.classList.toggle('wide-ai-mode');
    const isWide = panel.classList.contains('wide-ai-mode');
    if (icon) {
      icon.setAttribute('data-lucide', isWide ? 'minimize-2' : 'maximize-2');
      if (window.lucide) lucide.createIcons();
    }
    if (monacoEditor) {
      setTimeout(() => monacoEditor.layout(), 160);
    }
  });

  // Switch d'onglets de panneau d'activité (Explorer, Git, AI, Terminal)
  document.querySelectorAll('.activity-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panelName = btn.getAttribute('data-panel');
      if (panelName === 'terminal') {
        const term = document.getElementById('bottomTerminalPanel');
        term.classList.toggle('hidden');
        if (monacoEditor) {
          setTimeout(() => monacoEditor.layout(), 160);
        }
        return;
      }

      document.querySelectorAll('.activity-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const sidePanel = document.getElementById('sidePanel');
      if (panelName === 'ai') {
        sidePanel.classList.add('panel-ai-active');
      } else {
        sidePanel.classList.remove('panel-ai-active');
      }

      document.getElementById('panelExplorer').classList.add('hidden');
      document.getElementById('panelGit').classList.add('hidden');
      document.getElementById('panelAi').classList.add('hidden');

      if (panelName === 'explorer') document.getElementById('panelExplorer').classList.remove('hidden');
      if (panelName === 'git') {
        document.getElementById('panelGit').classList.remove('hidden');
        loadGitStatus();
      }
      if (panelName === 'ai') {
        document.getElementById('panelAi').classList.remove('hidden');
      }

      if (monacoEditor) {
        setTimeout(() => monacoEditor.layout(), 160);
      }

      // Si on est sur mobile, ouvrir le tiroir
      if (window.innerWidth < 768) {
        openMobileSidebar();
      }
    });
  });

  // Dropdown projet
  const dropdownBtn = document.getElementById('projectDropdownBtn');
  const dropdownMenu = document.getElementById('projectDropdownMenu');
  dropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    dropdownMenu.classList.add('hidden');
  });

  // Modal Nouveau Projet
  const modal = document.getElementById('newProjectModal');
  document.getElementById('btnOpenNewProjectModal').addEventListener('click', () => {
    modal.classList.remove('hidden');
    document.getElementById('newProjectName').focus();
  });
  document.getElementById('btnCloseProjectModal').addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('btnCancelProject').addEventListener('click', () => modal.classList.add('hidden'));

  // Toggle Type Création Projet (Init vs Clone)
  const initBtn = document.getElementById('typeInitBtn');
  const cloneBtn = document.getElementById('typeCloneBtn');
  const gitUrlCont = document.getElementById('gitUrlContainer');
  const descCont = document.getElementById('projectDescContainer');

  initBtn.addEventListener('click', () => {
    createProjectType = 'init';
    initBtn.className = 'p-2.5 rounded-lg border border-sky-500 bg-sky-50 dark:bg-sky-500/10 text-sky-800 dark:text-white font-medium text-left flex items-center space-x-2';
    cloneBtn.className = 'p-2.5 rounded-lg border border-slate-200 dark:border-gray-700 bg-slate-100 dark:bg-gray-800/50 text-slate-600 dark:text-gray-400 font-medium text-left flex items-center space-x-2 hover:border-slate-400';
    gitUrlCont.classList.add('hidden');
    descCont.classList.remove('hidden');
  });

  cloneBtn.addEventListener('click', () => {
    createProjectType = 'clone';
    cloneBtn.className = 'p-2.5 rounded-lg border border-sky-500 bg-sky-50 dark:bg-sky-500/10 text-sky-800 dark:text-white font-medium text-left flex items-center space-x-2';
    initBtn.className = 'p-2.5 rounded-lg border border-slate-200 dark:border-gray-700 bg-slate-100 dark:bg-gray-800/50 text-slate-600 dark:text-gray-400 font-medium text-left flex items-center space-x-2 hover:border-slate-400';
    gitUrlCont.classList.remove('hidden');
    descCont.classList.add('hidden');
  });

  // Soumission Nouveau Projet
  document.getElementById('btnCreateProjectSubmit').addEventListener('click', async () => {
    const name = document.getElementById('newProjectName').value.trim();
    const gitUrl = document.getElementById('newProjectGitUrl').value.trim();
    const description = document.getElementById('newProjectDesc').value.trim();

    if (!name) {
      alert('Veuillez renseigner un nom de projet.');
      return;
    }
    if (createProjectType === 'clone' && !gitUrl) {
      alert('Veuillez renseigner l\'URL du dépôt Git à cloner.');
      return;
    }

    const submitBtn = document.getElementById('btnCreateProjectSubmit');
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Création en cours...';

    try {
      const res = await fetch('/api/projects/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          type: createProjectType,
          gitUrl,
          description,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Erreur lors de la création du projet.');
      } else {
        modal.classList.add('hidden');
        document.getElementById('newProjectName').value = '';
        document.getElementById('newProjectGitUrl').value = '';
        document.getElementById('newProjectDesc').value = '';
        await loadProjects();
        await selectProject(name);
      }
    } catch (err) {
      alert('Erreur: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i><span>Créer le projet</span>';
      if (window.lucide) lucide.createIcons();
    }
  });

  // Actions de fichiers
  document.getElementById('btnNewFile').addEventListener('click', async () => {
    if (!currentProject) return;
    const name = prompt('Nom du nouveau fichier (ex: index.html ou src/app.py) :');
    if (!name) return;
    await fetch(`/api/projects/${encodeURIComponent(currentProject)}/new-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, type: 'file' }),
    });
    await loadFileTree();
    await openFile(name, name.split('/').pop());
  });

  document.getElementById('btnNewFolder').addEventListener('click', async () => {
    if (!currentProject) return;
    const name = prompt('Nom du nouveau dossier :');
    if (!name) return;
    await fetch(`/api/projects/${encodeURIComponent(currentProject)}/new-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, type: 'folder' }),
    });
    await loadFileTree();
  });

  document.getElementById('btnRefreshFiles').addEventListener('click', () => loadFileTree());
  document.getElementById('btnRefreshGit').addEventListener('click', () => loadGitStatus());

  // Git Commit
  document.getElementById('btnCommit').addEventListener('click', async () => {
    if (!currentProject) return;
    const msg = document.getElementById('commitMessage').value.trim();
    if (!msg) {
      alert('Veuillez saisir un message de commit.');
      return;
    }

    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });

    const data = await res.json();
    if (res.ok) {
      document.getElementById('commitMessage').value = '';
      await loadGitStatus();
    } else {
      alert(data.error || 'Erreur lors du commit Git.');
    }
  });

  // Prompt IA
  const aiInput = document.getElementById('aiPromptInput');
  document.getElementById('btnSendAi').addEventListener('click', () => {
    const val = aiInput.value.trim();
    if (val) {
      sendAiPrompt(val);
      aiInput.value = '';
    }
  });

  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = aiInput.value.trim();
      if (val) {
        sendAiPrompt(val);
        aiInput.value = '';
      }
    }
  });

  document.querySelectorAll('.quick-ai-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const promptText = btn.getAttribute('data-prompt');
      sendAiPrompt(promptText);
    });
  });

  // Terminal Input
  const termInput = document.getElementById('terminalInput');
  termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = termInput.value.trim();
      if (cmd) {
        executeTerminalCommand(cmd);
        termInput.value = '';
      }
    }
  });

  document.getElementById('btnClearTerminal').addEventListener('click', () => {
    document.getElementById('terminalOutput').innerHTML = '';
  });

  document.getElementById('btnToggleTerminal').addEventListener('click', () => {
    const term = document.getElementById('bottomTerminalPanel');
    term.classList.toggle('h-36');
    term.classList.toggle('sm:h-40');
    term.classList.toggle('h-8');
    if (monacoEditor) {
      setTimeout(() => { monacoEditor.layout(); }, 160);
    }
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
