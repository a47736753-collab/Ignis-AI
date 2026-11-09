/* Test-only replacement for @supabase/supabase-js (the CDN is not reachable from the test sandbox). */
(function () {
  var listeners = [];
  try { window.__user = JSON.parse(localStorage.getItem('stub-user') || 'null'); } catch (e) { window.__user = null; }
  window.__setUser = function (u) { window.__user = u; try { localStorage.setItem('stub-user', JSON.stringify(u)); } catch (e) {} listeners.forEach(function (f) { f(u ? "SIGNED_IN" : "SIGNED_OUT", u ? { user: u, access_token: u.token } : null); }); };
  var USERS = { "a@example.com": { id: "user-a", token: "tokA" }, "b@example.com": { id: "user-b", token: "tokB" } };
  window.supabase = { createClient: function () { return { auth: {
    getSession: function () { return Promise.resolve({ data: { session: window.__user ? { access_token: window.__user.token, user: window.__user } : null }, error: null }); },
    onAuthStateChange: function (f) { listeners.push(f); return { data: { subscription: { unsubscribe: function () {} } } }; },
    signInWithPassword: function (c) {
      var rec = USERS[c.email];
      if (!rec || c.password !== "correct-horse-battery") return new Promise(function (r) { setTimeout(function () { r({ data: {}, error: { message: "Invalid login credentials" } }); }, 150); });
      var u = { id: rec.id, email: c.email, token: rec.token, user_metadata: {} };
      return new Promise(function (r) { setTimeout(function () { window.__setUser(u); r({ data: { user: u, session: { access_token: u.token } }, error: null }); }, 150); });
    },
    signUp: function (c) { return Promise.resolve({ data: { user: { id: "new-user", email: c.email }, session: null }, error: null }); },
    signOut: function () { window.__setUser(null); return Promise.resolve({ error: null }); },
    signInWithOAuth: function () { return Promise.resolve({ error: { message: "Google sign-in is not configured in the test stub." } }); }
  } }; } };
})();
