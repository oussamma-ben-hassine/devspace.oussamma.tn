// DevSpace Web IDE Client Logic
let monacoEditor = null;
let currentProject = null;
let currentFile = null;
let openTabs = []; // { path, name, content, originalContent, isDirty }
let wsTerminal = null;
let activePanel = 'explorer';
let createProjectType = 'init';

// Initialisation au chargement
document.addEventListener('DOMContentLoaded', async () => {
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
    monacoEditor = monaco.editor.create(document.getElementById('monacoInstance'), {
      value: '',
      language: 'javascript',
      theme: 'vs-dark',
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
      item.className = 'px-3 py-2 hover:bg-gray-700/40 cursor-pointer flex items-center justify-between transition text-xs';
      item.innerHTML = `
        <div class="flex items-center space-x-2 truncate">
          <i data-lucide="${p.isGit ? 'git-branch' : 'alert-circle'}" class="w-3.5 h-3.5 ${p.isGit ? 'text-emerald-400' : 'text-amber-400'} shrink-0"></i>
          <span class="font-medium text-gray-200 truncate">${escapeHtml(p.name)}</span>
        </div>
        <div class="flex items-center space-x-1 shrink-0">
          ${p.isGit ? `<span class="text-[10px] px-1 py-0.2 bg-gray-800 text-gray-400 rounded font-mono">${escapeHtml(p.branch || 'main')}</span>` : `<span class="text-[9px] px-1 py-0.2 bg-amber-500/20 text-amber-300 rounded">Non-Git</span>`}
          ${p.isDirty ? `<span class="w-2 h-2 rounded-full bg-amber-400" title="Changements non commités"></span>` : ''}
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
  container.innerHTML = '<div class="text-gray-500 p-2 text-center text-xs">Chargement...</div>';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/tree`);
    if (res.status === 403) {
      const err = await res.json();
      container.innerHTML = `
        <div class="p-3 bg-amber-950/40 border border-amber-800/40 rounded text-amber-200 text-xs space-y-2">
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
      container.innerHTML = '<div class="text-gray-500 p-3 text-center text-xs">Projet vide. Créez un fichier pour démarrer.</div>';
      return;
    }

    renderTreeNodes(data.tree, container);
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    container.innerHTML = `<div class="text-rose-400 p-2 text-xs">Erreur: ${escapeHtml(err.message)}</div>`;
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
        <i data-lucide="${iconName}" class="w-3.5 h-3.5 ${isFolder ? 'text-sky-400' : 'text-gray-400'} shrink-0"></i>
        <span class="truncate ${node.path === currentFile ? 'text-sky-400 font-semibold' : 'text-gray-300'}">${escapeHtml(node.name)}</span>
      </div>
      <div class="actions opacity-0 hover:opacity-100 flex items-center space-x-1 shrink-0">
        <button class="btn-delete-item p-0.5 text-gray-500 hover:text-rose-400" title="Supprimer">
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
}

function renderTabs() {
  const tabsBar = document.getElementById('tabsBar');
  tabsBar.innerHTML = '';

  openTabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = `editor-tab ${tab.path === currentFile ? 'active' : ''}`;
    tabEl.innerHTML = `
      <span class="truncate max-w-[140px]">${escapeHtml(tab.name)}</span>
      ${tab.isDirty ? '<span class="ml-1.5 text-amber-400 font-bold">●</span>' : ''}
      <button class="ml-2 text-gray-500 hover:text-white p-0.5 rounded close-tab-btn">×</button>
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
  document.getElementById('monacoInstance').classList.remove('hidden');
}

function showEmptyEditorState() {
  document.getElementById('emptyEditorState').classList.remove('hidden');
  document.getElementById('monacoInstance').classList.add('hidden');
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
      filesList.innerHTML = '<div class="text-gray-500 p-2 text-center text-[10px]">Arborescence propre. Aucun changement en attente.</div>';
    } else {
      data.files.forEach(f => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between text-[11px] py-0.5 px-1 hover:bg-gray-800 rounded';
        row.innerHTML = `
          <span class="truncate text-gray-300 font-mono">${escapeHtml(f.path)}</span>
          <span class="text-[9px] px-1 bg-amber-500/20 text-amber-300 rounded font-mono">${escapeHtml(f.code.trim())}</span>
        `;
        filesList.appendChild(row);
      });
    }

    // Historique des commits
    const logContainer = document.getElementById('gitCommitLog');
    logContainer.innerHTML = '';

    if (!data.commits || data.commits.length === 0) {
      logContainer.innerHTML = '<div class="text-gray-500 text-[10px]">Aucun commit pour le moment.</div>';
    } else {
      data.commits.forEach(c => {
        const item = document.createElement('div');
        item.className = 'p-1.5 bg-[#16161a] border border-gray-800 rounded';
        item.innerHTML = `
          <div class="flex items-center justify-between text-gray-400">
            <span class="text-sky-400 font-bold">${escapeHtml(c.hash)}</span>
            <span class="text-[9px]">${escapeHtml(c.date)}</span>
          </div>
          <div class="text-gray-200 mt-0.5 truncate">${escapeHtml(c.message)}</div>
        `;
        logContainer.appendChild(item);
      });
    }
  } catch (err) {
    console.error('Erreur git status:', err);
  }
}

