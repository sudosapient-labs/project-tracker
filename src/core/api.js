/* ---------- HTTP client for /api ---------- */

/* Identifies this tab, so the server doesn't echo our own changes back over the event stream. */
export const CLIENT_ID = 'tab' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || (status ? `Request failed (${status})` : "You're offline. Check your connection and try again."));
    this.status = status;
    this.body = body || {};
    this.field = body?.field || null;
    this.code = body?.code || null;
  }
  get offline() {
    return this.status === 0;
  }
}

export async function api(method, url, body) {
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-requested-with': 'gr8r',
        'x-client-id': CLIENT_ID,
        ...(body != null && !form ? { 'content-type': 'application/json' } : {}),
      },
      body: body == null ? undefined : form ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, null);
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const get = url => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const del = url => api('DELETE', url);

/* Upload a file's raw bytes with progress (fetch can't report upload progress). Resolves with the JSON body. */
export function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.withCredentials = true;
    x.setRequestHeader('x-requested-with', 'gr8r');
    x.setRequestHeader('x-client-id', CLIENT_ID);
    x.setRequestHeader('content-type', file.type || 'application/octet-stream');
    x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let data = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* not JSON */
      }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new ApiError(x.status, data));
    };
    x.onerror = () => reject(new ApiError(0, null));
    x.send(file);
  });
}
