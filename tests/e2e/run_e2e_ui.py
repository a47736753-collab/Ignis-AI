"""Browser tests for hero, methodology, evidence, impact and authentication. Run: python3 tests/e2e/run_e2e_ui.py"""
import os, sys, json, re, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from e2e_lib import *
from playwright.sync_api import sync_playwright
import numpy as np
from sklearn.metrics import roc_auc_score, average_precision_score, precision_recall_curve, auc

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + ("  -> " + str(detail)[:300] if (detail and not cond) else ""))
SHOT = os.environ.get("IGNIS_SHOTS", "/tmp/shots"); os.makedirs(SHOT, exist_ok=True)

def data_dir(files):
    d = tempfile.mkdtemp(prefix="ignis-e2e-data-")
    for n, v in files.items(): open(os.path.join(d, n), "w").write(json.dumps(v))
    return d

# TEST FIXTURE ONLY (synthetic numbers) to exercise the evidence UI; never shipped in data/
rng = np.random.default_rng(5)
labels = (rng.random(500) < 0.12).astype(int)
scores = np.clip(np.round(np.where(labels == 1, 66, 42) + rng.normal(0, 17, 500)), 0, 100).astype(int)
p_, r_, _ = precision_recall_curve(labels, scores)
EXP = dict(roc=roc_auc_score(labels, scores), ap=average_precision_score(labels, scores), prauc=auc(r_, p_))
REAL = {"validation.json": {"labels": labels.tolist(), "scores": scores.tolist()}}
BT_VER = [{"name": "Fixture event", "zone": "D5", "scores": [30, 36, 44, 56, 66, 74, 81, 86], "note": "Fixture note.", "verified": True, "source": "Fixture independent record", "date": "2026-01-01", "location": "Fixture"}]

def goto_ev(page, tab):
    page.evaluate("location.hash='#evidence'"); page.wait_for_timeout(500)
    page.click('[data-evtab="%s"]' % tab); page.wait_for_timeout(300)

