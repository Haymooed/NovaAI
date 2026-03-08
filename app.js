// ── State ──────────────────────────────────────────────────
let SB = null, ME = null, SESSION_TOKEN = null;
let CURRENT_CHAT_ID = null, CURRENT_GROUP_ID = null;
let CHAT_MESSAGES = {}, CHATS = [], SETTINGS = {};
let CURRENT_MODE = 'normal', ATTACHED_FILE = null;
let DAILY_MSGS = 0, DAILY_IMGS = 0, IMG_LIMIT = 3;
let GROUP_REALTIME = null, IS_LOADING = false;
const COLORS = ['#7c3aed','#3b82f6','#10b981','#f59e0b','#ef4444','#ec4899','#06b6d4','#8b5cf6','#84cc16'];


// ── Worker API helpers (bypass Supabase JS RLS issues) ────
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function apiGet(path) {
  const res = await fetch(path, { headers: { 'X-User-Token': SESSION_TOKEN } });
  return res.json();
}

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
  } catch(e) {
    document.getElementById('auth-screen').classList.remove('hidden');
    console.error('Boot error:', e);
  }
}

async function initApp(session) {
  SESSION_TOKEN = session.access_token;
  const { data: prof } = await SB.from('profiles').select('*').eq('id', session.user.id).single();
  ME = prof || { id: session.user.id, display_name: session.user.email?.split('@')[0] || 'User', tier: 'free', avatar_color: COLORS[0] };
  DAILY_IMGS = ME.daily_imgs || 0;
  IMG_LIMIT = ME.tier === 'pro' ? 10 : 3;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  renderSidebarUser();
  buildColorPickers();
  await loadChats();
  loadGroups();
  loadUpdateLog();
  setActiveSection('chats');
  checkSiteStatus();
}

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

// ── Auth ───────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('auth-error').classList.add('hidden');
}

async function doLogin() {
  const email = gv('login-email'), pass = gv('login-pass');
  if (!email || !pass) return authErr('Enter email and password.');
  const btn = document.querySelector('#login-form .auth-btn');
  btn.textContent = 'Signing in…'; btn.disabled = true;
  const { error } = await SB.auth.signInWithPassword({ email, password: pass });
  btn.textContent = 'Sign In'; btn.disabled = false;
  if (error) authErr(error.message);
}

async function doRegister() {
  const name = gv('reg-name'), email = gv('reg-email'), pass = gv('reg-pass');
  if (!name || !email || !pass) return authErr('Fill in all fields.');
  if (pass.length < 6) return authErr('Password must be at least 6 characters.');
  const btn = document.querySelector('#register-form .auth-btn');
  btn.textContent = 'Creating…'; btn.disabled = true;
  const { data, error } = await SB.auth.signUp({ email, password: pass });
  btn.textContent = 'Create Account'; btn.disabled = false;
  if (error) return authErr(error.message);
  if (data.user) {
    const username = name.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,30);
    await SB.from('profiles').upsert({ id: data.user.id, display_name: name, username, avatar_color: COLORS[Math.floor(Math.random()*COLORS.length)] });
    showToast('Account created!');
  }
}

async function doLogout() {
  await SB.auth.signOut();
  CURRENT_CHAT_ID = null; CHATS = []; CHAT_MESSAGES = {};
}

function authErr(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.classList.remove('hidden');
}

// ── Sidebar ────────────────────────────────────────────────
function renderSidebarUser() {
  document.getElementById('sidebar-name').textContent = ME.display_name || 'User';
  const tb = document.getElementById('sidebar-tier');
  tb.textContent = ME.tier === 'pro' ? '⭐ Pro' : 'Free';
  tb.className = 'tier-badge ' + (ME.tier === 'pro' ? 'pro' : 'free');
  setAvatar(document.getElementById('sidebar-avatar'), ME);
  refreshMsgBar(DAILY_MSGS);
  refreshImgCounter();
}

function setAvatar(el, profile) {
  if (!el) return;
  if (profile?.avatar_url) {
    el.style.backgroundImage = `url(${profile.avatar_url})`;
    el.style.backgroundColor = 'transparent';
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.style.backgroundColor = profile?.avatar_color || '#7c3aed';
    el.textContent = ((profile?.display_name || '?')[0]).toUpperCase();
  }
}

function refreshMsgBar(count) {
  DAILY_MSGS = count || 0;
  const pct = Math.min((DAILY_MSGS / 50) * 100, 100);
  document.getElementById('msg-count-text').textContent = `${DAILY_MSGS} / 50 msgs today`;
  document.getElementById('counter-fill').style.width = pct + '%';
}

function refreshImgCounter() {
  const left = Math.max(0, IMG_LIMIT - DAILY_IMGS);
  document.getElementById('img-count-text').textContent = `${left} imgs left`;
}

// ── Section switching ──────────────────────────────────────
function setActiveSection(section) {
  ['chats','groups','updates','images'].forEach(s => {
    document.getElementById('nav-' + s)?.classList.toggle('active', s === section);
  });
  document.getElementById('chat-list').classList.toggle('hidden', section !== 'chats');
  document.getElementById('group-list').classList.toggle('hidden', section !== 'groups');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + section)?.classList.add('active');
  if (section === 'updates') { loadUpdateLog(); document.getElementById('updates-badge').classList.add('hidden'); }
  if (section === 'images') loadImagesPanel();
  closeSidebar();
}

function showSection(s) { setActiveSection(s); }

// ── Chats ──────────────────────────────────────────────────
async function loadChats() {
  const data = await apiGet('/api/chats/list');
  if (!Array.isArray(data)) { console.error('loadChats:', data); return; }
  CHATS = data;
  renderChatList(CHATS);
}
  CHATS = data;
  renderChatList(CHATS);
}

