import {
  createClient,
  type SupabaseClient,
} from "npm:@supabase/supabase-js@2.57.4";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Actor = {
  userId: string;
  jwt?: string;
  apiKey?: string;
  admin: boolean;
  forcePasswordChange: boolean;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY_LEGACY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});
const encoder = new TextEncoder();

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, apikey, content-type, x-worker-id, x-worker-token",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(body: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors, ...extra },
  });
}

function problem(status: number, code: string, message: string) {
  return json({ error: { code, message } }, status);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: any) {
  if (Number(error?.status)) return Number(error.status);
  switch (String(error?.code ?? "")) {
    case "22023":
      return 400;
    case "28000":
      return 401;
    case "42501":
      return 403;
    case "23505":
      return 409;
    case "54000":
      return 429;
    default:
      return 500;
  }
}

async function body(request: Request): Promise<Record<string, any>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {};
  }
  const value = await request.json();
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("JSON object required");
  }
  return value;
}

function routePath(url: URL) {
  const marker = "/api/";
  const at = url.pathname.indexOf(marker);
  if (at >= 0) {
    return "/" + url.pathname.slice(at + marker.length).replace(/^\/+/, "");
  }
  return url.pathname;
}

function encodeCursor(row: { created_at: string; id: string }) {
  return btoa(`${row.created_at}|${row.id}`).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replace(/=+$/, "");
}

function decodeCursor(value: string) {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((value.length + 3) % 4);
    const [createdAt, id, extra] = atob(padded).split("|");
    if (
      extra !== undefined || !createdAt || !id ||
      !Number.isFinite(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)
    ) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function userClient(jwt: string) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

async function isAdmin(userId: string) {
  const { data, error } = await service.from("admins").select("user_id").eq(
    "user_id",
    userId,
  ).maybeSingle();
  if (error) throw error;
  return !!data;
}

async function actor(
  request: Request,
  requireAdmin = false,
  allowPasswordChange = false,
): Promise<Actor> {
  const token = bearer(request);
  if (!token) {
    throw Object.assign(new Error("authentication required"), { status: 401 });
  }
  let userId = "";
  let jwt: string | undefined;
  let apiKey: string | undefined;
  if (token.startsWith("inferspool_")) {
    const { data, error } = await service.rpc("client_input_owner", {
      p_key: token,
    });
    if (error || !data?.[0]?.user_id) {
      throw Object.assign(new Error("invalid or revoked API key"), {
        status: 401,
      });
    }
    userId = data[0].user_id;
    apiKey = token;
  } else {
    const { data, error } = await service.auth.getUser(token);
    if (error || !data.user) {
      throw Object.assign(new Error("invalid or expired session"), {
        status: 401,
      });
    }
    userId = data.user.id;
    jwt = token;
  }
  const [admin, profileResult] = await Promise.all([
    isAdmin(userId),
    service.from("user_profiles").select(
      "status,force_password_change",
    ).eq("user_id", userId).maybeSingle(),
  ]);
  if (requireAdmin && !admin) {
    throw Object.assign(new Error("administrator access required"), {
      status: 403,
    });
  }
  if (profileResult.error) throw profileResult.error;
  const profile = profileResult.data;
  if (profile?.status === "disabled") {
    throw Object.assign(new Error("account disabled"), { status: 403 });
  }
  if (profile?.force_password_change && !allowPasswordChange) {
    throw Object.assign(new Error("password change required"), {
      status: 403,
      code: "password_change_required",
    });
  }
  return {
    userId,
    jwt,
    apiKey,
    admin,
    forcePasswordChange: profile?.force_password_change === true,
  };
}

function worker(request: Request) {
  const id = request.headers.get("x-worker-id")?.trim() ?? "";
  const token = request.headers.get("x-worker-token")?.trim() ?? "";
  if (!id || !token) {
    throw Object.assign(new Error("worker credentials required"), {
      status: 401,
    });
  }
  return { id, token };
}

async function rpc(
  client: SupabaseClient,
  name: string,
  params: Record<string, any> = {},
) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw error;
  return data;
}

function cleanFileName(value: unknown, fallback: string) {
  const safe = String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160);
  return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

function isJobType(value: unknown): value is "llm" | "image" | "video" | "tts" {
  return ["llm", "image", "video", "tts"].includes(String(value));
}

function artifactKind(mime: unknown) {
  const value = String(mime ?? "");
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("audio/")) return "audio";
  if (value.startsWith("video/")) return "video";
  return "file";
}

function normalizeResult(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (Array.isArray(value.artifacts)) return value;
  const legacy = [
    ...(Array.isArray(value.files) ? value.files : []),
    ...(value.file && typeof value.file === "object" ? [value.file] : []),
  ];
  if (!legacy.length) return value;
  const { file: _file, files: _files, type: _type, ...rest } = value;
  return {
    ...rest,
    artifacts: legacy.map((item: any) => ({
      ...item,
      kind: item.kind === "images"
        ? "image"
        : (item.kind ?? artifactKind(item.mime)),
    })),
  };
}

type JobStage =
  | "waiting_for_worker"
  | "waiting_for_service"
  | "waiting_for_capacity"
  | "waiting_for_direct_worker"
  | "assigned"
  | "generating"
  | "encoding"
  | "delivering"
  | "completed"
  | "failed"
  | "canceled";

type ServiceAvailability = Record<
  string,
  { registered: number; online: number; healthy: number; direct: number }