# ============ Stack 1: supabase + groq (no evidence files) ============
stack = Stack(with_groq=True, extra_env={"IGNIS_DATA_DIR": data_dir({})})
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx, page, errors = new_page(browser, stack)
        page.goto(stack.base, wait_until="domcontentloaded")
        stats = page.evaluate("Array.from(document.querySelectorAll('.stats .n')).map(e=>e.textContent)")
        check("hero counters show real values immediately (never 0)", stats == ["3.7M km²", "$135–150B", "9%"], stats)
        page.wait_for_timeout(3200)
        check("hero counters still correct after animations", page.evaluate("Array.from(document.querySelectorAll('.stats .n')).map(e=>e.textContent)") == ["3.7M km²", "$135–150B", "9%"])
        txt = page.inner_text(".hero")
        check("hero labels the figures as outside sources and IGNIS impact as not validated", "not results of IGNIS AI" in txt and "Not yet validated" in txt and "preliminary estimate" in txt)
        check("hero layout unchanged: headline + both original CTAs still present", "Predict before" in txt and "Explore Intelligence" in txt and "Discover how it works" in txt)
        ctx_rm = browser.new_context(reduced_motion="reduce"); prm = ctx_rm.new_page(); prm.route("**/@supabase/**", lambda r: r.fulfill(body="", content_type="text/javascript")); prm.route("**/fonts.*/**", lambda r: r.abort())
        prm.goto(stack.base, wait_until="domcontentloaded"); prm.wait_for_timeout(500)
        check("reduced-motion users also see final values", prm.evaluate("Array.from(document.querySelectorAll('.stats .n')).map(e=>e.textContent)") == ["3.7M km²", "$135–150B", "9%"])
        page.screenshot(path=SHOT + "/10_hero.png")

        body = page.evaluate("document.body.textContent")
        check("no remaining claim that a trained ML model produces the scores", "trained machine-learning model produces" not in body and "when training the model" not in body and "Train on earlier fire seasons" not in body)
        check("page states the score is NOT a trained machine-learning model", "not a trained machine-learning model" in body)

        # ---- methodology ----
        page.wait_for_timeout(500)
        m = page.evaluate("document.getElementById('sec-method').textContent")
        W = {"Temperature": 24, "Dry air": 26, "Wind speed": 12, "Dry vegetation": 22, "Fire history": 16}
        check("methodology lists the real weights from the engine", all(("%d%%" % v) in m for v in W.values()), m[:200])
        check("methodology shows the real rescale constants and thresholds", "0.26" in m and "0.55" in m and "65" in m and "40" in m)
        check("methodology names the CSV columns", all(c in m for c in ["temp_c", "humidity_pct", "wind_kmh", "ndvi", "fire_history"]))
        ex = page.evaluate("IgnisScoring.scoreFrom(34,31,11,0.46,0.6).score")
        check("worked example score equals the engine's", ("score of %d" % ex) in m, ex)
        check("methodology lists limitations incl. Sentinel-2 and local validation", "Sentinel-2" in m and "Local validation is required" in m and "Risk is not detection" in m)
        check("methodology explains Groq role incl. never sets scores", "never sets, changes or double-checks a score" in m and "briefings" in m and "operational questions" in m)
        check("Groq status shows connected when configured", "Groq connected" in page.inner_text("#methodGroqStatus") or "Groq connected" in page.evaluate("document.getElementById('methodGroqStatus').textContent"))
        leg = page.evaluate("document.getElementById('dataLegend').textContent")
        check("data legend names all five data kinds", all(k in leg for k in ["Demonstration data", "Synthetic validation samples", "User-uploaded observations", "Verified historical observations", "Measured model performance"]))
        check("legend: demo active, measured performance not yet validated", "(active)" in leg and "Not yet validated" in leg)

        # ---- evidence: synthetic sample must not read as performance ----
        goto_ev(page, "perf")
        ev = page.inner_text("#evBody"); ban = page.inner_text("#evBanner")
        check("synthetic evidence: banner + watermark say synthetic", "Synthetic validation sample" in ban and "SYNTHETIC SAMPLE" in ev)
        check("synthetic evidence: headline is 'Not yet validated', no AUC number", "Not yet validated" in ev and page.locator("#evBody .auc").count() == 0)
        check("synthetic evidence: no confusion-matrix numbers or precision/recall/F1", page.locator("#evDyn .cm").count() == 0 and page.locator("#evDyn .mchips").count() == 0)
        page.click('[data-evcurve="pr"]'); page.wait_for_timeout(200)
        check("synthetic PR view also shows no numbers", "Not yet validated" in page.inner_text("#evBody") and page.locator("#evBody .mchips").count() == 0)
        goto_ev(page, "back")
        b = page.inner_text("#evBody")
        check("backtest: labelled synthetic scenarios, not real events", "Synthetic scenarios" in b and "not real fire events" in page.inner_text("#evBanner") and "Sample fire A" in b)
        check("backtest: case-study workflow explains no-leakage replay", "without leaking the future" in b and "D-k" in b)
        page.evaluate("var s=document.querySelector('[data-ev=idx]');s.value=3;s.dispatchEvent(new Event('input',{bubbles:true}))"); page.wait_for_timeout(300)
        note = page.inner_text("#evBtNote")
        check("backtest replay reveals only information up to the selected day", "up to D-4 only" in note and "not a confirmed real event" in note, note)
        goto_ev(page, "impact")
        imp = page.inner_text("#evBody")
        check("impact: states potential benefit, assumptions and no measured claim", "potential" in imp.lower() and "not been measured" in imp and "Assumed" in imp)
        check("impact: lists all five preparedness benefits", all(k in imp for k in ["situational awareness", "pre-positioning", "Patrol prioritisation", "Village-level", "Faster decisions"]))
        check("impact: no Infinity/NaN", "Infinity" not in imp and "NaN" not in imp)
        goto_ev(page, "limits")
        lim = page.inner_text("#evBody")
        check("limits: data quality, forecast uncertainty, Sentinel-2, risk!=detection, local validation", all(k in lim for k in ["Data quality and coverage", "Weather forecast uncertainty", "Sentinel-2", "Risk is not detection", "Local validation"]))
        check("limits: validation plan makes no training claim", "expert-set, not trained" in lim and "Train on earlier" not in lim)

        # impact with a cool dataset: zero alerts must not print Infinity
        page.evaluate("location.hash='#intelligence'"); page.wait_for_selector("#dsbar"); page.click("#dsToggle")
        cool = make_csv(2, lambda z, d: [24, 70, 8, 0.72, 0.2], start=(2026, 12, 1))
        page.set_input_files("#dsFile", files=[{"name": "cool.csv", "mimeType": "text/csv", "buffer": cool.encode()}])
        page.wait_for_selector("#dsResult .dsok"); page.click("#dsConfirm"); page.wait_for_function("document.querySelector('#dsText').innerText.indexOf('cool')>=0 && document.querySelector('#plog').textContent.indexOf('Forecast ready')>=0", timeout=20000)
        check("legend marks user-uploaded as active after an upload", "User-uploaded observations" in page.evaluate("document.getElementById('dataLegend').textContent") and "(active)" in page.evaluate("document.querySelectorAll('#dataLegend > div')[2].textContent"))
        check("methodology header names the active uploaded dataset", "cool" in page.evaluate("document.getElementById('methodSource').textContent"))
        goto_ev(page, "impact")
        imp2 = page.inner_text("#evBody")
        check("impact with zero alerts: 'None', no Infinity/NaN, 2-day window", "None" in imp2 and "Infinity" not in imp2 and "NaN" not in imp2 and "2-day window" in imp2, imp2[:300])
        check("no JS errors in landing/method/evidence flows", not errors, errors)
        browser.close()
