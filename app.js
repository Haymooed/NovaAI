// ── State ──────────────────────────────────────────────────
let SB = null, ME = null, SESSION_TOKEN = null;
let CURRENT_CHAT_ID = null, CURRENT_GROUP_ID = null;
let CHAT_MESSAGES = {}, CHATS = [], SETTINGS = {};
let CURRENT_MODE = 'normal', ATTACHED_FILE = null;
let DAILY_MSGS = 0, DAILY_IMGS = 0, IMG_LIMIT = 3;
let GROUP_REALTIME = null, IS_LOADING = false;
const COLORS = ['#7c3aed','#3b82f6','#10b981','#f59e0b','#ef4444','#ec4899','#06b6d4','#8b5cf6','#84cc16'];

const ADMIN_UI_THEMES = [
  { key: 'default', name: 'Default', icon: '🧠', desc: 'Clean NovaAI experience with your local appearance settings.' },
  { key: 'brainrot', name: 'Brainrot Mode', icon: '🤪', desc: 'Chaotic emoji rain and extra motion everywhere.' },
  { key: 'anime', name: 'Anime Mode', icon: '🌸', desc: 'Pastel neon gradients inspired by anime UI style.' },
  { key: 'summer', name: 'Summer', icon: '🌴', desc: 'Warm beach colours with sun-kissed highlights.' },
  { key: 'winter', name: 'Winter', icon: '❄️', desc: 'Cool frosty tones with soft glass effects.' },
  { key: 'halloween', name: 'Halloween', icon: '🎃', desc: 'Spooky orange + midnight accents.' },
  { key: 'easter', name: 'Easter', icon: '🐣', desc: 'Playful candy pastel palette.' },
  { key: 'christmas', name: 'Christmas', icon: '🎄', desc: 'Festive red/green holiday vibe.' }
];


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
  handleOAuthCallback();
  SESSION_TOKEN = session.access_token;
  const { data: prof } = await SB.from('profiles').select('*').eq('id', session.user.id).single();
  ME = prof || { id: session.user.id, display_name: session.user.email?.split('@')[0] || 'User', tier: 'free', avatar_color: COLORS[0] };
  DAILY_IMGS = ME.daily_imgs || 0;
  // Use admin-configured limits if available, else sensible defaults
  const cfgImgLimitFree = parseInt(window._adminCfgCache?.global_img_limit_free || '3');
  const cfgImgLimitPro = parseInt(window._adminCfgCache?.global_img_limit_pro || '10');
  IMG_LIMIT = ME.custom_img_limit != null ? ME.custom_img_limit
    : (ME.tier === 'pro' ? cfgImgLimitPro : cfgImgLimitFree);
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  renderSidebarUser();
  buildColorPickers();
  await loadChats();
  loadGroups();
  loadUpdateLog();
  setActiveSection('chats');
  checkSiteStatus();
  loadBotProfile();
}

async function loadBotProfile() {
  try {
    const res = await fetch('/api/site-status');
    const d = await res.json();
    // Cache config for client-side limit calculations
    window._adminCfgCache = d;
    applyAdminThemeFromConfig(d);
    if (d.bot_name || d.bot_color || d.bot_avatar_url) {
      ADMIN_CFG.bot_name = d.bot_name;
      ADMIN_CFG.bot_color = d.bot_color;
      ADMIN_CFG.bot_avatar_url = d.bot_avatar_url;
      applyBotProfile();
    }
    // Show Go Pro button if Ko-fi URL is set
    if (d.kofi_url) {
      document.querySelectorAll('.go-pro-btn').forEach(el => {
        el.classList.remove('hidden');
        el.onclick = () => window.open(d.kofi_url, '_blank');
      });
    }
  } catch(_) {}
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

async function doGithubLogin() {
  setOAuthLoading('github', true);
  const { error } = await SB.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: window.location.origin + '?oauth=github' }
  });
  if (error) { setOAuthLoading('github', false); authErr(error.message); }
}

async function doDiscordLogin() {
  setOAuthLoading('discord', true);
  const { error } = await SB.auth.signInWithOAuth({
    provider: 'discord',
    options: { redirectTo: window.location.origin + '?oauth=discord' }
  });
  if (error) { setOAuthLoading('discord', false); authErr(error.message); }
}

function setOAuthLoading(provider, loading) {
  const btn = document.getElementById('oauth-btn-' + provider);
  if (!btn) return;
  if (loading) {
    btn.dataset.orig = btn.innerHTML;
    btn.innerHTML = '<span class="oauth-spinner"></span> Connecting…';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.orig || btn.innerHTML;
    btn.disabled = false;
  }
}

async function linkProvider(provider) {
  const { error } = await SB.auth.linkIdentity({ provider });
  if (error) showToast('Could not link ' + provider + ': ' + error.message, 'error');
  else showToast('Account linked to ' + provider + '!');
}

async function unlinkProvider(provider) {
  // Get identities
  const { data: { user } } = await SB.auth.getUser();
  const identity = user?.identities?.find(i => i.provider === provider);
  if (!identity) return showToast('Not linked to ' + provider);
  if (user.identities.length <= 1) return showToast('Cannot unlink your only sign-in method', 'error');
  const { error } = await SB.auth.unlinkIdentity(identity);
  if (error) showToast('Unlink failed: ' + error.message, 'error');
  else { showToast('Unlinked from ' + provider); loadConnectedAccounts(); }
}

