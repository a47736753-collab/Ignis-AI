"""Shared helpers for the IGNIS AI browser (Playwright) tests. Requires: pip install playwright && playwright install chromium"""
import os, subprocess, sys, time, json, random, urllib.request
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HEADER = "zone_id,date,temp_c,humidity_pct,wind_kmh,ndvi,fire_history"
ZONES = [r + str(c) for r in "ABCD" for c in range(1, 7)]

def make_csv(days, fn, start=(2026, 11, 10)):
    import datetime
    d0 = datetime.date(*start)
    lines = [HEADER]
    for d in range(days):
        for z in ZONES:
            lines.append(",".join([z, (d0 + datetime.timedelta(days=d)).isoformat()] + [str(x) for x in fn(z, d)]))
    return "\n".join(lines) + "\n"

class Stack:
    """Starts the mock Supabase + the real server on random ports."""
    def __init__(self, with_supabase=True, extra_env=None, with_groq=False):
        self.procs = []
        self.groq_base = None
        env = dict(os.environ)
        self.port = random.randint(21000, 39000)
        env.update({"PORT": str(self.port), "DATABASE_URL": "", "GROQ_API_KEY": "", "UPLOAD_RATE_LIMIT": "5000"})
        if with_supabase:
            sb = subprocess.Popen(["node", os.path.join(ROOT, "tests", "e2e", "mock-supabase.js")], stdout=subprocess.PIPE, text=True)
            self.procs.append(sb)
            sbport = sb.stdout.readline().strip()
            env.update({"SUPABASE_URL": "http://127.0.0.1:" + sbport, "SUPABASE_ANON_KEY": "anon-test"})
        else:
            env.pop("SUPABASE_URL", None); env.pop("SUPABASE_ANON_KEY", None)
        if with_groq:
            gq = subprocess.Popen(["node", os.path.join(ROOT, "tests", "e2e", "mock-groq.js")], stdout=subprocess.PIPE, text=True)
            self.procs.append(gq)
            self.groq_base = "http://127.0.0.1:" + gq.stdout.readline().strip()
            env.update({"GROQ_API_KEY": "test-key", "GROQ_BASE_URL": self.groq_base})
        env.update(extra_env or {})
        self.procs.append(subprocess.Popen(["node", os.path.join(ROOT, "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        self.base = "http://127.0.0.1:%d" % self.port
        for _ in range(60):
            try:
                urllib.request.urlopen(self.base + "/api/config", timeout=1); break
            except Exception:
                time.sleep(0.15)
        else:
            raise RuntimeError("server did not start")
    def groq_last(self):
        return json.loads(urllib.request.urlopen(self.groq_base + "/__last").read())
    def groq_fail(self, status):
        req = urllib.request.Request(self.groq_base + "/__fail", data=json.dumps({"status": status}).encode(), method="POST"); urllib.request.urlopen(req).read()
    def stop(self):
        for p in self.procs:
            p.terminate()

STUB = open(os.path.join(os.path.dirname(__file__), "supabase-stub.js")).read()

def new_page(browser, stack, width=1280, height=900, stub=True):
    ctx = browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    def on_console(m):
        if m.type == "error" and "ERR_" not in m.text and "Failed to load resource" not in m.text:
            errors.append("console: " + m.text)
    page.on("console", on_console)
    # external CDNs/fonts are unreachable in the sandbox; stub supabase-js, ignore the rest
    page.route("**/@supabase/supabase-js**", lambda r: r.fulfill(body=STUB if stub else "", content_type="text/javascript"))
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
    return ctx, page, errors
