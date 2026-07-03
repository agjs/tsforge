#!/usr/bin/env python3
"""Transparent PTY recorder — run tsforge INSIDE your real terminal and capture
the exact byte stream + real resize events (with timestamps), so the render bug
can be replayed and fixed against ground truth instead of a synthetic emulator.

Usage (from the repo root, in your VS Code/Cursor terminal):
    python3 scripts/record-tty.py

It launches tsforge normally. Reproduce the bug (e.g. the circular corner-drag),
then quit tsforge (/exit or Ctrl-D). A file `tty-capture.jsonl` is written next
to it — send that back.

It forwards your keystrokes and the terminal's real SIGWINCH to the child, so
tsforge behaves EXACTLY as it does when you run it directly; the recorder only
observes.
"""
import os, pty, sys, tty, termios, fcntl, struct, signal, select, time, json, base64

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.getcwd(), "tty-capture.jsonl")
CHILD_CMD = ["bun", "packages/core/src/cli.ts"]

def get_winsize(fd):
    try:
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
        return rows, cols
    except OSError:
        return 24, 80

def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def main():
    events = []
    t0 = time.monotonic()
    def ms():
        return int((time.monotonic() - t0) * 1000)

    pid, master = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        env = dict(os.environ)
        env["NO_UPDATE_NOTIFIER"] = "1"
        os.execvpe(CHILD_CMD[0], CHILD_CMD, env)
        os._exit(127)

    # Mirror the real terminal size onto the child, and keep it in sync.
    rows, cols = get_winsize(sys.stdin.fileno())
    set_winsize(master, rows, cols)
    events.append({"t": ms(), "k": "resize", "c": cols, "r": rows})

    winch = {"pending": False}
    def on_winch(_sig, _frm):
        winch["pending"] = True
    signal.signal(signal.SIGWINCH, on_winch)

    old = termios.tcgetattr(sys.stdin)
    try:
        tty.setraw(sys.stdin.fileno())
        while True:
            if winch["pending"]:
                winch["pending"] = False
                rows, cols = get_winsize(sys.stdin.fileno())
                set_winsize(master, rows, cols)
                events.append({"t": ms(), "k": "resize", "c": cols, "r": rows})

            try:
                r, _, _ = select.select([sys.stdin, master], [], [], 0.05)
            except InterruptedError:
                continue  # SIGWINCH interrupted select; loop re-checks pending

            if sys.stdin in r:
                data = os.read(sys.stdin.fileno(), 65536)
                if data:
                    os.write(master, data)  # forward keystrokes; not logged (privacy)

            if master in r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)   # user sees it live
                events.append({"t": ms(), "k": "out", "b": base64.b64encode(data).decode()})
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        with open(OUT, "w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")
        nres = sum(1 for e in events if e["k"] == "resize")
        sys.stdout.write(f"\r\n[recorder] wrote {len(events)} events ({nres} resizes) -> {OUT}\r\n")

if __name__ == "__main__":
    main()