async function loadConnectedAccounts() {
  const el = document.getElementById('connected-accounts');
  if (!el) return;
  const { data: { user } } = await SB.auth.getUser();
  const identities = user?.identities || [];
  const providers = ['github','discord','email'];
  el.innerHTML = providers.map(p => {
    const linked = identities.find(i => i.provider === p);
    const icons = { github:'🐙', discord:'🎮', email:'✉️' };
    const labels = { github:'GitHub', discord:'Discord', email:'Email' };
    return `<div class="connector-row">
      <span class="connector-icon">${icons[p]}</span>
      <span class="connector-label">${labels[p]}</span>
      ${linked
        ? `<span class="connector-badge linked">Connected</span>
           ${identities.length > 1 ? `<button class="connector-unlink" onclick="unlinkProvider('${p}')">Unlink</button>` : ''}`
        : `<button class="connector-link" onclick="linkProvider('${p}')">Connect</button>`
      }
    </div>`;
  }).join('');
}

// Auto-join Discord server after OAuth (if configured by admin)
async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const oauth = params.get('oauth');
  if (!oauth) return;
  // Clean URL
  window.history.replaceState({}, '', window.location.pathname);
  if (oauth === 'github' || oauth === 'discord') {
    // Check if admin has set a Discord invite link
    try {
      const res = await fetch('/api/site-status');
      const cfg = await res.json();
      if (cfg.discord_invite) {
        setTimeout(() => {
          showDiscordJoinPrompt(cfg.discord_invite, cfg.discord_server_name || 'our Discord server');
        }, 1500);
      }
    } catch(_) {}
  }
}

