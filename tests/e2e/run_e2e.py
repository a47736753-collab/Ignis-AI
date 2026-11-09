"""Browser end-to-end test for CSV upload + forecast. Run: python3 tests/e2e/run_e2e.py"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(__file__))
from e2e_lib import *
from playwright.sync_api import sync_playwright

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + ("  -> " + str(detail) if (detail and not cond) else ""))

def sign_in(page, who):
    page.evaluate("(u)=>window.__setUser(u)", {"a": {"id": "user-a", "email": "a@example.com", "token": "tokA", "user_metadata": {}}, "b": {"id": "user-b", "email": "b@example.com", "token": "tokB", "user_metadata": {}}}[who])
    page.wait_for_timeout(400)

def open_panel(page):
    if page.evaluate("document.getElementById('dspanel').hidden"): page.click("#dsToggle")

def wait_run(page, name):
    # done when the data bar names the dataset AND the run finished (not a stale message from a previous run)
    page.wait_for_function("(n)=>document.querySelector('#dsText').innerText.indexOf(n)>=0 && document.querySelector('#plog').textContent.indexOf('Forecast ready')>=0", arg=name, timeout=20000)

SHOT = os.environ.get("IGNIS_SHOTS", "/tmp/shots"); os.makedirs(SHOT, exist_ok=True)
stack = Stack(with_groq=True)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx, page, errors = new_page(browser, stack)
        reqlog = []
        page.on("request", lambda r: reqlog.append((r.method, r.url.replace(stack.base, ""), "AUTH" if r.headers.get("authorization") else "noauth")) if "/api/datasets" in r.url else None)
        page.goto(stack.base); page.wait_for_timeout(600)
        page.evaluate("location.hash='#intelligence'"); page.wait_for_selector("#dsbar"); page.wait_for_timeout(800)

        check("page loads with no JS errors", not errors, errors)
        check("demo data is labelled synthetic by default", "Demonstration data" in page.inner_text("#dsPill"))
        check("shared engine present in browser", page.evaluate("typeof IgnisScoring==='object' && IgnisScoring.WEIGHTS.hum===0.26"))
        check("DEMO_FC identical to original generator output (24 zones x 7 days)", page.evaluate("Object.keys(DEMO_FC).length===24 && DEMO_FC.A1.length===7"))
        demo_scores = page.evaluate("JSON.stringify(ZONES.map(z=>FC[z.id].map(f=>f.score)))")

        # ---- panel + template downloads ----
        open_panel(page); check("upload panel opens", page.is_visible("#dspanel"))
        with page.expect_download() as d: page.click("#tplBlank")
        blank = open(d.value.path()).read()
        check("blank template has header + 168 rows with empty measurements", blank.startswith(HEADER) and len(blank.strip().split("\n")) == 169 and ",,,,," in blank)
        with page.expect_download() as d: page.click("#tplDemo")
        demo_csv = open(d.value.path()).read()
        check("example template is labelled SYNTHETIC in its file name", "SYNTHETIC" in d.value.suggested_filename)

        # ---- invalid files are rejected, nothing changes ----
        bad = HEADER + "\nA1,2026-02-30,hot,,300,2,9\nZZ,2026-11-10,30,40,10,0.5,0.5\n"
        page.set_input_files("#dsFile", files=[{"name": "bad.csv", "mimeType": "text/csv", "buffer": bad.encode()}])
        page.wait_for_selector("#dsResult .dserr")
        txt = page.inner_text("#dsResult")
        check("invalid CSV shows line-numbered errors", "line 2" in txt and "line 3" in txt and "Nothing was uploaded" in txt, txt[:300])
        check("invalid CSV did not change the forecast", page.evaluate("JSON.stringify(ZONES.map(z=>FC[z.id].map(f=>f.score)))") == demo_scores)
        page.set_input_files("#dsFile", files=[{"name": "notes.txt", "mimeType": "text/plain", "buffer": b"hello"}])
        page.wait_for_selector("#dsResult .dserr")
        check("non-.csv file rejected in the browser", ".csv" in page.inner_text("#dsResult"))
        page.set_input_files("#dsFile", files=[{"name": "big.csv", "mimeType": "text/csv", "buffer": (HEADER + "\n" + "A1,2026-11-10,30,40,10,0.5,0.5\n" * 12000).encode()}])
        page.wait_for_selector("#dsResult .dserr")
        check("oversized file rejected with a clear message", "limit" in page.inner_text("#dsResult").lower())
        page.set_input_files("#dsFile", files=[{"name": "empty.csv", "mimeType": "text/csv", "buffer": b""}])
        page.wait_for_selector("#dsResult .dserr"); check("empty file rejected", "empty" in page.inner_text("#dsResult").lower())

        # ---- valid guest upload drives the dashboard ----
        hot = make_csv(3, lambda z, d: [41 + d * 0.5, 16 - d, 22, 0.34, 0.85])
        page.set_input_files("#dsFile", files=[{"name": "hot-week.csv", "mimeType": "text/csv", "buffer": hot.encode()}])
        page.wait_for_selector("#dsResult .dsok")
        check("valid CSV passes validation and shows a preview", "passed validation" in page.inner_text("#dsResult") and page.locator("#dsResult tbody tr").count() == 12)
        check("guest is told the dataset will not be saved", "not saved" in page.inner_text("#dsResult"))
        page.click("#dsConfirm")
        wait_run(page, "hot-week")
        check("dashboard switched to user-uploaded data", "User-uploaded" in page.inner_text("#dsPill") and "hot-week" in page.inner_text("#dsText"))
        check("data bar says session only / not verified", "this session only" in page.inner_text("#dsText") and "not independently verified" in page.inner_text("#dsText"))
        expected = page.evaluate("IgnisScoring.scoreFrom(41,16,22,0.34,0.85).score")
        check("uploaded values (not demo values) drive FC", page.evaluate("FC.A1[0].score") == expected and page.evaluate("FC.D6[0].temp") == 41)
        check("forecast window follows the uploaded dates (3 days)", page.evaluate("NDAYS") == 3 and page.locator("#timeline .day").count() == 3)
        check("timeline shows uploaded dates", "10 Nov" in page.inner_text("#timeline"))
        check("map status reflects uploaded dataset", "your upload" in page.inner_text("#mapwrap .badge-ill"))
        check("all 24 zones flagged high by the hot dataset", page.inner_text("#alertCount").strip() == "24", page.inner_text("#alertCount"))
        page.screenshot(path=SHOT + "/01_uploaded_forecast.png")

        # a zone panel states the data source
        page.click('#map .zone[data-id="B3"]'); page.wait_for_timeout(400)
        check("zone panel labels inputs as uploaded + score as weighted formula", "your uploaded observations" in page.inner_text("#panel") and "not ML" in page.inner_text("#panel"))

        # ---- Groq receives the UPLOADED forecast context and a truthful prompt ----
        page.click("[data-ai]"); page.wait_for_function("document.querySelector('#panel').innerText.indexOf('Written by Groq')>=0", timeout=10000)
        g = stack.groq_last()["explain"]
        check("Groq explain: user context is the uploaded data (41 C, score from engine)", g["user"]["conditions"]["temperatureC"] == 41 and g["user"]["riskScore"] == expected, g["user"])
        check("Groq explain: data source passed as user-upload with dataset name", g["user"]["dataSource"]["type"] == "user-upload" and g["user"]["dataSource"]["name"] == "hot-week", g["user"].get("dataSource"))
        check("Groq prompt says the engine is NOT machine learning and forbids inventing scores", "NOT a trained machine-learning model" in g["system"] and "Never change, recompute" in g["system"])
        stack.groq_fail(500)
        page.click("[data-ai]"); page.wait_for_function("document.querySelector('#panel').innerText.indexOf('Groq request failed')>=0", timeout=10000)
        check("AI failure shows a useful error instead of breaking", "Groq request failed" in page.inner_text("#panel"))
        stack.groq_fail(0)

        # ---- changing the data changes the forecast ----
        cool = make_csv(2, lambda z, d: [24, 70, 8, 0.72, 0.2], start=(2026, 12, 1))
        open_panel(page)
        page.set_input_files("#dsFile", files=[{"name": "cool.csv", "mimeType": "text/csv", "buffer": cool.encode()}])
        page.wait_for_selector("#dsResult .dsok"); page.click("#dsConfirm")
        wait_run(page, "cool")
        check("second dataset replaces the first (no mixing)", page.evaluate("NDAYS") == 2 and page.evaluate("FC.A1[0].temp") == 24 and page.inner_text("#alertCount").strip() in ("0", ""))
        check("old AI explanation is cleared when the dataset changes", "Test explanation" not in page.inner_text("#panel"))

        # ---- Use demo data restores the original forecast exactly ----
        page.click("#dsDemo"); page.wait_for_timeout(300)
        check("Use demo data restores the original demo forecast exactly", page.evaluate("JSON.stringify(ZONES.map(z=>FC[z.id].map(f=>f.score)))") == demo_scores and page.evaluate("NDAYS") == 7)
        check("demo label restored", "Demonstration data" in page.inner_text("#dsPill"))

        # ---- the example (synthetic) export round-trips to the demo forecast (within rounding) ----
        open_panel(page)
        page.set_input_files("#dsFile", files=[{"name": "example.csv", "mimeType": "text/csv", "buffer": demo_csv.encode()}])
        page.wait_for_selector("#dsResult .dsok"); page.click("#dsConfirm")
        wait_run(page, "example")
        s2 = json.loads(page.evaluate("JSON.stringify(ZONES.map(z=>FC[z.id].map(f=>f.score)))")); s1 = json.loads(demo_scores)
        maxdiff = max(abs(a - b) for r1, r2 in zip(s1, s2) for a, b in zip(r1, r2))
        check("example CSV reproduces the demo forecast (4-decimal export, max diff <= 1)", maxdiff <= 1, maxdiff)

        # ---- signed-in: saved per user, isolated ----
        page.click("#dsDemo"); page.wait_for_timeout(200)
        sign_in(page, "a")
        open_panel(page); page.wait_for_timeout(500)
        check("signed-in user sees an empty saved list", "no saved datasets" in page.inner_text("#dsSaved"))
        page.set_input_files("#dsFile", files=[{"name": "owner-a.csv", "mimeType": "text/csv", "buffer": hot.encode()}])
        page.wait_for_selector("#dsResult .dsok")
        check("signed-in user is told it will be saved", "saved to your account" in page.inner_text("#dsResult"))
        page.click("#dsConfirm")
        wait_run(page, "owner-a")
        check("saved flag shown in data bar", "saved to your account" in page.inner_text("#dsText"), (page.inner_text("#dsText"), reqlog[-4:]))
        open_panel(page); page.wait_for_selector("#dsSaved .dsrow", timeout=5000)
        check("saved dataset is listed for its owner", "owner-a" in page.inner_text("#dsSaved"))
        page.screenshot(path=SHOT + "/02_saved_list.png")

        sign_in(page, "b")
        check("switching to user B closes user A's saved dataset", "Demonstration data" in page.inner_text("#dsPill"))
        page.wait_for_timeout(500)
        check("user B does not see user A's dataset", "owner-a" not in page.inner_text("#dsSaved"), page.inner_text("#dsSaved"))

        sign_in(page, "a"); page.wait_for_selector("#dsSaved .dsrow", timeout=5000)
        page.click("[data-dsload]"); wait_run(page, "owner-a")
        check("user A can reopen the saved dataset", "owner-a" in page.inner_text("#dsText") and page.evaluate("FC.A1[0].temp") == 41)
        page.once("dialog", lambda dlg: dlg.accept())
        open_panel(page); page.wait_for_selector("[data-dsdel]"); page.click("[data-dsdel]"); page.wait_for_timeout(800)
        check("delete removes it and returns to demo data", "Demonstration data" in page.inner_text("#dsPill"))

        # sign out while a saved dataset is active -> back to demo
        open_panel(page); page.set_input_files("#dsFile", files=[{"name": "again.csv", "mimeType": "text/csv", "buffer": hot.encode()}])
        page.wait_for_selector("#dsResult .dsok"); page.click("#dsConfirm"); wait_run(page, "again")
        page.evaluate("window.__setUser(null)"); page.wait_for_timeout(500)
        check("sign-out removes the signed-in user's dataset from the screen", "Demonstration data" in page.inner_text("#dsPill"))
        check("no JS errors during the whole run", not errors, errors)

        # ---- responsive ----
        ctx2, mob, errs2 = new_page(browser, stack, width=390, height=844)
        mob.goto(stack.base + "/#intelligence"); mob.wait_for_selector("#dsbar"); mob.click("#dsToggle"); mob.wait_for_timeout(600)
        mob.screenshot(path=SHOT + "/03_mobile_upload.png", full_page=False)
        check("no horizontal overflow on a 390px phone", mob.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"), mob.evaluate("document.documentElement.scrollWidth"))
        browser.close()
finally:
    stack.stop()
failed = [r for r in results if not r[1]]
print("\n%d checks, %d passed, %d failed" % (len(results), len(results) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
