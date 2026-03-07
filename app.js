// ── State ──────────────────────────────────────────────────
let SB = null;
let ME = null;
let SESSION_TOKEN = null;
let CURRENT_CHAT_ID = null;
let CURRENT_GROUP_ID = null;
let CHAT_MESSAGES = {};
let CHATS = [];
let SETTINGS = {};
let CURRENT_MODE = 'normal';
let ATTACHED_FILE = null;
let DAILY_MSGS = 0;
let DAILY_IMGS = 0;
let IMG_LIMIT = 3;
let GROUP_REALTIME = null;

const COLORS = ['#7c3aed','#3b82f6','#10b981','#f59e0b','#ef4444','#ec4899','#06b6d4','#8b5cf6','#84cc16'];

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    SUPABASE_URL = cfg.supabaseUrl;
    SUPABASE_ANON = cfg.supabaseAnon;
    SB = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    loadSettings();
    applySettings();
    const { data: { session } } = await SB.auth.getSession();
    if (session) await initApp(session);
    else showAuth();
    SB.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) await initApp(session);
      if (event === 'SIGNED_OUT') showAuth();
    });
  } catch(e) { showToast('Boot error: ' + e.message, 'error'); }
}

async function initApp(session) {
  SESSION_TOKEN = session.access_token;
  const { data: prof } = await SB.from('profiles').select('*').eq('id', session.user.id).single();
  ME = prof || { id: session.user.id, display_name: session.user.email?.split('@')[0], tier: 'free' };
  DAILY_IMGS = ME.daily_imgs || 0;
  IMG_LIMIT = ME.tier === 'pro' ? 10 : 3;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  renderSidebarUser();
  await loadChats();
  await loadGroups();
  loadUpdateLog();
  buildColorPickers();
}

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

// ── Auth ───────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((el, i) => el.classList.toggle('active', (i === 0) === (tab === 'login')));
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('auth-error').classList.add('hidden');
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  if (!email || !pass) return showAuthError('Enter email and password.');
  const { error } = await SB.auth.signInWithPassword({ email, password: pass });
  if (error) showAuthError(error.message);
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass = document.getElementById('reg-pass').value;
  if (!name || !email || !pass) return showAuthError('Fill in all fields.');
  if (pass.length < 6) return showAuthError('Password must be at least 6 characters.');
  const { data, error } = await SB.auth.signUp({ email, password: pass });
  if (error) return showAuthError(error.message);
  if (data.user) {
    await SB.from('profiles').upsert({ id: data.user.id, display_name: name, username: name.toLowerCase().replace(/\s+/g,'_'), avatar_color: COLORS[Math.floor(Math.random()*COLORS.length)] });
    showToast('Account created! Signing in…');
  }
}

async function doLogout() {
  await SB.auth.signOut();
  CURRENT_CHAT_ID = null; CHATS = []; CHAT_MESSAGES = {};
  document.getElementById('messages').innerHTML = '';
  document.getElementById('chat-list').innerHTML = '';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.classList.remove('hidden');
}

// ── Sidebar User ───────────────────────────────────────────
function renderSidebarUser() {
  const av = document.getElementById('sidebar-avatar');
  const nm = document.getElementById('sidebar-name');
  const tr = document.getElementById('sidebar-tier');
  nm.textContent = ME.display_name || 'User';
  tr.textContent = ME.tier === 'pro' ? 'Pro' : 'Free';
  tr.className = `tier-badge ${ME.tier || 'free'}`;
  setAvatar(av, ME);
  updateMsgCounter(DAILY_MSGS);
  updateImgCounter();
}

function setAvatar(el, profile) {
  if (profile?.avatar_url) {
    el.style.backgroundImage = `url(${profile.avatar_url})`;
    el.style.backgroundColor = 'transparent';
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.style.backgroundColor = profile?.avatar_color || '#7c3aed';
    el.textContent = (profile?.display_name || '?')[0].toUpperCase();
  }
}

function updateMsgCounter(count) {
  DAILY_MSGS = count;
  const limit = 50;
  const pct = Math.min((count / limit) * 100, 100);
  document.getElementById('msg-count-text').textContent = `${count} / ${limit} msgs today`;
  document.getElementById('counter-fill').style.width = pct + '%';
}

function updateImgCounter() {
  const left = Math.max(0, IMG_LIMIT - DAILY_IMGS);
  document.getElementById('img-count-text').textContent = `${left} left`;
}

// ── Section nav ────────────────────────────────────────────
function showSection(section) {
  ['chats','groups','updates'].forEach(s => {
    document.getElementById(`nav-${s}`).classList.toggle('active', s === section);
    document.getElementById(`panel-${s}`).classList.toggle('active', s === section);
    const list = document.getElementById(s === 'chats' ? 'chat-list' : 'group-list');
    if (list) list.classList.toggle('hidden', s !== section && !(s === 'chats'));
  });
  // Toggle chat-list / group-list in sidebar
  document.getElementById('chat-list').classList.toggle('hidden', section !== 'chats');
  document.getElementById('group-list').classList.toggle('hidden', section !== 'groups');
  if (section === 'updates') { loadUpdateLog(); document.getElementById('updates-badge').classList.add('hidden'); }
  closeSidebar();
}

