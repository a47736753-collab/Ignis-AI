"use strict";
// Tiny stand-in for Supabase's /auth/v1/user endpoint, used by the browser e2e test.
// Usage: node mock-supabase.js  (prints the port on stdout)
const http = require("http");
const users = { tokA: { id: "user-a", email: "a@example.com" }, tokB: { id: "user-b", email: "b@example.com" } };
http.createServer((req, res) => {
  const m = (req.headers.authorization || "").match(/^Bearer (\S+)$/);
  const u = m && users[m[1]];
  if (req.url === "/auth/v1/user" && u) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(u)); }
  res.writeHead(401, { "Content-Type": "application/json" }); res.end("{}");
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
