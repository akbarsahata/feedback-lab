import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
const STARTUP_ATTEMPTS = 300;
const STARTUP_DELAY_MS = 200;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export interface Env {
  RUNNER_CONTAINER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || (url.pathname !== '/run' && url.pathname !== '/__reset')) {
      return new Response('Not found', { status: 404 });
    }
    const runId = request.headers.get('x-run-id') ?? '';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) {
      return new Response('A valid x-run-id header is required.', { status: 400 });
    }
    return env.RUNNER_CONTAINER.getByName(`run-${runId}`).fetch(request);
  },
};

/**
 * One private, long-lived container host. Every test still runs in a fresh
 * native Python child process inside the container. The container has no
 * outbound Internet access and no application bindings.
 */
export class RunnerContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        ctx.container!.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (container === undefined) {
      return new Response('Runner container is not configured.', { status: 503 });
    }

    if (new URL(request.url).pathname === '/__reset') {
      if (container.running) await container.destroy('Manual runner reset.');
      return new Response(null, { status: 204 });
    }

    const wasRunning = container.running && (await this.matchesConfiguredImage());
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    const response = await container.getTcpPort(PORT).fetch(forwarded);

    const headers = new Headers(response.headers);
    if (wasRunning) {
      headers.set('x-runner-warm', 'true');
    } else {
      headers.set('x-runner-startup-ms', String(this.lastStartupMs));
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private lastStartupMs = 0;

  private async matchesConfiguredImage(): Promise<boolean> {
    const container = this.ctx.container!;
    if (!container.running) return false;
    try {
      const info = await container.inspect();
      if (info === null || info.image === '') return true;
      return info.image === container.images.base;
    } catch {
      return true;
    }
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.ctx.container!;
    if (container.running && !(await this.matchesConfiguredImage())) {
      await container.destroy('Runner image updated.');
    }
    if (!container.running) {
      const startedAt = performance.now();
      container.start({
        image: container.images.base,
        instance: 'basic',
        enableInternet: false,
      });
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      this.observeExit();
      await this.waitForHealth(container);
      this.lastStartupMs = Math.max(0, Math.round(performance.now() - startedAt));
      return;
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  private async waitForHealth(container: Container): Promise<void> {
    const port = container.getTcpPort(PORT);
    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
      try {
        const response = await port.fetch('http://container/health', {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // The Python service is still starting. Only the readiness probe retries.
      }
      await scheduler.wait(STARTUP_DELAY_MS);
    }
    throw new Error('Runner container did not become ready on port 8080.');
  }

  private observeExit(): void {
    const container = this.ctx.container!;
    this.ctx.waitUntil(
      container
        .monitor()
        .then(() => console.log('Runner container exited.'))
        .catch((error: unknown) => console.error('Runner container failed.', error)),
    );
  }
}