finally:
    stack.stop()

# ============ Stack 2: real labelled validation (fixture) -> metrics verified against scikit-learn ============
stack = Stack(extra_env={"IGNIS_DATA_DIR": data_dir(dict(REAL, **{"backtest.json": BT_VER}))})
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(); ctx, page, errors = new_page(browser, stack)
        page.goto(stack.base); page.wait_for_timeout(1200)
        goto_ev(page, "perf")
        ev = page.inner_text("#evBody")
        roc_txt = page.inner_text("#evBody .auc")
        check("real validation: banner says Measured with sample size", "Measured" in page.inner_text("#evBanner") and "500" in page.inner_text("#evBanner"))
        check("ROC-AUC shown equals scikit-learn", abs(float(roc_txt) - EXP["roc"]) <= 0.0051, (roc_txt, EXP["roc"]))
        page.click('[data-evcurve="pr"]'); page.wait_for_timeout(300)
        vals = page.evaluate("Array.from(document.querySelectorAll('#evBody .mchips b')).map(e=>e.textContent)")
        check("Average Precision equals scikit-learn", abs(float(vals[0]) - EXP["ap"]) <= 0.0051, (vals, EXP["ap"]))
        check("trapezoid PR-AUC equals scikit-learn and is labelled separately", abs(float(vals[1]) - EXP["prauc"]) <= 0.0051 and "PR-AUC (trapezoid)" in page.inner_text("#evBody") and "Average Precision" in page.inner_text("#evBody"), (vals, EXP["prauc"]))
        check("AP and trapezoid PR-AUC are both shown and are not the same number", vals[0] != vals[1] or abs(EXP["ap"] - EXP["prauc"]) < 0.005)
        pred = (scores >= 65).astype(int); tp = int(((pred == 1) & (labels == 1)).sum()); fp = int(((pred == 1) & (labels == 0)).sum()); fn = int(((pred == 0) & (labels == 1)).sum())
        dyn = page.inner_text("#evDyn")
        check("confusion matrix at threshold 65 matches independent count", ("\n%d\n" % tp) in ("\n" + dyn.replace("Fires caught", "\n").replace("\n\n", "\n")) or str(tp) in dyn and str(fp) in dyn and str(fn) in dyn, (tp, fp, fn, dyn[:200]))
        check("precision / recall / F1 are shown for real data", all(k in dyn for k in ["Precision", "Recall", "F1 score"]))
        goto_ev(page, "back")
        b = page.inner_text("#evBody")
        check("verified backtest names its independent source", "Verified events" in b and "Fixture independent record" in b)
        check("no JS errors with real evidence", not errors, errors)
        browser.close()
