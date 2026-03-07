// ── UTILS ─────────────────────────────────────────────────────
function hide(id){ document.getElementById(id)?.classList.add('hidden') }
function show(id){ document.getElementById(id)?.classList.remove('hidden') }
function el(id){ return document.getElementById(id) }
function esc(t){ return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function grow(t){ t.style.height='auto'; t.style.height=Math.min(t.scrollHeight,180)+'px' }

function isConfigured() {
  return SUPABASE_URL && SUPABASE_ANON && SUPABASE_URL.startsWith('https://') && SUPABASE_ANON.length > 20;
}

// ── STATE ─────────────────────────────────────────────────────
let sb, ME, SESSION_TOKEN, VIEW, dmChannel, allUsers = [], totalTokens = 0, totalMsgs = 0, dailyMsgs = 0;

// ── INIT ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/config');
    if (res.ok) { const cfg = await res.json(); SUPABASE_URL = cfg.supabaseUrl; SUPABASE_ANON = cfg.supabaseAnon; }
  } catch(e) { console.warn('Config fetch failed:', e); }

  if (!isConfigured()) { hide('loading-screen'); show('config-error'); return; }

  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  let authResolved = false;
  async function handleSession(session) {
    if (authResolved) return;
    authResolved = true;
    SESSION_TOKEN = session?.access_token || null;
    hide('loading-screen');
    if (session?.user) {
      await loadMe(session.user);
      hide('auth-wrap'); show('app-wrap');
      loadSidebar();
    } else {
      ME = null; hide('app-wrap'); show('auth-wrap');
    }
  }

  const { data: { session } } = await sb.auth.getSession();
  await handleSession(session);
  sb.auth.onAuthStateChange(async (event, session) => {
    SESSION_TOKEN = session?.access_token || null;
    if (event === 'SIGNED_OUT') { ME = null; hide('app-wrap'); show('auth-wrap'); }
    else if (event === 'SIGNED_IN' && !ME) await handleSession(session);
  });
  setTimeout(() => { if (!authResolved) { hide('loading-screen'); show('auth-wrap'); } }, 8000);
});

// ── AUTH ──────────────────────────────────────────────────────
window.switchTab = (t) => {
  el('tab-in').classList.toggle('on', t==='in');
  el('tab-up').classList.toggle('on', t==='up');
  el('form-in').classList.toggle('hidden', t!=='in');
  el('form-up').classList.toggle('hidden', t!=='up');
  el('login-err').classList.remove('show');
  el('reg-err').classList.remove('show');
};

function setLoading(btnId, spinId, labelId, loading) {
  el(btnId).disabled = loading;
  el(spinId).classList.toggle('hidden', !loading);
  el(labelId).style.opacity = loading ? '0' : '1';
}
function showErr(id, msg){ const e=el(id); e.textContent=msg; e.classList.add('show'); }
function showOk(id, msg){ const e=el(id); e.textContent=msg; e.classList.add('show'); }
function friendlyErr(msg) {
  if (!msg) return 'Something went wrong.';
  if (msg.includes('Invalid login')||msg.includes('invalid_credentials')) return 'Incorrect email or password.';
  if (msg.includes('already registered')) return 'This email is already registered.';
  if (msg.includes('Email not confirmed')) return 'Please confirm your email first.';
  return msg;
}

window.doLogin = async () => {
  el('login-err').classList.remove('show');
  const email = el('li-email').value.trim(), pass = el('li-pass').value;
  if (!email||!pass) return showErr('login-err','Enter your email and password.');
  setLoading('login-btn','login-spin','login-label',true);
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  setLoading('login-btn','login-spin','login-label',false);
  if (error) showErr('login-err', friendlyErr(error.message));
};