// =============================================================================
// ASSISTANT IA (SSO LLM)
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
    <div class="flex items-center space-x-2 text-sky-400 text-xs">
      <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i>
      <span>L'IA analyse le projet...</span>
    </div>
  `;
  messagesContainer.appendChild(aiBubble);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  if (window.lucide) lucide.createIcons();

  const activeTab = openTabs.find(t => t.path === currentFile);
  const currentContent = monacoEditor ? monacoEditor.getValue() : (activeTab ? activeTab.content : null);

  try {
    const res = await fetch('/api/ai/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: promptText,
        currentFile: currentFile,
        fileContent: currentContent,
        projectName: currentProject,
        model: document.getElementById('aiModelSelect').value,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      aiBubble.innerHTML = `<p class="text-rose-400">Erreur : ${escapeHtml(data.error || 'Erreur inconnue')}</p>`;
      return;
    }

    const formattedReply = renderAiMarkdown(data.reply);
    aiBubble.innerHTML = `
      <div class="space-y-2">
        <div class="prose prose-invert max-w-none text-xs leading-relaxed text-gray-200">
          ${formattedReply}
        </div>
      </div>
    `;

    // Attacher des boutons "Insérer dans l'éditeur" sur les blocs de code
    aiBubble.querySelectorAll('pre code').forEach(codeBlock => {
      const btnInsert = document.createElement('button');
      btnInsert.className = 'text-[10px] bg-sky-600 hover:bg-sky-500 text-white px-2 py-0.5 rounded mt-1 block';
      btnInsert.textContent = 'Insérer dans l\'éditeur';
      btnInsert.addEventListener('click', () => {
        if (monacoEditor) {
          monacoEditor.trigger('keyboard', 'type', { text: codeBlock.innerText });
        }
      });
      codeBlock.parentElement.appendChild(btnInsert);
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (err) {
    aiBubble.innerHTML = `<p class="text-rose-400">Erreur de communication : ${escapeHtml(err.message)}</p>`;
  }
}

function renderAiMarkdown(text) {
  if (!text) return '';
  // Échappement HTML basique et formatage des blocs de code
  let parsed = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Blocs de code ```lang ... ```
  parsed = parsed.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre class="bg-gray-900 border border-gray-800 p-2 rounded my-1.5 overflow-x-auto text-[11px] font-mono"><code>${code.trim()}</code></pre>`;
  });

  // Code inline `...`
  parsed = parsed.replace(/`([^`]+)`/g, '<code class="bg-gray-800 text-sky-300 px-1 py-0.2 rounded font-mono text-[11px]">$1</code>');

  // Paragraphes
  parsed = parsed.replace(/\n\n/g, '<br><br>');
  return parsed;
}

// =============================================================================
// TERMINAL & CONSOLE DU PROJET
// =============================================================================
function initProjectTerminal(projectName) {
  const terminalOutput = document.getElementById('terminalOutput');
  terminalOutput.innerHTML = '';
  appendTerminalLine(`=== Terminal initialisé pour [${projectName}] ===`, 'text-sky-400 font-bold');
  appendTerminalLine(`Les commandes s'exécutent strictement à la racine de ce projet.`, 'text-gray-500');

  // Connexion WebSocket pour streaming interactif
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

  // Si WebSocket actif, envoyer dessus
  if (wsTerminal && wsTerminal.readyState === WebSocket.OPEN) {
    wsTerminal.send(JSON.stringify({ type: 'stdin', data: cmd + '\n' }));
    return;
  }

  // Sinon fallback via API HTTP POST /api/projects/:name/exec
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
// ÉVÉNEMENTS & INTERACTIONS UI
// =============================================================================
function initEventListeners() {
  // Switch d'onglets de panneau d'activité (Explorer, Git, AI, Terminal)
  document.querySelectorAll('.activity-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panelName = btn.getAttribute('data-panel');
      if (panelName === 'terminal') {
        const term = document.getElementById('bottomTerminalPanel');
        term.classList.toggle('hidden');
        return;
      }

      document.querySelectorAll('.activity-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.getElementById('panelExplorer').classList.add('hidden');
      document.getElementById('panelGit').classList.add('hidden');
      document.getElementById('panelAi').classList.add('hidden');

      if (panelName === 'explorer') document.getElementById('panelExplorer').classList.remove('hidden');
      if (panelName === 'git') {
        document.getElementById('panelGit').classList.remove('hidden');
        loadGitStatus();
      }
      if (panelName === 'ai') document.getElementById('panelAi').classList.remove('hidden');
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
    initBtn.className = 'p-2.5 rounded-lg border border-sky-500 bg-sky-500/10 text-white font-medium text-left flex items-center space-x-2';
    cloneBtn.className = 'p-2.5 rounded-lg border border-gray-700 bg-gray-800/50 text-gray-400 font-medium text-left flex items-center space-x-2 hover:border-gray-600';
    gitUrlCont.classList.add('hidden');
    descCont.classList.remove('hidden');
  });

  cloneBtn.addEventListener('click', () => {
    createProjectType = 'clone';
    cloneBtn.className = 'p-2.5 rounded-lg border border-sky-500 bg-sky-500/10 text-white font-medium text-left flex items-center space-x-2';
    initBtn.className = 'p-2.5 rounded-lg border border-gray-700 bg-gray-800/50 text-gray-400 font-medium text-left flex items-center space-x-2 hover:border-gray-600';
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
    const name = prompt('Nom du nouveau fichier (ex: index.js ou src/app.py) :');
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
    term.classList.toggle('h-44');
    term.classList.toggle('h-8');
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
