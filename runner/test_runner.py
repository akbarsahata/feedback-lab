"""Contract tests for the native Python runner.

Run with `python3 -m unittest discover -s runner -p 'test_*.py'` from the
repository root.
"""

from __future__ import annotations

import json
import platform
import sys
import time
import unittest

import runner


LIMITS = {"executionMs": 1500, "memoryMiB": 128, "outputBytes": 4096}


def job(source: str, *, arguments: object = None, limits: dict | None = None) -> dict:
    return {
        "protocol": 1,
        "runId": "run-1",
        "testId": "test-1",
        "entryPoint": "answer",
        "source": source,
        "argumentsJson": json.dumps(arguments if arguments is not None else []),
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


if __name__ == "__main__":
    unittest.main()