>;

async function serviceAvailability(): Promise<ServiceAvailability> {
  const { data, error } = await service.from("worker_services").select(
    "type,healthy,last_check,parameter_schema,workers!inner(last_heartbeat,disabled_at)",
  ).is("workers.disabled_at", null);
  if (error) throw error;
  const cutoff = Date.now() - 90_000;
  const result: ServiceAvailability = {};
  for (const row of data ?? []) {
    const type = String(row.type);
    const current = result[type] ?? {
      registered: 0,
      online: 0,
      healthy: 0,
      direct: 0,
    };
    current.registered++;
    const worker = Array.isArray(row.workers) ? row.workers[0] : row.workers;
    const fresh = Date.parse(String(row.last_check)) > cutoff &&
      Date.parse(String(worker?.last_heartbeat)) > cutoff;
    if (fresh) current.online++;
    if (fresh && row.healthy) current.healthy++;
    if (
      fresh && row.parameter_schema?._result_delivery?.enum?.includes("direct")
    ) current.direct++;
    result[type] = current;
  }
  return result;
}

function jobStage(job: any, services: ServiceAvailability): JobStage {
  if (job.status === "succeeded") return "completed";
  if (job.status === "failed") return "failed";
  if (job.status === "canceled") return "canceled";
  if (job.status === "running") {
    const progress = String(job.progress_msg ?? "").toLowerCase();
    if (progress.includes("encod") || progress.includes("compress")) {
      return "encoding";
    }
    if (progress.includes("upload") || progress.includes("deliver")) {
      return "delivering";
    }
    return job.progress == null ? "assigned" : "generating";
  }
  const available = services[String(job.type)] ?? {
    registered: 0,
    online: 0,
    healthy: 0,
    direct: 0,
  };
  if (job.payload?._result_delivery === "direct" && available.direct === 0) {
    return "waiting_for_direct_worker";
  }
  if (available.registered === 0 || available.online === 0) {
    return "waiting_for_worker";
  }
  if (available.healthy === 0) return "waiting_for_service";
  return "waiting_for_capacity";
}

function explainJobs(rows: any[], services: ServiceAvailability) {
  return rows.map((row) => {
    const { priority: _priority, ...visible } = row;
    return {
      ...visible,
      result: normalizeResult(row.result),
      stage: jobStage(row, services),
    };
  });
}

function validateProductPayload(
  type: string,
  payload: Record<string, any>,
  userId: string,
) {
  if (
    payload._result_delivery !== undefined &&
    !["cloud", "direct"].includes(String(payload._result_delivery))
  ) {
    throw Object.assign(
      new Error("_result_delivery must be cloud or direct"),
      { status: 400 },
    );
  }
  if (type === "llm" && payload._result_delivery === "direct") {
    throw Object.assign(new Error("LLM results are stored inline"), {
      status: 400,
    });
  }
  const field = type === "tts" ? "text" : "prompt";
  if (typeof payload[field] !== "string" || !payload[field].trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  if (type === "llm" && payload.images !== undefined) {
    if (!Array.isArray(payload.images) || payload.images.length > 8) {
      throw Object.assign(new Error("images must contain at most 8 items"), {
        status: 400,
      });
    }
    for (const image of payload.images) {
      const remote = typeof image?.url === "string" &&
        image.url.startsWith("https://");
      const stored = image?.bucket === "inputs" &&
        typeof image?.path === "string" && image.path.startsWith(`${userId}/`);
      if (!remote && !stored) {
        throw Object.assign(new Error("invalid image input"), { status: 400 });
      }
    }
  }
}

const payloadFields: Record<string, Set<string>> = {
  llm: new Set(["prompt", "images", "temperature", "max_tokens"]),
  image: new Set(["prompt", "size", "num_inference_steps"]),
  video: new Set([
    "prompt",
    "size",
    "num_inference_steps",
    "seconds",
    "fps",
  ]),
  tts: new Set(["text", "voice", "speed", "response_format"]),
};

function parameterAccepted(value: unknown, range: any) {
  if (!range || typeof range !== "object") return false;
  if (range.type === "number" || range.type === "integer") {
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      (range.type === "integer" && !Number.isInteger(value))
    ) return false;
    return (range.minimum === undefined || value >= range.minimum) &&
      (range.maximum === undefined || value <= range.maximum);
  }
  if (range.type === "string") {
    if (typeof value !== "string") return false;
    if (Array.isArray(range.enum) && !range.enum.includes(value)) return false;
    if (
      typeof range.pattern === "string" &&
      !(new RegExp(range.pattern)).test(value)
    ) return false;
    return true;
  }
  return false;
}

