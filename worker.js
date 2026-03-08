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

    // ── Auth helper ──────────────────────────────────────────
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

    // ── GET /api/config ──────────────────────────────────────
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({ supabaseUrl: env.SUPABASE_URL, supabaseAnon: env.SUPABASE_ANON_KEY });
    }

    // ── POST /api/chat ───────────────────────────────────────
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const profile = await getProfile(user.id);
        if (!profile) return json({ error: 'Profile not found' }, 404);

        // Reset daily count if past midnight
        const now = new Date();
        const resetAt = new Date(profile.msgs_reset_at);
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dailyMsgs = profile.daily_msgs || 0;
        if (resetAt < todayMidnight) {
          dailyMsgs = 0;
          await patchProfile(user.id, { daily_msgs: 0, msgs_reset_at: now.toISOString() });
        }

        // Check limit
        const LIMIT = 50;
        if (profile.tier === 'free' && dailyMsgs >= LIMIT) {
          const midnight = new Date(todayMidnight.getTime() + 86400000);
          const ms = midnight - now;
          const hrs = Math.floor(ms / 3600000), mins = Math.floor((ms % 3600000) / 60000);
          return json({ error: 'limit_reached', resetIn: `${hrs}h ${mins}m` }, 429);
        }

        const body = await request.json();
        const model = profile.tier === 'pro' ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

        // Web search if requested
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
              searchContext = '\n\n[Web Search Results]\n' + sd.results.map(r => `• ${r.title}: ${r.content} (${r.url})`).join('\n') + '\n[Use these results to inform your answer. Cite sources where relevant.]\n';
            }
          } catch(_) {}
        }

        // Inject search context into system message
        const messages = body.messages.map((m, i) => {
          if (i === 0 && m.role === 'system' && searchContext) {
            return { ...m, content: m.content + searchContext };
          }
          return m;
        });

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, temperature: body.temperature || 0.7, max_tokens: body.max_tokens || 2048 })
        });
        const data = await res.json();

        // Increment count
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
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const profile = await getProfile(user.id);
        if (!profile) return json({ error: 'Profile not found' }, 404);

        // Check image limits
        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const imgReset = new Date(profile.imgs_reset_at || 0);
        let dailyImgs = imgReset < todayMidnight ? 0 : (profile.daily_imgs || 0);
        const IMG_LIMIT = profile.tier === 'pro' ? 10 : 3;

        if (dailyImgs >= IMG_LIMIT) {
          const midnight = new Date(todayMidnight.getTime() + 86400000);
          const ms = midnight - now;
          const hrs = Math.floor(ms / 3600000), mins = Math.floor((ms % 3600000) / 60000);
          return json({ error: 'img_limit_reached', resetIn: `${hrs}h ${mins}m`, limit: IMG_LIMIT }, 429);
        }

        const { prompt } = await request.json();
        if (!prompt) return json({ error: 'Prompt required' }, 400);

        // Cloudflare AI - try Flux first, fall back to stable diffusion
        const cfBase = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run`;
        const cfHeaders = { 'Authorization': `Bearer ${env.CF_AI_TOKEN}`, 'Content-Type': 'application/json' };

        const tryModel = async (modelPath, body) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 25000); // 25s timeout
          try {
            const r = await fetch(`${cfBase}/${modelPath}`, {
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
          // Fallback to stable diffusion XL
          try {
            imgRes = await tryModel('@cf/stabilityai/stable-diffusion-xl-base-1.0', { prompt });
          } catch(e) {
            return json({ error: 'Image generation timed out. Try a shorter prompt or try again.' }, 504);
          }
        }

        if (!imgRes || !imgRes.ok) {
          const errText = await imgRes?.text() || 'unknown error';
          return json({ error: 'Image generation failed: ' + errText }, 500);
        }

        // Returns image bytes — convert to base64 safely (no spread = no stack overflow)
        const imgBytes = await imgRes.arrayBuffer();
        if (!imgBytes.byteLength) return json({ error: 'Empty image returned. Try again.' }, 500);
        const uint8 = new Uint8Array(imgBytes);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);

        // Update image count
        await patchProfile(user.id, {
          daily_imgs: dailyImgs + 1,
          imgs_reset_at: imgReset < todayMidnight ? now.toISOString() : profile.imgs_reset_at
        });

        return json({ image: `data:image/jpeg;base64,${base64}`, _dailyImgs: dailyImgs + 1, limit: IMG_LIMIT });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/analyse-file ───────────────────────────────
    if (url.pathname === '/api/analyse-file' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const profile = await getProfile(user.id);
        const body = await request.json();
        const { fileContent, fileName, userQuestion } = body;
        const model = profile?.tier === 'pro' ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

        const messages = [
          { role: 'system', content: 'You are NovaAI. The user has uploaded a file for you to analyse. Read the content carefully and answer their question accurately.' },
          { role: 'user', content: `File: ${fileName}\n\nContent:\n${fileContent.slice(0, 12000)}\n\n${userQuestion || 'Please summarise and analyse this file.'}` }
        ];

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 2048 })
        });
        const data = await res.json();
        return json({ reply: data.choices?.[0]?.message?.content || 'Could not analyse file.' });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/admin/set-tier ─────────────────────────────
    if (url.pathname === '/api/admin/set-tier' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const { targetUserId, tier } = await request.json();
        if (!['free', 'pro'].includes(tier)) return json({ error: 'Invalid tier' }, 400);
        await patchProfile(targetUserId, { tier });
        return json({ success: true });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // ── GET /api/admin/users ─────────────────────────────────
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      try {
        const token = request.headers.get('X-User-Token');
        const user = await getUser(token);
        const admin = await getProfile(user?.id);
        if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403);
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=id,username,display_name,tier,daily_msgs,daily_imgs,is_admin,avatar_color&order=created_at.desc`, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        });
        return new Response(await r.text(), { headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    return env.ASSETS.fetch(request);
  }
}
