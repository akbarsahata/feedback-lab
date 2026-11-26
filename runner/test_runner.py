"""Contract tests for the native Python runner.

Run with `python3 -m unittest discover -s runner -p 'test_*.py'` from the
repository root.
"""

from __future__ import annotations

import json
import platform
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

import runner


LIMITS = {"executionMs": 1500, "memoryMiB": 128, "outputBytes": 4096}


def job(source: str, *, arguments: object = None, limits: dict | None = None) -> dict:
    return {
        "protocol": runner.PROTOCOL,
        "format": "function",
        "runId": "run-1",
        "testId": "test-1",
        "entryPoint": "answer",
        "source": source,
        "argumentsJson": json.dumps(arguments if arguments is not None else []),
        "pythonRelease": platform.python_version(),
        "runnerArtifact": runner.RUNNER_ARTIFACT,
        "limits": limits or dict(LIMITS),
    }


def script_job(
    source: str,
    stdin: str = "",
    *,
    limits: dict | None = None,
) -> dict:
    return {
        "protocol": runner.PROTOCOL,
        "format": "script",
        "runId": "run-script",
        "testId": "test-script",
        "source": source,
        "stdin": stdin,
        "pythonRelease": platform.python_version(),
        "runnerArtifact": runner.RUNNER_ARTIFACT,
        "limits": limits or dict(LIMITS),
    }


class RunnerContractTests(unittest.TestCase):
    def run_job(self, source: str, **kwargs) -> dict:
        return runner.execute_job(job(source, **kwargs), warm=False)

    def test_returns_tagged_values_without_flattening_numeric_kinds(self) -> None:
        result = self.run_job(
            "def answer(x):\n"
            "    print('out')\n"
            "    print('err', file=__import__('sys').stderr)\n"
            "    return {'a': [x, 1.5, None, True]}\n",
            arguments=[4],
        )
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"], "out\n")
        self.assertEqual(result["stderr"], "err\n")
        value = result["actual"]["entries"][0]["value"]["items"]
        self.assertEqual(value[0], {"kind": "int", "value": "4"})
        self.assertEqual(value[1], {"kind": "float", "value": "1.5"})
        self.assertEqual(value[2], {"kind": "none"})
        self.assertEqual(value[3], {"kind": "bool", "value": True})

    def test_none_is_a_real_return_value(self) -> None:
        result = self.run_job("def answer():\n    return None\n")
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["actual"], {"kind": "none"})

    def test_syntax_error_is_an_execution_error(self) -> None:
        result = self.run_job("def answer(:\n    return 1\n")
        self.assertEqual(result["outcome"], "execution_error")
        self.assertIn("SyntaxError", result["diagnostic"])

    def test_missing_entry_point_is_an_execution_error(self) -> None:
        result = self.run_job("def something_else():\n    return 1\n")
        self.assertEqual(result["outcome"], "execution_error")
        self.assertIn("AttributeError", result["diagnostic"])

    def test_raised_exception_is_an_execution_error(self) -> None:
        result = self.run_job("def answer():\n    raise ValueError('bad input')\n")
        self.assertEqual(result["outcome"], "execution_error")
        self.assertIn("ValueError: bad input", result["diagnostic"])

    def test_recursion_is_an_execution_error(self) -> None:
        result = self.run_job(
            "def answer(n=0):\n    return answer(n + 1)\n",
        )
        self.assertEqual(result["outcome"], "execution_error")
        self.assertIn("RecursionError", result["diagnostic"])

    def test_timeout_stops_the_execution(self) -> None:
        started = time.monotonic()
        result = self.run_job(
            "import time\ndef answer():\n    time.sleep(5)\n",
            limits={**LIMITS, "executionMs": 150},
        )
        self.assertEqual(result["outcome"], "timed_out")
        self.assertLess(time.monotonic() - started, 3)

    def test_timeout_kills_child_processes(self) -> None:
        started = time.monotonic()
        result = self.run_job(
            "import subprocess, sys, time\n"
            "def answer():\n"
            "    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'])\n"
            "    time.sleep(10)\n",
            limits={**LIMITS, "executionMs": 150},
        )
        self.assertEqual(result["outcome"], "timed_out")
        self.assertLess(time.monotonic() - started, 3)

    def test_output_cap_retains_partial_output(self) -> None:
        result = self.run_job(
            "def answer():\n"
            "    for _ in range(100000):\n"
            "        print('x' * 100)\n",
            limits={**LIMITS, "outputBytes": 512},
        )
        self.assertEqual(result["outcome"], "output_limit")
        self.assertTrue(result["outputTruncated"])
        self.assertLessEqual(len(result["stdout"].encode()), 512)

    def test_invalid_output_bytes_stay_within_the_decoded_cap(self) -> None:
        result = self.run_job(
            "import sys\n"
            "def answer():\n"
            "    sys.stdout.buffer.write(b'\\xff' * 4000)\n"
            "    return None\n",
            limits={**LIMITS, "outputBytes": 512},
        )
        self.assertEqual(result["outcome"], "output_limit")
        self.assertLessEqual(
            len(result["stdout"].encode("utf-8")) + len(result["stderr"].encode("utf-8")),
            512,
        )

    def test_unsupported_return_is_an_execution_error(self) -> None:
        result = self.run_job("def answer():\n    return {1, 2}\n")
        self.assertEqual(result["outcome"], "execution_error")
        self.assertIn("unsupported return type", result["diagnostic"])

    def test_cycle_is_an_execution_error(self) -> None:
        result = self.run_job(
            "def answer():\n    value = []\n    value.append(value)\n    return value\n",
        )
        self.assertEqual(result["outcome"], "execution_error")
        self.assertIn("cyclic", result["diagnostic"])

    def test_encoded_return_budget_is_enforced(self) -> None:
        result = self.run_job(
            "def answer():\n    return ['x' * 1024 for _ in range(1100)]\n",
        )
        self.assertEqual(result["outcome"], "execution_error")
        self.assertIn("1 MiB", result["diagnostic"])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux resource limit")
    def test_memory_cap_is_reported(self) -> None:
        result = self.run_job(
            "def answer():\n    return bytearray(300 * 1024 * 1024)\n",
        )
        self.assertEqual(result["outcome"], "memory_limit")

    def test_invalid_job_is_rejected(self) -> None:
        with self.assertRaises(runner.JobError):
            runner.validate_job({"protocol": 1})
        bad = job("def answer():\n    return 1\n", arguments={})
        with self.assertRaises(runner.JobError):
            runner.validate_job(bad)