function showDiscordJoinPrompt(inviteUrl, serverName) {
  const el = document.getElementById('discord-join-prompt');
  if (!el) return;
  document.getElementById('discord-join-server-name').textContent = serverName;
  document.getElementById('discord-join-link').href = inviteUrl;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 12000);
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
    const username = name.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,30) + '_' + Date.now().toString(36);
    const { error: profileError } = await SB.from('profiles').upsert({ id: data.user.id, display_name: name, username, avatar_color: COLORS[Math.floor(Math.random()*COLORS.length)] });
    if (profileError) return authErr('Profile error: ' + profileError.message);
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
  // Go Pro button: only show for free users once Ko-fi URL is known
  if (ME.tier !== 'pro' && window._adminCfgCache?.kofi_url) {
    document.querySelectorAll('.go-pro-btn').forEach(el => el.classList.remove('hidden'));
  } else {
    document.querySelectorAll('.go-pro-btn').forEach(el => el.classList.add('hidden'));
  }
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
  ['chats','groups','updates','images','builder','notes','code'].forEach(s => {
    document.getElementById('nav-' + s)?.classList.toggle('active', s === section);
  });
  document.getElementById('chat-list').classList.toggle('hidden', section !== 'chats');
  document.getElementById('group-list').classList.toggle('hidden', section !== 'groups');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + section)?.classList.add('active');
  if (section === 'updates') { loadUpdateLog(); document.getElementById('updates-badge').classList.add('hidden'); }
  if (section === 'images') loadImagesPanel();
  if (section === 'notes') initNotes();
  if (section === 'code') initCodePlayground();
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
    if (data.moderated) {
      appendMsg('assistant', '🚫 **Request blocked** — ' + data.error + '\n\nNovaAI does not generate harmful, explicit, or inappropriate content.');
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
  if (DAILY_IMGS >= IMG_LIMIT) {
    // Calculate time until midnight reset
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const ms = midnight - now;
    const hrs = Math.floor(ms / 3600000), mins = Math.floor((ms % 3600000) / 60000);
    document.getElementById('img-limit-reset').textContent = `${hrs}h ${mins}m`;
    document.getElementById('img-limit-modal').classList.remove('hidden');
    return;
  }
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
    if (data.moderated) {
      showToast('🚫 ' + data.error, 'error');
      appendMsg('assistant', '🚫 **Image blocked** — ' + data.error);
      return;
    }
    if (data.error) { showToast(data.error, 'error'); return; }
    // Use URL if storage worked, else base64 fallback
    const imgSrc = data.url || data.image;
    if (!imgSrc) { showToast('Image returned no displayable content', 'error'); return; }
    appendImgMsg(imgSrc, prompt, data.imgId);
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
      <div class="update-card-body md-body">${mdRender(u.content)}</div>
    </div>`).join('');
}

function openPostUpdate() { document.getElementById('post-update-modal').classList.remove('hidden'); }

function openGoPro() {
  const url = window._adminCfgCache?.kofi_url;
  if (url) window.open(url, '_blank');
  else showToast('Pro upgrade coming soon!');
}

function openGoPro() {
  // Check if admin has set a Ko-fi URL
  fetch('/api/site-status').then(r => r.json()).then(d => {
    if (d.kofi_url) {
      window.open(d.kofi_url, '_blank');
    } else {
      showToast('Pro upgrade not available yet — check back soon!');
    }
  });
}

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
  loadConnectedAccounts();
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

async function openConnectedAccounts() {
  document.getElementById('settings-connectors').classList.remove('hidden');
  loadConnectedAccounts();
}

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
let ACTIVE_ADMIN_THEME = 'default';
let THEME_CHAOS_TIMER = null;

async function openAdmin() {
  document.getElementById('admin-modal').classList.remove('hidden');
  switchAdminTab('site');
  await Promise.all([loadAdminConfig(), loadAdminUsers()]);
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.admin-pane').forEach(el => el.classList.remove('active'));
  document.getElementById('admin-pane-' + tab)?.classList.add('active');
  if (tab === 'mod') loadAdminModLogs();
}

async function loadAdminConfig() {
  const res = await fetch('/api/admin/config', { headers: {'X-User-Token': SESSION_TOKEN} });
  ADMIN_CFG = await res.json();
  renderAdminSitePane();
  renderAdminLimitsPane();
  renderAdminBannerPane();
  renderAdminThemesPane();
  renderAdminBotPane();
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
    <div class="admin-section-label">🆓 Free Tier Limits</div>
    <div class="admin-limit-grid">
      <div class="admin-limit-item">
        <label>Messages / day</label>
        <div style="display:flex;gap:6px">
          <input class="form-input sm" id="g-msg-free" type="number" min="0" max="9999" value="${c.global_msg_limit||50}"/>
          <button class="btn-secondary sm" onclick="adminSaveGlobalLimit('global_msg_limit','g-msg-free','Free msg limit saved')">Save</button>
        </div>
      </div>
      <div class="admin-limit-item">
        <label>Images / day</label>
        <div style="display:flex;gap:6px">
          <input class="form-input sm" id="g-img-free" type="number" min="0" max="9999" value="${c.global_img_limit_free||3}"/>
          <button class="btn-secondary sm" onclick="adminSaveGlobalLimit('global_img_limit_free','g-img-free','Free image limit saved')">Save</button>
        </div>
      </div>
    </div>
    <div class="admin-section-label" style="margin-top:18px">⭐ Pro Tier Limits</div>
    <div class="admin-limit-grid">
      <div class="admin-limit-item">
        <label>Messages / day</label>
        <div style="display:flex;gap:6px">
          <input class="form-input sm" id="g-msg-pro" type="number" min="0" max="9999" value="${c.global_msg_limit_pro||200}"/>
          <button class="btn-secondary sm" onclick="adminSaveGlobalLimit('global_msg_limit_pro','g-msg-pro','Pro msg limit saved')">Save</button>
        </div>
      </div>
      <div class="admin-limit-item">
        <label>Images / day</label>
        <div style="display:flex;gap:6px">
          <input class="form-input sm" id="g-img-pro" type="number" min="0" max="9999" value="${c.global_img_limit_pro||10}"/>
          <button class="btn-secondary sm" onclick="adminSaveGlobalLimit('global_img_limit_pro','g-img-pro','Pro image limit saved')">Save</button>
        </div>
      </div>
    </div>
    <div class="admin-section-label" style="margin-top:24px">☕ Ko-fi — Paid Upgrades</div>
    <div class="admin-sub-text">When a user pays on Ko-fi using their NovaAI account email, they get automatically upgraded to Pro.</div>
    <div class="kofi-setup-card">
      <div class="kofi-setup-steps">
        <div class="kofi-step"><span class="kofi-step-num">1</span><span>Go to <a href="https://ko-fi.com/account/api" target="_blank" class="kofi-link">ko-fi.com/account/api</a> and copy your <strong>Webhook Verification Token</strong></span></div>
        <div class="kofi-step"><span class="kofi-step-num">2</span><span>In Cloudflare → Workers → NovaAI → Settings → Variables, add:<br/><code class="kofi-code">KOFI_WEBHOOK_TOKEN</code> = (your token)</span></div>
        <div class="kofi-step"><span class="kofi-step-num">3</span><span>In Ko-fi → Settings → API → Webhook URL, paste:<br/><code class="kofi-code">https://novaai.moodyhayden567.workers.dev/api/kofi-webhook</code></span></div>
        <div class="kofi-step"><span class="kofi-step-num">4</span><span>Set up a <strong>Membership tier</strong> or one-off donation on Ko-fi. Users must pay with the <strong>same email</strong> as their NovaAI account — they'll be upgraded to Pro automatically.</span></div>
        <div class="kofi-step"><span class="kofi-step-num">5</span><span>Paste your Ko-fi page URL below — this adds a "Go Pro ⭐" button to the app for users.</span></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;align-items:center">
        <input class="form-input" id="kofi-url-input" value="${esc(c.kofi_url||'')}" placeholder="https://ko-fi.com/yourpage" style="flex:1"/>
        <button class="btn-primary sm" onclick="adminSaveKofiUrl()">Save</button>
      </div>
      <div style="margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div class="admin-section-label" style="margin:0">Recent Payments</div>
          <button class="btn-secondary sm" onclick="loadKofiPayments()">↻ Load</button>
        </div>
        <div id="kofi-payments-list"><div class="admin-sub-text">Click Load to view recent Ko-fi payments.</div></div>
      </div>
    </div>`;
}

async function adminSaveKofiUrl() {
  const val = document.getElementById('kofi-url-input')?.value?.trim() || '';
  await adminSetConfig('kofi_url', val);
  ADMIN_CFG.kofi_url = val;
  showToast('Ko-fi URL saved!');
  renderSidebarUser(); // refresh Go Pro button
}