// ── Chats ──────────────────────────────────────────────────
async function loadChats() {
  const { data } = await SB.from('ai_chats').select('*').eq('user_id', ME.id).order('updated_at', { ascending: false });
  CHATS = data || [];
  renderChatList(CHATS);
}

function renderChatList(list) {
  const el = document.getElementById('chat-list');
  if (!list.length) { el.innerHTML = '<div class="empty-state" style="font-size:12px">No chats yet</div>'; return; }
  el.innerHTML = list.map(c => `
    <div class="chat-item ${c.id === CURRENT_CHAT_ID ? 'active' : ''}" onclick="openChat('${c.id}')">
      <div class="chat-item-text">
        <div class="chat-item-title">${escHtml(c.title || 'New Chat')}</div>
        <div class="chat-item-preview">${escHtml(c.last_message || '')}</div>
      </div>
      <button class="icon-btn chat-item-del" onclick="event.stopPropagation();deleteChat('${c.id}')" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </div>
  `).join('');
}

function filterChats(q) {
  const section = document.getElementById('nav-chats').classList.contains('active') ? 'chats' : 'groups';
  if (section === 'chats') {
    const filtered = CHATS.filter(c => (c.title || '').toLowerCase().includes(q.toLowerCase()) || (c.last_message || '').toLowerCase().includes(q.toLowerCase()));
    renderChatList(filtered);
  }
}

async function newChat() {
  showSection('chats');
  CURRENT_CHAT_ID = null;
  document.getElementById('welcome').style.display = 'flex';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('chat-header').classList.add('hidden');
  document.getElementById('mobile-title').textContent = 'NovaAI';
  renderChatList(CHATS);
  document.getElementById('msg-input').focus();
}

async function openChat(id) {
  CURRENT_CHAT_ID = id;
  showSection('chats');
  const chat = CHATS.find(c => c.id === id);
  if (!chat) return;
  const el = document.getElementById('chat-header');
  el.classList.remove('hidden');
  document.getElementById('chat-title-display').textContent = chat.title || 'New Chat';
  document.getElementById('mobile-title').textContent = chat.title || 'Chat';
  const av = document.getElementById('chat-header-avatar');
  setAvatar(av, ME);
  const { data: msgs } = await SB.from('ai_messages').select('*').eq('chat_id', id).order('created_at');
  CHAT_MESSAGES[id] = msgs || [];
  renderMessages(msgs || []);
  renderChatList(CHATS);
  closeSidebar();
}

function renderMessages(msgs) {
  const el = document.getElementById('messages');
  document.getElementById('welcome').style.display = 'none';
  el.innerHTML = msgs.map(m => buildMsgHTML(m.role, m.content, m.created_at)).join('');
  el.scrollTop = el.scrollHeight;
}

function buildMsgHTML(role, content, time) {
  const isUser = role === 'user';
  const avatar = isUser
    ? `<div class="avatar sm msg-avatar" style="background-color:${ME.avatar_color||'#7c3aed'}">${(ME.display_name||'U')[0].toUpperCase()}</div>`
    : `<div class="avatar sm msg-avatar" style="background:linear-gradient(135deg,#7c3aed,#3b82f6);font-size:11px;font-weight:800">N</div>`;
  const t = time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const rendered = isUser ? `<div class="msg-text">${escHtml(content)}</div>` : `<div class="msg-text">${renderMarkdown(content)}</div>`;
  return `<div class="message ${isUser ? 'user' : 'ai'}">
    ${avatar}
    <div class="msg-body">
      ${rendered}
      <div class="msg-time">${t}</div>
    </div>
  </div>`;
}

function appendMessage(role, content) {
  const el = document.getElementById('messages');
  document.getElementById('welcome').style.display = 'none';
  el.insertAdjacentHTML('beforeend', buildMsgHTML(role, content, new Date().toISOString()));
  el.scrollTop = el.scrollHeight;
}

function appendImageMessage(src) {
  const el = document.getElementById('messages');
  el.insertAdjacentHTML('beforeend', `
    <div class="message ai">
      <div class="avatar sm msg-avatar" style="background:linear-gradient(135deg,#7c3aed,#3b82f6);font-size:11px;font-weight:800">N</div>
      <div class="msg-body">
        <img src="${src}" class="msg-image" onclick="window.open(this.src)" alt="Generated image"/>
        <div class="msg-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
      </div>
    </div>`);
  el.scrollTop = el.scrollHeight;
}

