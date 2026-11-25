# Native Python test runner

One job runs one configured test. The submission executes in a fresh child process with a temporary working directory, a sanitized environment, a process-group wall-clock timeout, an address-space limit, and a combined output cap. The runner has no expected value: `function-value-v1` comparison happens in the trusted Worker.

## Contract tests

```sh
python3 -m unittest discover -s runner -p 'test_*.py' -v
```

The memory-limit test runs only on Linux because macOS does not enforce address-space limits the same way.

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
- enforcement of the 128 MiB memory limit across the whole execution, including child processes;
- shutdown or replacement of the container between runs when freshness cannot be proven.

Build and run the image with networking disabled:

```sh
docker build -t feedback-lab-runner:1 runner
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 128m --cpus 0.25 -p 127.0.0.1:8080:8080 feedback-lab-runner:1
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
| outbound request and DNS lookup | denied by the host |
| disposable app-file and credential canaries | inaccessible |
| child process spawning | killed with the test's process group |
| interruption after one completed test | completed result retained; started test becomes infrastructure failure; unstarted tests become not run |

The Python contract tests are regression evidence, not hosted isolation evidence.