function renderChatList(list) {
  const el = document.getElementById('chat-list');
  if (!list.length) {
    el.innerHTML = '<p class="sidebar-empty">No chats yet. Start one!</p>';
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="chat-item ${c.id === CURRENT_CHAT_ID ? 'active' : ''}" onclick="openChat('${c.id}')">
      <div class="chat-item-text">
        <div class="chat-item-title">${esc(c.title || 'New Chat')}</div>
        <div class="chat-item-preview">${esc((c.last_message || '').slice(0,55))}</div>
      </div>
      <button class="chat-item-del" onclick="event.stopPropagation();deleteChat('${c.id}')" title="Delete">✕</button>
    </div>`).join('');
}

function filterChats(q) {
  const filtered = CHATS.filter(c =>
    (c.title||'').toLowerCase().includes(q.toLowerCase()) ||
    (c.last_message||'').toLowerCase().includes(q.toLowerCase())
  );
  renderChatList(filtered);
}

function newChat() {
  setActiveSection('chats');
  CURRENT_CHAT_ID = null;
  document.getElementById('messages').innerHTML = '';
  document.getElementById('welcome').style.display = 'flex';
  document.getElementById('chat-header').classList.add('hidden');
  document.getElementById('mobile-title').textContent = 'NovaAI';
  renderChatList(CHATS);
  setTimeout(() => document.getElementById('msg-input').focus(), 100);
}

async function openChat(id) {
  CURRENT_CHAT_ID = id;
  setActiveSection('chats');
  const chat = CHATS.find(c => c.id === id);
  if (!chat) return;
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-title-display').textContent = chat.title || 'Chat';
  document.getElementById('mobile-title').textContent = chat.title || 'Chat';
  setAvatar(document.getElementById('chat-header-avatar'), ME);
  const msgs = await apiGet('/api/chats/messages?chat_id=' + id);
  const msgList = Array.isArray(msgs) ? msgs : [];
  CHAT_MESSAGES[id] = msgList;
  renderMessages(msgList);
  renderChatList(CHATS);
  closeSidebar();
}

function renderMessages(msgs) {
  const el = document.getElementById('messages');
  document.getElementById('welcome').style.display = 'none';
  el.innerHTML = msgs.map(m => buildMsgHTML(m.role, m.content, m.created_at)).join('');
  el.scrollTop = el.scrollHeight;
}

function buildMsgHTML(role, content, time, msgId) {
  const isUser = role === 'user';
  const t = time ? new Date(time).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
  const body = isUser ? `<div class="msg-text">${esc(content)}</div>` : `<div class="msg-text">${mdRender(content)}</div>`;
  const av = isUser
    ? `<div class="msg-av" style="background:${ME.avatar_color||'#7c3aed'}">${(ME.display_name||'U')[0].toUpperCase()}</div>`
    : `<div class="msg-av nova-av">N</div>`;
  const actions = isUser ? '' : `
    <div class="msg-actions">
      <button class="msg-action-btn" title="Copy" onclick="copyMsg(this)">📋</button>
      <button class="msg-action-btn" title="Thumbs up" onclick="reactMsg(this,'👍')">👍</button>
      <button class="msg-action-btn" title="Thumbs down" onclick="reactMsg(this,'👎')">👎</button>
      <button class="msg-action-btn" title="Regenerate" onclick="regenMsg(this)">🔄</button>
    </div>`;
  return `<div class="message ${isUser?'user':'ai'}" data-content="${esc(content)}">${av}<div class="msg-body">${body}${actions}<div class="msg-time">${t}</div></div></div>`;
}

function copyMsg(btn) {
  const msg = btn.closest('.message');
  const text = msg?.dataset.content || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✅'; setTimeout(() => btn.textContent = '📋', 1500);
  });
}

function reactMsg(btn, emoji) {
  btn.classList.toggle('reacted');
  btn.style.opacity = btn.classList.contains('reacted') ? '1' : '';
}

async function regenMsg(btn) {
  // find the preceding user message
  const msgEl = btn.closest('.message');
  let prev = msgEl?.previousElementSibling;
  while (prev && !prev.classList.contains('user')) prev = prev?.previousElementSibling;
  const prevText = prev?.dataset.content;
  if (!prevText || !CURRENT_CHAT_ID) return;
  msgEl.remove();
  setLoading(true); showTyping('Regenerating…');
  const history = (CHAT_MESSAGES[CURRENT_CHAT_ID] || []).slice(-20).map(m => ({ role: m.role, content: m.content }));
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({ messages: [{ role: 'system', content: buildSysPrompt() }, ...history, { role: 'user', content: prevText }], temperature: 0.9, max_tokens: 2048 })
    });
    const data = await res.json();
    hideTyping(); setLoading(false);
    const reply = data.choices?.[0]?.message?.content || '(no response)';
    appendMsg('assistant', reply);
    await api('/api/chats/message', { chat_id: CURRENT_CHAT_ID, role: 'assistant', content: reply });
  } catch(e) { hideTyping(); setLoading(false); showToast('Regeneration failed', 'error'); }
}

function appendMsg(role, content) {
  const el = document.getElementById('messages');
  document.getElementById('welcome').style.display = 'none';
  el.insertAdjacentHTML('beforeend', buildMsgHTML(role, content, new Date().toISOString()));
  el.scrollTop = el.scrollHeight;
}

function appendImgMsg(src, prompt, imgId) {
  const container = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'message ai';

  const av = document.createElement('div');
  av.className = 'msg-av nova-av';
  av.textContent = 'N';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const img = document.createElement('img');
  img.className = 'msg-image';
  img.alt = prompt || 'Generated image';
  img.src = src;

  // Action buttons row
  const actions = document.createElement('div');
  actions.className = 'img-actions';

  const dlBtn = document.createElement('button');
  dlBtn.className = 'img-action-btn';
  dlBtn.title = 'Download';
  dlBtn.innerHTML = '⬇️ Download';
  dlBtn.onclick = () => downloadImage(src, prompt);

  const editBtn = document.createElement('button');
  editBtn.className = 'img-action-btn';
  editBtn.title = 'Edit prompt';
  editBtn.innerHTML = '✏️ Edit';
  editBtn.onclick = () => openEditImage(src, prompt || '');

  const viewBtn = document.createElement('button');
  viewBtn.className = 'img-action-btn';
  viewBtn.title = 'Open full size';
  viewBtn.innerHTML = '🔍 Full size';
  viewBtn.onclick = () => window.open(src, '_blank');

  actions.appendChild(dlBtn);
  actions.appendChild(editBtn);
  actions.appendChild(viewBtn);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});

  body.appendChild(img);
  body.appendChild(actions);
  body.appendChild(time);
  wrap.appendChild(av);
  wrap.appendChild(body);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

// ── Typing indicator ───────────────────────────────────────
function showTyping(label) {
  hideTyping();
  const el = document.getElementById('messages');
  document.getElementById('welcome').style.display = 'none';
  const div = document.createElement('div');
  div.id = 'typing-indicator';
  div.className = 'message ai typing-msg';
  div.innerHTML = `
    <div class="msg-av nova-av">N</div>
    <div class="msg-body">
      <div class="typing-label" id="typing-label">${label||'Thinking…'}</div>
      <div class="typing-dots"><span></span><span></span><span></span></div>
    </div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function setTypingLabel(text) {
  const el = document.getElementById('typing-label');
  if (el) el.textContent = text;
}

function hideTyping() { document.getElementById('typing-indicator')?.remove(); }

function setLoading(on) {
  IS_LOADING = on;
  const btn = document.getElementById('send-btn');
  if (!btn) return;
  btn.disabled = on;
  btn.style.opacity = on ? '0.4' : '1';
}

// ── Send message ───────────────────────────────────────────
async function sendMessage() {
  if (IS_LOADING) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && !ATTACHED_FILE) return;

  if (CURRENT_MODE === 'imagine') {
    input.value = ''; resizeInput(input);
    await doGenerateImage(text);
    return;
  }

  if (ATTACHED_FILE) {
    input.value = ''; resizeInput(input);
    await doFileAnalysis(text);
    return;
  }

  input.value = ''; resizeInput(input);
  appendMsg('user', text);

  if (!CURRENT_CHAT_ID) {
    const ok = await createChat(text);
    if (!ok) { showToast('Could not create chat', 'error'); return; }
  }

  await api('/api/chats/message', { chat_id: CURRENT_CHAT_ID, role: 'user', content: text });

  setLoading(true);
  showTyping(CURRENT_MODE === 'search' ? 'Searching the web…' : 'Thinking…');

  const t1 = CURRENT_MODE === 'search'
    ? setTimeout(() => setTypingLabel('Reading results…'), 3500)
    : setTimeout(() => setTypingLabel('Writing response…'), 5000);

  const history = (CHAT_MESSAGES[CURRENT_CHAT_ID] || []).slice(-20).map(m => ({ role: m.role, content: m.content }));
  history.push({ role: 'user', content: text });

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [{ role: 'system', content: buildSysPrompt() }, ...history],
        useWebSearch: CURRENT_MODE === 'search',
        temperature: CURRENT_MODE === 'creative' ? 1.1 : CURRENT_MODE === 'code' ? 0.2 : 0.7,
        max_tokens: SETTINGS.style === 'detailed' ? 4096 : 2048
      })
    });
    clearTimeout(t1);
    const data = await res.json();
    hideTyping(); setLoading(false);

    if (data.error === 'limit_reached') {
      document.getElementById('limit-reset-time').textContent = data.resetIn;
      document.getElementById('limit-modal').classList.remove('hidden');
      return;
    }
    if (data.error) { showToast(data.error, 'error'); return; }

    const reply = data.choices?.[0]?.message?.content || '(no response)';
    appendMsg('assistant', reply);
    if (data._dailyMsgs !== undefined) refreshMsgBar(data._dailyMsgs);

    if (!CHAT_MESSAGES[CURRENT_CHAT_ID]) CHAT_MESSAGES[CURRENT_CHAT_ID] = [];
    CHAT_MESSAGES[CURRENT_CHAT_ID].push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    await api('/api/chats/message', { chat_id: CURRENT_CHAT_ID, role: 'assistant', content: reply });
    await api('/api/chats/update', { chat_id: CURRENT_CHAT_ID, last_message: reply.slice(0,80) });
    loadChats();
    // Auto-title after first exchange
    if ((CHAT_MESSAGES[CURRENT_CHAT_ID]||[]).length <= 2) autoTitleChat(text, reply);
  } catch(e) {
    clearTimeout(t1);
    hideTyping(); setLoading(false);
    showToast('Connection error — try again', 'error');
    console.error(e);
  }
}