async function loadKofiPayments() {
  const el = document.getElementById('kofi-payments-list');
  if (!el) return;
  el.innerHTML = '<div class="admin-sub-text">Loading…</div>';
  try {
    const res = await fetch('/api/admin/kofi-payments', { headers: {'X-User-Token': SESSION_TOKEN} });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) { el.innerHTML = '<div class="admin-sub-text">No payments yet.</div>'; return; }
    el.innerHTML = data.map(p => `
      <div class="kofi-payment-row">
        <span class="kofi-payment-type">${esc(p.type||'Payment')}</span>
        <span class="kofi-payment-info">$${parseFloat(p.amount||0).toFixed(2)} — ${esc(p.email||'')}</span>
        <span class="kofi-payment-date">${new Date(p.created_at).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}</span>
      </div>`).join('');
  } catch(e) { el.innerHTML = '<div class="admin-sub-text" style="color:var(--danger-text)">Could not load payments.</div>'; }
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

function renderAdminBotPane() {
  const c = ADMIN_CFG;
  CURRENT_BOT_COLOR = c.bot_color || '#7c3aed';
  const avatarHtml = c.bot_avatar_url
    ? `<img src="${c.bot_avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>`
    : (c.bot_name||'N')[0].toUpperCase();
  document.getElementById('admin-bot-inner').innerHTML = `
    <div class="admin-section-label">🤖 Nova AI Bot Profile</div>
    <div class="admin-sub-text">Customise how the AI appears in chats.</div>
    <div class="bot-profile-editor">
      <div class="bot-avatar-wrap">
        <div id="bot-avatar-preview" class="bot-avatar-preview" style="background:${c.bot_color||'#7c3aed'};color:#fff;font-size:28px;font-weight:700;display:flex;align-items:center;justify-content:center">${avatarHtml}</div>
        <input type="file" id="bot-avatar-upload" accept="image/*" style="display:none" onchange="uploadBotAvatar(event)"/>
        <button class="btn-secondary sm" style="margin-top:8px" onclick="document.getElementById('bot-avatar-upload').click()">⬆️ Upload</button>
        <button class="btn-secondary sm" style="margin-top:6px" onclick="openGenBotAvatar()">✨ AI Generate</button>
      </div>
      <div class="bot-fields">
        <label class="form-label">Bot Name</label>
        <input class="form-input" id="bot-name-input" value="${esc(c.bot_name||'Nova')}" placeholder="Nova"/>
        <label class="form-label" style="margin-top:10px">Avatar Colour</label>
        <div class="bot-color-row">
          ${['#7c3aed','#2563eb','#059669','#dc2626','#d97706','#db2777','#0891b2'].map(col =>
            `<button class="bot-color-dot ${(c.bot_color||'#7c3aed')===col?'active':''}" style="background:${col}" onclick="selectBotColor('${col}')"></button>`
          ).join('')}
        </div>
        <label class="form-label" style="margin-top:10px">Tagline</label>
        <input class="form-input" id="bot-tagline-input" value="${esc(c.bot_tagline||'Your AI assistant')}" placeholder="Your AI assistant"/>
        <button class="btn-primary" style="margin-top:12px;width:100%" onclick="saveBotProfile()">💾 Save Bot Profile</button>
      </div>
    </div>
    <div class="admin-section-label" style="margin-top:24px">🎮 Discord Integration</div>
    <div class="admin-sub-text">Users who sign in via GitHub or Discord will be prompted to join your server.</div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input class="form-input" id="discord-invite-input" value="${esc(c.discord_invite||'')}" placeholder="https://discord.gg/yourserver" style="flex:1"/>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input class="form-input sm" id="discord-server-name-input" value="${esc(c.discord_server_name||'')}" placeholder="Server display name e.g. NovaAI Community" style="flex:1"/>
      <button class="btn-primary sm" onclick="adminSaveDiscordInvite()">Save</button>
    </div>`;
}

let CURRENT_BOT_COLOR = '#7c3aed';

function selectBotColor(color) {
  CURRENT_BOT_COLOR = color;
  document.querySelectorAll('.bot-color-dot').forEach(el => {
    el.classList.toggle('active', el.style.background === color || el.style.backgroundColor === color);
  });
  const prev = document.getElementById('bot-avatar-preview');
  if (prev) prev.style.background = color;
}

async function uploadBotAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2*1024*1024) return showToast('Max 2MB', 'error');
  const ext = file.name.split('.').pop();
  const path = 'bot-avatar/' + Date.now() + '.' + ext;
  const { error } = await SB.storage.from('generated-images').upload(path, file, { upsert: true });
  if (error) return showToast('Upload failed: ' + error.message, 'error');
  const url = SB.storage.from('generated-images').getPublicUrl(path).data.publicUrl;
  await adminSetConfig('bot_avatar_url', url);
  document.getElementById('bot-avatar-preview').innerHTML = `<img src="${url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>`;
  showToast('Avatar uploaded!');
}

async function saveBotProfile() {
  const name = document.getElementById('bot-name-input')?.value?.trim() || 'Nova';
  const tagline = document.getElementById('bot-tagline-input')?.value?.trim() || 'Your AI assistant';
  await fetch('/api/admin/set-config', {
    method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN},
    body: JSON.stringify({ updates: [
      {key:'bot_name', value:name},
      {key:'bot_color', value:CURRENT_BOT_COLOR},
      {key:'bot_tagline', value:tagline}
    ]})
  });
  showToast('Bot profile saved!');
  await loadAdminConfig();
  applyBotProfile();
}

function openGenBotAvatar() {
  document.getElementById('gen-bot-avatar-modal').classList.remove('hidden');
}