async function validateWorkerParameters(
  type: string,
  payload: Record<string, any>,
) {
  if (payload._result_delivery === "direct") {
    const availability = await serviceAvailability();
    if ((availability[type]?.direct ?? 0) === 0) {
      throw Object.assign(
        new Error("no online worker supports temporary direct delivery"),
        { status: 422, code: "direct_delivery_unavailable" },
      );
    }
  }
  const supplied = Object.keys(payload).filter((name) =>
    !["prompt", "text", "images", "_result_delivery"].includes(name)
  );
  const experimental = supplied.filter((name) =>
    !payloadFields[type]?.has(name)
  );
  const { data, error } = await service.from("worker_services")
    .select("parameter_schema,workers!inner(disabled_at)")
    .eq("type", type).is("workers.disabled_at", null);
  if (error) throw error;
  // No registered service is not an input error: shared GPUs may be added or
  // currently asleep while a valid job waits in the durable queue.
  if (!data?.length) {
    if (experimental.length) {
      throw Object.assign(
        new Error(
          `experimental parameters require a registered service: ${
            experimental.join(", ")
          }`,
        ),
        { status: 422, code: "unsupported_parameters" },
      );
    }
    return;
  }
  const compatible = data.some((row: any) =>
    supplied.every((name) =>
      parameterAccepted(payload[name], row.parameter_schema?.[name])
    )
  );
  if (!compatible) {
    throw Object.assign(
      new Error("no registered worker supports the requested parameter values"),
      { status: 422, code: "unsupported_parameters" },
    );
  }
}

async function rerunJob(userId: string, id: string) {
  const { data: oldJob, error: readError } = await service.from("jobs")
    .select("type,payload,pool_id,tags").eq("id", id).eq("user_id", userId)
    .in("status", ["succeeded", "failed", "canceled"]).is("deleted_at", null)
    .maybeSingle();
  if (readError) throw readError;
  if (!oldJob) return null;
  await validateWorkerParameters(oldJob.type, oldJob.payload);
  const { data, error } = await service.from("jobs").insert({
    user_id: userId,
    type: oldJob.type,
    payload: oldJob.payload,
    priority: 0,
    source_job_id: id,
    pool_id: oldJob.pool_id,
    tags: oldJob.tags,
  }).select().single();
  if (error?.code === "23505") return null;
  if (error) throw error;
  return data;
}