function showTyping(statusText) {
  hideTyping();
  const el = document.getElementById('messages');
  document.getElementById('welcome').style.display = 'none';
  const div = document.createElement('div');
  div.className = 'message ai typing-message'; div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="avatar sm msg-avatar" style="background:linear-gradient(135deg,#7c3aed,#3b82f6);font-size:11px;font-weight:800">N</div>
    <div class="msg-body">
      <div class="typing-status" id="typing-status">${statusText || 'Thinking…'}</div>
      <div class="typing-dots"><span></span><span></span><span></span></div>
    </div>`;
  el.appendChild(div); el.scrollTop = el.scrollHeight;
}
function updateTypingStatus(text) {
  const el = document.getElementById('typing-status');
  if (el) el.textContent = text;
}
function hideTyping() { document.getElementById('typing-indicator')?.remove(); }

function setLoading(on) {
  const btn = document.getElementById('send-btn');
  const input = document.getElementById('msg-input');
  btn.disabled = on;
  input.disabled = on;
  btn.style.opacity = on ? '0.5' : '1';
}

// ── Send message ───────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && !ATTACHED_FILE) return;

  // Image generation mode
  if (CURRENT_MODE === 'imagine') {
    await generateImage(text);
    input.value = ''; autoResize(input);
    return;
  }

  input.value = ''; autoResize(input);
  let userContent = text;

  // File analysis
  if (ATTACHED_FILE) {
    await handleFileAnalysis(text);
    return;
  }

  appendMessage('user', userContent);
  if (!CURRENT_CHAT_ID) await createNewChat(userContent);
  await SB.from('ai_messages').insert({ chat_id: CURRENT_CHAT_ID, role: 'user', content: userContent });

  const isSearch = CURRENT_MODE === 'search';
  setLoading(true);
  showTyping(isSearch ? 'Searching the web…' : 'Thinking…');

  // If search mode, update status after a moment to show it's still working
  let statusTimer = null;
  if (isSearch) {
    statusTimer = setTimeout(() => updateTypingStatus('Reading results…'), 3000);
  } else {
    statusTimer = setTimeout(() => updateTypingStatus('Writing response…'), 4000);
  }

  const sysPrompt = buildSystemPrompt();
  const history = (CHAT_MESSAGES[CURRENT_CHAT_ID] || []).slice(-20).map(m => ({ role: m.role, content: m.content }));
  history.push({ role: 'user', content: userContent });

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [{ role: 'system', content: sysPrompt }, ...history],
        useWebSearch: isSearch,
        temperature: CURRENT_MODE === 'creative' ? 1.1 : 0.7,
        max_tokens: SETTINGS.style === 'detailed' ? 4096 : 2048
      })
    });
    clearTimeout(statusTimer);
    const data = await res.json();
    hideTyping();
    setLoading(false);
    if (data.error === 'limit_reached') {
      document.getElementById('limit-reset-time').textContent = data.resetIn;
      document.getElementById('limit-modal').classList.remove('hidden');
      return;
    }
    if (data.error) { showToast(data.error, 'error'); return; }
    const reply = data.choices?.[0]?.message?.content || '';
    appendMessage('assistant', reply);
    if (data._dailyMsgs !== undefined) updateMsgCounter(data._dailyMsgs);
    if (CURRENT_CHAT_ID) {
      if (!CHAT_MESSAGES[CURRENT_CHAT_ID]) CHAT_MESSAGES[CURRENT_CHAT_ID] = [];
      CHAT_MESSAGES[CURRENT_CHAT_ID].push({ role: 'user', content: userContent }, { role: 'assistant', content: reply });
      await SB.from('ai_messages').insert({ chat_id: CURRENT_CHAT_ID, role: 'assistant', content: reply });
      await SB.from('ai_chats').update({ last_message: reply.slice(0, 80), updated_at: new Date().toISOString() }).eq('id', CURRENT_CHAT_ID);
      await loadChats();
    }
  } catch(e) {
    clearTimeout(statusTimer);
    hideTyping();
    setLoading(false);
    showToast('Network error — please try again', 'error');
  }
}

function buildSystemPrompt() {
  const styles = { concise: 'Be concise. Short answers unless asked for more.', balanced: 'Be balanced and helpful.', detailed: 'Be thorough and detailed in your responses.', creative: 'Be creative, expressive, and engaging.' };
  const modeInstructions = {
    code: 'You are in Code Mode. Focus on programming. Always use code blocks. Explain code clearly.',
    search: 'You have been given web search results. Summarise and cite them helpfully.',
    creative: 'You are in Creative Mode. Be imaginative, expressive, and original.',
    normal: ''
  };
  const base = `You are NovaAI, a helpful, smart, and friendly AI assistant. ${styles[SETTINGS.style||'balanced']} ${modeInstructions[CURRENT_MODE]||''}`;
  return SETTINGS.customPrompt ? base + '\n\nAdditional instructions: ' + SETTINGS.customPrompt : base;
}

async function createNewChat(firstMsg) {
  const title = firstMsg.slice(0, 48) || 'New Chat';
  const { data } = await SB.from('ai_chats').insert({ user_id: ME.id, title, last_message: '' }).select().single();
  CURRENT_CHAT_ID = data.id;
  CHAT_MESSAGES[data.id] = [];
  CHATS.unshift(data);
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-title-display').textContent = title;
  document.getElementById('mobile-title').textContent = title;
  renderChatList(CHATS);
}

async function deleteChat(id) {
  await SB.from('ai_chats').delete().eq('id', id);
  CHATS = CHATS.filter(c => c.id !== id);
  if (CURRENT_CHAT_ID === id) newChat();
  else renderChatList(CHATS);
}

async function deleteCurrentChat() {
  if (!CURRENT_CHAT_ID) return;
  await deleteChat(CURRENT_CHAT_ID);
}

// ── Rename ─────────────────────────────────────────────────
function startRename() {
  const display = document.getElementById('chat-title-display');
  const input = document.getElementById('chat-title-input');
  input.value = display.textContent;
  display.classList.add('hidden');
  input.classList.remove('hidden');
  input.focus(); input.select();
}
async function finishRename() {
  const display = document.getElementById('chat-title-display');
  const input = document.getElementById('chat-title-input');
  const newTitle = input.value.trim() || 'New Chat';
  display.textContent = newTitle;
  display.classList.remove('hidden');
  input.classList.add('hidden');
  if (CURRENT_CHAT_ID) {
    await SB.from('ai_chats').update({ title: newTitle }).eq('id', CURRENT_CHAT_ID);
    const chat = CHATS.find(c => c.id === CURRENT_CHAT_ID);
    if (chat) chat.title = newTitle;
    renderChatList(CHATS);
  }
}

// ── Mode selector ──────────────────────────────────────────
function setMode(mode) {
  CURRENT_MODE = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`mode-${mode}`)?.classList.add('active');
  const placeholders = { normal: 'Message NovaAI…', code: 'Ask a coding question…', imagine: 'Describe an image to generate…', search: 'Search the web…', creative: 'Write something creative…' };
  document.getElementById('msg-input').placeholder = placeholders[mode] || 'Message NovaAI…';
}

function enableWebSearch() { setMode('search'); }

// ── Image generation ───────────────────────────────────────
async function generateImage(prompt) {
  if (!prompt) { showToast('Describe the image first'); return; }
  if (DAILY_IMGS >= IMG_LIMIT) {
    document.getElementById('img-limit-text').textContent = `You've used all ${IMG_LIMIT} image generations today.`;
    document.getElementById('img-limit-modal').classList.remove('hidden');
    return;
  }
  appendMessage('user', '🎨 Generate: ' + prompt);
  if (!CURRENT_CHAT_ID) await createNewChat('Image: ' + prompt);
  setLoading(true);
  showTyping('Generating image…');
  const imgTimer = setTimeout(() => updateTypingStatus('Still working — image gen can take 15–30s…'), 8000);
  try {
    const res = await fetch('/api/imagine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({ prompt })
    });
    clearTimeout(imgTimer);
    const data = await res.json();
    hideTyping();
    setLoading(false);
    if (data.error === 'img_limit_reached') {
      document.getElementById('img-limit-reset').textContent = data.resetIn;
      document.getElementById('img-limit-text').textContent = `You've used all ${data.limit} image generations today.`;
      document.getElementById('img-limit-modal').classList.remove('hidden');
      return;
    }
    if (data.error) { showToast(data.error, 'error'); return; }
    appendImageMessage(data.image);
    DAILY_IMGS = data._dailyImgs || DAILY_IMGS + 1;
    updateImgCounter();
    await SB.from('ai_messages').insert([
      { chat_id: CURRENT_CHAT_ID, role: 'user', content: '🎨 Generate: ' + prompt },
      { chat_id: CURRENT_CHAT_ID, role: 'assistant', content: '[Generated Image]' }
    ]);
  } catch(e) { clearTimeout(imgTimer); hideTyping(); setLoading(false); showToast('Image generation failed', 'error'); }
}