async function genBotAvatar() {
  const prompt = document.getElementById('gen-avatar-prompt').value.trim();
  if (!prompt) return showToast('Enter a prompt first');
  const btn = document.getElementById('gen-avatar-btn');
  btn.textContent = '⏳ Generating…'; btn.disabled = true;
  const preview = document.getElementById('gen-avatar-preview');
  preview.innerHTML = '<div class="gen-avatar-spinner"></div>';

  try {
    const res = await fetch('/api/admin/gen-bot-avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({ prompt })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); preview.innerHTML = ''; return; }

    // Show preview
    preview.innerHTML = `<img src="${data.url}" style="width:120px;height:120px;border-radius:50%;object-fit:cover;border:3px solid var(--accent)"/>`;
    document.getElementById('gen-avatar-confirm-btn').classList.remove('hidden');
    document.getElementById('gen-avatar-confirm-btn').onclick = async () => {
      // Save to config
      await adminSetConfig('bot_avatar_url', data.url);
      ADMIN_CFG.bot_avatar_url = data.url;
      // Update preview in bot pane
      const botPrev = document.getElementById('bot-avatar-preview');
      if (botPrev) botPrev.innerHTML = `<img src="${data.url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>`;
      applyBotProfile();
      closeModal('gen-bot-avatar-modal');
      showToast('Bot avatar updated!');
    };
  } catch(e) {
    showToast('Generation failed', 'error');
    preview.innerHTML = '';
  }
  btn.textContent = '✨ Generate'; btn.disabled = false;
}

async function adminSaveDiscordInvite() {
  const invite = document.getElementById('discord-invite-input')?.value?.trim() || '';
  const name = document.getElementById('discord-server-name-input')?.value?.trim() || '';
  await fetch('/api/admin/set-config', {
    method:'POST', headers:{'Content-Type':'application/json','X-User-Token':SESSION_TOKEN},
    body: JSON.stringify({ updates: [{key:'discord_invite',value:invite},{key:'discord_server_name',value:name}]})
  });
  showToast('Discord invite saved!');
}

function applyBotProfile() {
  const name = ADMIN_CFG.bot_name || 'Nova';
  const color = ADMIN_CFG.bot_color || '#7c3aed';
  const avatarUrl = ADMIN_CFG.bot_avatar_url || '';
  document.querySelectorAll('.nova-av').forEach(el => {
    if (avatarUrl) {
      el.style.background = `url(${avatarUrl}) center/cover`;
      el.textContent = '';
    } else {
      el.style.background = color;
      el.style.backgroundImage = '';
      el.textContent = name[0].toUpperCase();
    }
  });
  // Update welcome logo initial
  const wl = document.querySelector('.welcome-logo');
  if (wl) wl.textContent = name[0].toUpperCase();
}


function getThemeMeta(themeKey) {
  return ADMIN_UI_THEMES.find(t => t.key === themeKey) || ADMIN_UI_THEMES[0];
}

function normaliseAdminTheme(themeKey) {
  const exists = ADMIN_UI_THEMES.some(t => t.key === themeKey);
  return exists ? themeKey : 'default';
}

function getThemeEffectsRoot() {
  let root = document.getElementById('global-theme-effects');
  if (!root) {
    root = document.createElement('div');
    root.id = 'global-theme-effects';
    root.className = 'global-theme-effects';
    document.body.appendChild(root);
  }
  return root;
}

function clearThemeChaos() {
  if (THEME_CHAOS_TIMER) {
    clearInterval(THEME_CHAOS_TIMER);
    THEME_CHAOS_TIMER = null;
  }
  const root = document.getElementById('global-theme-effects');
  if (root) root.innerHTML = '';
}

function spawnThemeParticle(theme) {
  const map = {
    brainrot: ['🔥','💀','🤡','💥','😵‍💫','🧠','🍌','🚨','✨'],
    anime: ['🌸','⭐','💖','✨'],
    summer: ['☀️','🌴','🏖️','🍉'],
    winter: ['❄️','☃️','🧊','✨'],
    halloween: ['🎃','🕸️','👻','🦇'],
    easter: ['🐣','🥚','🌷','🪺'],
    christmas: ['🎄','❄️','🎁','🔔']
  };
  const opts = map[theme] || map.brainrot;
  const el = document.createElement('div');
  el.className = `theme-chaos-emoji theme-${theme}`;
  el.textContent = opts[Math.floor(Math.random() * opts.length)];
  el.style.left = (Math.random() * 96) + 'vw';
  el.style.animationDuration = (4 + Math.random() * 5) + 's';
  getThemeEffectsRoot().appendChild(el);
  setTimeout(() => el.remove(), 10000);
}

function applyAdminThemeFromConfig(cfg = {}) {
  const raw = cfg.active_ui_theme || cfg.ui_theme || 'default';
  const theme = normaliseAdminTheme(raw);
  ACTIVE_ADMIN_THEME = theme;
  document.documentElement.setAttribute('data-admin-theme', theme);
  clearThemeChaos();
  if (theme !== 'default') {
    for (let i = 0; i < (theme === 'brainrot' ? 10 : 5); i++) spawnThemeParticle(theme);
    THEME_CHAOS_TIMER = setInterval(() => spawnThemeParticle(theme), theme === 'brainrot' ? 550 : 1800);
  }
}

function renderAdminThemesPane() {
  const c = ADMIN_CFG;
  const selected = normaliseAdminTheme(c.active_ui_theme || 'default');
  const selectedMeta = getThemeMeta(selected);
  document.getElementById('admin-themes-inner').innerHTML = `
    <div class="admin-theme-hero">
      <div>
        <div class="admin-section-label" style="margin-bottom:6px">🎨 Admin Controlled UI Theme</div>
        <div class="admin-toggle-sub">Choose a global visual mode for all users. This setting overrides local appearance theme style only (font size/density still stay personal).</div>
      </div>
      <div class="admin-theme-active-pill">${selectedMeta.icon} ${selectedMeta.name}</div>
    </div>
    <div class="admin-theme-grid">
      ${ADMIN_UI_THEMES.map(t => `
        <button class="admin-theme-card ${selected===t.key?'active':''}" onclick="adminSetActiveTheme('${t.key}')">
          <div class="admin-theme-icon">${t.icon}</div>
          <div class="admin-theme-title">${t.name}</div>
          <div class="admin-theme-desc">${t.desc}</div>
          <div class="admin-theme-cta">${selected===t.key?'Active Theme':'Activate'}</div>
        </button>
      `).join('')}
    </div>`;
}

async function adminSetActiveTheme(themeKey) {
  const theme = normaliseAdminTheme(themeKey);
  await adminSetConfig('active_ui_theme', theme);
  ADMIN_CFG.active_ui_theme = theme;
  window._adminCfgCache = { ...(window._adminCfgCache || {}), active_ui_theme: theme };
  applyAdminThemeFromConfig(window._adminCfgCache);
  renderAdminThemesPane();
  showToast(`${getThemeMeta(theme).name} activated for all users`);
}

async function loadAdminModLogs() {
  const el = document.getElementById('admin-mod-logs');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const res = await fetch('/api/admin/mod-logs', { headers: {'X-User-Token': SESSION_TOKEN} });
    const logs = await res.json();
    if (!logs.length) { el.innerHTML = '<div class="empty-state">No violations logged.</div>'; return; }
    el.innerHTML = logs.map(l => `
      <div class="mod-log-row">
        <div class="mod-log-left">
          <span class="mod-log-type ${l.type}">${l.type}</span>
          <span class="mod-log-user">${esc(l.profiles?.display_name || l.profiles?.username || 'Unknown')}</span>
          <span class="mod-log-time">${new Date(l.created_at).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span>
        </div>
        <div class="mod-log-content">${esc((l.content||'').slice(0,120))}</div>
      </div>`).join('');
  } catch(e) {
    el.innerHTML = '<div class="empty-state">Could not load logs.</div>';
  }
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
    window._adminCfgCache = { ...(window._adminCfgCache || {}), ...data };
    applyAdminThemeFromConfig(data);
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

// ── Website Builder ────────────────────────────────────────
let BUILDER_HISTORY = [];
let BUILDER_CURRENT = '';
let BUILDER_GENERATING = false;

async function initBuilder() {
  const preview = document.getElementById('builder-preview');
  if (!preview.src || preview.src === 'about:blank') {
    preview.srcdoc = `<html><body style="font-family:sans-serif;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f12"><p>Describe a website and click Generate</p></body></html>`;
  }
}

async function builderGenerate() {
  if (BUILDER_GENERATING) return;
  const prompt = gv('builder-prompt');
  if (!prompt) { showToast('Describe your website first'); return; }
  BUILDER_GENERATING = true;
  const btn = document.getElementById('builder-gen-btn');
  btn.textContent = '⏳ Generating…'; btn.disabled = true;
  document.getElementById('builder-status').textContent = 'Generating website…';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: `You are an expert web developer. Generate complete, beautiful, modern single-file HTML websites.
Rules:
- Return ONLY the complete HTML code, nothing else, no markdown, no explanation
- Include all CSS in a <style> tag and all JS in a <script> tag
- Use modern CSS (gradients, flexbox, grid, animations)
- Make it fully responsive and visually impressive
- Use a dark theme by default unless specified otherwise
- Include realistic placeholder content
- Make it production-ready quality` },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 4096
      })
    });
    const data = await res.json();
    const html = data.choices?.[0]?.message?.content || '';
    const clean = html.replace(/^```html\n?/,'').replace(/^```\n?/,'').replace(/```$/,'').trim();
    if (!clean.includes('<html') && !clean.includes('<!DOCTYPE')) {
      showToast('Generation failed — try a more specific prompt', 'error');
    } else {
      BUILDER_CURRENT = clean;
      BUILDER_HISTORY.unshift({ prompt, html: clean, ts: Date.now() });
      if (BUILDER_HISTORY.length > 20) BUILDER_HISTORY.pop();
      renderBuilderPreview(clean);
      renderBuilderHistory();
      document.getElementById('builder-status').textContent = '✅ Generated! Click Export to download.';
    }
  } catch(e) {
    showToast('Generation failed', 'error');
    document.getElementById('builder-status').textContent = '';
  }
  btn.textContent = '✨ Generate'; btn.disabled = false;
  BUILDER_GENERATING = false;
}

async function builderRefine() {
  if (!BUILDER_CURRENT) { showToast('Generate a site first'); return; }
  const instruction = gv('builder-refine');
  if (!instruction) { showToast('Enter a refinement instruction'); return; }
  BUILDER_GENERATING = true;
  const btn = document.getElementById('builder-refine-btn');
  btn.textContent = '⏳ Refining…'; btn.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are a web developer. Modify the provided HTML based on the instruction. Return ONLY the complete updated HTML, no explanation.' },
          { role: 'user', content: `Current HTML:\n${BUILDER_CURRENT}\n\nInstruction: ${instruction}` }
        ],
        temperature: 0.5, max_tokens: 4096
      })
    });
    const data = await res.json();
    const html = data.choices?.[0]?.message?.content || '';
    const clean = html.replace(/^```html\n?/,'').replace(/^```\n?/,'').replace(/```$/,'').trim();
    if (clean.includes('<')) {
      BUILDER_CURRENT = clean;
      BUILDER_HISTORY.unshift({ prompt: instruction, html: clean, ts: Date.now() });
      renderBuilderPreview(clean);
      renderBuilderHistory();
      document.getElementById('builder-refine').value = '';
      document.getElementById('builder-status').textContent = '✅ Refined!';
    }
  } catch(e) { showToast('Refinement failed', 'error'); }
  btn.textContent = '🔧 Refine'; btn.disabled = false;
  BUILDER_GENERATING = false;
}

