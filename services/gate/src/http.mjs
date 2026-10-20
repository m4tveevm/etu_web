export async function readBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('response_too_large');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function jsonRequest(fetcher, url, init = {}) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('upstream_rejected');
  return JSON.parse((await readBytes(response, 65_536)).toString('utf8'));
}