// ── File handling ──────────────────────────────────────────
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const MAX = 5 * 1024 * 1024;
  if (file.size > MAX) { showToast('File too large (max 5MB)'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    ATTACHED_FILE = { name: file.name, content: e.target.result, type: file.type };
    document.getElementById('file-preview').classList.remove('hidden');
    document.getElementById('file-preview-inner').textContent = `📎 ${file.name} (${(file.size/1024).toFixed(1)}KB)`;
    document.getElementById('msg-input').placeholder = `Ask about ${file.name}…`;
  };
  reader.readAsText(file);
  event.target.value = '';
}

function clearFile() {
  ATTACHED_FILE = null;
  document.getElementById('file-preview').classList.add('hidden');
  document.getElementById('msg-input').placeholder = 'Message NovaAI…';
}

async function handleFileAnalysis(question) {
  const file = ATTACHED_FILE;
  clearFile();
  const display = `📎 ${file.name}${question ? '\n' + question : ''}`;
  appendMessage('user', display);
  if (!CURRENT_CHAT_ID) await createNewChat(`Analyse: ${file.name}`);
  setLoading(true);
  showTyping('Reading file…');
  const fileTimer = setTimeout(() => updateTypingStatus('Analysing…'), 3000);
  try {
    const res = await fetch('/api/analyse-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({ fileContent: file.content, fileName: file.name, userQuestion: question })
    });
    clearTimeout(fileTimer);
    const data = await res.json();
    hideTyping();
    setLoading(false);
    if (data.error) { showToast(data.error, 'error'); return; }
    appendMessage('assistant', data.reply);
    await SB.from('ai_messages').insert([
      { chat_id: CURRENT_CHAT_ID, role: 'user', content: display },
      { chat_id: CURRENT_CHAT_ID, role: 'assistant', content: data.reply }
    ]);
  } catch(e) { clearTimeout(fileTimer); hideTyping(); setLoading(false); showToast('File analysis failed', 'error'); }
}

