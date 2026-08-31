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
    const { worker_id, worker_token, job_id, bucket, path } = await request
      .json();
    if (
      ![worker_id, worker_token, job_id, bucket, path].every((value) =>
        typeof value === "string" && value
      )
    ) {
      return json({ error: "missing input fields" }, 400);
    }
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: allowed, error: authError } = await client.rpc(
      "worker_input_target",
      {
        p_worker_id: worker_id,
        p_token: worker_token,
        p_job_id: job_id,
        p_bucket: bucket,
        p_path: path,
      },
    );
    if (authError || allowed !== true) {
      return json({ error: "input not found" }, 404);
    }
    const { data, error } = await client.storage.from(bucket).createSignedUrl(
      path,
      600,
    );
    if (error) return json({ error: error.message }, 500);
    return json({ url: data.signedUrl, expires_in: 600 });
  } catch {
    return json({ error: "invalid request" }, 400);
  }
});