async function sessionRoute(request: Request, path: string) {
  if (path === "/v1/session" && request.method === "POST") {
    const input = await body(request);
    if (typeof input.email !== "string" || typeof input.password !== "string") {
      return problem(400, "invalid_request", "email and password are required");
    }
    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: { apikey: ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ email: input.email, password: input.password }),
      },
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  if (path === "/v1/session/refresh" && request.method === "POST") {
    const input = await body(request);
    if (typeof input.refresh_token !== "string") {
      return problem(400, "invalid_request", "refresh_token is required");
    }
    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: { apikey: ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: input.refresh_token }),
      },
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  if (path === "/v1/session" && request.method === "DELETE") {
    const token = bearer(request);
    if (!token) return problem(401, "unauthorized", "session required");
    const response = await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` },
    });
    return response.ok
      ? new Response(null, { status: 204, headers: cors })
      : problem(response.status, "logout_failed", "logout failed");
  }
  return null;
}

async function accountRoutes(request: Request, path: string) {
  if (path === "/v1/me" && request.method === "GET") {
    const a = await actor(request, false, true);
    const { data: user } = await service.auth.admin.getUserById(a.userId);
    const { data: profile } = await service.from("user_profiles").select("*")
      .eq("user_id", a.userId).single();
    return json({
      id: a.userId,
      email: user.user?.email,
      admin: a.admin,
      profile,
    });
  }
  if (path === "/v1/me/password" && request.method === "POST") {
    const a = await actor(request, false, true);
    if (!a.jwt) {
      return problem(
        400,
        "session_required",
        "password changes require a login session",
      );
    }
    const input = await body(request);
    if (typeof input.password !== "string" || input.password.length < 8) {
      return problem(
        400,
        "weak_password",
        "password must be at least 8 characters",
      );
    }
    // The JWT was already verified by actor(). A Supabase client configured
    // with an Authorization header can query as that user, but auth.updateUser
    // still expects an in-memory Auth session and otherwise fails with
    // "Auth session missing!". Update only the verified actor through the
    // service-role admin API instead.
    const { error } = await service.auth.admin.updateUserById(a.userId, {
      password: input.password,
    });
    if (error) throw error;
    await service.from("user_profiles").update({
      status: "active",
      force_password_change: false,
      updated_at: new Date().toISOString(),
    }).eq("user_id", a.userId);
    return json({ changed: true });
  }
  if (path === "/v1/keys" && request.method === "GET") {
    const a = await actor(request);
    const { data, error } = await service.from("api_keys").select(
      "id,prefix,label,created_at,last_used_at",
    ).eq("user_id", a.userId).is("revoked_at", null).order("created_at", {
      ascending: false,
    });
    if (error) throw error;
    return json(data ?? []);
  }
  if (path === "/v1/keys" && request.method === "POST") {
    const a = await actor(request);
    if (!a.jwt) {
      return problem(
        400,
        "session_required",
        "creating an API key requires a login session",
      );
    }
    const input = await body(request);
    return json(
      await rpc(userClient(a.jwt), "create_api_key", {
        p_label: typeof input.label === "string" && input.label.trim()
          ? input.label.trim()
          : null,
      }),
      201,
    );
  }
  const keyMatch = path.match(/^\/v1\/keys\/([0-9a-f-]+)$/i);
  if (keyMatch && request.method === "DELETE") {
    const a = await actor(request);
    const { error } = await service.from("api_keys").update({
      revoked_at: new Date().toISOString(),
    }).eq("id", keyMatch[1]).eq("user_id", a.userId).is("revoked_at", null);
    if (error) throw error;
    return new Response(null, { status: 204, headers: cors });
  }
  return null;
}

async function jobRoutes(request: Request, url: URL, path: string) {
  if (path === "/v1/status" && request.method === "GET") {
    const [stats, availability] = await Promise.all([
      rpc(service, "queue_stats"),
      serviceAvailability(),
    ]);
    return json({
      ...stats,
      direct: Object.fromEntries(
        Object.entries(availability).map(([type, value]) => [
          type,
          value.direct,
        ]),
      ),
    });
  }
  if (path === "/v1/jobs" && request.method === "POST") {
    const a = await actor(request);
    const input = await body(request);
    if (
      !isJobType(input.type) || !input.payload ||
      typeof input.payload !== "object" || Array.isArray(input.payload)
    ) return problem(400, "invalid_job", "type and payload are required");
    validateProductPayload(input.type, input.payload, a.userId);
    await validateWorkerParameters(input.type, input.payload);
    let job;
    if (a.apiKey) {
      job = await rpc(service, "submit_job", {
        p_key: a.apiKey,
        p_type: input.type,
        p_payload: input.payload,
        p_priority: a.admin ? (input.priority ?? 0) : 0,
        p_idempotency_key: input.idempotency_key ?? null,
      });
    } else {
      const { data, error } = await service.from("jobs").insert({
        user_id: a.userId,
        type: input.type,
        payload: input.payload,
        priority: a.admin ? (input.priority ?? 0) : 0,
        idempotency_key: input.idempotency_key ?? null,
        tags: Array.isArray(input.tags) ? input.tags : [],
      }).select().single();
      if (error) throw error;
      job = data;
    }
    const services = await serviceAvailability();
    return json(explainJobs([job], services)[0], 201);
  }
  if (path === "/v1/jobs" && request.method === "GET") {
    const a = await actor(request);
    const csvExport = url.searchParams.get("format") === "csv";
    const maxLimit = csvExport ? 5000 : 200;
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 20), 1),
      maxLimit,
    );
    const cursorValue = url.searchParams.get("cursor");
    const initialCursor = cursorValue ? decodeCursor(cursorValue) : null;
    if (cursorValue && !initialCursor) {
      return problem(400, "invalid_cursor", "cursor is invalid");
    }
    const buildQuery = (
      cursor: { createdAt: string; id: string } | null,
      pageSize: number,
    ) => {
      let query = service.from("jobs").select("*").eq("user_id", a.userId).is(
        "deleted_at",
        null,
      ).order("created_at", { ascending: false }).order("id", {
        ascending: false,
      }).limit(pageSize);
      for (
        const [key, column] of [["status", "status"], ["type", "type"]] as const
      ) {
        const value = url.searchParams.get(key);
        if (value) query = query.eq(column, value);
      }
      const search = url.searchParams.get("search");
      if (search) {
        query = query.or(
          `payload->>prompt.ilike.%${
            search.replace(/[%_,()]/g, "")
          }%,payload->>text.ilike.%${search.replace(/[%_,()]/g, "")}%`,
        );
      }
      const before = url.searchParams.get("before");
      if (before) query = query.lt("created_at", before);
      const after = url.searchParams.get("after");
      if (after) query = query.gte("created_at", after);
      const tag = url.searchParams.get("tag");
      if (tag) query = query.contains("tags", [tag]);
      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
        );
      }
      return query;
    };
    if (csvExport) {
      const rows: any[] = [];
      let cursor = initialCursor;
      while (rows.length < limit) {
        const size = Math.min(1000, limit - rows.length);
        const { data, error } = await buildQuery(cursor, size);
        if (error) throw error;
        const page = data ?? [];
        rows.push(...page);
        if (page.length < size) break;
        const last = page.at(-1);
        cursor = { createdAt: last.created_at, id: last.id };
      }
      const fields = [
        "id",
        "type",
        "status",
        "created_at",
        "started_at",
        "finished_at",
        "error",
      ];
      const csv = [
        fields.join(","),
        ...rows.map((row: any) =>
          fields.map((f) => `"${String(row[f] ?? "").replaceAll('"', '""')}"`)
            .join(",")
        ),
      ].join("\n");
      return new Response(csv + "\n", {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": "attachment; filename=inferspool-jobs.csv",
          ...cors,
        },
      });
    }
    const { data, error } = await buildQuery(initialCursor, limit + 1);
    if (error) throw error;
    const rows = data ?? [];
    const more = rows.length > limit;
    if (more) rows.pop();
    const services = await serviceAvailability();
    return json({
      data: explainJobs(rows, services),
      next_cursor: more && rows.length
        ? encodeCursor(rows[rows.length - 1]!)
        : null,
    });
  }
  const match = path.match(
    /^\/v1\/jobs\/([0-9a-f-]+)(?:\/(cancel|rerun|retry|result))?$/i,
  );
  if (!match) return null;
  const a = await actor(request);
  const id = match[1];
  const action = match[2];
  if (!action && request.method === "GET") {
    const { data, error } = await service.from("jobs").select("*").eq("id", id)
      .eq("user_id", a.userId).is("deleted_at", null).maybeSingle();
    if (error) throw error;
    if (!data) return problem(404, "not_found", "job not found");
    const services = await serviceAvailability();
    return json(explainJobs([data], services)[0]);
  }
  if (action === "cancel" && request.method === "POST") {
    let result;
    if (a.apiKey) {
      result = await rpc(service, "cancel_job_by_key", {
        p_key: a.apiKey,
        p_job_id: id,
      });
    } else {result = await rpc(userClient(a.jwt!), "request_cancel", {
        p_job_id: id,
      });}
    return result == null
      ? problem(409, "not_cancelable", "job not found or already finished")
      : json({ status: result });
  }
  if (["rerun", "retry"].includes(action ?? "") && request.method === "POST") {
    const result = await rerunJob(a.userId, id);
    if (!result) {
      return problem(
        409,
        "not_rerunnable",
        "job cannot be run again or already has an active rerun",
      );
    }
    const services = await serviceAvailability();
    return json(explainJobs([result], services)[0], 201);
  }
  if (!action && request.method === "DELETE") {
    const { data, error } = await service.from("jobs").update({
      deletion_requested_at: new Date().toISOString(),
    }).eq("id", id).eq("user_id", a.userId).in("status", [
      "succeeded",
      "failed",
      "canceled",
    ]).is("deleted_at", null).select("id").maybeSingle();
    if (error) throw error;
    return data
      ? json({ deletion_requested: true }, 202)
      : problem(409, "not_deletable", "only finished jobs can be deleted");
  }
  if (action === "result" && request.method === "POST") {
    const input = await body(request);
    const { data: job, error } = await service.from("jobs").select("result").eq(
      "id",
      id,
    ).eq("user_id", a.userId).is("deleted_at", null).maybeSingle();
    if (error) throw error;
    if (!job || !containsObject(job.result, input.bucket, input.path)) {
      return problem(404, "not_found", "result not found");
    }
    const { data, error: signError } = await service.storage.from(input.bucket)
      .createSignedUrl(input.path, 3600);
    if (signError) throw signError;
    return json({ url: data.signedUrl, expires_in: 3600 });
  }
  return null;
}

