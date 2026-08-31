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
    const { api_key, filename, content_type } = await request.json();
    if (
      ![api_key, filename, content_type].every((value) =>
        typeof value === "string" && value
      )
    ) {
      return json({ error: "missing input fields" }, 400);
    }
    if (
      !new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]).has(
        content_type,
      )
    ) {
      return json({ error: "unsupported image type" }, 400);
    }
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160);
    const probe = `${crypto.randomUUID()}/${safe || "image"}`;
    const { data: owners, error: authError } = await client.rpc(
      "client_input_owner",
      { p_key: api_key },
    );
    if (authError) return json({ error: "invalid API key" }, 401);
    const owner = owners?.[0]?.user_id;
    if (!owner) return json({ error: "invalid API key" }, 401);
    const path = `${owner}/${probe}`;
    const { data, error } = await client.storage.from("inputs")
      .createSignedUploadUrl(path, { upsert: false });
    if (error) return json({ error: error.message }, 500);
    return json({
      bucket: "inputs",
      path,
      signed_url: data.signedUrl,
      mime: content_type,
      filename: safe,
    });
  } catch {
    return json({ error: "invalid request" }, 400);
  }
});