function buildSysPrompt() {
  const styles = { concise:'Be concise and direct.', balanced:'Be helpful and balanced.', detailed:'Be thorough and detailed.', creative:'Be creative and expressive.' };
  const modes = { code:'You are in Code Mode. Always use code blocks. Explain code clearly.', search:'Summarise web search results helpfully and cite sources.', creative:'You are in Creative Mode. Be imaginative and original.', normal:'' };
  const base = `You are NovaAI, a helpful AI assistant. ${styles[SETTINGS.style||'balanced']} ${modes[CURRENT_MODE]||''}`.trim();
  return SETTINGS.customPrompt ? base + '\n\n' + SETTINGS.customPrompt : base;
}

async function createChat(firstMsg) {
  const title = (firstMsg || 'New Chat').slice(0, 50);
  const res = await api('/api/chats/create', { title });
  if (res.error || !res.data) {
    showToast('Could not create chat: ' + (res.error || 'unknown'), 'error');
    console.error('createChat:', res);
    return false;
  }
  const chatData = res.data;
  CURRENT_CHAT_ID = chatData.id;
  CHAT_MESSAGES[chatData.id] = [];
  CHATS.unshift(chatData);
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-title-display').textContent = title;
  document.getElementById('mobile-title').textContent = title;
  renderChatList(CHATS);
  return true;
}

async function deleteChat(id) {
  await api('/api/chats/delete', { chat_id: id });
  CHATS = CHATS.filter(c => c.id !== id);
  if (CURRENT_CHAT_ID === id) newChat();
  else renderChatList(CHATS);
}

async function deleteCurrentChat() { if (CURRENT_CHAT_ID) await deleteChat(CURRENT_CHAT_ID); }

// ── Rename ─────────────────────────────────────────────────
function startRename() {
  const d = document.getElementById('chat-title-display');
  const i = document.getElementById('chat-title-input');
  i.value = d.textContent;
  d.classList.add('hidden'); i.classList.remove('hidden');
  i.focus(); i.select();
}
async function finishRename() {
  const d = document.getElementById('chat-title-display');
  const i = document.getElementById('chat-title-input');
  const title = i.value.trim() || 'New Chat';
  d.textContent = title; d.classList.remove('hidden'); i.classList.add('hidden');
  if (CURRENT_CHAT_ID) {
    await api('/api/chats/update', { chat_id: CURRENT_CHAT_ID, title });
    const c = CHATS.find(c => c.id === CURRENT_CHAT_ID);
    if (c) c.title = title;
    renderChatList(CHATS);
  }
}

// ── Mode ───────────────────────────────────────────────────
function setMode(mode) {
  CURRENT_MODE = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('mode-' + mode)?.classList.add('active');
  const hints = { normal:'Message NovaAI…', code:'Ask a coding question…', imagine:'Describe an image to generate…', search:'Search the web…', creative:'Write something creative…' };
  document.getElementById('msg-input').placeholder = hints[mode] || 'Message NovaAI…';
  updateWelcomeChips();
}
function enableWebSearch() { setMode('search'); }

// ── Image gen ──────────────────────────────────────────────
async function doGenerateImage(prompt) {
  if (!prompt) { showToast('Describe the image first'); return; }
  if (DAILY_IMGS >= IMG_LIMIT) { document.getElementById('img-limit-modal').classList.remove('hidden'); return; }
  appendMsg('user', '🎨 ' + prompt);
  if (!CURRENT_CHAT_ID) { const ok = await createChat('Image: ' + prompt); if (!ok) return; }
  setLoading(true);
  showTyping('Generating image…');
  const t = setTimeout(() => setTypingLabel('Still rendering — usually 15–30s…'), 8000);
  try {
    const res = await fetch('/api/imagine', { method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN}, body:JSON.stringify({ prompt }) });
    clearTimeout(t);
    const data = await res.json();
    hideTyping(); setLoading(false);
    if (data.error === 'img_limit_reached') {
      document.getElementById('img-limit-reset').textContent = data.resetIn || '';
      document.getElementById('img-limit-modal').classList.remove('hidden');
      return;
    }
    if (data.error) { showToast(data.error, 'error'); return; }
    // Use persistent URL if available, else base64
    const displaySrc = data.url || data.image;
    appendImgMsg(displaySrc, prompt, data.imgId);
    DAILY_IMGS = data._dailyImgs ?? (DAILY_IMGS + 1);
    refreshImgCounter();
  } catch(e) { clearTimeout(t); hideTyping(); setLoading(false); showToast('Image generation failed', 'error'); }
}

