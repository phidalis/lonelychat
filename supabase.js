window.LC = window.LC || {};

LC.supabaseClient = (function () {
  if (typeof supabase === "undefined") {
    console.error("supabase-js not loaded. Add the CDN script before supabase.js");
    return null;
  }
  try {
    return supabase.createClient(LC.config.supabase.url, LC.config.supabase.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  } catch (e) {
    console.error("Supabase init failed", e);
    return null;
  }
})();