function renderBuilderPreview(html) {
  const preview = document.getElementById('builder-preview');
  preview.srcdoc = html;
}

function builderExportHTML() {
  if (!BUILDER_CURRENT) { showToast('Nothing to export'); return; }
  const blob = new Blob([BUILDER_CURRENT], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'nova-website.html';
  a.click();
  showToast('Downloaded!');
}

function builderCopyHTML() {
  if (!BUILDER_CURRENT) return;
  navigator.clipboard.writeText(BUILDER_CURRENT);
  showToast('HTML copied!');
}

function builderViewSource() {
  if (!BUILDER_CURRENT) return;
  const w = window.open('', '_blank');
  w.document.write('<pre style="font-family:monospace;background:#0f0f12;color:#e0e0e0;padding:20px;white-space:pre-wrap">' + BUILDER_CURRENT.replace(/</g,'&lt;') + '</pre>');
}

function builderTogglePreview() {
  const preview = document.getElementById('builder-preview');
  const code = document.getElementById('builder-code-view');
  const showing = !code.classList.contains('hidden');
  if (showing) {
    code.classList.add('hidden'); preview.classList.remove('hidden');
  } else {
    code.classList.remove('hidden'); preview.classList.add('hidden');
    code.value = BUILDER_CURRENT;
  }
}

function builderApplyCode() {
  const code = document.getElementById('builder-code-view');
  BUILDER_CURRENT = code.value;
  renderBuilderPreview(BUILDER_CURRENT);
  code.classList.add('hidden');
  document.getElementById('builder-preview').classList.remove('hidden');
  showToast('Changes applied');
}

function renderBuilderHistory() {
  const el = document.getElementById('builder-history');
  if (!BUILDER_HISTORY.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="builder-history-label">History</div>' +
    BUILDER_HISTORY.slice(0,8).map((h,i) => `
      <div class="builder-hist-item" onclick="loadBuilderHistory(${i})" title="${esc(h.prompt)}">
        ${esc(h.prompt.slice(0,30))}…
      </div>`).join('');
}

function loadBuilderHistory(i) {
  const h = BUILDER_HISTORY[i];
  if (!h) return;
  BUILDER_CURRENT = h.html;
  renderBuilderPreview(h.html);
  document.getElementById('builder-prompt').value = h.prompt;
  showToast('Loaded from history');
}

// ── Notes ──────────────────────────────────────────────────
let NOTES = [];
let CURRENT_NOTE = null;

function initNotes() {
  NOTES = JSON.parse(localStorage.getItem('nova_notes') || '[]');
  renderNotesList();
  if (NOTES.length) openNote(NOTES[0].id);
  else newNote();
}

function saveNotes() {
  localStorage.setItem('nova_notes', JSON.stringify(NOTES));
}

function newNote() {
  const note = { id: Date.now().toString(), title: 'Untitled Note', content: '', updated: Date.now() };
  NOTES.unshift(note);
  saveNotes();
  renderNotesList();
  openNote(note.id);
}

function openNote(id) {
  CURRENT_NOTE = id;
  const note = NOTES.find(n => n.id === id);
  if (!note) return;
  document.getElementById('note-title').value = note.title;
  document.getElementById('note-editor').value = note.content;
  document.getElementById('note-updated').textContent = 'Updated ' + new Date(note.updated).toLocaleString('en-AU', { day:'numeric',month:'short',hour:'2-digit',minute:'2-digit' });
  renderNotesList();
}

function saveCurrentNote() {
  if (!CURRENT_NOTE) return;
  const note = NOTES.find(n => n.id === CURRENT_NOTE);
  if (!note) return;
  note.title = document.getElementById('note-title').value || 'Untitled Note';
  note.content = document.getElementById('note-editor').value;
  note.updated = Date.now();
  saveNotes();
  renderNotesList();
  document.getElementById('note-updated').textContent = 'Saved just now';
}

function deleteCurrentNote() {
  if (!CURRENT_NOTE) return;
  if (!confirm('Delete this note?')) return;
  NOTES = NOTES.filter(n => n.id !== CURRENT_NOTE);
  saveNotes();
  renderNotesList();
  CURRENT_NOTE = null;
  if (NOTES.length) openNote(NOTES[0].id);
  else { document.getElementById('note-title').value = ''; document.getElementById('note-editor').value = ''; }
}

function renderNotesList() {
  const el = document.getElementById('notes-list');
  if (!NOTES.length) { el.innerHTML = '<p class="sidebar-empty" style="padding:12px">No notes yet</p>'; return; }
  el.innerHTML = NOTES.map(n => `
    <div class="note-item ${n.id === CURRENT_NOTE ? 'active' : ''}" onclick="openNote('${n.id}')">
      <div class="note-item-title">${esc(n.title)}</div>
      <div class="note-item-preview">${esc(n.content.slice(0,50)) || 'Empty note'}</div>
    </div>`).join('');
}

async function aiEnhanceNote() {
  if (!CURRENT_NOTE) return;
  const content = document.getElementById('note-editor').value;
  if (!content.trim()) { showToast('Write something first'); return; }
  const btn = document.getElementById('note-ai-btn');
  btn.textContent = '⏳'; btn.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Improve and expand the following note. Keep the same meaning but make it clearer, more structured, and more detailed. Return only the improved text.' },
          { role: 'user', content: content }
        ],
        temperature: 0.6, max_tokens: 1024
      })
    });
    const data = await res.json();
    const improved = data.choices?.[0]?.message?.content;
    if (improved) {
      document.getElementById('note-editor').value = improved;
      saveCurrentNote();
      showToast('Note enhanced by AI!');
    }
  } catch(e) { showToast('AI enhancement failed', 'error'); }
  btn.textContent = '✨ AI Enhance'; btn.disabled = false;
}