class ScriptRunnerContractTests(unittest.TestCase):
    def run_job(self, source: str, stdin: str = "", **kwargs) -> dict:
        return runner.execute_job(script_job(source, stdin, **kwargs), warm=False)

    def test_executes_the_file_as_main_and_feeds_stdin_through_eof(self) -> None:
        source = (
            "import sys\n"
            "if __name__ == '__main__':\n"
            "    data = sys.stdin.buffer.read()\n"
            "    sys.stdout.buffer.write(b'main:' + data)\n"
            "    sys.stderr.write('diagnostic')\n"
        )
        stdin = "héllo\r\nno-final-line"
        result = self.run_job(source, stdin)

        self.assertEqual(result["format"], "script")
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"], f"main:{stdin}".encode("utf-8").decode("utf-8"))
        self.assertEqual(result["stderr"], "diagnostic")
        self.assertTrue(result["stdoutValid"])
        self.assertNotIn("actual", result)

    def test_full_size_utf8_stdin_round_trips_exactly(self) -> None:
        line = "λ🙂\r\n"
        stdin = line * (16 * 1024 // len(line.encode("utf-8")))
        self.assertEqual(len(stdin.encode("utf-8")), 16 * 1024)
        source = (
            "import sys\n"
            "if __name__ == '__main__':\n"
            "    sys.stdout.buffer.write(sys.stdin.buffer.read())\n"
        )
        result = self.run_job(source, stdin, limits={**LIMITS, "outputBytes": 20_000})
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"].encode("utf-8"), stdin.encode("utf-8"))
        self.assertTrue(result["stdoutValid"])

    def test_empty_input_and_empty_stdout_are_distinct_from_unavailable_output(self) -> None:
        result = self.run_job(
            "if __name__ == '__main__':\n"
            "    assert __import__('sys').stdin.read() == ''\n",
            "",
        )
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"], "")
        self.assertTrue(result["stdoutValid"])

    def test_a_script_may_leave_stdin_unread(self) -> None:
        result = self.run_job(
            "import sys\n"
            "if __name__ == '__main__':\n"
            "    print(sys.stdin.readline().strip())\n",
            "first\nsecond\n",
        )
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"], "first\n")

    def test_crlf_output_is_preserved_for_the_worker_to_compare(self) -> None:
        result = self.run_job(
            "import sys\n"
            "if __name__ == '__main__':\n"
            "    sys.stdout.buffer.write(b'7\\r\\n')\n",
        )
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"], "7\r\n")

    def test_nonzero_exit_and_unhandled_exception_are_execution_errors(self) -> None:
        system_exit = self.run_job(
            "if __name__ == '__main__':\n"
            "    raise SystemExit(3)\n",
        )
        self.assertEqual(system_exit["outcome"], "execution_error")
        self.assertIn("SystemExit", system_exit["diagnostic"])

        raised = self.run_job(
            "if __name__ == '__main__':\n"
            "    raise ValueError('bad input')\n",
        )
        self.assertEqual(raised["outcome"], "execution_error")
        self.assertIn("ValueError: bad input", raised["diagnostic"])

        abrupt = self.run_job(
            "import os\n"
            "if __name__ == '__main__':\n"
            "    os._exit(2)\n",
        )
        self.assertEqual(abrupt["outcome"], "execution_error")
        self.assertIn("code 2", abrupt["diagnostic"])

    def test_zero_exit_from_sys_exit_is_normal_completion(self) -> None:
        result = self.run_job(
            "import sys\n"
            "if __name__ == '__main__':\n"
            "    print('done')\n"
            "    sys.exit(0)\n",
        )
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"], "done\n")

    def test_invalid_utf8_stdout_is_flagged_separately_from_stderr(self) -> None:
        result = self.run_job(
            "import sys\n"
            "if __name__ == '__main__':\n"
            "    sys.stdout.buffer.write(b'\\xffnot-utf8')\n"
            "    sys.stderr.write('still valid')\n",
        )
        self.assertEqual(result["outcome"], "completed")
        self.assertFalse(result["stdoutValid"])
        self.assertIn("still valid", result["stderr"])
        self.assertLessEqual(
            len(result["stdout"].encode("utf-8")) + len(result["stderr"].encode("utf-8")),
            LIMITS["outputBytes"],
        )

    def test_lossy_stderr_preview_does_not_truncate_complete_stdout(self) -> None:
        result = self.run_job(
            "import sys\n"
            "sys.stdout.write('x' * 14000)\n"
            "sys.stderr.buffer.write(b'\\xff' * 2384)\n",
            limits={**LIMITS, "outputBytes": 16384},
        )
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["stdout"], "x" * 14000)
        self.assertEqual(result["stderr"], "\ufffd" * 2384)
        self.assertEqual(result["capturedOutputBytes"], 16384)
        self.assertTrue(result["stdoutValid"])
        self.assertFalse(result["stderrValid"])
        self.assertFalse(result["outputTruncated"])

    def test_resource_limits_take_precedence_for_scripts(self) -> None:
        timed_out = self.run_job(
            "import time\n"
            "if __name__ == '__main__':\n"
            "    time.sleep(5)\n",
            limits={**LIMITS, "executionMs": 150},
        )
        self.assertEqual(timed_out["outcome"], "timed_out")

        output = self.run_job(
            "if __name__ == '__main__':\n"
            "    for _ in range(100000):\n"
            "        print('x' * 100)\n",
            limits={**LIMITS, "outputBytes": 512},
        )
        self.assertEqual(output["outcome"], "output_limit")
        self.assertTrue(output["outputTruncated"])

    def test_invalid_script_jobs_are_rejected(self) -> None:
        mixed = script_job("print(1)")
        mixed["entryPoint"] = "main"
        with self.assertRaises(runner.JobError):
            runner.validate_job(mixed)

        missing = script_job("print(1)")
        del missing["stdin"]
        with self.assertRaises(runner.JobError):
            runner.validate_job(missing)

    def test_rejects_jobs_pinned_to_another_artifact(self) -> None:
        legacy = job("def answer():\n    return 7\n")
        legacy["protocol"] = 1
        legacy["runnerArtifact"] = "native-python-runner/1"
        with self.assertRaisesRegex(runner.JobError, "unsupported protocol"):
            runner.validate_job(legacy)
        legacy["protocol"] = runner.PROTOCOL
        with self.assertRaisesRegex(runner.JobError, "runnerArtifact"):
            runner.validate_job(legacy)

    def test_private_http_endpoint_runs_script_jobs_and_rejects_invalid_ones(self) -> None:
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        process = subprocess.Popen(
            [sys.executable, runner.__file__, "--serve", "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            health = f"http://127.0.0.1:{port}/health"
            for _ in range(100):
                try:
                    with urllib.request.urlopen(health, timeout=0.2) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.05)
            else:
                self.fail("runner HTTP endpoint did not become ready")

            payload = script_job(
                "import sys\n"
                "if __name__ == '__main__':\n"
                "    print(sys.stdin.read().strip(), file=sys.stdout)\n",
                "endpoint",
            )
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/run",
                data=json.dumps(payload).encode("utf-8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.loads(response.read().decode("utf-8"))
            self.assertEqual(result["protocol"], runner.PROTOCOL)
            self.assertEqual(result["format"], "script")
            self.assertEqual(result["outcome"], "completed")
            self.assertEqual(result["stdout"], "endpoint\n")
            self.assertTrue(result["stdoutValid"])

            invalid = script_job("print(1)")
            del invalid["stdin"]
            bad_request = urllib.request.Request(
                f"http://127.0.0.1:{port}/run",
                data=json.dumps(invalid).encode("utf-8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(bad_request, timeout=10)
            self.assertEqual(error.exception.code, 422)
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    unittest.main()