// ── File ──────────────────────────────────────────────────
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5*1024*1024) { showToast('File too large (max 5MB)'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    ATTACHED_FILE = { name: file.name, content: ev.target.result };
    document.getElementById('file-preview').classList.remove('hidden');
    document.getElementById('file-preview-inner').textContent = `📎 ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
    document.getElementById('msg-input').placeholder = `Ask about ${file.name}…`;
  };
  reader.readAsText(file);
  e.target.value = '';
}

function clearFile() {
  ATTACHED_FILE = null;
  document.getElementById('file-preview').classList.add('hidden');
  document.getElementById('msg-input').placeholder = 'Message NovaAI…';
}

async function doFileAnalysis(question) {
  const file = ATTACHED_FILE; clearFile();
  const display = `📎 ${file.name}${question ? '\n' + question : ''}`;
  appendMsg('user', display);
  if (!CURRENT_CHAT_ID) { const ok = await createChat('Analyse: ' + file.name); if (!ok) return; }
  setLoading(true); showTyping('Reading file…');
  const t = setTimeout(() => setTypingLabel('Analysing content…'), 3000);
  try {
    const res = await fetch('/api/analyse-file', { method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN}, body:JSON.stringify({ fileContent: file.content, fileName: file.name, userQuestion: question }) });
    clearTimeout(t);
    const data = await res.json();
    hideTyping(); setLoading(false);
    if (data.error) { showToast(data.error, 'error'); return; }
    appendMsg('assistant', data.reply);
    await api('/api/chats/message', { chat_id: CURRENT_CHAT_ID, role: 'user', content: display });
    await api('/api/chats/message', { chat_id: CURRENT_CHAT_ID, role: 'assistant', content: data.reply });
  } catch(e) { clearTimeout(t); hideTyping(); setLoading(false); showToast('File analysis failed', 'error'); }
}

// ── Group Chats ────────────────────────────────────────────
async function loadGroups() {
  const { data: mem } = await SB.from('group_members').select('group_id').eq('user_id', ME.id);
  if (!mem?.length) { renderGroupSidebar([]); renderGroupBrowser([]); return; }
  const { data: groups } = await SB.from('group_chats').select('*').in('id', mem.map(m=>m.group_id)).order('created_at', { ascending: false });
  renderGroupSidebar(groups || []);
  renderGroupBrowser(groups || []);
}

function renderGroupSidebar(groups) {
  const el = document.getElementById('group-list');
  el.innerHTML = groups.length
    ? groups.map(g => `<div class="chat-item ${g.id===CURRENT_GROUP_ID?'active':''}" onclick="openGroupChat('${g.id}')">
        <div class="chat-item-text"><div class="chat-item-title">${esc(g.name)}</div><div class="chat-item-preview">${esc(g.description||'')}</div></div>
      </div>`).join('')
    : '<p class="sidebar-empty">No groups yet</p>';
}

function renderGroupBrowser(groups) {
  const el = document.getElementById('group-browser');
  el.innerHTML = groups.length
    ? groups.map(g => `<div class="group-card" onclick="openGroupChat('${g.id}')">
        <div class="group-card-av" style="background:${g.avatar_color||'#7c3aed'}">${g.name[0].toUpperCase()}</div>
        <div class="group-card-info"><div class="group-card-name">${esc(g.name)}</div><div class="group-card-desc">${esc(g.description||'No description')}</div></div>
        <span style="color:var(--text3)">›</span>
      </div>`).join('')
    : '<div class="empty-state">No groups yet.<br>Create one to get started!</div>';
}

async function openGroupChat(groupId) {
  CURRENT_GROUP_ID = groupId;
  setActiveSection('groups');
  const { data: group } = await SB.from('group_chats').select('*').eq('id', groupId).single();
  if (!group) return;
  document.getElementById('group-browser').classList.add('hidden');
  document.getElementById('group-chat-view').classList.remove('hidden');
  document.getElementById('gc-title').textContent = group.name;
  document.getElementById('mobile-title').textContent = group.name;
  const av = document.getElementById('gc-avatar');
  av.style.background = group.avatar_color||'#7c3aed'; av.textContent = group.name[0].toUpperCase();
  const { data: members } = await SB.from('group_members').select('user_id').eq('group_id', groupId);
  document.getElementById('gc-members-count').textContent = `${members?.length||0} members`;
  await loadGroupMessages(groupId);
  if (GROUP_REALTIME) SB.removeChannel(GROUP_REALTIME);
  GROUP_REALTIME = SB.channel('grp-'+groupId).on('postgres_changes', { event:'INSERT', schema:'public', table:'group_messages', filter:`group_id=eq.${groupId}` }, async p => {
    if (p.new.sender_id === ME.id) return;
    const { data: s } = await SB.from('profiles').select('display_name,avatar_color').eq('id', p.new.sender_id).single();
    appendGroupMsg(p.new, s);
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
  el.innerHTML = (msgs||[]).map(m => buildGroupMsgHTML(m, m.profiles)).join('');
  el.scrollTop = el.scrollHeight;
}

function buildGroupMsgHTML(msg, sender) {
  const own = msg.sender_id === ME.id;
  const name = own ? 'You' : (sender?.display_name||'User');
  const color = own ? (ME.avatar_color||'#7c3aed') : (sender?.avatar_color||'#3b82f6');
  const t = new Date(msg.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return `<div class="message ${own?'user':'ai'}">
    ${!own?`<div class="msg-av" style="background:${color}">${name[0].toUpperCase()}</div>`:''}
    <div class="msg-body">${!own?`<div class="msg-sender">${esc(name)}</div>`:''}<div class="msg-text">${esc(msg.content)}</div><div class="msg-time">${t}</div></div>
  </div>`;
}

function appendGroupMsg(msg, sender) {
  const el = document.getElementById('group-messages');
  el.insertAdjacentHTML('beforeend', buildGroupMsgHTML(msg, sender));
  el.scrollTop = el.scrollHeight;
}

async function sendGroupMessage() {
  if (!CURRENT_GROUP_ID) return;
  const input = document.getElementById('group-msg-input');
  const text = input.value.trim(); if (!text) return;
  input.value = ''; resizeInput(input);
  const { data: msg } = await SB.from('group_messages').insert({ group_id: CURRENT_GROUP_ID, sender_id: ME.id, content: text }).select().single();
  if (msg) appendGroupMsg(msg, ME);
}

function openCreateGroup() { document.getElementById('create-group-modal').classList.remove('hidden'); }

async function createGroup() {
  const name = gv('group-name-input'), desc = gv('group-desc-input');
  const color = document.querySelector('#group-color-picker .color-swatch.selected')?.dataset.color || '#7c3aed';
  if (!name) { showToast('Enter a group name'); return; }
  const { data: group, error } = await SB.from('group_chats').insert({ name, description: desc, created_by: ME.id, avatar_color: color }).select().single();
  if (error||!group) { showToast('Could not create group', 'error'); return; }
  await SB.from('group_members').insert({ group_id: group.id, user_id: ME.id, role: 'admin' });
  closeModal('create-group-modal');
  document.getElementById('group-name-input').value = '';
  document.getElementById('group-desc-input').value = '';
  showToast('Group created!');
  await loadGroups();
  openGroupChat(group.id);
}

function openGroupInfo() { if (!CURRENT_GROUP_ID) return; loadGroupInfo(CURRENT_GROUP_ID); document.getElementById('group-info-modal').classList.remove('hidden'); }

async function loadGroupInfo(groupId) {
  const { data: group } = await SB.from('group_chats').select('name').eq('id', groupId).single();
  document.getElementById('gi-title').textContent = group?.name || 'Group';
  const { data: members } = await SB.from('group_members').select('*, profiles(display_name,avatar_color)').eq('group_id', groupId);
  document.getElementById('gi-members-list').innerHTML = (members||[]).map(m => `
    <div class="member-row">
      <div class="msg-av" style="background:${m.profiles?.avatar_color||'#7c3aed'}">${(m.profiles?.display_name||'?')[0].toUpperCase()}</div>
      <div class="member-name">${esc(m.profiles?.display_name||'User')}</div>
      <span class="member-role">${m.role}</span>
    </div>`).join('');
}

async function inviteMember() {
  const username = gv('gi-invite-input'); if (!username) return;
  const { data: user } = await SB.from('profiles').select('id,display_name').eq('username', username).single();
  if (!user) { showToast('User not found'); return; }
  const { error } = await SB.from('group_members').insert({ group_id: CURRENT_GROUP_ID, user_id: user.id });
  if (error) { showToast('Could not invite — already a member?', 'error'); return; }
  showToast(user.display_name + ' invited!');
  document.getElementById('gi-invite-input').value = '';
  loadGroupInfo(CURRENT_GROUP_ID);
}

async function leaveGroup() {
  if (!CURRENT_GROUP_ID) return;
  await SB.from('group_members').delete().eq('group_id', CURRENT_GROUP_ID).eq('user_id', ME.id);
  closeModal('group-info-modal'); closeGroupChat(); showToast('Left group'); loadGroups();
}

// ── Update Log ─────────────────────────────────────────────
async function loadUpdateLog() {
  if (ME?.is_admin) document.getElementById('post-update-btn').classList.remove('hidden');
  const { data } = await SB.from('update_logs').select('*, profiles(display_name)').order('created_at', { ascending: false });
  const el = document.getElementById('update-log-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state">No updates posted yet.</div>'; return; }
  el.innerHTML = data.map(u => `
    <div class="update-card">
      <div class="update-card-header">
        ${u.version?`<span class="update-version">${esc(u.version)}</span>`:''}
        <div class="update-card-title">${esc(u.title)}</div>
        ${ME?.is_admin?`<button class="icon-btn" style="color:var(--danger);margin-left:auto" onclick="deleteUpdate('${u.id}')">✕</button>`:''}
      </div>
      <div class="update-card-meta">By ${esc(u.profiles?.display_name||'Admin')} · ${new Date(u.created_at).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}</div>
      <div class="update-card-body">${esc(u.content)}</div>
    </div>`).join('');
}

function openPostUpdate() { document.getElementById('post-update-modal').classList.remove('hidden'); }

async function postUpdate() {
  const title = gv('update-title'), content = gv('update-content'), version = gv('update-version');
  if (!title||!content) { showToast('Title and content required'); return; }
  await SB.from('update_logs').insert({ title, content, version: version||null, posted_by: ME.id });
  closeModal('post-update-modal');
  ['update-title','update-content','update-version'].forEach(id => { document.getElementById(id).value = ''; });
  showToast('Update posted!'); loadUpdateLog();
}

async function deleteUpdate(id) { await SB.from('update_logs').delete().eq('id', id); loadUpdateLog(); }

// ── Profile ────────────────────────────────────────────────
function openProfile() {
  document.getElementById('profile-name-input').value = ME.display_name||'';
  setAvatar(document.getElementById('profile-avatar-preview'), ME);
  document.getElementById('profile-modal').classList.remove('hidden');
}

async function saveProfile() {
  const name = gv('profile-name-input');
  const color = document.querySelector('#color-picker .color-swatch.selected')?.dataset.color;
  const update = {};
  if (name) update.display_name = name;
  if (color) update.avatar_color = color;
  await SB.from('profiles').update(update).eq('id', ME.id);
  Object.assign(ME, update);
  renderSidebarUser(); closeModal('profile-modal'); showToast('Profile updated!');
}

async function uploadAvatar(e) {
  const file = e.target.files[0]; if (!file) return;
  const ext = file.name.split('.').pop();
  const path = `${ME.id}/avatar.${ext}`;
  const { error } = await SB.storage.from('avatars').upload(path, file, { upsert: true });
  if (error) { showToast('Upload failed: '+error.message, 'error'); return; }
  const { data: { publicUrl } } = SB.storage.from('avatars').getPublicUrl(path);
  await SB.from('profiles').update({ avatar_url: publicUrl }).eq('id', ME.id);
  ME.avatar_url = publicUrl;
  setAvatar(document.getElementById('profile-avatar-preview'), ME);
  renderSidebarUser(); showToast('Photo updated!');
}

function buildColorPickers() {
  ['color-picker','group-color-picker'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = COLORS.map(c => `<div class="color-swatch ${c===(ME.avatar_color||COLORS[0])?'selected':''}" style="background:${c}" data-color="${c}" onclick="pickColor(this,'${id}')"></div>`).join('');
  });
}

function pickColor(el, pickerId) {
  document.querySelectorAll(`#${pickerId} .color-swatch`).forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
  if (pickerId === 'color-picker') {
    const av = document.getElementById('profile-avatar-preview');
    av.style.backgroundColor = el.dataset.color; av.style.backgroundImage = '';
  }
}

// ── Settings ───────────────────────────────────────────────
function loadSettings() { try { SETTINGS = JSON.parse(localStorage.getItem('novaai_settings')||'{}'); } catch { SETTINGS={}; } }
function saveSetting(key, v) { SETTINGS[key]=v; localStorage.setItem('novaai_settings', JSON.stringify(SETTINGS)); }
function applySettings() { applyTheme(SETTINGS.theme||'dark'); applyFontSize(SETTINGS.fontSize||'md'); applyDensity(SETTINGS.density||'comfortable'); }

function openSettings() {
  document.getElementById('settings-modal').classList.remove('hidden');
  if (ME?.is_admin) document.getElementById('settings-admin-tab').classList.remove('hidden');
  switchSettings('appearance');
  markSeg('theme', SETTINGS.theme||'dark'); markSeg('fs', SETTINGS.fontSize||'md');
  markSeg('density', SETTINGS.density||'comfortable'); markSeg('style', SETTINGS.style||'balanced');
  const lang = document.getElementById('ai-language'); if (lang) lang.value = SETTINGS.language||'en-AU';
  const cp = document.getElementById('custom-prompt'); if (cp) cp.value = SETTINGS.customPrompt||'';
}

function switchSettings(pane) {
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.toggle('active', el.getAttribute('data-pane')===pane));
  document.querySelectorAll('.settings-pane').forEach(el => el.classList.remove('active'));
  document.getElementById('settings-'+pane)?.classList.add('active');
}