window.doRegister = async () => {
  el('reg-err').classList.remove('show'); el('reg-ok').classList.remove('show');
  const username = el('ru-user').value.trim().toLowerCase().replace(/\s+/g,'');
  const email = el('ru-email').value.trim(), pass = el('ru-pass').value, conf = el('ru-conf').value;
  if (!username) return showErr('reg-err','Username required.');
  if (!email) return showErr('reg-err','Email required.');
  if (pass.length < 6) return showErr('reg-err','Password must be 6+ characters.');
  if (pass !== conf) return showErr('reg-err','Passwords do not match.');
  if (!/^[a-z0-9_]+$/.test(username)) return showErr('reg-err','Letters, numbers, underscores only.');
  setLoading('reg-btn','reg-spin','reg-label',true);
  const { data: existing } = await sb.from('profiles').select('id').eq('username',username).maybeSingle();
  if (existing) { setLoading('reg-btn','reg-spin','reg-label',false); return showErr('reg-err','Username taken.'); }
  const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { username, display_name: username } } });
  setLoading('reg-btn','reg-spin','reg-label',false);
  if (error) return showErr('reg-err', friendlyErr(error.message));
  if (data.user) await sb.from('profiles').upsert({ id: data.user.id, username, display_name: username, email, bio:'', avatar_char: username[0].toUpperCase(), avatar_color: randomColor() });
  if (!data.session) showOk('reg-ok','✓ Account created! Check your email to confirm.');
};

window.doLogout = async () => { if (dmChannel) sb.removeChannel(dmChannel); await sb.auth.signOut(); };

// ── PROFILE ───────────────────────────────────────────────────
function randomColor() {
  const colors = ['#7c6ef7','#3ecf8e','#f59e0b','#ef4444','#3b82f6','#ec4899','#8b5cf6','#14b8a6'];
  return colors[Math.floor(Math.random() * colors.length)];
}

async function loadMe(user) {
  const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (data) { ME = data; }
  else {
    ME = { id: user.id, username: user.email.split('@')[0], display_name: user.email.split('@')[0], email: user.email, avatar_char: user.email[0].toUpperCase(), avatar_color: randomColor(), bio:'', tier:'free', daily_msgs:0, is_admin: false };
    await sb.from('profiles').upsert(ME);
  }
  dailyMsgs = ME.daily_msgs || 0;
  renderSidebarUser();
  updateMsgCounter();
  if (ME.is_admin) show('admin-sidebar-btn');
}

function renderSidebarUser() {
  const av = el('sb-av');
  if (ME.avatar_url) {
    av.innerHTML = `<img src="${ME.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
    av.style.background = 'none';
  } else {
    av.textContent = ME.avatar_char || ME.display_name[0].toUpperCase();
    av.style.background = `linear-gradient(135deg, ${ME.avatar_color||'#7c6ef7'}, ${ME.avatar_color||'#7c6ef7'}88)`;
  }
  el('sb-name').innerHTML = esc(ME.display_name) + (ME.tier==='pro' ? ' <span class="pro-badge">PRO</span>' : '');
  el('sb-sub').textContent = '@' + ME.username;
}

function updateMsgCounter() {
  const left = Math.max(0, 50 - (dailyMsgs||0));
  const bar = el('msg-counter');
  if (!bar) return;
  if (ME.tier === 'pro') { bar.innerHTML = '<span style="color:var(--accent)">⚡ NovaAI Pro — Unlimited</span>'; return; }
  bar.innerHTML = `<span style="color:${left<10?'var(--red)':'var(--text3)'}">${left} messages left today</span>`;
}

// ── PROFILE MODAL ─────────────────────────────────────────────
window.openProfile = () => {
  const pav = el('prof-av');
  if (ME.avatar_url) {
    pav.innerHTML = `<img src="${ME.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
    pav.style.background = 'none';
  } else {
    pav.textContent = ME.avatar_char || '?';
    pav.style.background = `linear-gradient(135deg, ${ME.avatar_color||'#7c6ef7'}, ${ME.avatar_color||'#7c6ef7'}88)`;
  }
  el('prof-dn').textContent = ME.display_name;
  el('prof-un').textContent = '@' + ME.username;
  el('prof-bio').value = ME.bio||'';
  el('prof-name-edit').value = ME.display_name;
  el('saved-ok').classList.add('hidden');
  renderColorPicker();
  el('prof-modal').classList.add('on');
};
window.closeProfModal = () => el('prof-modal').classList.remove('on');