// ── Group Chats ────────────────────────────────────────────
async function loadGroups() {
  const { data: memberships } = await SB.from('group_members').select('group_id').eq('user_id', ME.id);
  if (!memberships?.length) { renderGroupList([]); return; }
  const ids = memberships.map(m => m.group_id);
  const { data: groups } = await SB.from('group_chats').select('*').in('id', ids).order('created_at', { ascending: false });
  renderGroupList(groups || []);
  renderGroupBrowser(groups || []);
}

function renderGroupList(groups) {
  const el = document.getElementById('group-list');
  if (!groups.length) { el.innerHTML = '<div class="empty-state" style="font-size:12px">No groups yet</div>'; return; }
  el.innerHTML = groups.map(g => `
    <div class="chat-item ${g.id === CURRENT_GROUP_ID ? 'active' : ''}" onclick="openGroupChat('${g.id}')">
      <div class="avatar sm" style="background:${g.avatar_color||'#7c3aed'}">${g.name[0].toUpperCase()}</div>
      <div class="chat-item-text">
        <div class="chat-item-title">${escHtml(g.name)}</div>
        <div class="chat-item-preview">${escHtml(g.description||'')}</div>
      </div>
    </div>
  `).join('');
}

function renderGroupBrowser(groups) {
  const el = document.getElementById('group-browser');
  if (!groups.length) { el.innerHTML = '<div class="empty-state">No groups yet. Create or join one!</div>'; return; }
  el.innerHTML = groups.map(g => `
    <div class="group-card" onclick="openGroupChat('${g.id}')">
      <div class="avatar md" style="background:${g.avatar_color||'#7c3aed'}">${g.name[0].toUpperCase()}</div>
      <div class="group-card-info">
        <div class="group-card-name">${escHtml(g.name)}</div>
        <div class="group-card-desc">${escHtml(g.description||'No description')}</div>
        <div class="group-card-meta">Click to open</div>
      </div>
    </div>
  `).join('');
}