function containsObject(value: any, bucket: unknown, path: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && value.bucket === bucket && value.path === path) {
    return true;
  }
  return Object.values(value).some((child) =>
    containsObject(child, bucket, path)
  );
}

async function removeStoragePrefix(
  bucket: string,
  prefix: string,
  depth = 0,
): Promise<number> {
  if (depth > 8) {
    throw new Error(`storage path is too deeply nested in ${bucket}/${prefix}`);
  }
  let removed = 0;
  for (;;) {
    const { data, error } = await service.storage.from(bucket).list(prefix, {
      limit: 1000,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const rows = data ?? [];
    const files: string[] = [];
    for (const row of rows) {
      const path = `${prefix}/${row.name}`;
      if (row.metadata == null) {
        removed += await removeStoragePrefix(bucket, path, depth + 1);
      } else files.push(path);
    }
    for (let at = 0; at < files.length; at += 100) {
      const batch = files.slice(at, at + 100);
      const { error: removeError } = await service.storage.from(bucket).remove(
        batch,
      );
      if (removeError) throw removeError;
      removed += batch.length;
    }
    if (rows.length < 1000) return removed;
    // Every file from this page was removed. If a page contained only folder
    // markers, their children were removed recursively, so the next list also
    // advances without relying on a mutable offset.
  }
}

async function inputRoute(request: Request, path: string) {
  if (path !== "/v1/inputs" || request.method !== "POST") return null;
  const a = await actor(request);
  const input = await body(request);
  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ]);
  if (!allowed.has(input.content_type)) {
    return problem(400, "unsupported_media", "JPEG, PNG, WebP or GIF required");
  }
  const filename = cleanFileName(input.filename, "image");
  const objectPath = `${a.userId}/${crypto.randomUUID()}/${filename}`;
  const { data, error } = await service.storage.from("inputs")
    .createSignedUploadUrl(objectPath, { upsert: false });
  if (error) throw error;
  return json({
    bucket: "inputs",
    path: objectPath,
    signed_url: data.signedUrl,
    mime: input.content_type,
    filename,
  }, 201);
}

async function workerRoutes(request: Request, path: string) {
  if (!path.startsWith("/v1/workers/")) return null;
  const w = worker(request);
  const input = request.method === "POST" ? await body(request) : {};
  const params = { p_worker_id: w.id, p_token: w.token } as Record<string, any>;
  const route: Record<string, [string, Record<string, string>]> = {
    "/v1/workers/pending": ["pending_by_type", {}],
    "/v1/workers/services": ["report_services", { services: "p_services" }],
    "/v1/workers/claim": ["claim_jobs", {
      types: "p_types",
      limit: "p_limit",
      lease_secs: "p_lease_secs",
    }],
    "/v1/workers/heartbeat": ["heartbeat_batch", {
      job_ids: "p_job_ids",
      lease_secs: "p_lease_secs",
    }],
    "/v1/workers/progress": ["progress_batch", { updates: "p_updates" }],
    "/v1/workers/complete": ["complete_job", {
      job_id: "p_job_id",
      result: "p_result",
    }],
    "/v1/workers/fail": ["fail_job", {
      job_id: "p_job_id",
      error: "p_error",
      retryable: "p_retryable",
    }],
  };
  if (route[path] && request.method === "POST") {
    const [name, mapping] = route[path];
    for (const [from, to] of Object.entries(mapping)) {
      if (input[from] !== undefined) {
        params[to] = path === "/v1/workers/complete" && from === "result"
          ? normalizeResult(input[from])
          : input[from];
      }
    }
    return json(await rpc(service, name, params));
  }
  if (path === "/v1/workers/results/upload" && request.method === "POST") {
    const owners = await rpc(service, "worker_upload_target", {
      ...params,
      p_job_id: input.job_id,
    });
    const owner = owners?.[0]?.user_id;
    if (!owner) {
      return problem(
        409,
        "lease_lost",
        "job lease is not owned by this worker",
      );
    }
    const filename = cleanFileName(input.filename, "result.bin");
    const objectPath =
      `${owner}/${input.job_id}/${crypto.randomUUID()}-${filename}`;
    const { data, error } = await service.storage.from("results")
      .createSignedUploadUrl(objectPath, { upsert: false });
    if (error) throw error;
    return json({
      bucket: "results",
      path: objectPath,
      signed_url: data.signedUrl,
      content_type: input.content_type ?? "application/octet-stream",
    }, 201);
  }
  if (path === "/v1/workers/inputs/download" && request.method === "POST") {
    const allowed = await rpc(service, "worker_input_target", {
      ...params,
      p_job_id: input.job_id,
      p_bucket: input.bucket,
      p_path: input.path,
    });
    if (allowed !== true) return problem(404, "not_found", "input not found");
    const { data, error } = await service.storage.from(input.bucket)
      .createSignedUrl(input.path, 600);
    if (error) throw error;
    return json({ url: data.signedUrl, expires_in: 600 });
  }
  return null;
}

