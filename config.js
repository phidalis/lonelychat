window.LC = window.LC || {};

LC.config = {
  appName: "Hearth Chat",
  tagline: "You don't have to be alone.",
  adminDefault: { username: "admin", email: "phidaliskipyego@gmail.com", password: "Phid@3630" },
  supabase: {
    url: "https://npuengzscsaeubhzykhz.supabase.co",
    key: "sb_publishable_Mv16aGI5ZrN363TShp8E5Q_jWWiPTbS"
  },
  mpesa: {
    // Render backend base URL. You will host basic auth + channel id there.
    // Leave empty until your Render app is live.
    baseUrl: ""
  },
  email: {
    // Render backend base URL used for Resend emails (same app as M-Pesa).
    // Leave empty to fall back to the mpesa.baseUrl above.
    baseUrl: ""
  },
  cloudinary: {
    cloudName: "dzylr1wkd",
    uploadPreset: "glowandflawless"
  }
};