function markSeg(group, v) {
  document.querySelectorAll(`[data-seg="${group}"]`).forEach(el => el.classList.toggle('active', el.dataset.val===v));
}

function setTheme(t) { applyTheme(t); saveSetting('theme',t); markSeg('theme',t); }
function setFontSize(f) { applyFontSize(f); saveSetting('fontSize',f); markSeg('fs',f); }
function setDensity(d) { applyDensity(d); saveSetting('density',d); markSeg('density',d); }
function setStyle(s) { saveSetting('style',s); markSeg('style',s); }
function applyTheme(t) { document.documentElement.setAttribute('data-theme',t); }
function applyFontSize(f) { document.documentElement.setAttribute('data-fs',f); }
function applyDensity(d) { document.documentElement.setAttribute('data-density',d); }

async function changePassword() {
  const p = gv('new-password'); if (!p||p.length<6) { showToast('Must be 6+ chars'); return; }
  const { error } = await SB.auth.updateUser({ password: p });
  if (error) showToast(error.message,'error'); else { showToast('Password updated!'); document.getElementById('new-password').value=''; }
}

async function deleteAccount() {
  if (!confirm('Permanently delete your account?')) return;
  await SB.from('profiles').delete().eq('id', ME.id); await SB.auth.signOut();
}

async function exportChats() {
  const chats = await apiGet('/api/chats/list');
  const out = [];
  for (const c of (Array.isArray(chats)?chats:[])) {
    const msgs = await apiGet('/api/chats/messages?chat_id=' + c.id);
    out.push({...c, messages: Array.isArray(msgs)?msgs:[]});
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));
  a.download = 'novaai-export.json'; a.click(); showToast('Exported!');
}

async function importChats(e) {
  const file = e.target.files[0]; if (!file) return;
  let data; try { data = JSON.parse(await file.text()); } catch { showToast('Invalid JSON','error'); return; }
  const chats = Array.isArray(data) ? data : (data.conversations||[]);
  let n = 0;
  for (const c of chats) {
    const res = await api('/api/chats/create', { title: c.title||'Imported Chat' });
    const nc = res.data;
    if (nc && c.messages?.length) {
      for (const m of c.messages) await api('/api/chats/message', { chat_id: nc.id, role: m.role, content: m.content });
    }
    n++;
  }
  showToast(`Imported ${n} chats`); loadChats();
}

async function clearAllChats() {
  if (!confirm('Delete all chats permanently?')) return;
  for (const c of CHATS) { await api('/api/chats/delete', { chat_id: c.id }); }
  CHATS=[]; CHAT_MESSAGES={}; CURRENT_CHAT_ID=null; newChat(); showToast('All chats deleted');
}

// ── Admin ──────────────────────────────────────────────────
let ADMIN_CFG = {};
let ADMIN_USERS = [];

async function openAdmin() {
  document.getElementById('admin-modal').classList.remove('hidden');
  switchAdminTab('site');
  await Promise.all([loadAdminConfig(), loadAdminUsers()]);
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.admin-pane').forEach(el => el.classList.remove('active'));
  document.getElementById('admin-pane-' + tab)?.classList.add('active');
}

async function loadAdminConfig() {
  const res = await fetch('/api/admin/config', { headers: {'X-User-Token': SESSION_TOKEN} });
  ADMIN_CFG = await res.json();
  renderAdminSitePane();
  renderAdminLimitsPane();
  renderAdminBannerPane();
}