function randomSecret(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}

async function sha256(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  ).map((n) => n.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey() {
  const secret = Deno.env.get("WEBHOOK_ENCRYPTION_KEY");
  if (!secret) throw new Error("WEBHOOK_ENCRYPTION_KEY is not configured");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
}

async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(),
      encoder.encode(value),
    ),
  );
  const encode = (data: Uint8Array) => btoa(String.fromCharCode(...data));
  return `v1:${encode(iv)}:${encode(encrypted)}`;
}

async function webhookRoutes(request: Request, path: string) {
  if (path === "/v1/webhooks" && request.method === "GET") {
    const a = await actor(request);
    const { data, error } = await service.from("webhooks").select(
      "id,url,events,description,consecutive_failures,disabled_at,created_at",
    ).eq("user_id", a.userId).order("created_at", { ascending: false });
    if (error) throw error;
    return json(data ?? []);
  }
  if (path === "/v1/webhooks" && request.method === "POST") {
    const a = await actor(request);
    const input = await body(request);
    if (typeof input.url !== "string" || !input.url.startsWith("https://")) {
      return problem(400, "invalid_url", "webhook URL must use HTTPS");
    }
    const valid = new Set(["job.succeeded", "job.failed", "job.canceled"]);
    const events = Array.isArray(input.events) ? input.events : [...valid];
    if (
      !events.length ||
      events.some((event: unknown) => !valid.has(String(event)))
    ) return problem(400, "invalid_events", "unsupported webhook event");
    const secret = randomSecret();
    const { data, error } = await service.from("webhooks").insert({
      user_id: a.userId,
      url: input.url,
      events,
      description: typeof input.description === "string"
        ? input.description
        : null,
      secret_hash: await sha256(secret),
      secret_ciphertext: await encrypt(secret),
    }).select("id,url,events,description,created_at").single();
    if (error) throw error;
    return json({ ...data, secret }, 201);
  }
  const match = path.match(/^\/v1\/webhooks\/([0-9a-f-]+)$/i);
  if (match && request.method === "DELETE") {
    const a = await actor(request);
    const { error } = await service.from("webhooks").delete().eq("id", match[1])
      .eq("user_id", a.userId);
    if (error) throw error;
    return new Response(null, { status: 204, headers: cors });
  }
  return null;
}

