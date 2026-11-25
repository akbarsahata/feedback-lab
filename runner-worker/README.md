# Private runner Worker

A Container-backed Durable Object that runs the native Python runner in [`../runner`](../runner/README.md). It has no public route; the main Worker calls it through the private `RUNNER` service binding.

- **One container per Test run.** The request header `x-run-id` selects `run-<runId>`; each run starts clean.
- **Fresh test execution.** The container's Python service runs each configured test in a new child process with its own temp directory and process group.
- **No outbound network.** `enableInternet: false`; no app bindings or secrets are attached to this Worker.
- **Basic instance.** 0.25 vCPU, 1024 MiB, 4000 MB disk. The 128 MiB test cap is enforced inside the container.
- **Image rollout.** A Durable Object restarts a container whose image no longer matches `ctx.container.images.base`.
- **Recovery.** `POST /__reset` with a valid `x-run-id` destroys that run's container without touching app data.

Deploy:

```sh
npx wrangler deploy -c runner-worker/wrangler.jsonc
```

The main Worker must have the matching service binding:

```jsonc
"services": [{ "binding": "RUNNER", "service": "feedback-lab-runner" }]
```

The hosted verification record is in [`../docs/verification/issue-2-hosted-runner.md`](../docs/verification/issue-2-hosted-runner.md).
