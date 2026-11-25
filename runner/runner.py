#!/usr/bin/env python3
"""Trusted native Python test runner for Feedback Lab.

One job runs one configured test. The submission executes in a fresh child
process with its own temporary working directory, a sanitized environment,
process-group timeout, memory limit, and bounded output. The runner never
receives the expected return value; the Worker performs `function-value-v1`
comparison on the trusted side.

Hosted isolation (no network, no app files, no credentials, aggregate limits
including child processes) is enforced by the container/VM boundary. This
process assumes it already runs inside that boundary.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

PROTOCOL = 1
STARTED_AT = time.monotonic()
MAX_SOURCE_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_ACTUAL_BYTES = 1024 * 1024
MAX_DEPTH = 64
MAX_DIAGNOSTIC = 2000


class JobError(ValueError):
    pass


def validate_job(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("job must be an object")
    if raw.get("protocol") != PROTOCOL:
        raise JobError("unsupported protocol")
    for field in ("runId", "testId", "entryPoint", "source", "argumentsJson",
                  "pythonRelease", "runnerArtifact"):
        if not isinstance(raw.get(field), str) or raw[field] == "":
            raise JobError(f"{field} must be a non-empty string")
    source = raw["source"]
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise JobError("source exceeds the 64 KiB limit")
    try:
        arguments = json.loads(raw["argumentsJson"])
    except json.JSONDecodeError as error:
        raise JobError(f"argumentsJson is not valid JSON: {error}") from error
    if not isinstance(arguments, list):
        raise JobError("argumentsJson must encode a JSON array")
    limits = raw.get("limits")
    if not isinstance(limits, dict):
        raise JobError("limits must be an object")
    for field in ("executionMs", "memoryMiB", "outputBytes"):
        value = limits.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise JobError(f"limits.{field} must be a positive integer")
    if limits["executionMs"] > 60_000:
        raise JobError("limits.executionMs is unreasonably large")
    if limits["memoryMiB"] > 4096:
        raise JobError("limits.memoryMiB is unreasonably large")
    if limits["outputBytes"] > 1024 * 1024:
        raise JobError("limits.outputBytes is unreasonably large")
    return raw


def execute_job(job: dict[str, Any], warm: bool) -> dict[str, Any]:
    limits = job["limits"]
    with tempfile.TemporaryDirectory(prefix="feedback-lab-test-") as work:
        work_path = Path(work)
        source_path = work_path / "submission.py"
        job_path = work_path / "job.json"
        source_path.write_text(job["source"], encoding="utf-8")
        arguments = json.loads(job["argumentsJson"])
        job_path.write_text(
            json.dumps(
                {
                    "sourcePath": str(source_path),
                    "entryPoint": job["entryPoint"],
                    "arguments": arguments,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        result_file = tempfile.TemporaryFile()
        result_fd = result_file.fileno()
        os.set_inheritable(result_fd, True)
        environment = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": work,
            "TMPDIR": work,
            "PYTHONNOUSERSITE": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONHASHSEED": "0",
            "LC_ALL": "C.UTF-8",
            "LANG": "C.UTF-8",
        }
        command = [
            sys.executable,
            "-I",
            "-B",
            str(Path(__file__).with_name("harness.py")),
            str(job_path),
            str(result_fd),
        ]
        # The execution clock starts after isolation setup and before any
        # submission code can run.
        started = time.monotonic()
        process = subprocess.Popen(
            command,
            cwd=work,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(result_fd,),
            start_new_session=True,
            preexec_fn=lambda: apply_limits(limits),
        )
        try:
            captured = capture(
                process,
                execution_seconds=limits["executionMs"] / 1000,
                output_bytes=limits["outputBytes"],
                memory_bytes=limits["memoryMiB"] * 1024 * 1024,
            )
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        execution_ms = int((time.monotonic() - started) * 1000)
        result_file.seek(0)
        result_bytes = result_file.read(MAX_ACTUAL_BYTES + MAX_DIAGNOSTIC + 4096)
        result_file.close()

    result: dict[str, Any] | None = None
    if result_bytes:
        try:
            decoded = json.loads(result_bytes.decode("utf-8"))
            if isinstance(decoded, dict):
                result = decoded
        except (UnicodeDecodeError, json.JSONDecodeError):
            result = None

    stdout, stderr = captured["stdout"], captured["stderr"]
    truncated = captured["truncated"]
    common = {
        "protocol": PROTOCOL,
        "runId": job["runId"],
        "testId": job["testId"],
        "stdout": stdout,
        "stderr": stderr,
        "outputTruncated": truncated,
        "executionMs": execution_ms,
        "warm": warm,
    }

    if captured["output_limit"]:
        return common | {
            "outcome": "output_limit",
            "diagnostic": "The combined standard output and standard error reached the configured cap.",
        }
    if captured["timed_out"]:
        return common | {
            "outcome": "timed_out",
            "diagnostic": "The execution reached the configured time limit.",
        }
    if captured["peak_memory"] >= limits["memoryMiB"] * 1024 * 1024:
        return common | {
            "outcome": "memory_limit",
            "diagnostic": "The execution reached the configured memory limit.",
        }
    if process.returncode != 0:
        return common | {
            "outcome": "execution_error",
            "diagnostic": f"The execution process exited with code {process.returncode}.",
        }
    if result is None:
        return common | {
            "outcome": "execution_error",
            "diagnostic": "The execution ended without a readable result.",
        }
    if result.get("memoryError") is True:
        return common | {
            "outcome": "memory_limit",
            "diagnostic": "The execution reached the configured memory limit.",
        }
    if result.get("outcome") == "execution_error":
        return common | {
            "outcome": "execution_error",
            "diagnostic": bounded(str(result.get("diagnostic", "Execution failed."))),
        }
    if result.get("outcome") != "completed" or "actual" not in result:
        return common | {
            "outcome": "execution_error",
            "diagnostic": "The execution returned an unusable result.",
        }
    return common | {"outcome": "completed", "actual": result["actual"]}


def apply_limits(limits: dict[str, int]) -> None:
    import resource

    memory = limits["memoryMiB"] * 1024 * 1024
    cpu_seconds = max(1, math.ceil(limits["executionMs"] / 1000) + 1)
    set_limit(resource, "RLIMIT_AS", memory, memory)
    set_limit(resource, "RLIMIT_CPU", cpu_seconds, cpu_seconds + 1)
    set_limit(resource, "RLIMIT_FSIZE", 1024 * 1024, 1024 * 1024)
    set_limit(resource, "RLIMIT_NOFILE", 64, 64)
    if sys.platform.startswith("linux"):
        set_limit(resource, "RLIMIT_NPROC", 256, 256)


def set_limit(resource: Any, name: str, soft: int, hard: int) -> None:
    limit = getattr(resource, name, None)
    if limit is None:
        return
    try:
        resource.setrlimit(limit, (soft, hard))
    except (OSError, ValueError):
        # macOS does not support every Linux limit. The hosted Linux runner
        # verifies enforcement; local execution still retains the wall clock,
        # process-group, and output controls.
        return


def capture(
    process: subprocess.Popen[bytes],
    *,
    execution_seconds: float,
    output_bytes: int,
    memory_bytes: int,
) -> dict[str, Any]:
    selector = selectors.DefaultSelector()
    assert process.stdout is not None and process.stderr is not None
    for stream in (process.stdout, process.stderr):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    buffers = {process.stdout: bytearray(), process.stderr: bytearray()}
    total = 0
    deadline = time.monotonic() + execution_seconds
    timed_out = False
    output_limit = False
    peak_memory = 0
    open_streams = 2

    while open_streams > 0:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            kill_group(process)
            break
        peak_memory = max(peak_memory, process_tree_rss(process.pid))
        if peak_memory >= memory_bytes:
            kill_group(process)
            break
        events = selector.select(min(0.02, remaining))
        for key, _ in events:
            stream = key.fileobj
            try:
                chunk = os.read(stream.fileno(), 8192)
            except BlockingIOError:
                continue
            except OSError:
                chunk = b""
            if not chunk:
                selector.unregister(stream)
                stream.close()
                open_streams -= 1
                continue
            available = output_bytes - total
            if available <= 0:
                output_limit = True
                kill_group(process)
                break
            kept = chunk[:available]
            buffers[stream].extend(kept)
            total += len(kept)
            if len(kept) < len(chunk):
                output_limit = True
                kill_group(process)
                break
        if output_limit:
            break
        if process.poll() is not None and not selector.get_map():
            break

    process.wait()
    selector.close()
    for stream in (process.stdout, process.stderr):
        try:
            stream.close()
        except OSError:
            pass
    return {
        "stdout": bytes(buffers[process.stdout]).decode("utf-8", "replace")
        if process.stdout in buffers else "",
        "stderr": bytes(buffers[process.stderr]).decode("utf-8", "replace")
        if process.stderr in buffers else "",
        "truncated": timed_out or output_limit,
        "timed_out": timed_out,
        "output_limit": output_limit,
        "peak_memory": peak_memory,
    }


def kill_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def process_tree_rss(root_pid: int) -> int:
    proc = Path("/proc")
    if not proc.is_dir():
        return 0
    children: dict[int, list[int]] = {}
    rss: dict[int, int] = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            status = (entry / "status").read_text(errors="ignore")
        except OSError:
            continue
        rss_match = None
        parent = None
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                rss_match = int(line.split()[1]) * 1024
            elif line.startswith("PPid:"):
                parent = int(line.split()[1])
        if rss_match is not None:
            rss[pid] = rss_match
        if parent is not None:
            children.setdefault(parent, []).append(pid)
    total = 0
    pending = [root_pid]
    seen = set()
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        total += rss.get(pid, 0)
        pending.extend(children.get(pid, []))
    return total


def bounded(value: str, limit: int = MAX_DIAGNOSTIC) -> str:
    return value if len(value) <= limit else value[:limit] + "..."


def serve(port: int) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer

    state = {"warm": False}

    class Handler(BaseHTTPRequestHandler):
        server_version = "FeedbackLabRunner/1"

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self.send_error(404)
                return
            payload = {
                "ok": True,
                "protocol": PROTOCOL,
                "python": platform.python_version(),
                "startupMs": None,
            }
            self.respond(200, payload)

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/run":
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                self.send_error(400)
                return
            if length <= 0 or length > MAX_REQUEST_BYTES:
                self.send_error(413)
                return
            try:
                job = validate_job(json.loads(self.rfile.read(length)))
            except (JobError, json.JSONDecodeError) as error:
                self.respond(422, {"error": "invalid_job", "message": bounded(str(error))})
                return
            if job["pythonRelease"] != platform.python_version():
                self.respond(
                    409,
                    {
                        "error": "python_release_mismatch",
                        "expected": job["pythonRelease"],
                        "actual": platform.python_version(),
                    },
                )
                return
            try:
                cold = not state["warm"]
                result = execute_job(job, state["warm"])
            except Exception as error:  # pragma: no cover - defensive boundary
                self.respond(
                    500,
                    {"error": "runner_failure", "message": bounded(f"{type(error).__name__}: {error}")},
                )
                return
            state["warm"] = True
            if cold:
                result["startupMs"] = int((time.monotonic() - STARTED_AT) * 1000)
            self.respond(200, result)

        def respond(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    server = HTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    if args.serve:
        serve(args.port)
        return 0

    try:
        raw = json.load(sys.stdin)
        job = validate_job(raw)
        result = execute_job(job, warm=False)
    except (JobError, json.JSONDecodeError) as error:
        sys.stderr.write(f"invalid job: {error}\n")
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
