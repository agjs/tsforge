#!/usr/bin/env python3
"""Drive the /config "add a model" flow in a REAL pty: open the settings menu,
pick "Add a model", type the fields (name, accept default baseUrl, model, empty
key), review + apply. Asserts the entry was persisted to models.json AND made
active, and that the provider was hot-swapped. Deterministic; no model needed."""
import os
import pty
import select
import struct
import fcntl
import termios
import time
import tempfile
import json
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS = os.path.join(REPO, "packages/core/scripts/config-harness.ts")


def read_until(m, marker, timeout, buf=""):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r, _, _ = select.select([m], [], [], 0.3)
        if m in r:
            try:
                d = os.read(m, 65536)
            except OSError:
                break
            if not d:
                break
            buf += d.decode("utf-8", "replace")
            if marker(buf):
                return True, buf
    return False, buf


def step(m, marker, keys, timeout=10, buf=""):
    ok, buf = read_until(m, lambda b: marker in b, timeout, buf)
    if ok and keys:
        os.write(m, keys)
    return ok, buf


def main():
    home = tempfile.mkdtemp(prefix="tsforge-cfg-")
    models_path = os.path.join(home, ".tsforge", "models.json")

    pid, m = pty.fork()
    if pid == 0:
        os.execvpe(
            "bun",
            ["bun", HARNESS],
            dict(os.environ, TSFORGE_HOME=home, TSFORGE_NO_UPDATE_CHECK="1"),
        )
        os._exit(127)
    fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    ok = True
    # Settings menu → move to "Add a model" (2nd option) and select it.
    got, buf = step(m, "Settings", b"\x1b[B\r", 30)
    print(f"  [{'PASS' if got else 'FAIL'}] /config opens the settings menu")
    ok &= got

    # Add-model text flow: name → baseUrl (accept default) → model → apiKey (empty).
    got, buf = step(m, "Name", b"e2e-model\r", 10, buf)
    print(f"  [{'PASS' if got else 'FAIL'}] add-model: Name field")
    ok &= got

    got, buf = step(m, "Base URL", b"\r", 10, buf)  # accept the default
    print(f"  [{'PASS' if got else 'FAIL'}] add-model: Base URL (default accepted)")
    ok &= got

    got, buf = step(m, "Model", b"test-model\r", 10, buf)
    print(f"  [{'PASS' if got else 'FAIL'}] add-model: Model field")
    ok &= got

    got, buf = step(m, "API key", b"\r", 10, buf)  # optional → empty
    print(f"  [{'PASS' if got else 'FAIL'}] add-model: API key (optional)")
    ok &= got

    got, buf = step(m, "Review", b"\r", 10, buf)  # apply
    print(f"  [{'PASS' if got else 'FAIL'}] review screen → apply")
    ok &= got

    got, buf = read_until(m, lambda b: "RESULT" in b, 10, buf)
    reconfigured = "RECONFIG test-model" in buf
    print(f"  [{'PASS' if reconfigured else 'FAIL'}] provider hot-swapped to the new model")
    ok &= reconfigured

    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass

    # The persisted registry: the new entry exists AND is active.
    persisted = os.path.exists(models_path)
    good = False
    if persisted:
        cfg = json.load(open(models_path))
        good = (
            cfg.get("active") == "e2e-model"
            and cfg.get("models", {}).get("e2e-model", {}).get("model") == "test-model"
        )
    print(f"  [{'PASS' if good else 'FAIL'}] models.json: e2e-model added + active   exists={persisted}")
    ok &= good

    print("\n==== RESULT:", "ALL PASS" if ok else "FAILURES", "====")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
