import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const service = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function objects(
  value: any,
  owner?: string,
  out = new Map<string, Set<string>>(),
) {
  if (!value || typeof value !== "object") return out;
  if (
    !Array.isArray(value) && typeof value.bucket === "string" &&
    typeof value.path === "string"
  ) {
    if (
      ["inputs", "results"].includes(value.bucket) &&
      (!owner || value.path.startsWith(`${owner}/`))
    ) {
      if (!out.has(value.bucket)) out.set(value.bucket, new Set());
      out.get(value.bucket)!.add(value.path);
    }
  }
  for (const child of Object.values(value)) objects(child, owner, out);
  return out;
}

interface StoredObject {
  name: string;
  created_at?: string;
  updated_at?: string;
  metadata?: unknown;
}

async function walk(
  bucket: string,
  prefix = "",
  depth = 0,
  out: string[] = [],
): Promise<string[]> {
  if (depth > 5 || out.length >= 10_000) return out;
  let offset = 0;
  while (out.length < 10_000) {
    const { data, error } = await service.storage.from(bucket).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const rows = (data ?? []) as StoredObject[];
    for (const row of rows) {
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      if (row.metadata == null) await walk(bucket, path, depth + 1, out);
      else {
        const age = Date.now() -
          new Date(row.created_at ?? row.updated_at ?? 0).getTime();
        if (age >= 24 * 60 * 60 * 1000) out.push(path);
      }
      if (out.length >= 10_000) break;
    }
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return out;
}

async function removeOrphans() {
  const referenced = new Map<string, Set<string>>();
  let offset = 0;
  while (offset < 10_000) {
    const { data, error } = await service.from("jobs").select("payload,result")
      .is("deleted_at", null).range(offset, offset + 999);
    if (error) throw error;
    for (const job of data ?? []) {
      objects(job.payload, undefined, referenced);
      objects(job.result, undefined, referenced);
    }
    if ((data?.length ?? 0) < 1000) break;
    offset += data!.length;
  }
  let removed = 0;
  for (const bucket of ["inputs", "results"]) {
    const candidates = await walk(bucket);
    const orphaned = candidates.filter((path) =>
      !referenced.get(bucket)?.has(path)
    );
    for (let at = 0; at < orphaned.length; at += 100) {
      const batch = orphaned.slice(at, at + 100);
      const { error } = await service.storage.from(bucket).remove(batch);
      if (error) throw error;
      removed += batch.length;
    }
  }
  return removed;
}

Deno.serve(async (request) => {
  if (
    request.method !== "POST" ||
    request.headers.get("authorization") !==
      `Bearer ${Deno.env.get("CRON_SECRET")}`
  ) return json({ error: "unauthorized" }, 401);
  const now = new Date().toISOString();
  await service.rpc("record_offline_workers");
  const { data: jobs, error } = await service.from("jobs").select(
    "id,user_id,payload,result",
  ).is("deleted_at", null).in("status", ["succeeded", "failed", "canceled"]).or(
    `deletion_requested_at.not.is.null,and(keep_result.eq.false,retained_until.lte.${now})`,
  ).limit(100);
  if (error) return json({ error: error.message }, 500);
  let removed = 0;
  const errors: string[] = [];
  for (const job of jobs ?? []) {
    const refs = objects(job.payload, job.user_id);
    objects(job.result, job.user_id, refs);
    let ok = true;
    for (const [bucket, paths] of refs) {
      const list = [...paths];
      if (!list.length) continue;
      const { error: removeError } = await service.storage.from(bucket).remove(
        list,
      );
      if (removeError) {
        ok = false;
        errors.push(`${job.id}: ${removeError.message}`);
      } else removed += list.length;
    }
    if (ok) {
      await service.from("jobs").update({
        payload: { deleted: true },
        result: { deleted: true },
        error: null,
        deleted_at: now,
      }).eq("id", job.id).is("deleted_at", null);
    }
  }
  let orphansRemoved = 0;
  try {
    orphansRemoved = await removeOrphans();
  } catch (error) {
    errors.push(
      `orphan scan: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return json({
    jobs: jobs?.length ?? 0,
    objects_removed: removed,
    orphans_removed: orphansRemoved,
    errors,
  }, errors.length ? 207 : 200);
});
