# Native Python test runner

One job runs one configured test. The submission executes in a fresh child process with a temporary working directory, a sanitized environment, a process-group wall-clock timeout, an address-space limit, and a combined output cap. The runner has no expected value: `function-value-v1` and `script-stdout-v1` comparison happen in the trusted Worker.

Protocol 2 (`native-python-runner/2`) supports both formats. The runner rejects jobs pinned to earlier artifacts. Before switching artifacts, drain pending runs on the version they pinned.

- **Function jobs** load the source and call `entryPoint(*arguments)`, returning a tagged actual value.
- **Script jobs** execute the file with `run_name="__main__"` and supply the complete configured UTF-8 stdin byte-for-byte, then close the pipe at EOF. The Worker compares captured stdout after CRLF→LF and at most one final LF is removed. Invalid UTF-8 stdout is returned as a completed execution with `stdoutValid: false`; the Worker records it as an Execution error. Resource limits keep precedence over output interpretation.
- **Bytecode cache** is built into the image. The `python:3.12.11-slim-bookworm` base ships empty `__pycache__` directories, so without this step every process recompiles stdlib imports such as `json`, `re`, and `enum` inside the 0.25 vCPU container. Startup still counts toward the 2-second wall-clock limit; the cache keeps it small.

## Contract tests

```sh
python3 -m unittest discover -s runner -p 'test_*.py' -v
```

The memory-limit test runs only on Linux because macOS does not enforce address-space limits the same way. The runner spawns the submission child directly and drains its result envelope over a dedicated pipe; the child has no access to the runner's request socket. Script stdin is fed by the runner over a non-blocking pipe, not embedded in the submission child's argument list.

Script contract tests cover `__main__`, full-size UTF-8 stdin through EOF, empty input and output, a script that does not consume all stdin, stdin larger than the pipe buffer (consumed and ignored), CRLF output, nonzero exit, `sys.exit(0)`, abrupt `os._exit(0)`, unhandled exceptions, invalid stdout, resource limits, artifact mismatches, and the private HTTP `/health` and `/run` endpoints.

## Local one-shot

```sh
python3 runner/runner.py < job.json
```

`runner/runner.py --serve --port 8080` exposes `GET /health` and `POST /run`. The service is private to the trusted Worker and must not be exposed to a browser.

## Hosted requirements

The image is `python:3.12.11-slim-bookworm`, which pins the Python release recorded in `src/runs.ts`. The hosting boundary, not this Python process, must provide:

- no outbound network or public DNS, including non-HTTP traffic;
- no app files, credentials, bindings, or trusted local services;
- a read-only root filesystem with a writable, disposable temporary directory;
- enforcement of the 128 MiB memory limit across the whole execution, including child processes; the host quota must be larger than the test cap so the runner observes the test limit rather than the host being OOM-killed;
- shutdown or replacement of the container between runs when freshness cannot be proven.

Build and run the image with networking disabled:

```sh
docker build -t feedback-lab-runner:1 runner
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 256m --cpus 0.25 -p 127.0.0.1:8080:8080 feedback-lab-runner:1
```

The Worker adapter is `createServiceRunner` in `src/runner.ts`; bind it to a private `RUNNER` service. Do not add a public route.

## Verification fixtures

Before closing issue #2, repeat these against the deployed runner and record the expected and observed results:

| Fixture | Expected |
| --- | --- |
| known-correct `first_positive` | completed, then `Pass` in the app |
| endless loop | `timed_out` within the 2 s limit |
| unbounded printing | `output_limit` with partial output retained |
| memory growth | `memory_limit` |
| faulty recursion base case | `execution_error` with `RecursionError` |
| script reading stdin to EOF | completed with byte-exact stdout |
| script expected `7` printing `7\n` | `Pass` after comparison |
| script printing `7 ` for expected `7` | `Mismatch` |
| script exiting nonzero after printing the expected text | `Execution error` |
| invalid UTF-8 stdout | `Execution error` with lossy preview |
| outbound request and DNS lookup | denied by the host |
| disposable app-file and credential canaries | inaccessible |
| child process spawning | killed with the test's process group |
| interruption after one completed test | completed result retained; started test becomes infrastructure failure; unstarted tests become not run |

The issue #3 hosted record is pending in [`../docs/verification/issue-3-hosted-runner.md`](../docs/verification/issue-3-hosted-runner.md).

The Python contract tests are regression evidence, not hosted isolation evidence.