function renderColorPicker() {
  const colors = ['#7c6ef7','#3ecf8e','#f59e0b','#ef4444','#3b82f6','#ec4899','#8b5cf6','#14b8a6','#f97316','#06b6d4'];
  el('color-picker').innerHTML = colors.map(c =>
    `<div class="color-swatch ${ME.avatar_color===c?'on':''}" style="background:${c}" onclick="pickColor('${c}')"></div>`
  ).join('');
}

window.pickColor = (color) => {
  ME.avatar_color = color;
  const pav = el('prof-av');
  pav.style.background = `linear-gradient(135deg, ${color}, ${color}88)`;
  pav.textContent = ME.avatar_char || ME.display_name[0].toUpperCase();
  pav.innerHTML = ME.avatar_char || ME.display_name[0].toUpperCase();
  renderColorPicker();
};

window.handleAvatarUpload = async (input) => {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { alert('Image must be under 2MB'); return; }
  const ext = file.name.split('.').pop();
  const path = `${ME.id}/avatar.${ext}`;
  const { error } = await sb.storage.from('avatars').upload(path, file, { upsert: true });
  if (error) { alert('Upload failed: ' + error.message); return; }
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  ME.avatar_url = data.publicUrl + '?t=' + Date.now();
  const pav = el('prof-av');
  pav.innerHTML = `<img src="${ME.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
  pav.style.background = 'none';
};

window.saveProfile = async () => {
  const bio = el('prof-bio').value.trim();
  const display_name = el('prof-name-edit').value.trim() || ME.display_name;
  const avatar_char = display_name[0].toUpperCase();
  const updates = { bio, display_name, avatar_char, avatar_color: ME.avatar_color };
  if (ME.avatar_url) updates.avatar_url = ME.avatar_url;
  await sb.from('profiles').update(updates).eq('id', ME.id);
  Object.assign(ME, updates);
  renderSidebarUser();
  el('saved-ok').classList.remove('hidden');
  setTimeout(() => el('saved-ok').classList.add('hidden'), 2000);
};

// ── SIDEBAR ───────────────────────────────────────────────────
function loadSidebar() { loadAIChats(); loadDMList(); loadAllUsers(); }

async function loadAIChats() {
  const { data } = await sb.from('ai_chats').select('id,title,model').eq('user_id', ME.id).order('updated_at',{ascending:false});
  const list = el('ai-list'); list.innerHTML = '';
  (data||[]).forEach(c => list.appendChild(makeChatRow(c.id, c.title||'New Chat','ai',c.id)));
}

async function loadDMList() {
  const { data } = await sb.from('dm_channels').select('id,member_ids,member_names,updated_at').contains('member_ids',[ME.id]).order('updated_at',{ascending:false});
  const list = el('dm-list'); list.innerHTML = '';
  (data||[]).forEach(c => {
    const otherName = (c.member_names||[]).find(n=>n!==ME.display_name)||'User';
    list.appendChild(makeChatRow(c.id, otherName,'dm',c.id));
  });
}

async function loadAllUsers() {
  const { data } = await sb.from('profiles').select('*').neq('id',ME.id);
  allUsers = data||[];
}

function makeChatRow(id, label, type, rowId) {
  const div = document.createElement('div');
  div.className = 'chat-row'; div.dataset.id = rowId;
  div.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;opacity:.45">
      ${type==='ai'?'<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>':'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'}
    </svg>
    <span class="cr-name">${esc(label)}</span>
    ${type==='ai'?`
      <button class="cr-btn cr-rename" onclick="startRename(event,'${id}')" title="Rename">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="cr-btn cr-del" onclick="delChat(event,'${id}')" title="Delete">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>` : ''}`;
  div.addEventListener('click', () => type==='ai' ? openAIChat(id,label) : openDMChat(id,label));
  return div;
}

function setActive(id) {
  document.querySelectorAll('.chat-row').forEach(r => r.classList.toggle('on', r.dataset.id===id));
}

