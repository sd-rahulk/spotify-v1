"""Run against the disposable local stack after the Playwright fixture upload."""
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.request import Request, build_opener, HTTPCookieProcessor
import json

ROOT = Path(os.environ.get("ANDROID_HOME", Path(os.environ["LOCALAPPDATA"]) / "Android" / "Sdk"))
ADB = ROOT / "platform-tools" / "adb.exe"
PACKAGE = "com.resonant"
ORIGIN = "http://localhost:3000"
client = build_opener(HTTPCookieProcessor(CookieJar()))


def adb(*args):
    return subprocess.check_output([str(ADB), *args], text=True, encoding="utf-8", errors="replace").strip()


def api(path, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(ORIGIN + "/gateway/api" + path, data, {
        "Origin": ORIGIN, **({"Content-Type": "application/json"} if data is not None else {}),
    }, method=method)
    with client.open(request, timeout=15) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def tree():
    result = adb("shell", "uiautomator", "dump", "/sdcard/resonant-ui.xml")
    if "ERROR:" in result:
        return None
    raw = adb("exec-out", "cat", "/sdcard/resonant-ui.xml")
    start = raw.find("<?xml")
    end = raw.rfind("</hierarchy>")
    return ET.fromstring(raw[start:end + len("</hierarchy>")]) if start >= 0 and end >= 0 else None


def wait_ui(label, seconds=24):
    expires = time.monotonic() + seconds
    while time.monotonic() < expires:
        try:
            root = tree()
            if root is not None:
                matches = [n for n in root.iter("node") if label in [n.get("text"), n.get("content-desc")]]
                if matches:
                    return max(matches, key=lambda n: (n.get("clickable") == "true", n.get("content-desc") == label))
        except (ET.ParseError, subprocess.CalledProcessError):
            pass
        time.sleep(.25)
    raise RuntimeError("Missing Android control: " + label)


def click(label, seconds=24):
    node = wait_ui(label, seconds)
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def fill(label, value):
    node = wait_ui(label)
    click(label)
    if node.get("text") and node.get("text") != node.get("hint"):
        adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", *(["KEYCODE_DEL"] * len(node.get("text"))))
    adb("shell", "input", "text", value.replace(" ", "%s"))


def launch():
    adb("shell", "am", "start", "-n", PACKAGE + "/.MainActivity")


def playing(seconds=10):
    expires = time.monotonic() + seconds
    while time.monotonic() < expires:
        status = adb("shell", "dumpsys", "media_session")
        if PACKAGE in status and re.search(r"state=PlaybackState \{state=(?:3\b|PLAYING\(3\))", status):
            return status
        time.sleep(.25)
    raise RuntimeError("Android MediaSession did not enter playing state")


def main():
    for port in [4100, 4569]:
        adb("reverse", "tcp:" + str(port), "tcp:" + str(port))
    api("/auth/login", "POST", {"password": "resonant-local-test-only"})
    launch()
    click("Settings", 70)
    root = tree()
    paired = root is not None and any(node.get("content-desc") == "Sync now" for node in root.iter("node"))
    if not paired:
        code = api("/auth/pairing-code", "POST")["code"]
        click("API URL")
        adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
        adb("shell", "input", "keyevent", *(["KEYCODE_DEL"] * 35))
        adb("shell", "input", "text", "http://localhost:4100")
        fill("Pairing code", code)
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        click("Pair device")
        wait_ui("Your library", 50)
    print("Paired device opened the SQLite-backed library.")
    click("Search")
    fill("Search library", "Night Signal")
    adb("shell", "input", "keyevent", "KEYCODE_BACK")
    click("Play Night Signal")
    playing()
    print("Paired, synced, searched and streamed the browser fixture.")
    adb("shell", "input", "keyevent", "KEYCODE_HOME")
    playing(seconds=5)
    adb("shell", "input", "keyevent", "KEYCODE_SLEEP")
    try:
        playing(seconds=3)
    finally:
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
    adb("shell", "input", "keyevent", "KEYCODE_MEDIA_PAUSE")
    time.sleep(.5)
    assert not re.search(r"state=PlaybackState \{state=(?:3\b|PLAYING\(3\))", adb("shell", "dumpsys", "media_session"))
    adb("shell", "input", "keyevent", "KEYCODE_MEDIA_PLAY")
    playing(seconds=5)
    print("Playback persisted after Home and screen-off and accepted Android media key events.")
    adb("shell", "input", "keyevent", "KEYCODE_MEDIA_PAUSE")

    playlist = next(p for p in api("/playlists")["items"] if p["name"] in ("Evening set", "Evening set revised"))
    adb("shell", "am", "force-stop", PACKAGE)
    launch()
    for _ in range(3):
        click(playlist["name"], 40)
        try:
            wait_ui("Download all", 6)
            break
        except RuntimeError:
            continue
    click("Download all")
    expected = set(playlist["trackIds"])
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        files = set(adb("shell", "run-as", PACKAGE, "ls", "files/audio").split())
        if expected and expected.issubset(files):
            break
        time.sleep(.5)
    else:
        raise RuntimeError("Playlist downloads did not verify within 40 seconds")

    adb("shell", "am", "force-stop", PACKAGE)
    private_path = adb("shell", "run-as", PACKAGE, "pwd")
    assert private_path in ("/data/user/0/" + PACKAGE, "/data/data/" + PACKAGE)
    adb("shell", "run-as", PACKAGE, "rm", "-r", "cache/stream")
    try:
        adb("reverse", "--remove", "tcp:4100")
        adb("reverse", "--remove", "tcp:4569")
        adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
        adb("shell", "svc", "wifi", "disable")
        launch()
        wait_ui("Open Now Playing", 40)
        click("Play")
        playing(seconds=10)
        print("The queue restored and played the verified file with the cache and network unavailable.")
        adb("shell", "input", "keyevent", "KEYCODE_MEDIA_PAUSE")
    finally:
        adb("shell", "cmd", "connectivity", "airplane-mode", "disable")
        adb("shell", "svc", "wifi", "enable")
        adb("reverse", "tcp:4100", "tcp:4100")
        adb("reverse", "tcp:4569", "tcp:4569")
    new_name = "Evening set" if playlist["name"] == "Evening set revised" else "Evening set revised"
    api("/playlists/" + playlist["id"], "PATCH", {"name": new_name})
    adb("shell", "am", "force-stop", PACKAGE)
    launch()
    wait_ui(new_name, 45)
    print("A dashboard API playlist edit appeared after Android reconnected.")


if __name__ == "__main__":
    main()