function renderAdminSitePane() {
  const c = ADMIN_CFG;
  const siteDown = c.site_down === 'true';
  const chatOff = c.chat_disabled === 'true';
  const imgOff = c.img_disabled === 'true';

  document.getElementById('admin-site-status').innerHTML = `
    <div class="admin-status-card ${siteDown ? 'danger' : 'ok'}">
      <div class="admin-status-dot"></div>
      <span>${siteDown ? '🔴 Site is OFFLINE' : '🟢 Site is ONLINE'}</span>
    </div>`;

  document.getElementById('admin-site-controls').innerHTML = `
    <div class="admin-toggle-row">
      <div>
        <div class="admin-toggle-label">🔴 Site Offline Mode</div>
        <div class="admin-toggle-sub">Blocks all users (except admins). Shows a maintenance page.</div>
      </div>
      <button class="admin-toggle-btn ${siteDown?'on':'off'}" onclick="adminToggle('site_down','${siteDown?'false':'true'}','Site ${siteDown?'restored':'taken offline'}')">
        ${siteDown ? 'Bring Online' : 'Take Offline'}
      </button>
    </div>
    <div class="admin-sub-row ${siteDown?'':'muted'}">
      <input class="form-input sm" id="down-msg-input" value="${esc(c.down_message||'NovaAI is temporarily offline for maintenance.')}" placeholder="Offline message shown to users"/>
      <button class="btn-secondary sm" onclick="adminSaveDownMsg()">Save Message</button>
    </div>
    <div class="admin-toggle-row">
      <div>
        <div class="admin-toggle-label">💬 Disable Chat</div>
        <div class="admin-toggle-sub">Blocks all new messages. Images still work.</div>
      </div>
      <button class="admin-toggle-btn ${chatOff?'on':'off'}" onclick="adminToggle('chat_disabled','${chatOff?'false':'true'}','Chat ${chatOff?'enabled':'disabled'}')">
        ${chatOff ? 'Enable Chat' : 'Disable Chat'}
      </button>
    </div>
    <div class="admin-toggle-row">
      <div>
        <div class="admin-toggle-label">🎨 Disable Image Gen</div>
        <div class="admin-toggle-sub">Blocks all image generation. Chat still works.</div>
      </div>
      <button class="admin-toggle-btn ${imgOff?'on':'off'}" onclick="adminToggle('img_disabled','${imgOff?'false':'true'}','Image gen ${imgOff?'enabled':'disabled'}')">
        ${imgOff ? 'Enable Images' : 'Disable Images'}
      </button>
    </div>`;
}

function renderAdminLimitsPane() {
  const c = ADMIN_CFG;
  document.getElementById('admin-limits-pane-inner').innerHTML = `
    <div class="admin-section-label">🌐 Global Limits (applies to all free users unless overridden)</div>
    <div class="admin-limit-grid">
      <div class="admin-limit-item">
        <label>Free msg limit/day</label>
        <div style="display:flex;gap:6px">
          <input class="form-input sm" id="g-msg-free" type="number" min="0" max="9999" value="${c.global_msg_limit||50}"/>
          <button class="btn-secondary sm" onclick="adminSaveGlobalLimit('global_msg_limit','g-msg-free','Message limit saved')">Save</button>
        </div>
      </div>
      <div class="admin-limit-item">
        <label>Free image limit/day</label>
        <div style="display:flex;gap:6px">
          <input class="form-input sm" id="g-img-free" type="number" min="0" max="9999" value="${c.global_img_limit_free||3}"/>
          <button class="btn-secondary sm" onclick="adminSaveGlobalLimit('global_img_limit_free','g-img-free','Image limit saved')">Save</button>
        </div>
      </div>
      <div class="admin-limit-item">
        <label>Pro image limit/day</label>
        <div style="display:flex;gap:6px">
          <input class="form-input sm" id="g-img-pro" type="number" min="0" max="9999" value="${c.global_img_limit_pro||10}"/>
          <button class="btn-secondary sm" onclick="adminSaveGlobalLimit('global_img_limit_pro','g-img-pro','Pro limit saved')">Save</button>
        </div>
      </div>
    </div>`;
}

function renderAdminBannerPane() {
  const c = ADMIN_CFG;
  const hasBanner = !!c.banner;
  document.getElementById('admin-banner-inner').innerHTML = `
    <div class="admin-section-label">📢 Site-wide Banner Message</div>
    <div class="admin-sub-text">Shown to all users at the top of the app.</div>
    <textarea class="form-input" id="banner-text" rows="3" placeholder="e.g. Maintenance scheduled for Sunday 2am AEST">${esc(c.banner||'')}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
      <select class="form-input sm" id="banner-type" style="flex:0 0 120px">
        <option value="info" ${c.banner_type==='info'?'selected':''}>ℹ️ Info</option>
        <option value="warning" ${c.banner_type==='warning'?'selected':''}>⚠️ Warning</option>
        <option value="danger" ${c.banner_type==='danger'?'selected':''}>🔴 Danger</option>
        <option value="success" ${c.banner_type==='success'?'selected':''}>✅ Success</option>
      </select>
      <button class="btn-primary sm" onclick="adminSaveBanner()">Set Banner</button>
      ${hasBanner ? '<button class="btn-danger sm" onclick="adminClearBanner()">Clear Banner</button>' : ''}
    </div>`;
}

async function loadAdminUsers() {
  const res = await fetch('/api/admin/users', { headers: {'X-User-Token': SESSION_TOKEN} });
  ADMIN_USERS = await res.json();
  renderAdminUsers();
}

function renderAdminUsers(filter = '') {
  const el = document.getElementById('admin-user-list');
  let list = ADMIN_USERS;
  if (filter) list = list.filter(u => (u.display_name||'').toLowerCase().includes(filter) || (u.username||'').toLowerCase().includes(filter));
  if (!list.length) { el.innerHTML = '<div class="empty-state">No users found.</div>'; return; }
  el.innerHTML = list.map(u => `
    <div class="admin-user-row ${u.is_banned?'banned':''}">
      <div class="msg-av" style="background:${u.avatar_color||'#7c3aed'}">${(u.display_name||'?')[0].toUpperCase()}</div>
      <div class="admin-user-info">
        <div class="admin-user-name">${esc(u.display_name||u.username||'User')} ${u.is_admin?'<span class="badge-admin">Admin</span>':''} ${u.is_banned?'<span class="badge-banned">Banned</span>':''}</div>
        <div class="admin-user-sub">
          💬 ${u.daily_msgs||0}${u.custom_msg_limit!=null?'/'+u.custom_msg_limit:''} msgs today &nbsp;·&nbsp;
          🎨 ${u.daily_imgs||0}${u.custom_img_limit!=null?'/'+u.custom_img_limit:''} imgs today
        </div>
      </div>
      <div class="admin-user-actions">
        <span class="tier-badge ${u.tier||'free'}">${u.tier||'free'}</span>
        <button class="admin-icon-btn" title="Expand controls" onclick="toggleUserControls('${u.id}')">⚙️</button>
      </div>
    </div>
    <div id="uc-${u.id}" class="user-controls hidden">
      <div class="user-controls-grid">
        <button class="uc-btn tier" onclick="setTier('${u.id}','${u.tier==='pro'?'free':'pro'}')">${u.tier==='pro'?'→ Free':'→ Pro'}</button>
        <button class="uc-btn reset" onclick="adminResetUser('${u.id}')">🔄 Reset Counts</button>
        <button class="uc-btn ${u.is_banned?'unban':'ban'}" onclick="adminBanUser('${u.id}',${!u.is_banned})">${u.is_banned?'✅ Unban':'🚫 Ban'}</button>
      </div>
      <div class="user-limits-row">
        <div class="user-limit-field">
          <label>Custom msg limit/day <small>(blank = global)</small></label>
          <div style="display:flex;gap:6px">
            <input class="form-input sm" id="ul-msg-${u.id}" type="number" min="0" max="9999" placeholder="${ADMIN_CFG.global_msg_limit||50}" value="${u.custom_msg_limit??''}"/>
            <input class="form-input sm" id="ul-img-${u.id}" type="number" min="0" max="9999" placeholder="${u.tier==='pro'?(ADMIN_CFG.global_img_limit_pro||10):(ADMIN_CFG.global_img_limit_free||3)}" style="width:70px" title="Custom img limit"/>
            <button class="btn-secondary sm" onclick="adminSetUserLimits('${u.id}')">Save</button>
          </div>
        </div>
      </div>
    </div>`).join('');
}

function toggleUserControls(uid) {
  const el = document.getElementById('uc-' + uid);
  if (el) el.classList.toggle('hidden');
}