// ── RENAME CHAT ───────────────────────────────────────────────
window.startRename = (e, chatId) => {
  e.stopPropagation();
  const row = document.querySelector(`.chat-row[data-id="${chatId}"]`);
  const nameEl = row.querySelector('.cr-name');
  const current = nameEl.textContent;
  nameEl.innerHTML = `<input class="rename-input" value="${esc(current)}" onclick="event.stopPropagation()" onkeydown="handleRenameKey(event,'${chatId}',this)" onblur="cancelRename(this,'${esc(current)}')"/>`;
  const input = nameEl.querySelector('input');
  input.focus(); input.select();
};

window.handleRenameKey = async (e, chatId, input) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const newName = input.value.trim() || 'New Chat';
    await sb.from('ai_chats').update({ title: newName }).eq('id', chatId);
    if (VIEW?.id === chatId) el('chat-title').textContent = newName;
    await loadAIChats();
    if (VIEW?.id === chatId) setActive(chatId);
  }
  if (e.key === 'Escape') { await loadAIChats(); if (VIEW?.id === chatId) setActive(chatId); }
};

window.cancelRename = async (input, original) => {
  const row = input.closest('.chat-row');
  const chatId = row?.dataset.id;
  if (chatId) { await loadAIChats(); if (VIEW?.id === chatId) setActive(chatId); }
};

// ── AI CHAT ───────────────────────────────────────────────────
window.newAIChat = async () => {
  let data, error;
  for (let i = 0; i < 3; i++) {
    ({ data, error } = await sb.from('ai_chats').insert({ user_id: ME.id, title: 'New Chat', model: 'novaai-free' }).select().single());
    if (!error || !error.message?.includes('Lock broken')) break;
    await new Promise(r => setTimeout(r, 300));
  }
  if (error) { alert('Error creating chat: ' + error.message); return; }
  await loadAIChats();
  openAIChat(data.id, 'New Chat');
};

async function openAIChat(chatId, title) {
  if (dmChannel) { sb.removeChannel(dmChannel); dmChannel = null; }
  VIEW = { type:'ai', id:chatId };
  setActive(chatId);
  totalTokens = 0; totalMsgs = 0;
  updateStats();
  showChatView('ai', title);
  const { data:msgs } = await sb.from('ai_messages').select('role,content').eq('chat_id',chatId).order('created_at',{ascending:true});
  el('msgs').innerHTML = '';
  if (!msgs?.length) { renderWelcome(); return; }
  msgs.forEach(m => appendMsg(m.role, m.content));
  totalMsgs = msgs.filter(m=>m.role==='user').length;
  updateStats();
}

window.delChat = async (e, chatId) => {
  e.stopPropagation();
  if (!confirm('Delete this chat?')) return;
  await sb.from('ai_messages').delete().eq('chat_id',chatId);
  await sb.from('ai_chats').delete().eq('id',chatId);
  if (VIEW?.id===chatId) { VIEW=null; showEmpty(); }
  loadAIChats();
};