async function adminRoutes(request: Request, path: string) {
  if (!path.startsWith("/v1/admin/")) return null;
  const a = await actor(request, true);
  const url = new URL(request.url);
  if (path === "/v1/admin/jobs" && request.method === "GET") {
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 200), 1),
      500,
    );
    let query = service.from("jobs").select(
      "id,user_id,type,status,payload,worker_id,created_at",
    ).is("deleted_at", null).order(
      "created_at",
      { ascending: false },
    ).order("id", { ascending: false }).limit(limit + 1);
    const status = url.searchParams.get("status");
    if (status) query = query.eq("status", status);
    const type = url.searchParams.get("type");
    if (type) query = query.eq("type", type);
    const userId = url.searchParams.get("user_id");
    if (userId) query = query.eq("user_id", userId);
    const workerId = url.searchParams.get("worker_id");
    if (workerId) query = query.eq("worker_id", workerId);
    const search = url.searchParams.get("search");
    if (search) {
      query = query.or(
        `payload->>prompt.ilike.%${
          search.replace(/[%_,()]/g, "")
        }%,payload->>text.ilike.%${search.replace(/[%_,()]/g, "")}%`,
      );
    }
    const after = url.searchParams.get("after");
    if (after) query = query.gte("created_at", after);
    const before = url.searchParams.get("before");
    if (before) query = query.lt("created_at", before);
    const tag = url.searchParams.get("tag");
    if (tag) query = query.contains("tags", [tag]);
    const cursorValue = url.searchParams.get("cursor");
    if (cursorValue) {
      const cursor = decodeCursor(cursorValue);
      if (!cursor) return problem(400, "invalid_cursor", "cursor is invalid");
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await query;
    if (error) throw error;
    const rows = data ?? [];
    const more = rows.length > limit;
    if (more) rows.pop();
    const services = await serviceAvailability();
    return json({
      data: explainJobs(rows, services),
      next_cursor: more && rows.length
        ? encodeCursor(rows[rows.length - 1]!)
        : null,
    });
  }
  const adminJobMatch = path.match(
    /^\/v1\/admin\/jobs\/([0-9a-f-]+)\/(cancel|rerun|retry)$/i,
  );
  if (adminJobMatch && request.method === "POST") {
    const [, id, action] = adminJobMatch;
    if (action === "cancel") {
      const { data, error } = await service.from("jobs").update({
        cancel_requested: true,
        status: "canceled",
        finished_at: new Date().toISOString(),
      }).eq("id", id).eq("status", "queued").select("id").maybeSingle();
      if (error) throw error;
      if (data) return json({ status: "canceled" });
      const running = await service.from("jobs").update({
        cancel_requested: true,
      }).eq("id", id).eq("status", "running").select("id").maybeSingle();
      if (running.error) throw running.error;
      return running.data
        ? json({ status: "running" })
        : problem(409, "not_cancelable", "job is already finished");
    }
    const { data: oldJob, error: ownerError } = await service.from("jobs")
      .select("user_id").eq("id", id).maybeSingle();
    if (ownerError) throw ownerError;
    const rerun = oldJob ? await rerunJob(oldJob.user_id, id) : null;
    if (!rerun) {
      return problem(409, "not_rerunnable", "job cannot be run again");
    }
    const services = await serviceAvailability();
    return json(explainJobs([rerun], services)[0], 201);
  }
  if (path === "/v1/admin/users" && request.method === "GET") {
    const page = Math.max(
      Number(new URL(request.url).searchParams.get("page") ?? 1),
      1,
    );
    const { data, error } = await service.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw error;
    const ids = data.users.map((user) => user.id);
    const { data: profiles } = ids.length
      ? await service.from("user_profiles").select("*").in("user_id", ids)
      : { data: [] as any[] };
    const byId = new Map(
      (profiles ?? []).map((profile: any) => [profile.user_id, profile]),
    );
    return json({
      data: data.users.map((user) => ({
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
        banned_until: (user as any).banned_until,
        profile: byId.get(user.id),
      })),
    });
  }
  if (path === "/v1/admin/users" && request.method === "POST") {
    const input = await body(request);
    if (typeof input.email !== "string") {
      return problem(400, "invalid_email", "email is required");
    }
    const temporaryPassword =
      typeof input.password === "string" && input.password.length >= 8
        ? input.password
        : randomSecret(18);
    const { data, error } = await service.auth.admin.createUser({
      email: input.email.trim().toLowerCase(),
      password: temporaryPassword,
      email_confirm: true,
    });
    if (error) throw error;
    await service.from("user_profiles").upsert({
      user_id: data.user.id,
      status: "invited",
      force_password_change: true,
      max_active_jobs: input.max_active_jobs ?? 100,
      daily_job_limit: input.daily_job_limit ?? 500,
      retention_days: input.retention_days ?? 30,
    });
    return json({
      id: data.user.id,
      email: data.user.email,
      temporary_password: temporaryPassword,
    }, 201);
  }
  const userMatch = path.match(
    /^\/v1\/admin\/users\/([0-9a-f-]+)\/(reset-password|disable|enable|delete)$/i,
  );
  if (userMatch && request.method === "POST") {
    const [, id, action] = userMatch;
    const input = await body(request);
    if (action === "reset-password") {
      const temporaryPassword =
        typeof input.password === "string" && input.password.length >= 8
          ? input.password
          : randomSecret(18);
      const { error } = await service.auth.admin.updateUserById(id, {
        password: temporaryPassword,
      });
      if (error) throw error;
      await service.from("api_keys").update({
        revoked_at: new Date().toISOString(),
      }).eq("user_id", id).is("revoked_at", null);
      await service.from("user_profiles").update({
        status: "invited",
        force_password_change: true,
        updated_at: new Date().toISOString(),
      }).eq("user_id", id);
      return json({ temporary_password: temporaryPassword });
    }
    if (action === "delete") {
      if (await isAdmin(id)) {
        return problem(
          409,
          "admin_account",
          "remove administrator access before deleting this account",
        );
      }
      const { data: existing, error: lookupError } = await service.auth.admin
        .getUserById(id);
      if (lookupError || !existing.user) {
        return problem(404, "not_found", "user not found");
      }
      await service.from("user_profiles").update({
        status: "disabled",
        updated_at: new Date().toISOString(),
      }).eq("user_id", id);
      const { error: banError } = await service.auth.admin.updateUserById(id, {
        ban_duration: "876000h",
      });
      if (banError) throw banError;
      await service.from("jobs").update({
        cancel_requested: true,
        status: "canceled",
        finished_at: new Date().toISOString(),
        lease_expires_at: null,
      }).eq("user_id", id).in("status", ["queued", "running"]);
      let objectsRemoved = 0;
      for (const bucket of ["inputs", "results"]) {
        objectsRemoved += await removeStoragePrefix(bucket, id);
      }
      const { error: deleteError } = await service.auth.admin.deleteUser(id);
      if (deleteError) throw deleteError;
      return json({ deleted: true, objects_removed: objectsRemoved });
    }
    const disabled = action === "disable";
    const { error } = await service.auth.admin.updateUserById(id, {
      ban_duration: disabled ? "876000h" : "none",
    });
    if (error) throw error;
    await service.from("user_profiles").update({
      status: disabled ? "disabled" : "active",
      updated_at: new Date().toISOString(),
    }).eq("user_id", id);
    return json({ disabled });
  }
  const profileMatch = path.match(/^\/v1\/admin\/users\/([0-9a-f-]+)$/i);
  if (profileMatch && request.method === "PATCH") {
    const input = await body(request);
    const update: Record<string, number> = {};
    for (
      const key of [
        "max_active_jobs",
        "daily_job_limit",
        "retention_days",
      ]
    ) if (Number.isInteger(input[key])) update[key] = input[key];
    const { data, error } = await service.from("user_profiles").update({
      ...update,
      updated_at: new Date().toISOString(),
    }).eq("user_id", profileMatch[1]).select().single();
    if (error) throw error;
    return json(data);
  }
  if (!a.jwt) {
    return problem(
      400,
      "session_required",
      "administrator operations require a login session",
    );
  }
  const adminClient = userClient(a.jwt);
  if (path === "/v1/admin/workers" && request.method === "GET") {
    return json(await rpc(adminClient, "admin_list_workers"));
  }
  if (path === "/v1/admin/workers" && request.method === "POST") {
    const input = await body(request);
    const created = await rpc(adminClient, "admin_create_worker", {
      p_id: input.id,
      p_name: input.name ?? input.id,
      p_pool_id: input.pool_id ?? "00000000-0000-0000-0000-000000000001",
    });
    const requestURL = request.url;
    const prefix = requestURL.slice(0, requestURL.indexOf("/v1/admin/workers"));
    created.env = `INFERSPOOL_URL=${prefix}\n${created.env}`;
    return json(created, 201);
  }
  const workerMatch = path.match(
    /^\/v1\/admin\/workers\/([a-z0-9_-]+)\/(rotate-token|disable|enable|revoke)$/,
  );
  if (workerMatch && request.method === "POST") {
    const [, id, action] = workerMatch;
    if (action === "rotate-token") {
      const token = await rpc(adminClient, "admin_rotate_worker_token", {
        p_worker_id: id,
      });
      return token
        ? json({ token })
        : problem(404, "not_found", "worker not found");
    }
    if (action === "revoke") {
      const changed = await rpc(adminClient, "admin_revoke_worker", {
        p_worker_id: id,
      });
      return changed
        ? json({ revoked: true })
        : problem(404, "not_found", "worker not found");
    }
    const changed = await rpc(adminClient, "admin_set_worker_disabled", {
      p_worker_id: id,
      p_disabled: action === "disable",
    });
    return changed
      ? json({ disabled: action === "disable" })
      : problem(404, "not_found", "worker not found");
  }
  if (path === "/v1/admin/metrics" && request.method === "GET") {
    return json(
      await rpc(adminClient, "admin_metrics", {
        p_hours: Number(new URL(request.url).searchParams.get("hours") ?? 24),
      }),
    );
  }
  return null;
}

