export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const createClient = (base: string, token?: string) => async <T>(
  path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> => {
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if(options.signal?.aborted)abort();
  options.signal?.addEventListener('abort',abort,{once:true});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;abort();},options.timeoutMs??20000);
  try {
    const response = await fetch(base.replace(/\/$/, '') + path, {
      method: options.method ?? 'GET', credentials: token ? 'omit' : 'include', signal: controller.signal,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, data?.error?.code ?? 'REQUEST_FAILED', data?.error?.message ?? 'Request failed');
    if (data===null && timedOut) throw new ApiError(408,'TIMEOUT','The server took too long to respond');
    return data as T;
  } catch (error) {
    if(timedOut)throw new ApiError(408,'TIMEOUT','The server took too long to respond');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort',abort);
  }
};