// ── SEND AI ───────────────────────────────────────────────────
async function sendAI(text) {
  // Check limit client-side first
  if (ME.tier === 'free' && dailyMsgs >= 50) {
    showLimitModal();
    return;
  }

  const { data:history } = await sb.from('ai_messages').select('role,content').eq('chat_id',VIEW.id).order('created_at',{ascending:true});
  await sb.from('ai_messages').insert({ chat_id:VIEW.id, role:'user', content:text });
  if (!history?.length) {
    const newTitle = text.slice(0,45) + (text.length>45?'…':'');
    await sb.from('ai_chats').update({ title:newTitle, updated_at:new Date().toISOString() }).eq('id',VIEW.id);
    el('chat-title').textContent = newTitle;
    loadAIChats();
  } else {
    await sb.from('ai_chats').update({ updated_at:new Date().toISOString() }).eq('id',VIEW.id);
  }

  const typingEl = showTyping();
  el('send-btn').disabled = true;
  try {
    const messages = [
      { role:'system', content:'You are NovaAI, a helpful and knowledgeable AI assistant. Be clear, accurate and friendly. Use markdown for code, and structure longer answers with headers.' },
      ...(history||[]),
      { role:'user', content:text }
    ];
    const res = await fetch('/api/chat', {
      method:'POST',
      headers: { 'Content-Type':'application/json', 'X-User-Token': SESSION_TOKEN },
      body: JSON.stringify({ messages, temperature:0.7, max_tokens:2048 })
    });
    typingEl.remove();

    if (res.status === 429) {
      const d = await res.json();
      showLimitModal(d.resetIn);
      el('send-btn').disabled = false;
      return;
    }

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try { const j = await res.json(); errMsg = j.error || errMsg; } catch(_){}
      throw new Error(errMsg);
    }

    const d = await res.json();
    const reply = d.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty response from API.');

    // Update daily count from server response
    if (d._dailyMsgs !== undefined) {
      dailyMsgs = d._dailyMsgs;
      ME.daily_msgs = dailyMsgs;
      updateMsgCounter();
    }

    totalTokens += d.usage?.total_tokens || 0;
    totalMsgs++;
    updateStats();
    await sb.from('ai_messages').insert({ chat_id:VIEW.id, role:'assistant', content:reply });
    appendMsg('assistant', reply);
  } catch(err) {
    typingEl.remove();
    appendErr('Error: ' + err.message);
  }
  el('send-btn').disabled = false;
  el('msg-input').focus();
}

function showLimitModal(resetIn) {
  el('limit-reset-time').textContent = resetIn ? `Resets in ${resetIn}` : 'Resets at midnight';
  el('limit-modal').classList.add('on');
}
window.closeLimitModal = () => el('limit-modal').classList.remove('on');

// ── DM ────────────────────────────────────────────────────────
window.openDMModal = async () => {
  await loadAllUsers(); renderUserResults(allUsers);
  el('dm-search').value = '';
  el('dm-modal').classList.add('on');
};
window.closeDMModal = () => el('dm-modal').classList.remove('on');
window.filterUsers = () => {
  const q = el('dm-search').value.toLowerCase();
  renderUserResults(allUsers.filter(u => u.username.includes(q)||u.display_name.toLowerCase().includes(q)));
};
function renderUserResults(users) {
  el('user-results').innerHTML = users.length
    ? users.map(u => `<div class="user-hit" onclick="startDM('${u.id}','${esc(u.display_name)}')">
        <div class="av sm" style="background:linear-gradient(135deg,${u.avatar_color||'#7c6ef7'},${u.avatar_color||'#7c6ef7'}88)">${u.avatar_char||u.display_name[0].toUpperCase()}</div>
        <div><div class="uh-name">${esc(u.display_name)}${u.tier==='pro'?' <span class="pro-badge">PRO</span>':''}</div><div class="uh-user">@${esc(u.username)}</div></div>
      </div>`).join('')
    : '<div style="color:var(--text3);font-size:.85rem;padding:8px 0">No other users found.</div>';
}

window.startDM = async (otherId, otherName) => {
  closeDMModal();
  const { data:all } = await sb.from('dm_channels').select('id,member_ids').contains('member_ids',[ME.id]);
  const existing = (all||[]).find(c=>c.member_ids.includes(otherId));
  if (existing) { openDMChat(existing.id, otherName); return; }
  const { data:newChan, error } = await sb.from('dm_channels').insert({ member_ids:[ME.id,otherId], member_names:[ME.display_name,otherName], updated_at:new Date().toISOString() }).select().single();
  if (error) { alert('Error: '+error.message); return; }
  await loadDMList();
  openDMChat(newChan.id, otherName);
};

async function openDMChat(chanId, otherName) {
  if (dmChannel) { sb.removeChannel(dmChannel); dmChannel=null; }
  VIEW = { type:'dm', id:chanId };
  setActive(chanId);
  showChatView('dm', otherName);
  const { data:msgs } = await sb.from('dm_messages').select('*').eq('channel_id',chanId).order('created_at',{ascending:true});
  el('msgs').innerHTML = '';
  if (!msgs?.length) {
    el('msgs').innerHTML = `<div class="dm-empty">Start a conversation with <strong>${esc(otherName)}</strong> 👋</div>`;
  } else { msgs.forEach(m => appendDM(m.sender_id===ME.id?'me':'them', m.content, m.sender_name)); }
  dmChannel = sb.channel(`dm:${chanId}`)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'dm_messages',filter:`channel_id=eq.${chanId}`}, payload => {
      if (payload.new.sender_id===ME.id) return;
      el('msgs').querySelector('.dm-empty')?.remove();
      appendDM('them', payload.new.content, payload.new.sender_name);
    }).subscribe();
}

