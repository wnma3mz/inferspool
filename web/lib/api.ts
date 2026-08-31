import { supabase } from "./supabase";

export const apiURL = (process.env.NEXT_PUBLIC_API_URL ||
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/api`).replace(
    /\/$/,
    "",
  );

export async function api<T>(
  path: string,
  init: RequestInit = {},
  authenticated = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (authenticated) {
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) throw new Error("not signed in");
    headers.set("authorization", `Bearer ${data.session.access_token}`);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${apiURL}/v1${path}`, { ...init, headers });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    const error = new Error(
      value?.error?.message || `HTTP ${response.status}`,
    ) as Error & { code?: string };
    error.code = value?.error?.code;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const jsonBody = (value: unknown) => JSON.stringify(value);

export async function apiDownload(path: string, filename: string) {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("not signed in");
  const response = await fetch(`${apiURL}/v1${path}`, {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const href = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}