async function openGroupChat(groupId) {
  CURRENT_GROUP_ID = groupId;
  showSection('groups');
  const { data: group } = await SB.from('group_chats').select('*').eq('id', groupId).single();
  if (!group) return;
  document.getElementById('gc-title').textContent = group.name;
  document.getElementById('mobile-title').textContent = group.name;
  const gc = document.getElementById('group-chat-view');
  const browser = document.getElementById('group-browser');
  gc.classList.remove('hidden'); browser.classList.add('hidden');
  const av = document.getElementById('gc-avatar');
  av.style.background = group.avatar_color || '#7c3aed';
  av.textContent = group.name[0].toUpperCase();
  const { data: members } = await SB.from('group_members').select('user_id').eq('group_id', groupId);
  document.getElementById('gc-members-count').textContent = `${members?.length || 0} members`;
  await loadGroupMessages(groupId);
  // Subscribe to realtime
  if (GROUP_REALTIME) SB.removeChannel(GROUP_REALTIME);
  GROUP_REALTIME = SB.channel(`group-${groupId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_messages', filter: `group_id=eq.${groupId}` }, async payload => {
      const msg = payload.new;
      if (msg.sender_id !== ME.id) {
        const { data: sender } = await SB.from('profiles').select('display_name,avatar_color').eq('id', msg.sender_id).single();
        appendGroupMessage(msg, sender);
      }
    }).subscribe();
}

function closeGroupChat() {
  CURRENT_GROUP_ID = null;
  document.getElementById('group-chat-view').classList.add('hidden');
  document.getElementById('group-browser').classList.remove('hidden');
}

async function loadGroupMessages(groupId) {
  const { data: msgs } = await SB.from('group_messages').select('*, profiles(display_name,avatar_color)').eq('group_id', groupId).order('created_at').limit(100);
  const el = document.getElementById('group-messages');
  el.innerHTML = (msgs||[]).map(m => buildGroupMsgHTML(m)).join('');
  el.scrollTop = el.scrollHeight;
}

function buildGroupMsgHTML(msg, senderOverride) {
  const sender = senderOverride || msg.profiles || {};
  const isOwn = msg.sender_id === ME.id;
  const name = isOwn ? 'You' : (sender.display_name || 'User');
  const color = isOwn ? (ME.avatar_color||'#7c3aed') : (sender.avatar_color||'#3b82f6');
  const initial = name[0].toUpperCase();
  const t = new Date(msg.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return `<div class="message group-msg ${isOwn ? 'own' : ''}">
    ${!isOwn ? `<div class="avatar sm msg-avatar" style="background:${color}">${initial}</div>` : ''}
    <div class="msg-body">
      ${!isOwn ? `<div class="msg-name">${escHtml(name)}</div>` : ''}
      <div class="msg-text">${escHtml(msg.content)}</div>
      <div class="msg-time">${t}</div>
    </div>
  </div>`;
}

function appendGroupMessage(msg, sender) {
  const el = document.getElementById('group-messages');
  el.insertAdjacentHTML('beforeend', buildGroupMsgHTML(msg, sender));
  el.scrollTop = el.scrollHeight;
}

async function sendGroupMessage() {
  if (!CURRENT_GROUP_ID) return;
  const input = document.getElementById('group-msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; autoResize(input);
  const { data: msg } = await SB.from('group_messages').insert({ group_id: CURRENT_GROUP_ID, sender_id: ME.id, content: text }).select().single();
  if (msg) appendGroupMessage({ ...msg, profiles: ME });
}

function openCreateGroup() {
  document.getElementById('create-group-modal').classList.remove('hidden');
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  const desc = document.getElementById('group-desc-input').value.trim();
  const color = document.querySelector('#group-color-picker .color-swatch.selected')?.dataset.color || '#7c3aed';
  if (!name) { showToast('Enter a group name'); return; }
  const { data: group } = await SB.from('group_chats').insert({ name, description: desc, created_by: ME.id, avatar_color: color }).select().single();
  if (!group) { showToast('Could not create group', 'error'); return; }
  await SB.from('group_members').insert({ group_id: group.id, user_id: ME.id, role: 'admin' });
  closeModal('create-group-modal');
  document.getElementById('group-name-input').value = '';
  document.getElementById('group-desc-input').value = '';
  showToast('Group created!');
  await loadGroups();
  openGroupChat(group.id);
}

function openGroupInfo() {
  if (!CURRENT_GROUP_ID) return;
  loadGroupInfo(CURRENT_GROUP_ID);
  document.getElementById('group-info-modal').classList.remove('hidden');
}

async function loadGroupInfo(groupId) {
  const { data: group } = await SB.from('group_chats').select('name').eq('id', groupId).single();
  document.getElementById('gi-title').textContent = group?.name || 'Group Info';
  const { data: members } = await SB.from('group_members').select('*, profiles(display_name,avatar_color)').eq('group_id', groupId);
  const el = document.getElementById('gi-members-list');
  el.innerHTML = (members||[]).map(m => `
    <div class="member-row">
      <div class="avatar sm" style="background:${m.profiles?.avatar_color||'#7c3aed'}">${(m.profiles?.display_name||'?')[0].toUpperCase()}</div>
      <div class="member-name">${escHtml(m.profiles?.display_name||'User')}</div>
      <span class="member-role">${m.role}</span>
    </div>
  `).join('');
}

async function inviteMember() {
  const username = document.getElementById('gi-invite-input').value.trim();
  if (!username) return;
  const { data: user } = await SB.from('profiles').select('id,display_name').eq('username', username).single();
  if (!user) { showToast('User not found'); return; }
  const { error } = await SB.from('group_members').insert({ group_id: CURRENT_GROUP_ID, user_id: user.id });
  if (error) { showToast('Could not invite: ' + error.message, 'error'); return; }
  showToast(`${user.display_name} invited!`);
  document.getElementById('gi-invite-input').value = '';
  loadGroupInfo(CURRENT_GROUP_ID);
}

async function leaveGroup() {
  if (!CURRENT_GROUP_ID) return;
  await SB.from('group_members').delete().eq('group_id', CURRENT_GROUP_ID).eq('user_id', ME.id);
  closeModal('group-info-modal');
  closeGroupChat();
  showToast('Left group');
  await loadGroups();
}

// ── Update Log ─────────────────────────────────────────────
async function loadUpdateLog() {
  const { data } = await SB.from('update_logs').select('*, profiles(display_name)').order('created_at', { ascending: false });
  const el = document.getElementById('update-log-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state">No updates posted yet.</div>'; return; }
  el.innerHTML = data.map(u => `
    <div class="update-card">
      <div class="update-card-header">
        ${u.version ? `<span class="update-version">${escHtml(u.version)}</span>` : ''}
        <div class="update-card-title">${escHtml(u.title)}</div>
        ${ME?.is_admin ? `<button class="icon-btn danger update-card-del" onclick="deleteUpdate('${u.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>` : ''}
      </div>
      <div class="update-card-meta">Posted by ${escHtml(u.profiles?.display_name||'Admin')} · ${new Date(u.created_at).toLocaleDateString()}</div>
      <div class="update-card-body" style="margin-top:10px">${escHtml(u.content)}</div>
    </div>
  `).join('');
  if (ME?.is_admin) document.getElementById('post-update-btn').classList.remove('hidden');
}

function openPostUpdate() { document.getElementById('post-update-modal').classList.remove('hidden'); }

async function postUpdate() {
  const title = document.getElementById('update-title').value.trim();
  const content = document.getElementById('update-content').value.trim();
  const version = document.getElementById('update-version').value.trim();
  if (!title || !content) { showToast('Fill in title and content'); return; }
  await SB.from('update_logs').insert({ title, content, version: version||null, posted_by: ME.id });
  closeModal('post-update-modal');
  document.getElementById('update-title').value = '';
  document.getElementById('update-content').value = '';
  document.getElementById('update-version').value = '';
  showToast('Update posted!');
  loadUpdateLog();
}

async function deleteUpdate(id) {
  await SB.from('update_logs').delete().eq('id', id);
  showToast('Deleted');
  loadUpdateLog();
}

// ── Profile ────────────────────────────────────────────────
function openProfile() {
  document.getElementById('profile-name-input').value = ME.display_name || '';
  setAvatar(document.getElementById('profile-avatar-preview'), ME);
  document.getElementById('profile-modal').classList.remove('hidden');
}

async function saveProfile() {
  const name = document.getElementById('profile-name-input').value.trim();
  const color = document.querySelector('#color-picker .color-swatch.selected')?.dataset.color;
  const update = {};
  if (name) update.display_name = name;
  if (color) update.avatar_color = color;
  await SB.from('profiles').update(update).eq('id', ME.id);
  Object.assign(ME, update);
  renderSidebarUser();
  closeModal('profile-modal');
  showToast('Profile updated!');
}

async function uploadAvatar(event) {
  const file = event.target.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop();
  const path = `${ME.id}/avatar.${ext}`;
  const { error } = await SB.storage.from('avatars').upload(path, file, { upsert: true });
  if (error) { showToast('Upload failed: ' + error.message, 'error'); return; }
  const { data: { publicUrl } } = SB.storage.from('avatars').getPublicUrl(path);
  await SB.from('profiles').update({ avatar_url: publicUrl }).eq('id', ME.id);
  ME.avatar_url = publicUrl;
  setAvatar(document.getElementById('profile-avatar-preview'), ME);
  renderSidebarUser();
  showToast('Photo updated!');
}

function buildColorPickers() {
  ['color-picker','group-color-picker'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = COLORS.map(c => `<div class="color-swatch ${c === (ME.avatar_color||COLORS[0]) ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="selectColor(this,'${id}')"></div>`).join('');
  });
}