async function adminToggle(key, value, msg) {
  await adminSetConfig(key, value);
  showToast(msg);
  await loadAdminConfig();
}

async function adminSaveDownMsg() {
  const msg = document.getElementById('down-msg-input')?.value?.trim();
  if (!msg) return;
  await adminSetConfig('down_message', msg);
  showToast('Offline message saved');
}

async function adminSaveGlobalLimit(key, inputId, msg) {
  const val = document.getElementById(inputId)?.value;
  if (val === '' || val == null) return;
  await adminSetConfig(key, val);
  showToast(msg);
  ADMIN_CFG[key] = val;
}

async function adminSaveBanner() {
  const text = document.getElementById('banner-text')?.value?.trim();
  const type = document.getElementById('banner-type')?.value || 'info';
  await fetch('/api/admin/set-config', {
    method: 'POST', headers: {'Content-Type':'application/json','X-User-Token':SESSION_TOKEN},
    body: JSON.stringify({ updates: [{key:'banner',value:text||''},{key:'banner_type',value:type}] })
  });
  showToast('Banner updated');
  checkBanner();
  await loadAdminConfig();
}

async function adminClearBanner() {
  await adminSetConfig('banner', '');
  document.getElementById('site-banner')?.classList.add('hidden');
  showToast('Banner cleared');
  await loadAdminConfig();
}

async function adminSetConfig(key, value) {
  await fetch('/api/admin/set-config', {
    method: 'POST', headers: {'Content-Type':'application/json','X-User-Token':SESSION_TOKEN},
    body: JSON.stringify({ key, value })
  });
}

async function setTier(userId, tier) {
  await fetch('/api/admin/set-tier', { method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN}, body: JSON.stringify({ targetUserId: userId, tier }) });
  showToast('Tier updated to ' + tier);
  await loadAdminUsers();
}

async function adminResetUser(uid) {
  await fetch('/api/admin/reset-user', { method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN}, body: JSON.stringify({ targetUserId: uid }) });
  showToast('Daily counts reset');
  await loadAdminUsers();
}

async function adminBanUser(uid, banned) {
  await fetch('/api/admin/ban-user', { method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN}, body: JSON.stringify({ targetUserId: uid, banned }) });
  showToast(banned ? 'User banned' : 'User unbanned');
  await loadAdminUsers();
}

async function adminSetUserLimits(uid) {
  const msgVal = document.getElementById('ul-msg-'+uid)?.value;
  const imgVal = document.getElementById('ul-img-'+uid)?.value;
  const body = { targetUserId: uid };
  body.custom_msg_limit = msgVal === '' ? null : parseInt(msgVal);
  body.custom_img_limit = imgVal === '' ? null : parseInt(imgVal);
  await fetch('/api/admin/set-user-limits', { method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN}, body: JSON.stringify(body) });
  showToast('User limits saved');
  await loadAdminUsers();
}

// ── Site banner + site-down check ──────────────────────────
async function checkSiteStatus() {
  try {
    const res = await fetch('/api/site-status');
    const data = await res.json();
    if (data.site_down && !ME?.is_admin) {
      document.getElementById('app').classList.add('hidden');
      document.getElementById('site-down-screen').classList.remove('hidden');
      document.getElementById('site-down-msg').textContent = data.down_message;
      return;
    }
    checkBannerData(data);
  } catch(_) {}
}

function checkBannerData(data) {
  const banner = document.getElementById('site-banner');
  if (!banner) return;
  if (data.banner) {
    document.getElementById('site-banner-text').textContent = data.banner;
    banner.className = 'site-banner banner-' + (data.banner_type || 'info');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function checkBanner() {
  try {
    const res = await fetch('/api/site-status');
    const data = await res.json();
    checkBannerData(data);
  } catch(_) {}
}

// ── Utils ──────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('sidebar-overlay').classList.add('open'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebar-overlay').classList.remove('open'); }
function handleKey(e) { if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); sendMessage(); } }

function resizeInput(el) {
  el.style.height = '36px';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

function setInput(text) { const el = document.getElementById('msg-input'); el.value=text; resizeInput(el); el.focus(); }

function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type==='error' ? ' toast-error' : '');
  el.classList.remove('hidden'); el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity='0'; setTimeout(()=>el.classList.add('hidden'),300); }, 3000);
}

