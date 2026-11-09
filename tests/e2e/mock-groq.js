"use strict";
// Fake Groq (OpenAI-compatible) server for tests. Records what the IGNIS server sends and can be told to fail.
const http = require("http");
let last = {}, failWith = 0;
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/__last") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(last)); }
    if (req.url === "/__fail") { failWith = Number(JSON.parse(body || "{}").status) || 0; res.writeHead(200); return res.end("{}"); }
    if (req.url === "/chat/completions") {
      const j = JSON.parse(body || "{}"); const sys = (j.messages && j.messages[0] && j.messages[0].content) || ""; const user = (j.messages && j.messages[1] && j.messages[1].content) || "{}";
      const kind = /explanation layer/.test(sys) ? "explain" : /Tactical Briefing/.test(sys) ? "briefing" : "chat";
      last[kind] = { system: sys, user: JSON.parse(user), model: j.model };
      if (failWith) { res.writeHead(failWith, { "Content-Type": "application/json" }); return res.end("{}"); }
      const out = kind === "explain" ? { explanation: "Test explanation.", factors: ["dry air"], actions: ["patrol"] }
        : kind === "briefing" ? { title: "Test briefing", threatLevel: "high", summary: "s", keyRisks: ["r"], stagedRecommendations: ["x"], briefingText: "t" }
        : { reply: "Test reply.", suggestedAction: "" };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    }
    res.writeHead(404); res.end();
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