async function sendDM(text) {
  el('msgs').querySelector('.dm-empty')?.remove();
  appendDM('me', text, ME.display_name);
  const { error } = await sb.from('dm_messages').insert({ channel_id:VIEW.id, sender_id:ME.id, sender_name:ME.display_name, content:text });
  if (error) appendErr('DM Error: '+error.message);
  await sb.from('dm_channels').update({ updated_at:new Date().toISOString() }).eq('id',VIEW.id);
}

window.doSend = async () => {
  const input = el('msg-input'), text = input.value.trim();
  if (!text||!VIEW) return;
  input.value = ''; grow(input);
  if (VIEW.type==='ai') { appendMsg('user',text); await sendAI(text); }
  else { await sendDM(text); }
};
window.useChip = (t) => { el('msg-input').value = t; doSend(); };

// ── ADMIN PANEL ───────────────────────────────────────────────
window.openAdmin = async () => {
  if (!ME?.is_admin) return;
  el('admin-modal').classList.add('on');
  await loadAdminUsers();
};
window.closeAdmin = () => el('admin-modal').classList.remove('on');

async function loadAdminUsers() {
  el('admin-user-list').innerHTML = '<div style="color:var(--text3);padding:12px">Loading…</div>';
  const res = await fetch('/api/admin/users', {
    headers: { 'X-User-Token': SESSION_TOKEN }
  });
  if (!res.ok) { el('admin-user-list').innerHTML = '<div style="color:var(--red)">Failed to load users.</div>'; return; }
  const users = await res.json();
  el('admin-search').value = '';
  renderAdminUsers(users);
  el('admin-user-list').dataset.users = JSON.stringify(users);
}

window.filterAdminUsers = () => {
  const q = el('admin-search').value.toLowerCase();
  const users = JSON.parse(el('admin-user-list').dataset.users || '[]');
  renderAdminUsers(users.filter(u => u.username.includes(q) || u.display_name.toLowerCase().includes(q)));
};

function renderAdminUsers(users) {
  el('admin-user-list').innerHTML = users.map(u => `
    <div class="admin-user-row">
      <div class="admin-av" style="background:linear-gradient(135deg,${u.avatar_color||'#7c6ef7'},${u.avatar_color||'#7c6ef7'}88)">${u.avatar_char||u.display_name[0].toUpperCase()}</div>
      <div class="admin-info">
        <div class="admin-uname">${esc(u.display_name)} ${u.is_admin?'<span class="pro-badge" style="background:#ef4444">ADMIN</span>':''}</div>
        <div class="admin-usub">@${esc(u.username)} · ${u.daily_msgs||0} msgs today</div>
      </div>
      <div class="admin-tier-btns">
        <button class="tier-btn ${u.tier==='free'?'on':''}" onclick="setTier('${u.id}','free',this)">Free</button>
        <button class="tier-btn pro ${u.tier==='pro'?'on':''}" onclick="setTier('${u.id}','pro',this)">Pro</button>
      </div>
    </div>`).join('');
}

window.setTier = async (userId, tier, btn) => {
  btn.disabled = true; btn.textContent = '…';
  const res = await fetch('/api/admin/set-tier', {
    method:'POST',
    headers: { 'Content-Type':'application/json', 'X-User-Token': SESSION_TOKEN },
    body: JSON.stringify({ targetUserId: userId, tier })
  });
  if (res.ok) { await loadAdminUsers(); }
  else { btn.disabled=false; btn.textContent=tier; alert('Failed to update tier.'); }
};

