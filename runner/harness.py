#!/usr/bin/env python3
"""Runs one submission call inside the isolated child process.

This process is not trusted with the expected value. It loads the submitted
source, calls the configured entry point with the saved arguments, and writes a
tagged actual value to the inherited result file descriptor. Standard output and
standard error remain the submission's output channels.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import sys
import traceback
from typing import Any

MAX_ACTUAL_BYTES = 1024 * 1024
MAX_DEPTH = 64
MAX_DIAGNOSTIC = 2000


class UnsupportedValue(Exception):
    pass


def encode(value: Any, depth: int = 0, active: set[int] | None = None) -> dict[str, Any]:
    active = active if active is not None else set()
    if value is None:
        return {"kind": "none"}
    if isinstance(value, bool):
        return {"kind": "bool", "value": value}
    if isinstance(value, int):
        return {"kind": "int", "value": str(value)}
    if isinstance(value, float):
        if not math.isfinite(value):
            raise UnsupportedValue("non-finite float")
        return {"kind": "float", "value": repr(value)}
    if isinstance(value, str):
        return {"kind": "str", "value": value}
    if isinstance(value, (list, dict)):
        if depth >= MAX_DEPTH:
            raise UnsupportedValue(f"value exceeds the {MAX_DEPTH}-level depth limit")
        identity = id(value)
        if identity in active:
            raise UnsupportedValue("cyclic value")
        active.add(identity)
        try:
            if isinstance(value, list):
                return {
                    "kind": "list",
                    "items": [encode(item, depth + 1, active) for item in value],
                }
            if not all(isinstance(key, str) for key in value):
                raise UnsupportedValue("dictionary keys must be strings")
            return {
                "kind": "dict",
                "entries": [
                    {"key": key, "value": encode(item, depth + 1, active)}
                    for key, item in value.items()
                ],
            }
        finally:
            active.remove(identity)
    raise UnsupportedValue(f"unsupported return type: {type(value).__name__}")


def write_result(fd: int, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def failure(message: str) -> dict[str, Any]:
    return {"outcome": "execution_error", "diagnostic": message[:MAX_DIAGNOSTIC]}


def main() -> int:
    job_path = sys.argv[1]
    result_fd = int(sys.argv[2])
    with open(job_path, encoding="utf-8") as handle:
        job = json.load(handle)

    # Do not leave the runner's paths in the submission's argument list.
    sys.argv = ["submission.py"]

    try:
        spec = importlib.util.spec_from_file_location("submission", job["sourcePath"])
        if spec is None or spec.loader is None:
            raise RuntimeError("submission could not be loaded")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        function = getattr(module, job["entryPoint"])
        if not callable(function):
            raise TypeError(f"{job['entryPoint']} is not callable")
        value = function(*job["arguments"])
    except MemoryError as error:
        detail = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        payload = failure(detail)
        payload["memoryError"] = True
        write_result(result_fd, payload)
        return 0
    except BaseException as error:  # SystemExit and KeyboardInterrupt are execution errors.
        detail = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        write_result(result_fd, failure(detail))
        return 0

    try:
        tagged = encode(value)
        encoded = json.dumps(tagged, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_ACTUAL_BYTES:
            raise UnsupportedValue("return value exceeds the 1 MiB encoded budget")
    except UnsupportedValue as error:
        write_result(result_fd, failure(str(error)))
        return 0

    write_result(result_fd, {"outcome": "completed", "actual": tagged})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