finally:
    stack.stop()

# ============ Stack 3: too little labelled data -> metrics withheld ============
stack = Stack(extra_env={"IGNIS_DATA_DIR": data_dir({"validation.json": {"labels": [0, 0, 1, 0, 1, 0, 0, 1, 0, 0], "scores": [22, 35, 71, 40, 64, 18, 52, 80, 30, 45]}})})
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(); ctx, page, errors = new_page(browser, stack)
        page.goto(stack.base); page.wait_for_timeout(1200); goto_ev(page, "perf")
        ev = page.inner_text("#evBody")
        check("10-sample validation file: metrics are withheld with a reason", "Metrics withheld" in ev and "at least 30" in ev and page.locator("#evBody .auc").count() == 0 and "Insufficient data" in page.inner_text("#evBanner"), ev[:200])
        browser.close()
finally:
    stack.stop()

# ============ Stack 4: authentication UX (Supabase stub) ============
stack = Stack()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(); ctx, page, errors = new_page(browser, stack)
        page.goto(stack.base); page.wait_for_timeout(900)
        check("hero is the first screen and offers Sign in / Get started", page.is_visible("#heroStart") and "Sign in / Get started" in page.inner_text("#heroStart") and not page.is_visible("#authModal"))
        page.click("#heroStart"); page.wait_for_selector("#authModal", state="visible")
        box = page.evaluate("(()=>{const r=document.getElementById('authModal').getBoundingClientRect();return [r.width,r.height,innerWidth,innerHeight]})()")
        check("auth opens as a dedicated full-screen step", box[0] >= box[2] - 1 and box[1] >= box[3] - 1, box)
        check("auth screen titled for sign-in", "Sign in to IGNIS AI" in page.inner_text("#authTitle"))
        page.screenshot(path=SHOT + "/11_auth_screen.png")
        page.click("#btnAuthSubmit")
        check("empty form: inline errors, nothing submitted", "valid email" in page.inner_text("#authEmailErr") and "Enter your password" in page.inner_text("#authPasswordErr") and page.get_attribute("#authEmail", "aria-invalid") == "true")
        page.fill("#authEmail", "not-an-email"); page.fill("#authPassword", "x"); page.click("#btnAuthSubmit")
        check("invalid email is rejected client-side", "valid email" in page.inner_text("#authEmailErr"))
        check("password hidden by default; Show toggles visibility", page.get_attribute("#authPassword", "type") == "password")
        page.click("#pwToggle"); check("password toggle reveals", page.get_attribute("#authPassword", "type") == "text" and page.inner_text("#pwToggle") == "Hide")
        page.click("#pwToggle"); check("password toggle hides again", page.get_attribute("#authPassword", "type") == "password")
        page.click("#tabSignUp")
        check("create-account mode changes title, button and hint", "Create your IGNIS AI account" in page.inner_text("#authTitle") and page.inner_text("#btnAuthSubmit") == "Create account" and "8 characters" in page.inner_text("#authPwHint"))
        page.fill("#authEmail", "new@example.com"); page.fill("#authPassword", "short"); page.click("#btnAuthSubmit")
        check("sign-up enforces 8+ character passwords", "at least 8" in page.inner_text("#authPasswordErr"))
        page.fill("#authPassword", "long-enough-password"); page.click("#btnAuthSubmit"); page.wait_for_timeout(500)
        check("sign-up without session tells the user to confirm email", "confirmation link" in page.inner_text("#authNotice"))
        page.click("#tabSignIn")
        page.fill("#authEmail", "a@example.com"); page.fill("#authPassword", "wrong-password"); page.click("#btnAuthSubmit")
        loading = page.evaluate("(()=>{const b=document.getElementById('btnAuthSubmit');return [b.disabled, !!b.querySelector('.spin')]})()")
        check("loading state: button disabled with spinner while signing in", loading == [True, True], loading)
        page.wait_for_function("document.getElementById('authNotice').textContent.length>0", timeout=5000)
        check("wrong password shows a friendly error and re-enables the form", "incorrect" in page.inner_text("#authNotice") and not page.evaluate("document.getElementById('btnAuthSubmit').disabled"), page.inner_text("#authNotice"))
        page.click("#btnGoogleAuth"); page.wait_for_timeout(300)
        check("Google OAuth failure is reported, not swallowed", "Google" in page.inner_text("#authNotice"))
        page.fill("#authPassword", "correct-horse-battery"); page.click("#btnAuthSubmit")
        page.wait_for_function("document.getElementById('authModal').hidden===true", timeout=5000)
        check("successful sign-in closes the screen and shows the user", page.inner_text("#authLabel").strip().lower() in ("a",) and page.get_attribute("#authAvatar", "class").find("logged") >= 0, page.inner_text("#authLabel"))
        check("success toast shown", "Signed in as a@example.com" in page.inner_text("#toast"))
        check("hero button becomes 'Open the dashboard' when signed in", page.inner_text("#heroStart") == "Open the dashboard")
        page.reload(); page.wait_for_timeout(1200)
        check("session survives a page refresh", page.inner_text("#authLabel").strip().lower() == "a" and page.inner_text("#heroStart") == "Open the dashboard", page.inner_text("#authLabel"))
        page.click("#btnAuthOpen"); page.click("#btnSignOut"); page.wait_for_timeout(400)
        check("sign-out returns to guest state with feedback", page.inner_text("#authLabel") == "Sign In" and "Signed out" in page.inner_text("#toast") and page.inner_text("#heroStart") == "Sign in / Get started")
        page.reload(); page.wait_for_timeout(1000)
        check("after sign-out a refresh stays signed out", page.inner_text("#authLabel") == "Sign In")
        page.click("#btnAuthOpen"); page.wait_for_selector("#authModal", state="visible"); page.keyboard.press("Escape")
        check("Escape closes the auth screen", page.evaluate("document.getElementById('authModal').hidden"))
        page.click("#btnAuthOpen"); page.click("#btnContinueGuest")
        page.evaluate("location.hash='#intelligence'"); page.wait_for_selector("#dsbar")
        check("guest can continue into the demo dashboard", page.is_visible("#dsbar") and "Demonstration data" in page.inner_text("#dsPill"))
        check("no JS errors in auth flows", not errors, errors)
        ctx2, mob, errs2 = new_page(browser, stack, width=390, height=844)
        mob.goto(stack.base); mob.wait_for_timeout(700); mob.click("#heroStart"); mob.wait_for_timeout(300)
        mob.screenshot(path=SHOT + "/12_auth_mobile.png")
        check("auth screen fits a 390px phone without sideways scroll", mob.evaluate("document.getElementById('authModal').scrollWidth<=innerWidth+1"))
        browser.close()