// ── UI HELPERS ────────────────────────────────────────────────
function showEmpty(){ show('empty'); hide('chat-view'); }
function showChatView(type, title) {
  hide('empty'); show('chat-view');
  el('chat-title').textContent = title;
  el('model-bar').classList.toggle('hidden', type!=='ai');
  if (type==='ai') {
    el('model-label').textContent = ME.tier==='pro' ? '⚡ NovaAI Pro' : '🟢 NovaAI Free';
  }
  el('msg-input').placeholder = type==='ai' ? 'Message NovaAI…' : `Message ${title}…`;
  el('msg-input').focus();
}

function renderWelcome() {
  el('msgs').innerHTML = `
    <div class="welcome">
      <div class="wl-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
      <h2>How can I help?</h2>
      <p>Ask me anything — code, writing, research, or just a chat.</p>
      <div class="chips">
        <button class="chip" onclick="useChip('Explain how neural networks work')">How do neural networks work?</button>
        <button class="chip" onclick="useChip('Write a Python function to reverse a string')">Reverse a string in Python</button>
        <button class="chip" onclick="useChip('Give me 5 creative business ideas')">Creative business ideas</button>
        <button class="chip" onclick="useChip('Explain TCP vs UDP simply')">TCP vs UDP</button>
        <button class="chip" onclick="useChip('Write a short poem about space')">Poem about space</button>
        <button class="chip" onclick="useChip('What are best practices for clean code?')">Clean code tips</button>
      </div>
    </div>`;
}

function appendMsg(role, content) {
  const msgs = el('msgs');
  msgs.querySelector('.welcome')?.remove();
  const w = document.createElement('div');
  w.className = 'msg-wrap';
  if (role==='user') {
    w.innerHTML = `<div class="msg-user"><div class="bubble">${esc(content)}</div></div>`;
  } else {
    w.innerHTML = `<div class="msg-ai"><div class="ai-av"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div><div class="ai-body">${renderMD(content)}</div></div>`;
  }
  msgs.appendChild(w); msgs.scrollTop = msgs.scrollHeight;
}

function appendDM(who, content, name) {
  const msgs = el('msgs');
  const w = document.createElement('div'); w.className = 'msg-wrap';
  if (who==='me') {
    w.innerHTML = `<div class="msg-user"><div class="bubble">${esc(content)}</div></div>`;
  } else {
    w.innerHTML = `<div class="msg-other"><div class="av sm">${(name||'U')[0].toUpperCase()}</div><div><div class="dm-name">${esc(name)}</div><div class="dm-text">${esc(content)}</div></div></div>`;
  }
  msgs.appendChild(w); msgs.scrollTop = msgs.scrollHeight;
}

function showTyping() {
  const msgs = el('msgs');
  msgs.querySelector('.welcome')?.remove();
  const d = document.createElement('div'); d.className = 'typing-row';
  d.innerHTML = `<div class="ai-av"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div><div class="typing-dots"><span></span><span></span><span></span></div>`;
  msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
  return d;
}

function appendErr(msg) {
  const msgs = el('msgs');
  const d = document.createElement('div'); d.className = 'msg-wrap';
  d.innerHTML = `<div class="msg-err">⚠ ${esc(msg)}</div>`;
  msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
}

function updateStats() {
  el('st-tok').textContent = totalTokens.toLocaleString();
  el('st-msg').textContent = totalMsgs;
}

// ── MARKDOWN ──────────────────────────────────────────────────
function renderMD(raw) {
  let s = esc(raw);
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_,lang,code) => `<pre><code>${code.trim()}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s = s.replace(/\*([^\*\n]+)\*/g,'<em>$1</em>');
  s = s.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  s = s.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  s = s.replace(/^---$/gm,'<hr/>');
  s = s.replace(/^[\*\-] (.+)$/gm,'<li>$1</li>');
  s = s.replace(/^\d+\. (.+)$/gm,'<li>$1</li>');
  s = s.replace(/\n\n+/g,'</p><p>');
  s = s.replace(/([^>])\n([^<])/g,'$1<br/>$2');
  return `<p>${s}</p>`;
}
