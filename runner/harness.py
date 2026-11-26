#!/usr/bin/env python3
"""Supervises one submission child and writes the trusted result envelope.

The harness has the evidence file descriptor; the submission child does not.
The child returns only its tagged actual value through a dedicated pipe. All
timeout, memory, and output observations remain in the trusted runner parent.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

MAX_RESULT_BYTES = 2 * 1024 * 1024
MAX_DIAGNOSTIC = 2000


def failure(message: str) -> dict:
    return {"outcome": "execution_error", "diagnostic": message[:MAX_DIAGNOSTIC]}


def read_bounded(fd: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(fd, 8192)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ValueError("submission result exceeds the 2 MiB envelope limit")
        chunks.append(chunk)
    return b"".join(chunks)


def write_result(fd: int, payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def main() -> int:
    job_path = sys.argv[1]
    evidence_fd = int(sys.argv[2])
    with open(job_path, encoding="utf-8") as handle:
        job = json.load(handle)
    is_script = job.get("format") == "script"
    read_fd, write_fd = os.pipe()
    os.set_inheritable(write_fd, True)
    child = subprocess.Popen(
        [
            sys.executable,
            "-I",
            "-B",
            os.path.join(os.path.dirname(__file__), "submission_child.py"),
            job_path,
            str(write_fd),
        ],
        stdin=subprocess.PIPE if is_script else subprocess.DEVNULL,
        stdout=None,
        stderr=None,
        pass_fds=(write_fd,),
        close_fds=True,
    )
    os.close(write_fd)
    if is_script and child.stdin is not None:
        try:
            child.stdin.write(job.get("stdin", "").encode("utf-8"))
        except BrokenPipeError:
            pass
        finally:
            try:
                child.stdin.close()
            except BrokenPipeError:
                pass
    try:
        result_bytes = read_bounded(read_fd, MAX_RESULT_BYTES)
    except ValueError as error:
        child.kill()
        write_result(evidence_fd, failure(str(error)))
        return 0
    finally:
        os.close(read_fd)
        child.wait()

    if result_bytes:
        try:
            decoded = json.loads(result_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            decoded = None
        if isinstance(decoded, dict):
            write_result(evidence_fd, decoded)
            return 0

    if is_script and child.returncode == 0:
        # An abrupt os._exit(0) bypasses the envelope. A zero exit is not a
        # submission-caused failure; the captured stdout is still evidence.
        write_result(evidence_fd, {"outcome": "completed"})
        return 0

    write_result(
        evidence_fd,
        failure(f"The submission process exited with code {child.returncode}."),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