finally:
    stack.stop()

# ============ Stack 5: Supabase NOT configured -> demo-mode auth is labelled honestly ============
stack = Stack(with_supabase=False)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(); ctx, page, errors = new_page(browser, stack, stub=False)
        page.goto(stack.base); page.wait_for_timeout(900); page.click("#heroStart")
        check("without Supabase the auth screen says it is demo mode, not real authentication", "not real authentication" in page.inner_text("#authNotice") and "demo mode" in page.inner_text("#authSubtitle").lower())
        page.fill("#authEmail", "anyone@example.com"); page.fill("#authPassword", "whatever1"); page.click("#btnAuthSubmit"); page.wait_for_timeout(1500)
        check("demo sign-in is labelled and does not claim an account", "Demo mode sign-in" in page.inner_text("#toast"))
        page.evaluate("location.hash='#intelligence'"); page.wait_for_selector("#dsbar"); page.click("#dsToggle")
        page.set_input_files("#dsFile", files=[{"name": "d.csv", "mimeType": "text/csv", "buffer": make_csv(1, lambda z, d: [30, 40, 10, 0.5, 0.5]).encode()}]); page.wait_for_selector("#dsResult .dsok")
        check("demo-mode user is still told uploads are not saved", "not saved" in page.inner_text("#dsResult"))
        browser.close()
finally:
    stack.stop()

failed = [r for r in results if not r[1]]
print("\n%d checks, %d passed, %d failed" % (len(results), len(results) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
