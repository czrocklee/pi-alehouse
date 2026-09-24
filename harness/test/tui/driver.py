#!/usr/bin/env python3
"""Drive genuine Pi TUI input in a private PTY; never reload the user's Pi."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path


def read_events(report: Path) -> list[dict[str, object]]:
    # Only a newline commits a JSONL record. A partial nested object can end in
    # '}', and a concurrent read can also end inside a UTF-8 code point. Decode
    # complete byte records only; malformed committed records must still fail.
    return [json.loads(line) for line in report.read_bytes().split(b"\n")[:-1] if line.strip()]


def require_event(events: list[dict[str, object]], name: str, report: Path) -> dict[str, object]:
    event = next((event for event in events if event.get("event") == name), None)
    observed = [event.get("event") for event in events]
    assert event is not None, f"Missing {name!r}; observed {observed}; inspect {report}"
    return event


def assert_unsafe_live_reload(events: list[dict[str, object]], entry: str, report: Path) -> None:
    ready = require_event(events, "ready", report)
    assert ready["permissionPresent"] and ready["childStillExecuting"]
    reloaded = require_event(events, "reloaded", report)
    assert reloaded["outcome"] == "unsafe-live-reload"
    assert reloaded["boundary"] == "unsupported-live-owner-reload"
    assert reloaded["oldRunnerInvalidated"]
    assert reloaded["permissionReplaced"]
    assert reloaded["childStillExecuting"]
    veto = require_event(events, "shutdown-veto-attempt", report)
    assert veto["reason"] == "reload" and veto["childStillExecuting"]
    assert not veto["permissionPresent"], "expected earlier permission handler teardown"
    if entry == "command":
        assert any(event["event"] == "command-entered" for event in events)


def fixture_command(executable: str, permission: str, extension: str) -> list[str]:
    return [
        executable,
        "--offline",
        # Never prompt for or load project resources, even when the output
        # directory has an ancestor .agents/skills. Explicit extensions remain.
        "--no-approve",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        "--extension",
        permission,
        "--extension",
        extension,
        "--provider",
        "harness-fixture",
        "--model",
        "controlled",
        "--thinking",
        "off",
    ]


def run() -> None:
    executable, permission, extension, output, entry = sys.argv[1:]
    root = Path(output)
    report = root / f"tui-{entry}.jsonl"
    terminal = root / f"tui-{entry}.ansi"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
    env = {**os.environ, "TERM": "xterm-256color", "P0_TUI_REPORT": str(report), "P0_TUI_ENTRY": entry}
    command = fixture_command(executable, permission, extension)
    process = subprocess.Popen(
        command, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True
    )
    os.close(slave)
    deadline = time.monotonic() + 45
    ready_at = None
    cleaned_at = None
    sent = False
    quitting = False
    events = []
    try:
        with terminal.open("wb") as log:
            os.chmod(terminal, 0o600)
            while process.poll() is None and time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    log.write(data)
                    log.flush()
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
                if report.exists():
                    events = read_events(report)
                if ready_at is None and any(event["event"] == "ready" for event in events):
                    ready_at = time.monotonic()
                if ready_at is not None and not sent and time.monotonic() - ready_at > 0.6:
                    text = "/reload" if entry == "builtin" else "/harness-fixture-reload"
                    os.write(master, text.encode() + b"\r")
                    sent = True
                if cleaned_at is None and any(event["event"] == "fixture-cleaned" for event in events):
                    cleaned_at = time.monotonic()
                # session_start completes before TUI finishes restoring its
                # editor; input sent inside that restoration window is dropped.
                if cleaned_at is not None and not quitting and time.monotonic() - cleaned_at > 0.6:
                    os.write(master, b"/quit\r")
                    quitting = True
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired as error:
                if quitting:
                    phase = "waiting for process exit after /quit"
                elif cleaned_at is not None:
                    phase = "waiting to send /quit"
                elif sent:
                    phase = "waiting for fixture cleanup after reload"
                elif ready_at is not None:
                    phase = "waiting to send reload"
                else:
                    phase = "waiting for fixture readiness"
                observed = [event.get("event") for event in events]
                raise AssertionError(
                    f"Pi TUI {entry} timed out ({phase}); last observed events: {observed}; "
                    f"inspect {report} and {terminal}"
                ) from error
        assert process.returncode == 0, f"Pi exited {process.returncode}; inspect {terminal}"
        if report.exists():
            events = read_events(report)  # Include the final append before process exit.
        assert_unsafe_live_reload(events, entry, report)
        print(f"OBSERVED UNSAFE LIVE-OWNER RELOAD: real TUI {entry} destroyed the old environment with a live child; known unsupported boundary, never safe reload")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)


if __name__ == "__main__":
    run()