async function handle(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  const url = new URL(request.url);
  const path = routePath(url);
  if (path === "/v1/health" && request.method === "GET") {
    return json({ ok: true, version: "v1" });
  }
  for (const handler of [sessionRoute, accountRoutes] as const) {
    const result = await handler(request, path);
    if (result) return result;
  }
  for (
    const handler of [
      inputRoute,
      workerRoutes,
      webhookRoutes,
      adminRoutes,
    ] as const
  ) {
    const result = await handler(request, path);
    if (result) return result;
  }
  const jobs = await jobRoutes(request, url, path);
  if (jobs) return jobs;
  return problem(404, "not_found", "route not found");
}

async function wakeMaintenance(path: string) {
  if (
    !(["/v1/workers/pending", "/v1/workers/complete", "/v1/workers/fail"]
      .includes(path) || path.startsWith("/v1/jobs"))
  ) return;
  const tasks: Promise<unknown>[] = [];
  const { data: reclaim } = await service.rpc("claim_maintenance", {
    p_name: "leases",
    p_interval_seconds: 10,
  });
  if (reclaim === true) {
    tasks.push(Promise.resolve(service.rpc("reclaim_expired_jobs")));
  }

  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) {
    if (tasks.length) await Promise.allSettled(tasks);
    return;
  }
  for (
    const item of [{ name: "webhooks", seconds: 10, fn: "webhook-dispatch" }, {
      name: "cleanup",
      seconds: 300,
      fn: "cleanup-results",
    }]
  ) {
    const { data } = await service.rpc("claim_maintenance", {
      p_name: item.name,
      p_interval_seconds: item.seconds,
    });
    if (data === true) {
      tasks.push(
        fetch(`${SUPABASE_URL}/functions/v1/${item.fn}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
        }).catch(console.error),
      );
    }
  }
  if (!tasks.length) return;
  await Promise.allSettled(tasks);
}

Deno.serve(async (request) => {
  try {
    const path = routePath(new URL(request.url));
    const response = await handle(request);
    if (response.status < 500) {
      const maintenance = wakeMaintenance(path);
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(maintenance);
      else await maintenance;
    }
    return response;
  } catch (error) {
    const status = errorStatus(error);
    console.error(error);
    const code = String(
      (error as any)?.code ??
        (status === 500 ? "internal_error" : "request_failed"),
    );
    return problem(
      status,
      code,
      status === 500 ? "request failed" : message(error),
    );
  }
});