function exportNote() {
  if (!CURRENT_NOTE) return;
  const note = NOTES.find(n => n.id === CURRENT_NOTE);
  if (!note) return;
  const blob = new Blob([`# ${note.title}\n\n${note.content}`], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = note.title.replace(/[^a-z0-9]/gi,'_') + '.md';
  a.click();
}

// Auto-save notes every 2s while typing
let noteSaveTimer = null;
function noteInput() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(saveCurrentNote, 1500);
}

// ── Code Playground ────────────────────────────────────────
let CODE_OUTPUT_FRAME = null;

function initCodePlayground() {
  if (document.getElementById('code-editor').value) return;
  document.getElementById('code-editor').value = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: sans-serif; background: #0f0f12; color: #e0e0e0; padding: 20px; }
    h1 { color: #9d5cff; }
  </style>
</head>
<body>
  <h1>Hello from Nova Code!</h1>
  <p>Edit this HTML/CSS/JS and click Run.</p>
  <button onclick="alert('It works!')">Click me</button>
</body>
</html>`;
}

function runCode() {
  const code = document.getElementById('code-editor').value;
  const lang = document.getElementById('code-lang').value;
  const frame = document.getElementById('code-output');
  if (lang === 'html') {
    frame.srcdoc = code;
  } else if (lang === 'js') {
    frame.srcdoc = `<html><body style="background:#0f0f12;color:#e0e0e0;font-family:monospace;padding:16px"><script>
      const _log = console.log.bind(console);
      const _out = document.createElement('pre');
      document.body.appendChild(_out);
      console.log = (...a) => { _out.textContent += a.map(x=>JSON.stringify(x,null,2)).join(' ') + '\\n'; _log(...a); };
      try { ${code} } catch(e) { _out.textContent += '\\nError: ' + e.message; _out.style.color='#f87171'; }
    <\/script></body></html>`;
  } else if (lang === 'css') {
    frame.srcdoc = `<html><head><style>body{background:#0f0f12;color:#e0e0e0;padding:20px;font-family:sans-serif}${code}</style></head><body><h1>H1 Heading</h1><p>Paragraph text</p><button>Button</button><ul><li>List item 1</li><li>List item 2</li></ul></body></html>`;
  }
}

async function aiFixCode() {
  const code = document.getElementById('code-editor').value;
  if (!code.trim()) return;
  const btn = document.getElementById('code-ai-fix-btn');
  btn.textContent = '⏳ Fixing…'; btn.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Fix any bugs in this code and improve it. Return ONLY the fixed code, no explanation, no markdown.' },
          { role: 'user', content: code }
        ],
        temperature: 0.2, max_tokens: 2048
      })
    });
    const data = await res.json();
    const fixed = data.choices?.[0]?.message?.content?.replace(/^```[\w]*\n?/,'').replace(/```$/,'').trim();
    if (fixed) { document.getElementById('code-editor').value = fixed; showToast('Code fixed by AI!'); runCode(); }
  } catch(e) { showToast('AI fix failed', 'error'); }
  btn.textContent = '🤖 AI Fix'; btn.disabled = false;
}

