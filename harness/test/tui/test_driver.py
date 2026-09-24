#!/usr/bin/env python3
"""Offline report/launch-contract tests; never start Pi or open a PTY."""

import json
import runpy
import tempfile
import unittest
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import Mock, patch

DRIVER = runpy.run_path(str(Path(__file__).with_name("driver.py")))
read_events = DRIVER["read_events"]
require_event = DRIVER["require_event"]
assert_unsafe_live_reload = DRIVER["assert_unsafe_live_reload"]
fixture_command = DRIVER["fixture_command"]


class ReportPollingTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="harness-report-poll-")
        self.addCleanup(directory.cleanup)
        self.report = Path(directory.name) / "events.jsonl"

    def test_launch_ignores_project_resources_without_granting_trust(self) -> None:
        command = fixture_command("/fixture/pi", "/fixture/managed.ts", "/fixture/reload.mjs")
        self.assertIn("--no-approve", command)
        self.assertNotIn("--approve", command)
        self.assertIn("--no-context-files", command)
        self.assertIn("--no-extensions", command)
        self.assertEqual(command.count("--extension"), 2)
        self.assertEqual(command[command.index("--extension") + 1], "/fixture/managed.ts")

    def test_partial_nested_object_and_utf8_wait_for_newline(self) -> None:
        first = b'{"event":"ready"}\n'
        for suffix in [b'{"event":"later","nested":{}', b'{"event":"later","text":"\xe7']:
            self.report.write_bytes(first + suffix)
            self.assertEqual(read_events(self.report), [{"event": "ready"}])
        last = {"event": "later", "nested": {}, "text": "\u7532"}
        data = json.dumps(last, ensure_ascii=False).encode()
        self.report.write_bytes(first + data)
        self.assertEqual(read_events(self.report), [{"event": "ready"}])
        self.report.write_bytes(first + data + b"\n")
        self.assertEqual(read_events(self.report), [{"event": "ready"}, last])

    def test_malformed_committed_record_is_not_silently_discarded(self) -> None:
        self.report.write_bytes(b'{"event":"ready"}\n{"broken":}\n')
        with self.assertRaises(json.JSONDecodeError):
            read_events(self.report)

    def test_blank_records_are_ignored(self) -> None:
        self.report.write_bytes(b'\n \n{"event":"ready"}\n')
        self.assertEqual(read_events(self.report), [{"event": "ready"}])

    def test_missing_event_has_phase_and_report_context(self) -> None:
        events = [{"event": "ready"}]
        self.assertIs(require_event(events, "ready", self.report), events[0])
        with self.assertRaisesRegex(AssertionError, r"Missing 'reloaded'.*ready.*events\.jsonl"):
            require_event(events, "reloaded", self.report)

    def test_unsafe_live_owner_reload_facts_remain_required(self) -> None:
        events = [
            {"event": "ready", "permissionPresent": True, "childStillExecuting": True},
            {"event": "reloaded", "outcome": "unsafe-live-reload", "boundary": "unsupported-live-owner-reload",
             "oldRunnerInvalidated": True, "permissionReplaced": True, "childStillExecuting": True},
            {"event": "shutdown-veto-attempt", "reason": "reload", "childStillExecuting": True, "permissionPresent": False},
        ]
        self.assertIsNone(assert_unsafe_live_reload(events, "builtin", self.report))
        events[1]["outcome"] = "unexpected-outcome"
        with self.assertRaises(AssertionError):
            assert_unsafe_live_reload(events, "builtin", self.report)


class DriverTimeoutTests(unittest.TestCase):
    def test_timeout_reports_phase_artifacts_and_preserves_process_cleanup(self) -> None:
        run_driver = DRIVER["run"]
        namespace = run_driver.__globals__
        phases = [
            "waiting for fixture readiness",
            "waiting to send reload",
            "waiting for fixture cleanup after reload",
            "waiting to send /quit",
            "waiting for process exit after /quit",
        ]
        for entry in ["builtin", "command"]:
            for iterations, phase in enumerate(phases):
                with self.subTest(entry=entry, phase=phase), tempfile.TemporaryDirectory(prefix="harness-timeout-") as directory:
                    report = Path(directory) / f"tui-{entry}.jsonl"
                    terminal = Path(directory) / f"tui-{entry}.ansi"
                    clock = [0.0]
                    times = iter(range(1, iterations + 1))
                    process = Mock(pid=424242)
                    timeout = namespace["subprocess"].TimeoutExpired("fixture-pi", 3)
                    process.wait.side_effect = [timeout, 0]

                    def poll(clock: list[float] = clock, times: Iterator[int] = times) -> None:
                        clock[0] = float(next(times, 46))

                    def select_ready(
                        *_args: object, clock: list[float] = clock, report: Path = report
                    ) -> tuple[list[int], list[int], list[int]]:
                        events = [{"event": "ready"}]
                        if clock[0] >= 3:
                            events.append({"event": "fixture-cleaned"})
                        report.write_text("".join(json.dumps(event) + "\n" for event in events))
                        return [], [], []

                    process.poll.side_effect = poll
                    with (
                        patch.object(namespace["sys"], "argv", ["driver.py", "fixture-pi", "permission.ts", "extension.mjs", directory, entry]),
                        patch.object(namespace["pty"], "openpty", return_value=(101, 102)),
                        patch.object(namespace["fcntl"], "ioctl"),
                        patch.object(namespace["subprocess"], "Popen", return_value=process),
                        patch.object(namespace["time"], "monotonic", side_effect=lambda clock=clock: clock[0]),
                        patch.object(namespace["select"], "select", side_effect=select_ready),
                        patch.object(namespace["os"], "write") as write,
                        patch.object(namespace["os"], "close") as close,
                        patch.object(namespace["os"], "killpg") as kill,
                    ):
                        with self.assertRaises(AssertionError) as caught:
                            run_driver()
                        self.assertIn(f"Pi TUI {entry} timed out", str(caught.exception))
                        self.assertIn(phase, str(caught.exception))
                        self.assertIn(str(report), str(caught.exception))
                        self.assertIn(str(terminal), str(caught.exception))
                        observed = [] if iterations == 0 else ["ready"] + (["fixture-cleaned"] if iterations >= 3 else [])
                        self.assertIn(f"last observed events: {observed}", str(caught.exception))
                        self.assertIs(caught.exception.__cause__, timeout)
                        kill.assert_called_once_with(process.pid, namespace["signal"].SIGKILL)
                        self.assertEqual(process.wait.call_args_list, [unittest.mock.call(timeout=3), unittest.mock.call()])
                        self.assertEqual(close.call_args_list, [unittest.mock.call(102), unittest.mock.call(101)])
                        commands = [call.args[1] for call in write.call_args_list]
                        reload_command = b"/reload\r" if entry == "builtin" else b"/harness-fixture-reload\r"
                        self.assertEqual(commands, ([reload_command] if iterations >= 2 else []) + ([b"/quit\r"] if iterations >= 4 else []))


if __name__ == "__main__":
    unittest.main()
