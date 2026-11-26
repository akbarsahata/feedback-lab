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

PROTOCOL = 2
RUNNER_ARTIFACT = "native-python-runner/2"
STARTED_AT = time.monotonic()
MAX_SOURCE_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_ACTUAL_BYTES = 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024
MAX_DEPTH = 64
MAX_DIAGNOSTIC = 2000
SUBMISSION_CHILD = Path(__file__).with_name("submission_child.py")


class JobError(ValueError):
    pass


def validate_job(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("job must be an object")
    if raw.get("protocol") != PROTOCOL:
        raise JobError("unsupported protocol")
    for field in ("runId", "testId", "source", "pythonRelease", "runnerArtifact"):
        if not isinstance(raw.get(field), str) or raw[field] == "":
            raise JobError(f"{field} must be a non-empty string")
    if raw["runnerArtifact"] != RUNNER_ARTIFACT:
        raise JobError("runnerArtifact does not match this runner")
    if raw["pythonRelease"] != platform.python_version():
        raise JobError("pythonRelease does not match this runner")
    format = raw.get("format")
    if format not in ("function", "script"):
        raise JobError("format must be function or script")
    if format == "script":
        if not isinstance(raw.get("stdin"), str):
            raise JobError("stdin must be a string")
        for field in ("entryPoint", "argumentsJson"):
            if field in raw:
                raise JobError(f"{field} must not be present for a script job")
    else:
        for field in ("entryPoint", "argumentsJson"):
            if not isinstance(raw.get(field), str) or raw[field] == "":
                raise JobError(f"{field} must be a non-empty string")
        if "stdin" in raw:
            raise JobError("stdin must not be present for a function job")
        try:
            arguments = json.loads(raw["argumentsJson"])
        except json.JSONDecodeError as error:
            raise JobError(f"argumentsJson is not valid JSON: {error}") from error
        if not isinstance(arguments, list):
            raise JobError("argumentsJson must encode a JSON array")
    source = raw["source"]
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise JobError("source exceeds the 64 KiB limit")
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
        format = job["format"]
        submission_job: dict[str, Any] = {
            "format": format,
            "sourcePath": str(source_path),
        }
        if format == "script":
            submission_job["stdin"] = job["stdin"]
        else:
            submission_job["entryPoint"] = job["entryPoint"]
            submission_job["arguments"] = json.loads(job["argumentsJson"])
        job_path.write_text(
            json.dumps(submission_job, ensure_ascii=False),
            encoding="utf-8",
        )
        return finish_job(job, limits, work, warm)


def finish_job(
    job: dict[str, Any],
    limits: dict[str, int],
    work: str,
    warm: bool,
) -> dict[str, Any]:
    job_path = Path(work) / "job.json"
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
    result_read, result_write = os.pipe()
    is_script = job["format"] == "script"
    stdin_read: int | None = None
    stdin_write: int | None = None
    if is_script:
        stdin_read, stdin_write = os.pipe()
    command = [
        sys.executable,
        "-I",
        "-B",
        str(SUBMISSION_CHILD),
        str(job_path),
        str(result_write),
    ]
    # The execution clock starts after isolation setup and before any
    # submission code can run. Trusted interpreter startup is part of the
    # per-test wall-clock limit; the image precompiles bytecode to keep it
    # small on the basic container.
    started = time.monotonic()
    try:
        process = subprocess.Popen(
            command,
            cwd=work,
            env=environment,
            stdin=stdin_read if stdin_read is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(result_write,),
            start_new_session=True,
            preexec_fn=lambda: apply_limits(limits),
        )
    except BaseException:
        for fd in (result_read, result_write, stdin_read, stdin_write):
            close_fd(fd)
        raise
    close_fd(result_write)
    close_fd(stdin_read)
    stdin_data = job["stdin"].encode("utf-8") if is_script else b""
    try:
        captured = capture(
            process,
            result_fd=result_read,
            stdin_fd=stdin_write,
            stdin_data=stdin_data,
            execution_seconds=limits["executionMs"] / 1000,
            output_bytes=limits["outputBytes"],
            memory_bytes=limits["memoryMiB"] * 1024 * 1024,
        )
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    execution_ms = int((time.monotonic() - started) * 1000)

    result: dict[str, Any] | None = None
    if captured["result_bytes"]:
        try:
            decoded = json.loads(captured["result_bytes"].decode("utf-8"))
            if isinstance(decoded, dict):
                result = decoded
        except (UnicodeDecodeError, json.JSONDecodeError):
            result = None

    stdout_bytes = captured["stdout_bytes"]
    stderr_bytes = captured["stderr_bytes"]
    captured_bytes = len(stdout_bytes) + len(stderr_bytes)
    stdout_valid = valid_utf8(stdout_bytes)
    stderr_valid = valid_utf8(stderr_bytes)
    stdout = stdout_bytes.decode("utf-8", "replace")
    stderr = stderr_bytes.decode("utf-8", "replace")
    truncated = captured["truncated"]
    if not is_script:
        # Keep the existing function output preview budget.
        stdout, stderr, preview_trimmed = cap_decoded_output(stdout, stderr, limits["outputBytes"])
        truncated = truncated or preview_trimmed
    common = {
        "protocol": PROTOCOL,
        "format": job["format"],
        "runId": job["runId"],
        "testId": job["testId"],
        "runnerArtifact": RUNNER_ARTIFACT,
        "stdout": stdout,
        "stderr": stderr,
        "stdoutValid": stdout_valid,
        "stderrValid": stderr_valid,
        "outputTruncated": truncated,
        "executionMs": execution_ms,
        "warm": warm,
    }
    if is_script:
        common["capturedOutputBytes"] = captured_bytes

    if captured["output_limit"]:
        return common | {
            "outcome": "output_limit",
            "diagnostic": (
                "The combined standard output and standard error reached the configured cap "
                f"({captured_bytes} bytes captured)."
            ),
        }
    if captured["timed_out"]:
        return common | {
            "outcome": "timed_out",
            "diagnostic": (
                "The execution reached the configured time limit "
                f"(peak memory {captured['peak_memory'] // (1024 * 1024)} MiB, "
                f"{captured_bytes} output bytes captured, "
                f"{captured['leftover']} leftover processes{leftover_detail(captured['leftover_pids'])})."
            ),
        }
    if captured["memory_limited"] or captured["peak_memory"] >= limits["memoryMiB"] * 1024 * 1024:
        return common | {
            "outcome": "memory_limit",
            "diagnostic": "The execution reached the configured memory limit.",
        }
    if captured["result_error"] is not None:
        return common | {
            "outcome": "execution_error",
            "diagnostic": captured["result_error"],
        }
    if process.returncode != 0:
        return common | {
            "outcome": "execution_error",
            "diagnostic": f"The execution process exited with code {process.returncode}.",
        }
    if result is None:
        if is_script:
            # An abrupt os._exit(0) bypasses the envelope. A zero exit is not
            # a submission-caused failure; the captured stdout is still
            # evidence.
            return common | {"outcome": "completed"}
        return common | {
            "outcome": "execution_error",
            "diagnostic": "The execution ended without a readable result.",
        }
    if result.get("memoryError") is True and sys.platform.startswith("linux"):
        return common | {
            "outcome": "memory_limit",
            "diagnostic": "The execution reached the configured memory limit.",
        }
    if result.get("outcome") == "execution_error":
        return common | {
            "outcome": "execution_error",
            "diagnostic": bounded(str(result.get("diagnostic", "Execution failed."))),
        }
    if result.get("outcome") != "completed":
        return common | {
            "outcome": "execution_error",
            "diagnostic": "The execution returned an unusable result.",
        }
    if is_script:
        return common | {"outcome": "completed"}
    if "actual" not in result:
        return common | {
            "outcome": "execution_error",
            "diagnostic": "The execution returned an unusable result.",
        }
    return common | {"outcome": "completed", "actual": result["actual"]}


def apply_limits(limits: dict[str, int]) -> None:
    import resource

    memory = limits["memoryMiB"] * 1024 * 1024
    cpu_seconds = max(1, math.ceil(limits["executionMs"] / 1000) + 1)
    linux = sys.platform.startswith("linux")
    # The memory cap is the evidence that lets the runner report a confirmed
    # memory-limit outcome. Fail closed when the hosted Linux host cannot
    # enforce it rather than silently degrading to an unconfined test.
    set_limit(resource, "RLIMIT_AS", memory, memory, required=linux)
    set_limit(resource, "RLIMIT_CPU", cpu_seconds, cpu_seconds + 1)
    set_limit(resource, "RLIMIT_FSIZE", 1024 * 1024, 1024 * 1024)
    set_limit(resource, "RLIMIT_NOFILE", 64, 64)
    if linux:
        set_limit(resource, "RLIMIT_NPROC", 256, 256)


def set_limit(
    resource: Any, name: str, soft: int, hard: int, *, required: bool = False
) -> None:
    limit = getattr(resource, name, None)
    if limit is None:
        if required:
            raise RuntimeError(f"{name} is unavailable on this host")
        return
    try:
        resource.setrlimit(limit, (soft, hard))
    except (OSError, ValueError) as error:
        # macOS does not support every Linux limit. On Linux the required
        # memory limit must be enforceable.
        if required:
            raise RuntimeError(f"{name} could not be enforced") from error
        return


def close_fd(fd: int | None) -> None:
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        pass


def capture(
    process: subprocess.Popen[bytes],
    *,
    result_fd: int,
    stdin_fd: int | None,
    stdin_data: bytes,
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
    result = bytearray()
    result_error: str | None = None
    open_streams = 2
    stdin_view = memoryview(stdin_data) if stdin_fd is not None else None
    os.set_blocking(result_fd, False)
    selector.register(result_fd, selectors.EVENT_READ)
    if stdin_fd is not None:
        os.set_blocking(stdin_fd, False)
        if stdin_view:
            selector.register(stdin_fd, selectors.EVENT_WRITE)
        else:
            close_fd(stdin_fd)
            stdin_fd = None
    deadline = time.monotonic() + execution_seconds
    timed_out = False
    output_limit = False
    memory_limited = False
    peak_memory = 0
    next_memory_check = 0.0

    # Keep observing until the whole process tree has exited and its output
    # pipes are closed. A submission can close its pipes and keep running; that
    # must still hit the wall-clock deadline.
    while process.poll() is None or open_streams > 0 or result_fd is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            kill_group(process)
            break
        # Scanning /proc is expensive for the 0.25 vCPU container. A 100 ms
        # cadence preserves the aggregate memory cap without starving the
        # submission under the 2 s execution deadline.
        now = time.monotonic()
        if now >= next_memory_check:
            peak_memory = max(peak_memory, process_tree_rss(process.pid))
            next_memory_check = now + 0.1
        if peak_memory >= memory_bytes:
            memory_limited = True
            kill_group(process)
            break
        if process.poll() is not None and stdin_fd is not None:
            selector.unregister(stdin_fd)
            close_fd(stdin_fd)
            stdin_fd = None
            stdin_view = None
        events = selector.select(min(0.02, remaining))
        for key, _ in events:
            stream = key.fileobj
            if stdin_fd is not None and stream == stdin_fd:
                assert stdin_view is not None
                try:
                    written = os.write(stdin_fd, stdin_view[:65536])
                except BlockingIOError:
                    continue
                except OSError:
                    written = 0
                stdin_view = stdin_view[written:]
                if written == 0 or not stdin_view:
                    selector.unregister(stdin_fd)
                    close_fd(stdin_fd)
                    stdin_fd = None
                    stdin_view = None
                continue
            if result_fd is not None and stream == result_fd:
                try:
                    chunk = os.read(result_fd, 8192)
                except BlockingIOError:
                    continue
                except OSError:
                    chunk = b""
                if not chunk:
                    selector.unregister(result_fd)
                    close_fd(result_fd)
                    result_fd = None
                    continue
                result.extend(chunk)
                if len(result) > MAX_RESULT_BYTES:
                    result_error = (
                        "The submission result exceeded the "
                        f"{MAX_RESULT_BYTES // (1024 * 1024)} MiB envelope limit."
                    )
                    kill_group(process)
                    break
                continue
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
        if output_limit or result_error is not None:
            break
        if process.poll() is not None and not selector.get_map():
            break

    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        kill_group(process)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    reap_orphans()
    selector.close()
    close_fd(stdin_fd)
    close_fd(result_fd)
    for stream in (process.stdout, process.stderr):
        try:
            stream.close()
        except OSError:
            pass
    leftover_pids = process_group_members(process.pid)
    return {
        "stdout_bytes": bytes(buffers[process.stdout])
        if process.stdout in buffers else b"",
        "stderr_bytes": bytes(buffers[process.stderr])
        if process.stderr in buffers else b"",
        "result_bytes": bytes(result),
        "result_error": result_error,
        "truncated": timed_out or output_limit or memory_limited or result_error is not None,
        "timed_out": timed_out,
        "output_limit": output_limit,
        "memory_limited": memory_limited,
        "peak_memory": peak_memory,
        "leftover": len(leftover_pids),
        "leftover_pids": leftover_pids,
    }


def leftover_detail(pids: list[int]) -> str:
    if not pids:
        return ""
    details = []
    for pid in pids[:3]:
        try:
            comm = (Path("/proc") / str(pid) / "comm").read_text(errors="ignore").strip()
            stat = (Path("/proc") / str(pid) / "stat").read_text(errors="ignore")
            closing = stat.rfind(")")
            state = stat[closing + 2 : closing + 3] if closing != -1 else "?"
        except OSError:
            comm, state = "?", "?"
        details.append(f"{pid}:{comm}:{state}")
    return f" ({', '.join(details)})"


def valid_utf8(data: bytes) -> bool:
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def cap_decoded_output(stdout: str, stderr: str, limit: int) -> tuple[str, str, bool]:
    """Keep the decoded output within the byte cap after replacement decoding.

    Invalid UTF-8 bytes can expand to U+FFFD. Trimming on a character boundary
    keeps the Worker's byte validation from rejecting otherwise usable partial
    evidence.
    """
    encoded_stdout = stdout.encode("utf-8")
    encoded_stderr = stderr.encode("utf-8")
    if len(encoded_stdout) + len(encoded_stderr) <= limit:
        return stdout, stderr, False
    stderr_budget = min(len(encoded_stderr), limit // 4)
    stdout_budget = limit - stderr_budget
    if len(encoded_stdout) < stdout_budget:
        stdout_budget = len(encoded_stdout)
        stderr_budget = limit - stdout_budget
    trimmed_stdout = encoded_stdout[:stdout_budget].decode("utf-8", "ignore")
    trimmed_stderr = encoded_stderr[:stderr_budget].decode("utf-8", "ignore")
    return trimmed_stdout, trimmed_stderr, True


def kill_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    # killpg can be unavailable or fail in a sandbox. Scan /proc so no
    # surviving child keeps consuming the container's CPU or output pipes.
    for pid in process_group_members(process.pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        # The direct child may remain a zombie until wait(); zombies consume
        # no CPU, so only live descendants extend the deadline.
        remaining = [
            pid
            for pid in process_group_members(process.pid)
            if pid != process.pid and process_state(pid) != "Z"
        ]
        if not remaining:
            return
        time.sleep(0.02)


def process_state(pid: int) -> str:
    try:
        stat = (Path("/proc") / str(pid) / "stat").read_text(errors="ignore")
    except OSError:
        return "?"
    closing = stat.rfind(")")
    return stat[closing + 2 : closing + 3] if closing != -1 else "?"


def reap_orphans() -> None:
    # The server is PID 1 in the container. Reap adopted children so timed-out
    # tests do not accumulate zombies across runs.
    if os.getpid() != 1:
        return
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def process_group_members(pgid: int) -> list[int]:
    root = Path("/proc")
    if not root.is_dir():
        return []
    members: list[int] = []
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text(errors="ignore")
        except OSError:
            continue
        closing = stat.rfind(")")
        if closing == -1:
            continue
        fields = stat[closing + 2 :].split()
        if len(fields) >= 3 and int(fields[2]) == pgid:
            pid = int(entry.name)
            if pid != os.getpid():
                members.append(pid)
    return members


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
                startup_ms = int((time.monotonic() - STARTED_AT) * 1000)
                result = execute_job(job, state["warm"])
            except Exception as error:  # pragma: no cover - defensive boundary
                self.respond(
                    500,
                    {"error": "runner_failure", "message": bounded(f"{type(error).__name__}: {error}")},
                )
                return
            state["warm"] = True
            if cold:
                result["startupMs"] = startup_ms
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
    while True:
        server.handle_request()
        reap_orphans()


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
