export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET /api/config — sends Supabase config to frontend
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return new Response(JSON.stringify({
        supabaseUrl:  env.SUPABASE_URL,
        supabaseAnon: env.SUPABASE_ANON_KEY,
      }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // POST /api/chat — proxies to NVIDIA API server-side
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // Everything else — serve static assets
    return env.ASSETS.fetch(request);
  }
}
