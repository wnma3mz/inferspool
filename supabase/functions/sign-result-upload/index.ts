import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  try {
    const { worker_id, worker_token, job_id, filename, content_type } =
      await request.json();
    if (
      ![worker_id, worker_token, job_id, filename].every((v) =>
        typeof v === "string" && v
      )
    ) {
      return json({ error: "missing upload fields" }, 400);
    }
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
    if (!safeName || safeName === "." || safeName === "..") {
      return json({ error: "invalid filename" }, 400);
    }
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: owners, error: authError } = await client.rpc(
      "worker_upload_target",
      {
        p_worker_id: worker_id,
        p_token: worker_token,
        p_job_id: job_id,
      },
    );
    if (authError) return json({ error: "worker authorization failed" }, 401);
    const owner = owners?.[0]?.user_id;
    if (!owner) {
      return json({ error: "job lease is not owned by this worker" }, 409);
    }

    const path = `${owner}/${job_id}/${crypto.randomUUID()}-${safeName}`;
    const { data, error } = await client.storage
      .from("results")
      .createSignedUploadUrl(path, { upsert: false });
    if (error) return json({ error: error.message }, 500);
    return json({
      bucket: "results",
      path,
      signed_url: data.signedUrl,
      content_type: content_type || "application/octet-stream",
    });
  } catch {
    return json({ error: "invalid request" }, 400);
  }
});
