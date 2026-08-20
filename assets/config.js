/* Fill these in from your Supabase project:
 *   Dashboard → Project Settings → Data API → Project URL
 *   Dashboard → Project Settings → API Keys → publishable key (sb_publishable_…)
 *
 * Both values are meant to be public. The database is protected by row level
 * security and by the consignment.app_users roles, not by hiding this key.
 * NEVER put a service_role key in this file — it bypasses every policy.
 */
window.CB_CONFIG = {
  SUPABASE_URL: 'https://qwuqzpfixfvzsehkazbs.supabase.co',
  SUPABASE_KEY: 'sb_publishable_0FW0GLnhoQ_eeWZfh5nhjg_394GSyNE',
  SCHEMA: 'consignment',
  COMPANY: 'CTG4U RETAIL SDN BHD'
};

/* A misconfigured site should say so plainly instead of failing with a stack
 * trace nobody can act on. */
window.CB_CONFIG.ready = function () {
  var c = window.CB_CONFIG;
  return c.SUPABASE_URL.indexOf('http') === 0 && c.SUPABASE_KEY.indexOf('PASTE_') !== 0;
};