async function aiGenerateCode() {
  const prompt = gv('code-prompt');
  if (!prompt) { showToast('Describe what to generate'); return; }
  const lang = document.getElementById('code-lang').value;
  const btn = document.getElementById('code-gen-btn');
  btn.textContent = '⏳ Generating…'; btn.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: `Generate ${lang.toUpperCase()} code. Return ONLY the code, no explanation, no markdown fences.` },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4, max_tokens: 2048
      })
    });
    const data = await res.json();
    const code = data.choices?.[0]?.message?.content?.replace(/^```[\w]*\n?/,'').replace(/```$/,'').trim();
    if (code) { document.getElementById('code-editor').value = code; runCode(); document.getElementById('code-prompt').value = ''; showToast('Code generated!'); }
  } catch(e) { showToast('Generation failed', 'error'); }
  btn.textContent = '✨ Generate'; btn.disabled = false;
}

function copyCode() {
  navigator.clipboard.writeText(document.getElementById('code-editor').value);
  showToast('Copied!');
}

function downloadCode() {
  const code = document.getElementById('code-editor').value;
  const lang = document.getElementById('code-lang').value;
  const ext = { html:'html', js:'js', css:'css' }[lang] || 'txt';
  const blob = new Blob([code], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nova-code.${ext}`;
  a.click();
}
