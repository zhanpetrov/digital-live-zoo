"""Check that the zoo is running by itself, and say so on GitHub when it is not.

Runs hourly in .github/workflows/watchdog.yml (started by the zoo-live Worker, with a GitHub cron as backup).
Checks the site, the data files the jobs write, the Worker (visitors, weather, chat) and the last run of every
workflow. Problems go into one open issue labelled "watchdog" (GitHub e-mails the repo owner); the issue is
updated only when the list of problems changes, and closed when everything is fine again.

Usage: python tools/watchdog.py            (needs GH_TOKEN and GITHUB_REPOSITORY, as in the workflow)
       python tools/watchdog.py --dry-run  (print the findings, touch no issue)
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

SITE = "https://digitallivezoo.com"
WORKER = "https://zoo-live.zhanpetrov8.workers.dev"
OWNER = "zhanpetrov"
LABEL = "watchdog"
UA = "DigitalLiveZoo-watchdog/1.0 (+https://digitallivezoo.com)"
# how old each file may get before it counts as stuck (the jobs write it every 30 min / daily)
MAX_AGE = {"activity.json": 90 * 60, "catalog.json": 36 * 3600}
WORKFLOWS = ["activity.yml", "refresh.yml", "pages.yml", "mfk.yml", "attention.yml"]

problems = []   # (title, detail)


def get(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")
    except Exception as e:
        return 0, str(e)


def age_of(iso):
    return time.time() - datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def human(sec):
    return f"{sec / 3600:.1f} h" if sec >= 3600 else f"{sec / 60:.0f} min"


def check_pages():
    for path, must in [("/", "Digital Live Zoo"), ("/field-station/", "Field Station"), ("/privacy.html", "Zoo Chat")]:
        code, body = get(SITE + path + f"?wd={int(time.time())}")
        if code != 200 or must not in body:
            problems.append((f"Page {path} is down", f"HTTP {code}; expected the text \"{must}\"."))


def check_data():
    for name, limit in MAX_AGE.items():
        code, body = get(f"{SITE}/{name}?wd={int(time.time())}")
        try:
            updated = json.loads(body)["updated"]
            age = age_of(updated)
        except Exception:
            problems.append((f"{name} can't be read", f"HTTP {code}."))
            continue
        if age > limit:
            problems.append((f"{name} is {human(age)} old", f"Last updated {updated}; it should be at most {human(limit)} old. "
                             "The job that writes it is not running or keeps failing."))


def check_worker():
    code, body = get(WORKER + "/", {"Origin": SITE})
    try:
        if "now" not in json.loads(body):
            raise ValueError
    except Exception:
        problems.append(("Visitor numbers are down", f"Worker / answered HTTP {code}: {body[:200]}"))
    code, body = get(WORKER + "/weather", {"Origin": SITE})
    try:
        age = time.time() - datetime.fromisoformat(json.loads(body)["at"].replace("Z", "+00:00")).timestamp()
        if age > 3 * 3600:
            problems.append((f"Weather is {human(age)} old", "The Worker's cron trigger may have stopped."))
    except Exception:
        problems.append(("Weather is down", f"Worker /weather answered HTTP {code}: {body[:200]}"))
    # a WebSocket request with a fake bot-check token: a healthy chat answers "bot check failed"
    code, body = get(WORKER + "/chat?ts=watchdog", {"Origin": SITE, "Upgrade": "websocket", "Connection": "Upgrade",
                                                    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "d2F0Y2hkb2cgY2hlY2sh"})
    if "bot check failed" not in body:
        why = "it is switched off (CHAT_OFF = 1)" if "closed" in body else body[:200] or f"HTTP {code}"
        problems.append(("Zoo Chat is not accepting people", f"The chat answered: {why}."))


def check_workflows(repo):
    for wf in WORKFLOWS:
        out = gh(["api", f"repos/{repo}/actions/workflows/{wf}/runs?per_page=3&status=completed"], quiet=True)
        try:
            runs = json.loads(out)["workflow_runs"]
        except Exception:
            continue
        if len(runs) >= 2 and all(r["conclusion"] == "failure" for r in runs[:2]):
            problems.append((f"{wf} failed twice in a row", f"Latest run: {runs[0]['html_url']}"))


def gh(args, quiet=False, stdin=None):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True, input=stdin)
    if r.returncode and not quiet:
        print("gh", " ".join(args[:3]), "failed:", r.stderr.strip()[:300])
    return r.stdout


def report(repo, dry):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    for t, d in problems:
        print(f"PROBLEM: {t}: {d}")
    if not problems:
        print("all good")
    if dry:
        return
    found = json.loads(gh(["issue", "list", "-R", repo, "--label", LABEL, "--state", "open", "--json", "number,body"]) or "[]")
    key = "<!-- " + " | ".join(sorted(t for t, _ in problems)) + " -->"
    if problems:
        body = (f"{key}\n@{OWNER} the watchdog found {len(problems)} problem(s) at {stamp}:\n\n"
                + "\n".join(f"- **{t}**: {d}" for t, d in problems)
                + "\n\nThis issue closes itself when everything works again. "
                  "Chat emergency switch: Cloudflare, zoo-live, Settings, add variable `CHAT_OFF` = `1`.")
        if not found:
            gh(["label", "create", LABEL, "-R", repo, "--color", "d93f0b", "--description", "Opened by tools/watchdog.py"], quiet=True)
            gh(["issue", "create", "-R", repo, "--title", f"⚠️ Watchdog: {problems[0][0]}" + (f" (+{len(problems) - 1})" if len(problems) > 1 else ""),
                "--label", LABEL, "--body-file", "-"], stdin=body)
        elif not found[0]["body"].startswith(key):        # the list changed: say so once
            gh(["issue", "edit", str(found[0]["number"]), "-R", repo, "--body-file", "-"], stdin=body)
            gh(["issue", "comment", str(found[0]["number"]), "-R", repo, "--body-file", "-"], stdin=f"Changed at {stamp}:\n\n" + body.split("\n", 1)[1])
    elif found:
        for i in found:
            gh(["issue", "close", str(i["number"]), "-R", repo, "--comment", f"✅ Everything works again ({stamp})."])


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    repo = os.environ.get("GITHUB_REPOSITORY", "zhanpetrov/digital-live-zoo")
    check_pages()
    check_data()
    check_worker()
    if os.environ.get("GH_TOKEN"):
        check_workflows(repo)
    report(repo, dry)
