import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const service = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const encoder = new TextEncoder();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function decode(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function key() {
  const secret = Deno.env.get("WEBHOOK_ENCRYPTION_KEY");
  if (!secret) throw new Error("WEBHOOK_ENCRYPTION_KEY is not configured");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
}
async function decrypt(value: string) {
  const [version, iv, data] = value.split(":");
  if (version !== "v1" || !iv || !data) {
    throw new Error("invalid webhook secret");
  }
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv) },
      await key(),
      decode(data),
    ),
  );
}
async function signature(secret: string, value: string) {
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", hmac, encoder.encode(value)),
    ),
  ).map((n) => n.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (
    request.method !== "POST" ||
    request.headers.get("authorization") !==
      `Bearer ${Deno.env.get("CRON_SECRET")}`
  ) return json({ error: "unauthorized" }, 401);
  const { data: claimed, error: claimError } = await service.rpc(
    "claim_webhook_deliveries",
    { p_limit: 50 },
  );
  if (claimError) return json({ error: claimError.message }, 500);
  const ids = (claimed ?? []).map((delivery: any) => delivery.id);
  if (!ids.length) return json({ processed: 0, succeeded: 0, failed: 0 });
  const { data: deliveries, error } = await service.from("webhook_deliveries")
    .select(
      "id,attempts,webhook_id,event_id,webhooks!inner(id,url,secret_ciphertext,disabled_at),job_events!inner(id,event,payload,created_at)",
    ).in("id", ids);
  if (error) return json({ error: error.message }, 500);
  let succeeded = 0, failed = 0;
  for (const delivery of deliveries ?? []) {
    const webhook: any = delivery.webhooks;
    const event: any = delivery.job_events;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({
      id: delivery.id,
      event: event.event,
      created_at: event.created_at,
      data: event.payload,
    });
    let timer: number | undefined;
    try {
      const secret = await decrypt(webhook.secret_ciphertext);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(webhook.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "user-agent": "InferSpool-Webhooks/1.0",
          "x-inferspool-delivery": delivery.id,
          "x-inferspool-timestamp": timestamp,
          "x-inferspool-signature": `sha256=${await signature(
            secret,
            `${timestamp}.${payload}`,
          )}`,
        },
        body: payload,
      });
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), {
          status: response.status,
        });
      }
      await service.from("webhook_deliveries").update({
        status: "succeeded",
        attempts: delivery.attempts + 1,
        last_status: response.status,
        last_error: null,
        delivered_at: new Date().toISOString(),
      }).eq("id", delivery.id);
      await service.from("webhooks").update({ consecutive_failures: 0 }).eq(
        "id",
        webhook.id,
      );
      succeeded++;
    } catch (cause) {
      const attempts = delivery.attempts + 1;
      const retrySeconds = Math.min(3600, 15 * 2 ** Math.min(attempts - 1, 8));
      await service.from("webhook_deliveries").update({
        status: "failed",
        attempts,
        last_status: Number((cause as any)?.status) || null,
        last_error: String((cause as any)?.message ?? cause).slice(0, 1000),
        next_attempt_at: new Date(Date.now() + retrySeconds * 1000)
          .toISOString(),
      }).eq("id", delivery.id);
      const { data: updated } = await service.rpc("record_webhook_failure", {
        p_webhook_id: webhook.id,
      });
      if (Number(updated) >= 10) {
        await service.from("webhooks").update({
          disabled_at: new Date().toISOString(),
        }).eq("id", webhook.id);
      }
      failed++;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return json({ processed: succeeded + failed, succeeded, failed });
});
