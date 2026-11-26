import { MAX_SOURCE_BYTES } from './runs';

export const MAX_UPLOAD_BODY_BYTES = MAX_SOURCE_BYTES + 16 * 1024;

export class UploadError extends Error {
  readonly status: 413 | 422;

  constructor(message: string, status: 413 | 422 = 422) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

export interface SourceUpload {
  csrfToken: string;
  versionId: string;
  bytes: Uint8Array;
}

export async function readSourceUpload(request: Request): Promise<SourceUpload> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const size = Number.parseInt(declared, 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new UploadError('The upload size could not be read.');
    }
    if (size > MAX_UPLOAD_BODY_BYTES) {
      throw new UploadError(
        `The upload is too large. Use one Python file of at most ${MAX_SOURCE_BYTES / 1024} KiB.`,
        413,
      );
    }
  }

  const body = await readLimitedBody(request, MAX_UPLOAD_BODY_BYTES);
  let form: FormData;
  try {
    form = await new Request('https://upload.invalid', {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      body,
    }).formData();
  } catch {
    throw new UploadError('The upload form could not be read. Choose the file again.');
  }

  const files = [...form.values()].filter((value): value is File => value instanceof File);
  if (files.length !== 1) {
    throw new UploadError('Upload exactly one Python source file.');
  }
  const file = files[0]!;
  if (!file.name.toLowerCase().endsWith('.py')) {
    throw new UploadError('The submission must be a single .py file.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new UploadError(
      `The file is too large. Use at most ${MAX_SOURCE_BYTES / 1024} KiB.`,
      413,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UploadError('The submission must be valid UTF-8 text.');
  }

  return {
    csrfToken: formString(form, '_csrf'),
    versionId: formString(form, 'versionId'),
    bytes,
  };
}

export async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new UploadError(
        `The upload is too large. Use one Python file of at most ${MAX_SOURCE_BYTES / 1024} KiB.`,
        413,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
