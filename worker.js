export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json', ...cors }
    });

    // ── Helpers ──────────────────────────────────────────────
    async function getUser(token) {
      if (!token) return null;
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (!r.ok) return null;
      return r.json();
    }
    async function getProfile(userId) {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {
        headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
      });
      const d = await r.json();
      return d[0] || null;
    }
    async function patchProfile(userId, data) {
      return fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        },
        body: JSON.stringify(data)
      });
    }
    // Read site_config table (key-value store for admin settings)
    async function getSiteConfig() {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/site_config?select=key,value`, {
        headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
      });
      const rows = await r.json();
      const cfg = {};
      if (Array.isArray(rows)) rows.forEach(row => { cfg[row.key] = row.value; });
      return cfg;
    }
    async function setSiteConfig(key, value) {
      return fetch(`${env.SUPABASE_URL}/rest/v1/site_config`, {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ key, value })
      });
    }

    // ── GET /api/config ──────────────────────────────────────
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({ supabaseUrl: env.SUPABASE_URL, supabaseAnon: env.SUPABASE_ANON_KEY });
    }

    // ── GET /api/site-status ─────────────────────────────────
    // Public endpoint — returns site_down flag and banner message
    if (url.pathname === '/api/site-status' && request.method === 'GET') {
      const cfg = await getSiteConfig();
      return json({
        site_down: cfg.site_down === 'true',
        down_message: cfg.down_message || 'NovaAI is temporarily offline for maintenance. Check back soon.',
        banner: cfg.banner || null,
        banner_type: cfg.banner_type || 'info'
      });
    }

    // ── POST /api/chat ───────────────────────────────────────
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const cfg = await getSiteConfig();
        if (cfg.site_down === 'true') return json({ error: cfg.down_message || 'Site is offline for maintenance.' }, 503);
        if (cfg.chat_disabled === 'true') return json({ error: cfg.chat_disabled_msg || 'Chat is temporarily disabled.' }, 503);

        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const profile = await getProfile(user.id);
        if (!profile) return json({ error: 'Profile not found' }, 404);

        if (cfg.banned_users && cfg.banned_users.includes(user.id)) {
          return json({ error: 'Your account has been suspended.' }, 403);
        }

        // Reset daily count if past midnight
        const now = new Date();
        const resetAt = new Date(profile.msgs_reset_at);
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dailyMsgs = profile.daily_msgs || 0;
        if (resetAt < todayMidnight) {
          dailyMsgs = 0;
          await patchProfile(user.id, { daily_msgs: 0, msgs_reset_at: now.toISOString() });
        }

        // Limits: use profile override, else global config, else default
        const globalMsgLimit = parseInt(cfg.global_msg_limit || '50');
        const userMsgLimit = profile.custom_msg_limit != null ? profile.custom_msg_limit : globalMsgLimit;
        const LIMIT = profile.tier === 'pro' ? 999 : userMsgLimit;

        if (dailyMsgs >= LIMIT) {
          const midnight = new Date(todayMidnight.getTime() + 86400000);
          const ms = midnight - now;
          const hrs = Math.floor(ms / 3600000), mins = Math.floor((ms % 3600000) / 60000);
          return json({ error: 'limit_reached', resetIn: `${hrs}h ${mins}m`, limit: LIMIT }, 429);
        }

        const body = await request.json();
        const model = profile.tier === 'pro' ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

        // Web search
        let searchContext = '';
        if (body.useWebSearch && env.TAVILY_API_KEY) {
          const lastMsg = body.messages[body.messages.length - 1]?.content || '';
          try {
            const sr = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query: lastMsg, max_results: 5, search_depth: 'basic' })
            });
            const sd = await sr.json();
            if (sd.results?.length) {
              searchContext = '\n\n[Web Search Results]\n' + sd.results.map(r => `• ${r.title}: ${r.content} (${r.url})`).join('\n') + '\n[Use these results to inform your answer.]\n';
            }
          } catch(_) {}
        }

        const messages = body.messages.map((m, i) => {
          if (i === 0 && m.role === 'system' && searchContext) return { ...m, content: m.content + searchContext };
          return m;
        });

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, temperature: body.temperature || 0.7, max_tokens: body.max_tokens || 2048 })
        });
        const data = await res.json();
        await patchProfile(user.id, { daily_msgs: dailyMsgs + 1 });
        return new Response(JSON.stringify({ ...data, _dailyMsgs: dailyMsgs + 1 }), {
          status: res.status, headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/imagine ────────────────────────────────────
    if (url.pathname === '/api/imagine' && request.method === 'POST') {
      try {
        const cfg = await getSiteConfig();
        if (cfg.site_down === 'true') return json({ error: 'Site is offline for maintenance.' }, 503);
        if (cfg.img_disabled === 'true') return json({ error: cfg.img_disabled_msg || 'Image generation is temporarily disabled.' }, 503);

        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const profile = await getProfile(user.id);
        if (!profile) return json({ error: 'Profile not found' }, 404);

        if (cfg.banned_users && cfg.banned_users.includes(user.id)) {
          return json({ error: 'Your account has been suspended.' }, 403);
        }

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const imgReset = new Date(profile.imgs_reset_at || 0);
        let dailyImgs = imgReset < todayMidnight ? 0 : (profile.daily_imgs || 0);

        // Limits
        const globalImgLimit = parseInt(cfg.global_img_limit_free || '3');
        const globalImgLimitPro = parseInt(cfg.global_img_limit_pro || '10');
        const userImgLimit = profile.custom_img_limit != null ? profile.custom_img_limit
          : (profile.tier === 'pro' ? globalImgLimitPro : globalImgLimit);
        const IMG_LIMIT = userImgLimit;

        if (dailyImgs >= IMG_LIMIT) {
          const midnight = new Date(todayMidnight.getTime() + 86400000);
          const ms = midnight - now;
          const hrs = Math.floor(ms / 3600000), mins = Math.floor((ms % 3600000) / 60000);
          return json({ error: 'img_limit_reached', resetIn: `${hrs}h ${mins}m`, limit: IMG_LIMIT }, 429);
        }

        const { prompt } = await request.json();
        if (!prompt) return json({ error: 'Prompt required' }, 400);

        const cfHeaders = {
          'Authorization': `Bearer ${env.CF_AI_TOKEN}`,
          'Content-Type': 'application/json'
        };
        const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run`;

        const tryModel = async (model, body) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 25000);
          try {
            const r = await fetch(`${baseUrl}/${model}`, {
              method: 'POST', headers: cfHeaders,
              body: JSON.stringify(body), signal: controller.signal
            });
            clearTimeout(timer);
            return r;
          } catch(e) {
            clearTimeout(timer);
            throw e;
          }
        };

        let imgRes;
        try {
          imgRes = await tryModel('@cf/black-forest-labs/flux-1-schnell', { prompt, num_steps: 4 });
          if (!imgRes.ok) throw new Error('flux failed');
        } catch(_) {
          try {
            imgRes = await tryModel('@cf/stabilityai/stable-diffusion-xl-base-1.0', { prompt });
          } catch(e) {
            return json({ error: 'Image generation timed out. Try again.' }, 504);
          }
        }

        if (!imgRes || !imgRes.ok) {
          const errText = await imgRes?.text() || 'unknown';
          return json({ error: 'Image generation failed: ' + errText }, 500);
        }

        const imgBytes = await imgRes.arrayBuffer();
        if (!imgBytes.byteLength) return json({ error: 'Empty image returned.' }, 500);

        // Upload to Supabase Storage first
        const imgId = crypto.randomUUID();
        const storagePath = `${user.id}/${imgId}.jpg`;
        const uploadRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/generated-images/${storagePath}`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'image/jpeg', 'x-upsert': 'true'
          },
          body: imgBytes
        });

        let publicUrl = null;
        if (uploadRes.ok) {
          publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/generated-images/${storagePath}`;
          await fetch(`${env.SUPABASE_URL}/rest/v1/generated_images`, {
            method: 'POST',
            headers: {
              'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json', 'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ id: imgId, user_id: user.id, prompt, url: publicUrl })
          });
        }

        await patchProfile(user.id, {
          daily_imgs: dailyImgs + 1,
          imgs_reset_at: imgReset < todayMidnight ? now.toISOString() : profile.imgs_reset_at
        });

        // If storage worked, return just the URL (tiny response)
        // If not, return the image as raw binary — NOT base64 JSON (avoids size/corruption issues)
        if (publicUrl) {
          return json({ url: publicUrl, imgId, prompt, _dailyImgs: dailyImgs + 1, limit: IMG_LIMIT });
        } else {
          // Return raw bytes with a JSON header in a multipart-style approach:
          // Encode as base64 in chunks to avoid stack overflow, then return
          const uint8 = new Uint8Array(imgBytes);
          let binary = '';
          const chunkSize = 8192;
          for (let i = 0; i < uint8.length; i += chunkSize) {
            binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
          }
          const base64 = btoa(binary);
          return json({ image: `data:image/jpeg;base64,${base64}`, imgId, prompt, _dailyImgs: dailyImgs + 1, limit: IMG_LIMIT });
        }
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/analyse-file ───────────────────────────────
    if (url.pathname === '/api/analyse-file' && request.method === 'POST') {
      try {
        const cfg = await getSiteConfig();
        if (cfg.site_down === 'true') return json({ error: 'Site is offline.' }, 503);
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const { fileContent, fileName, userQuestion } = await request.json();
        const prompt = userQuestion
          ? `File: ${fileName}\n\nContent:\n${fileContent.slice(0, 12000)}\n\nQuestion: ${userQuestion}`
          : `Analyse this file (${fileName}) and summarise its contents:\n\n${fileContent.slice(0, 12000)}`;
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 })
        });
        const data = await res.json();
        return json({ reply: data.choices?.[0]?.message?.content || 'No response.' });
      } catch(err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/admin/users ─────────────────────────────────
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=*&order=created_at.desc`, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        });
        return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', ...cors } });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/admin/set-tier ─────────────────────────────
    if (url.pathname === '/api/admin/set-tier' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const { targetUserId, tier } = await request.json();
        await patchProfile(targetUserId, { tier });
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/admin/set-config ───────────────────────────
    // Set any site_config key (site_down, limits, banner, etc.)
    if (url.pathname === '/api/admin/set-config' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const body = await request.json();
        // body = { key: 'site_down', value: 'true' } or { updates: [{key,value},...] }
        if (body.updates) {
          for (const { key, value } of body.updates) await setSiteConfig(key, value);
        } else {
          await setSiteConfig(body.key, body.value);
        }
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── GET /api/admin/config ────────────────────────────────
    if (url.pathname === '/api/admin/config' && request.method === 'GET') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const cfg = await getSiteConfig();
        return json(cfg);
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/admin/reset-user ───────────────────────────
    // Reset a user's daily counts
    if (url.pathname === '/api/admin/reset-user' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const { targetUserId } = await request.json();
        await patchProfile(targetUserId, { daily_msgs: 0, daily_imgs: 0 });
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/admin/set-user-limits ─────────────────────
    // Set custom per-user limits (overrides global)
    if (url.pathname === '/api/admin/set-user-limits' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const { targetUserId, custom_msg_limit, custom_img_limit } = await request.json();
        const update = {};
        if (custom_msg_limit !== undefined) update.custom_msg_limit = custom_msg_limit;
        if (custom_img_limit !== undefined) update.custom_img_limit = custom_img_limit;
        await patchProfile(targetUserId, update);
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/admin/ban-user ─────────────────────────────
    if (url.pathname === '/api/admin/ban-user' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const { targetUserId, banned } = await request.json();
        await patchProfile(targetUserId, { is_banned: banned });
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/chats/create ──────────────────────────────
    // Uses service key — bypasses any RLS issues with JS client
    if (url.pathname === '/api/chats/create' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const { title } = await request.json();
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/ai_chats`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ user_id: user.id, title: (title||'New Chat').slice(0,50), last_message: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        });
        const rows = await r.json();
        if (!r.ok) return json({ error: rows?.message || rows?.hint || JSON.stringify(rows) }, r.status);
        return json({ data: rows[0] });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/chats/message ──────────────────────────────
    // Save a message via service key
    if (url.pathname === '/api/chats/message' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const { chat_id, role, content } = await request.json();
        // Verify chat belongs to user
        const checkR = await fetch(`${env.SUPABASE_URL}/rest/v1/ai_chats?id=eq.${chat_id}&user_id=eq.${user.id}&select=id`, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        });
        const check = await checkR.json();
        if (!check?.length) return json({ error: 'Chat not found' }, 404);
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/ai_messages`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ chat_id, role, content })
        });
        if (!r.ok) { const e = await r.text(); return json({ error: e }, r.status); }
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── PATCH /api/chats/update ──────────────────────────────
    if (url.pathname === '/api/chats/update' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const { chat_id, title, last_message } = await request.json();
        const update = { updated_at: new Date().toISOString() };
        if (title !== undefined) update.title = title;
        if (last_message !== undefined) update.last_message = last_message;
        await fetch(`${env.SUPABASE_URL}/rest/v1/ai_chats?id=eq.${chat_id}&user_id=eq.${user.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal'
          },
          body: JSON.stringify(update)
        });
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── DELETE /api/chats/delete ─────────────────────────────
    if (url.pathname === '/api/chats/delete' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const { chat_id } = await request.json();
        await fetch(`${env.SUPABASE_URL}/rest/v1/ai_chats?id=eq.${chat_id}&user_id=eq.${user.id}`, {
          method: 'DELETE',
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        });
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── GET /api/chats/list ──────────────────────────────────
    if (url.pathname === '/api/chats/list' && request.method === 'GET') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/ai_chats?user_id=eq.${user.id}&order=updated_at.desc&select=*`, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        });
        const data = await r.json();
        return json(data);
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── GET /api/chats/messages ──────────────────────────────
    if (url.pathname === '/api/chats/messages' && request.method === 'GET') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const chatId = url.searchParams.get('chat_id');
        // verify ownership
        const cr = await fetch(`${env.SUPABASE_URL}/rest/v1/ai_chats?id=eq.${chatId}&user_id=eq.${user.id}&select=id`, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        });
        const ck = await cr.json();
        if (!ck?.length) return json({ error: 'Not found' }, 404);
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/ai_messages?chat_id=eq.${chatId}&order=created_at.asc&select=*`, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        });
        const data = await r.json();
        return json(data);
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/chat/react ─────────────────────────────────
    // Save a message reaction
    if (url.pathname === '/api/chat/react' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const { message_id, emoji } = await request.json();
        await fetch(`${env.SUPABASE_URL}/rest/v1/message_reactions`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({ message_id, user_id: user.id, emoji })
        });
        return json({ ok: true });
      } catch(err) { return json({ error: err.message }, 500); }
    }

    // ── Static assets ────────────────────────────────────────
    try {
      return await env.ASSETS.fetch(request);
    } catch(e) {
      return new Response('Not found', { status: 404 });
    }
  }
};
