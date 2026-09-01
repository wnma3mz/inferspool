"use client";

/**
 * Subscribing to job state is deliberately behind this one hook. Pages never
 * learn whether updates arrive by Realtime broadcast, polling, or (later) an
 * SSE token stream — so adding streaming is a change to this file only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { api, apiDownload, jsonBody } from "./api";
import { isTerminal, type Job, type JobType, type QueueStats } from "./types";

const POLL_MS = 4000;

export interface JobFilters {
  status?: string;
  type?: string;
  search?: string;
  after?: string;
  before?: string;
  tag?: string;
}

function jobQuery(limit: number, filters: JobFilters, cursor?: string | null) {
  const query = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export function useJobs(limit = 30, filters: JobFilters = {}, enabled = true) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const filterKey = JSON.stringify(filters);

  // Mirror of `jobs` for the poll timer to read. Reading state inside a setter
  // callback would violate the purity React 19 StrictMode assumes.
  const jobsRef = useRef<Job[]>([]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const page = await api<{ data: Job[]; next_cursor: string | null }>(
        `/jobs?${jobQuery(limit, filters)}`,
      );
      setJobs(page.data);
      jobsRef.current = page.data;
      setNextCursor(page.next_cursor);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    setLoading(false);
  }, [limit, filterKey, enabled]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    try {
      const page = await api<{ data: Job[]; next_cursor: string | null }>(
        `/jobs?${jobQuery(limit, filters, nextCursor)}`,
      );
      setJobs((current) => {
        const combined = [...current, ...page.data];
        jobsRef.current = combined;
        return combined;
      });
      setNextCursor(page.next_cursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [limit, filterKey, nextCursor]);

  useEffect(() => {
    if (!enabled) {
      setJobs([]);
      jobsRef.current = [];
      setNextCursor(null);
      setLoading(false);
      setError(null);
      return;
    }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    void refresh();

    // Realtime is the fast path; the poll below is the safety net. Channel
    // names are matched exactly, so this must be the per-user topic the SQL
    // trigger writes — a per-job topic would never be delivered here.
    void (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user || cancelled) return;

      // Required before a private channel: subscribe() only attaches the token
      // if it has already been resolved, so without this the JOIN goes out
      // with the anon key and Realtime Authorization rejects it.
      await supabase.realtime.setAuth();
      if (cancelled) return;

      channel = supabase
        .channel(`user:${auth.user.id}`, { config: { private: true } })
        .on("broadcast", { event: "*" }, () => void refresh())
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            // Not fatal: the poll keeps the UI correct, just slower.
            console.warn(`realtime ${status}; falling back to polling`);
          }
        });
    })();

    const timer = setInterval(() => {
      // Only poll while something could still change on its own.
      const current = jobsRef.current;
      if (current.length === 0 || current.some((j) => !isTerminal(j.status))) {
        void refresh();
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
      clearInterval(timer);
    };
  }, [refresh, enabled]);

  return { jobs, loading, error, refresh, nextCursor, loadMore };
}

export async function exportJobs(filters: JobFilters) {
  const query = new URLSearchParams({ limit: "5000", format: "csv" });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  await apiDownload(`/jobs?${query}`, "inferspool-jobs.csv");
}

export function useQueueStats() {
  const [stats, setStats] = useState<QueueStats | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setStats(await api<QueueStats>("/status", {}, false));
      } catch { /* keep last good value */ }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, []);

  return stats;
}

/**
 * Key derived from the request itself, bucketed into a 10s window. A random
 * UUID would make the unique index inert — it could never collide, so a
 * double-click would enqueue two GPU runs. Bucketing keeps deliberate
 * resubmissions of the same prompt possible a few seconds later.
 */
async function idempotencyKey(
  type: JobType,
  payload: Record<string, unknown>,
): Promise<string> {
  const bucket = Math.floor(Date.now() / 10_000);
  const body = `${type}:${bucket}:${JSON.stringify(payload)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function submitJob(
	type: JobType,
	payload: Record<string, unknown>,
	delivery: "cloud" | "direct" = "cloud",
) {
	const submittedPayload = { ...payload, _result_delivery: delivery };
	return api<Job>("/jobs", {
    method: "POST",
    body: jsonBody({
      type,
		payload: submittedPayload,
		idempotency_key: await idempotencyKey(type, submittedPayload),
    }),
  });
}

export interface InputImageRef {
  bucket: "inputs";
  path: string;
  mime: string;
  filename: string;
  bytes: number;
}

export async function uploadInputImage(file: File): Promise<InputImageRef> {
  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ]);
  if (!allowed.has(file.type)) throw new Error("unsupported image type");
  if (file.size > 20 * 1024 * 1024) {
    throw new Error("image must be 20 MB or smaller");
  }
  const target = await api<InputImageRef & { signed_url: string }>("/inputs", {
    method: "POST",
    body: jsonBody({ filename: file.name, content_type: file.type }),
  });
  const uploaded = await fetch(target.signed_url, {
    method: "PUT",
    headers: { "content-type": file.type, "x-upsert": "false" },
    body: file,
  });
  if (!uploaded.ok) throw new Error(`upload failed: HTTP ${uploaded.status}`);
  return {
    bucket: target.bucket,
    path: target.path,
    mime: file.type,
    filename: target.filename,
    bytes: file.size,
  };
}

export async function cancelJob(jobId: string) {
  await api(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: "{}",
  });
}

export async function retryJob(jobId: string) {
  return api<Job>(`/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: "{}",
  });
}

export async function deleteJob(jobId: string) {
  await api(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

export async function keepJob(jobId: string, keep: boolean) {
  await api(`/jobs/${encodeURIComponent(jobId)}/keep`, {
    method: "POST",
    body: jsonBody({ keep }),
  });
}

export async function signedResultUrl(
  jobId: string,
  bucket: string,
  path: string,
) {
  const result = await api<{ url: string }>(
    `/jobs/${encodeURIComponent(jobId)}/result`,
    {
      method: "POST",
      body: jsonBody({ bucket, path }),
    },
  );
  return result.url;
}

/** Ref-stable helper for components that submit on a keypress. */
export function useSubmitting() {
  const busy = useRef(false);
  return {
    run: async (fn: () => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      try {
        await fn();
      } finally {
        busy.current = false;
      }
    },
  };
}