function selectColor(el, pickerId) {
  document.querySelectorAll(`#${pickerId} .color-swatch`).forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
  if (pickerId === 'color-picker') {
    document.getElementById('profile-avatar-preview').style.backgroundColor = el.dataset.color;
  }
}

// ── Settings ───────────────────────────────────────────────
function loadSettings() {
  try { SETTINGS = JSON.parse(localStorage.getItem('novaai_settings') || '{}'); } catch { SETTINGS = {}; }
}
function saveSetting(key, val) {
  SETTINGS[key] = val;
  localStorage.setItem('novaai_settings', JSON.stringify(SETTINGS));
}
function applySettings() {
  setTheme(SETTINGS.theme || 'dark', true);
  setFontSize(SETTINGS.fontSize || 'md', true);
  setDensity(SETTINGS.density || 'comfortable', true);
}

function openSettings() {
  document.getElementById('settings-modal').classList.remove('hidden');
  if (ME?.is_admin) document.getElementById('settings-admin-tab').classList.remove('hidden');
  switchSettings('appearance');
  const s = SETTINGS;
  ['dark','light','midnight'].forEach(t => document.getElementById(`theme-${t}`)?.classList.toggle('active', (s.theme||'dark') === t));
  ['sm','md','lg'].forEach(f => document.getElementById(`fs-${f}`)?.classList.toggle('active', (s.fontSize||'md') === f));
  ['compact','comfortable','spacious'].forEach(d => document.getElementById(`density-${d}`)?.classList.toggle('active', (s.density||'comfortable') === d));
  ['concise','balanced','detailed','creative'].forEach(st => document.getElementById(`style-${st}`)?.classList.toggle('active', (s.style||'balanced') === st));
  const lang = document.getElementById('ai-language');
  if (lang) lang.value = s.language || 'en-AU';
  const cp = document.getElementById('custom-prompt');
  if (cp) cp.value = s.customPrompt || '';
}

function switchSettings(pane) {
  document.querySelectorAll('.settings-tab').forEach((el, i) => {
    el.classList.toggle('active', el.textContent.toLowerCase().includes(pane) || el.onclick?.toString().includes(pane));
  });
  document.querySelectorAll('.settings-pane').forEach(el => el.classList.remove('active'));
  document.getElementById(`settings-${pane}`)?.classList.add('active');
}

function setTheme(t, silent) {
  document.documentElement.setAttribute('data-theme', t);
  saveSetting('theme', t);
  if (!silent) document.querySelectorAll('[id^="theme-"]').forEach(el => el.classList.toggle('active', el.id === `theme-${t}`));
}
function setFontSize(f, silent) {
  document.documentElement.setAttribute('data-fs', f);
  saveSetting('fontSize', f);
  if (!silent) document.querySelectorAll('[id^="fs-"]').forEach(el => el.classList.toggle('active', el.id === `fs-${f}`));
}
function setDensity(d, silent) {
  document.documentElement.setAttribute('data-density', d);
  saveSetting('density', d);
  if (!silent) document.querySelectorAll('[id^="density-"]').forEach(el => el.classList.toggle('active', el.id === `density-${d}`));
}
function setStyle(s) {
  saveSetting('style', s);
  document.querySelectorAll('[id^="style-"]').forEach(el => el.classList.toggle('active', el.id === `style-${s}`));
}

