// Config is loaded at runtime from /api/config (Cloudflare Pages Function)
// No secrets are stored in this file
let SUPABASE_URL   = null;
let SUPABASE_ANON  = null;
let NVIDIA_API_KEY = null; // not needed client-side anymore
const NV_BASE      = '/api/chat'; // proxied via Cloudflare Pages Function