function gv(id) { return document.getElementById(id)?.value?.trim()||''; }

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function mdRender(text) {
  let o = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Code blocks — protect them first
  const blocks = [];
  o = o.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) => { blocks.push(c.trim()); return `\x00CODE${blocks.length-1}\x00`; });
  // Inline code
  o = o.replace(/`([^`\n]{1,200})`/g, (_, c) => { blocks.push(c); return `\x00INLINE${blocks.length-1}\x00`; });
  // Bold / italic (bounded length to prevent catastrophic backtracking)
  o = o.replace(/\*\*(.{1,200}?)\*\*/g, '<strong>$1</strong>');
  o = o.replace(/\*(.{1,200}?)\*/g, '<em>$1</em>');
  // Headings
  o = o.replace(/^### (.{1,200})$/gm, '<h3>$1</h3>');
  o = o.replace(/^## (.{1,200})$/gm, '<h2>$1</h2>');
  o = o.replace(/^# (.{1,200})$/gm, '<h1>$1</h1>');
  // Links
  o = o.replace(/\[([^\]\n]{1,200})\]\(([^)\n]{1,500})\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Lists — line by line, no catastrophic backtracking
  const lines = o.split('\n');
  const out = []; let inUl=false, inOl=false;
  for (const line of lines) {
    if (/^[-*] /.test(line)) {
      if (!inUl) { if (inOl) { out.push('</ol>'); inOl=false; } out.push('<ul>'); inUl=true; }
      out.push('<li>' + line.slice(2) + '</li>');
    } else if (/^\d+\. /.test(line)) {
      if (!inOl) { if (inUl) { out.push('</ul>'); inUl=false; } out.push('<ol>'); inOl=true; }
      out.push('<li>' + line.replace(/^\d+\. /,'') + '</li>');
    } else {
      if (inUl) { out.push('</ul>'); inUl=false; }
      if (inOl) { out.push('</ol>'); inOl=false; }
      out.push(line);
    }
  }
  if (inUl) out.push('</ul>');
  if (inOl) out.push('</ol>');
  o = out.join('\n');
  // Restore code blocks
  o = o.replace(/\x00CODE(\d+)\x00/g, (_, i) => `<pre><code>${blocks[+i]}</code></pre>`);
  o = o.replace(/\x00INLINE(\d+)\x00/g, (_, i) => `<code>${esc(blocks[+i])}</code>`);
  // Paragraphs
  o = o.replace(/\n\n+/g, '</p><p>');
  o = o.replace(/\n/g, '<br>');
  return '<p>' + o + '</p>';
}

// ── Pinned chats ──────────────────────────────────────────
function togglePin(id, e) {
  e?.stopPropagation();
  const pinned = JSON.parse(localStorage.getItem('pinned_chats') || '[]');
  const idx = pinned.indexOf(id);
  if (idx === -1) pinned.push(id); else pinned.splice(idx, 1);
  localStorage.setItem('pinned_chats', JSON.stringify(pinned));
  renderChatList(CHATS);
  showToast(idx === -1 ? 'Chat pinned' : 'Chat unpinned');
}

function isPinned(id) {
  return JSON.parse(localStorage.getItem('pinned_chats') || '[]').includes(id);
}

// Override renderChatList to support pinned + folder
const _origRenderChatList = renderChatList;
function renderChatList(list) {
  const el = document.getElementById('chat-list');
  if (!list.length) { el.innerHTML = '<p class="sidebar-empty">No chats yet. Start one!</p>'; return; }
  const pinned = list.filter(c => isPinned(c.id));
  const unpinned = list.filter(c => !isPinned(c.id));
  const makeItem = c => `
    <div class="chat-item ${c.id === CURRENT_CHAT_ID ? 'active' : ''} ${isPinned(c.id)?'pinned':''}" onclick="openChat('${c.id}')">
      <div class="chat-item-text">
        <div class="chat-item-title">${isPinned(c.id)?'📌 ':''}${esc(c.title || 'New Chat')}</div>
        <div class="chat-item-preview">${esc((c.last_message || '').slice(0,55))}</div>
      </div>
      <div class="chat-item-btns">
        <button class="chat-item-del" onclick="event.stopPropagation();togglePin('${c.id}')" title="${isPinned(c.id)?'Unpin':'Pin'}">📌</button>
        <button class="chat-item-del" onclick="event.stopPropagation();deleteChat('${c.id}')" title="Delete">✕</button>
      </div>
    </div>`;
  el.innerHTML = (pinned.length ? `<div class="sidebar-section-label">Pinned</div>${pinned.map(makeItem).join('')}<div class="sidebar-section-label">Chats</div>` : '') + unpinned.map(makeItem).join('');
}

// ── Prompt suggestions ─────────────────────────────────────
const PROMPT_SUGGESTIONS = {
  normal: ['Explain something complex simply', 'Write a professional email', 'Give me a fun fact', 'Help me brainstorm ideas'],
  code: ['Debug this code', 'Write a REST API in Python', 'Explain Big O notation', 'Generate a regex for emails'],
  imagine: ['A futuristic city at sunset', 'A cute robot reading a book', 'Underwater forest with bioluminescent plants', 'Cozy cabin in snowy mountains'],
  search: ['Latest AI news today', 'Current Bitcoin price', 'Best restaurants in Sydney', 'Recent space discoveries'],
  creative: ['Write a short sci-fi story', 'Poem about rain at night', 'A villain monologue', 'Opening line of a mystery novel']
};

function updateWelcomeChips() {
  const chips = document.querySelector('.welcome-chips');
  if (!chips) return;
  const suggestions = PROMPT_SUGGESTIONS[CURRENT_MODE] || PROMPT_SUGGESTIONS.normal;
  chips.innerHTML = suggestions.map(s => `<button class="chip" onclick="setInput('${esc(s)}')">${s}</button>`).join('');
}

// ── Character counter ──────────────────────────────────────
function updateCharCount(el) {
  resizeInput(el);
  const counter = document.getElementById('char-count');
  if (counter) {
    const len = el.value.length;
    counter.textContent = len > 0 ? `${len} chars` : '';
    counter.style.color = len > 3000 ? 'var(--danger-text)' : 'var(--text3)';
  }
}

// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'k') { e.preventDefault(); document.getElementById('msg-input')?.focus(); }
    if (e.key === 'n') { e.preventDefault(); newChat(); }
    if (e.key === '/') { e.preventDefault(); document.querySelector('.sidebar-search input')?.focus(); }
  }
  if (e.key === 'Escape') {
    document.querySelectorAll('.overlay:not(.hidden)').forEach(el => el.classList.add('hidden'));
    closeSidebar();
  }
});

// ── Word count in messages ─────────────────────────────────
function getWordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Auto-title chats from AI ───────────────────────────────
async function autoTitleChat(userMsg, aiReply) {
  if (!CURRENT_CHAT_ID) return;
  const chat = CHATS.find(c => c.id === CURRENT_CHAT_ID);
  if (!chat || chat.title !== userMsg.slice(0,50)) return; // already renamed
  // Generate a short title via Groq
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Generate a short 3-5 word title for this conversation. Reply with ONLY the title, no punctuation, no quotes.' },
          { role: 'user', content: userMsg.slice(0, 200) },
          { role: 'assistant', content: aiReply.slice(0, 200) }
        ],
        max_tokens: 20, temperature: 0.3
      })
    });
    const data = await res.json();
    const title = data.choices?.[0]?.message?.content?.trim().slice(0,50);
    if (title && title.length > 2) {
      await api('/api/chats/update', { chat_id: CURRENT_CHAT_ID, title });
      chat.title = title;
      document.getElementById('chat-title-display').textContent = title;
      document.getElementById('mobile-title').textContent = title;
      renderChatList(CHATS);
    }
  } catch(_) {}
}

// ── Images Panel ──────────────────────────────────────────
async function loadImagesPanel() {
  const grid = document.getElementById('images-grid');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  const { data, error } = await SB.from('generated_images')
    .select('*').eq('user_id', ME.id)
    .order('created_at', { ascending: false });
  if (error) { grid.innerHTML = '<div class="empty-state">Could not load images.</div>'; return; }
  if (!data?.length) { grid.innerHTML = '<div class="empty-state">No images yet.<br>Use <strong>Imagine</strong> mode to create some!</div>'; return; }
  document.getElementById('img-panel-counter').textContent = `${data.length} image${data.length!==1?'s':''}`;
  grid.innerHTML = '';
  data.forEach(img => {
    const card = document.createElement('div');
    card.className = 'img-card';

    const imgEl = document.createElement('img');
    imgEl.src = img.url;
    imgEl.alt = img.prompt;
    imgEl.className = 'img-card-img';
    imgEl.onclick = () => window.open(img.url, '_blank');

    const info = document.createElement('div');
    info.className = 'img-card-info';

    const prompt = document.createElement('div');
    prompt.className = 'img-card-prompt';
    prompt.textContent = img.prompt;

    const date = document.createElement('div');
    date.className = 'img-card-date';
    date.textContent = new Date(img.created_at).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'numeric'});

    const btns = document.createElement('div');
    btns.className = 'img-card-btns';

    const dl = document.createElement('button');
    dl.className = 'img-card-btn';
    dl.textContent = '⬇️ Download';
    dl.onclick = (e) => { e.stopPropagation(); downloadImage(img.url, img.prompt); };

    const edit = document.createElement('button');
    edit.className = 'img-card-btn';
    edit.textContent = '✏️ Edit';
    edit.onclick = (e) => { e.stopPropagation(); openEditImage(img.url, img.prompt); };

    const del = document.createElement('button');
    del.className = 'img-card-btn danger';
    del.textContent = '🗑️';
    del.title = 'Delete';
    del.onclick = (e) => { e.stopPropagation(); deleteImage(img.id, img.url, card); };

    btns.appendChild(dl);
    btns.appendChild(edit);
    btns.appendChild(del);
    info.appendChild(prompt);
    info.appendChild(date);
    info.appendChild(btns);
    card.appendChild(imgEl);
    card.appendChild(info);
    grid.appendChild(card);
  });
}

async function deleteImage(id, url, cardEl) {
  if (!confirm('Delete this image?')) return;
  await SB.from('generated_images').delete().eq('id', id);
  // Also delete from storage
  const path = url.split('/generated-images/')[1];
  if (path) await SB.storage.from('generated-images').remove([path]);
  cardEl.remove();
  showToast('Image deleted');
}

function downloadImage(src, prompt) {
  const a = document.createElement('a');
  a.href = src;
  a.download = (prompt || 'nova-image').slice(0,40).replace(/[^a-z0-9]/gi,'_') + '.jpg';
  // For cross-origin URLs, fetch first
  if (src.startsWith('http') && !src.startsWith('data:')) {
    fetch(src)
      .then(r => r.blob())
      .then(blob => {
        a.href = URL.createObjectURL(blob);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      })
      .catch(() => { a.click(); }); // fallback: open in new tab
  } else {
    a.click();
  }
}

function openEditImage(src, prompt) {
  document.getElementById('edit-img-src').src = src;
  document.getElementById('edit-img-prompt').value = prompt || '';
  document.getElementById('edit-image-modal').classList.remove('hidden');
}

async function regenerateImage() {
  const prompt = document.getElementById('edit-img-prompt').value.trim();
  if (!prompt) { showToast('Enter a prompt'); return; }
  closeModal('edit-image-modal');
  setMode('imagine');
  setActiveSection('chats');
  await doGenerateImage(prompt);
}

boot();