// ── Account settings ───────────────────────────────────────
async function changePassword() {
  const p = document.getElementById('new-password').value;
  if (!p || p.length < 6) { showToast('Password must be 6+ chars'); return; }
  const { error } = await SB.auth.updateUser({ password: p });
  if (error) showToast(error.message, 'error');
  else { showToast('Password updated!'); document.getElementById('new-password').value = ''; }
}

async function deleteAccount() {
  if (!confirm('Permanently delete your account? This cannot be undone.')) return;
  await SB.from('profiles').delete().eq('id', ME.id);
  await SB.auth.signOut();
  showToast('Account deleted');
}

// ── Data: export / import ──────────────────────────────────
async function exportChats() {
  const { data: chats } = await SB.from('ai_chats').select('*').eq('user_id', ME.id);
  const result = [];
  for (const c of chats || []) {
    const { data: msgs } = await SB.from('ai_messages').select('*').eq('chat_id', c.id);
    result.push({ ...c, messages: msgs || [] });
  }
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'novaai-chats.json'; a.click();
  showToast('Chats exported!');
}

async function importChats(event) {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { showToast('Invalid JSON', 'error'); return; }
  const chats = Array.isArray(data) ? data : (data.conversations || data.chats || []);
  let count = 0;
  for (const chat of chats) {
    const msgs = chat.messages || chat.mapping ? Object.values(chat.mapping || {}).filter(n => n.message).map(n => ({ role: n.message.author.role === 'assistant' ? 'assistant' : 'user', content: n.message.content?.parts?.join('') || '' })) : [];
    const title = chat.title || chat.name || 'Imported Chat';
    const { data: nc } = await SB.from('ai_chats').insert({ user_id: ME.id, title, last_message: '' }).select().single();
    if (nc && msgs.length) {
      await SB.from('ai_messages').insert(msgs.map(m => ({ chat_id: nc.id, role: m.role, content: m.content })));
    }
    count++;
  }
  showToast(`Imported ${count} chats`);
  await loadChats();
}

async function clearAllChats() {
  if (!confirm('Delete all your chats permanently?')) return;
  await SB.from('ai_chats').delete().eq('user_id', ME.id);
  CHATS = []; CHAT_MESSAGES = {}; CURRENT_CHAT_ID = null;
  renderChatList([]);
  document.getElementById('messages').innerHTML = '';
  document.getElementById('welcome').style.display = 'flex';
  document.getElementById('chat-header').classList.add('hidden');
  showToast('All chats deleted');
}

// ── Admin ──────────────────────────────────────────────────
async function openAdmin() {
  document.getElementById('admin-modal').classList.remove('hidden');
  const res = await fetch('/api/admin/users', { headers: { 'X-User-Token': SESSION_TOKEN } });
  const users = await res.json();
  const el = document.getElementById('admin-user-list');
  if (!users?.length) { el.innerHTML = '<div class="empty-state">No users found.</div>'; return; }
  el.innerHTML = users.map(u => `
    <div class="admin-user-row">
      <div class="avatar sm" style="background:${u.avatar_color||'#7c3aed'}">${(u.display_name||'?')[0].toUpperCase()}</div>
      <div class="admin-user-info">
        <div class="admin-user-name">${escHtml(u.display_name||u.username||'User')}</div>
        <div class="admin-user-sub">${u.daily_msgs||0} msgs · ${u.daily_imgs||0} imgs today ${u.is_admin?'· Admin':''}</div>
      </div>
      <span class="tier-badge ${u.tier||'free'}">${u.tier||'free'}</span>
      ${u.id !== ME.id ? `
        <button class="admin-tier-btn ${u.tier==='pro'?'set-free':'set-pro'}" onclick="setTier('${u.id}','${u.tier==='pro'?'free':'pro'}',this)">
          ${u.tier==='pro'?'Set Free':'Set Pro'}
        </button>` : ''}
    </div>
  `).join('');
}

async function setTier(userId, tier, btn) {
  await fetch('/api/admin/set-tier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
    body: JSON.stringify({ targetUserId: userId, tier })
  });
  showToast(`Set to ${tier}`);
  openAdmin();
}

// ── Helpers ────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

function setInput(text) {
  const el = document.getElementById('msg-input');
  el.value = text; autoResize(el); el.focus();
}

function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = type === 'error' ? 'var(--danger-bg)' : 'var(--bg4)';
  el.style.color = type === 'error' ? 'var(--danger)' : 'var(--text)';
  el.style.borderColor = type === 'error' ? 'var(--danger)' : 'var(--border)';
  el.classList.remove('hidden'); el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.classList.add('hidden'), 300); }, 2800);
}

function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderMarkdown(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hua]|<li|<pre|<code)(.+)$/gm, (m) => m.startsWith('<') ? m : m);
}

// ── Init ───────────────────────────────────────────────────
boot();
