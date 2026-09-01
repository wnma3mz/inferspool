import { expect, type Page, test } from "@playwright/test";

const user = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "user@example.com",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function token() {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${
    encode({
      sub: user.id,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  }.signature`;
}

function job(id: string, status: string, prompt: string): any {
  return {
    id,
    user_id: user.id,
    type: "llm",
    status,
    stage: status === "queued"
      ? "waiting_for_capacity"
      : status === "running"
      ? "generating"
      : status === "succeeded"
      ? "completed"
      : status,
    priority: 0,
    payload: { prompt },
    result: null,
    progress: null,
    progress_msg: null,
    error: status === "failed" ? "test failure" : null,
    attempts: 1,
    max_attempts: 3,
    worker_id: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: ["succeeded", "failed", "canceled"].includes(status)
      ? new Date().toISOString()
      : null,
    source_job_id: null,
    retained_until: null,
    tags: [],
  };
}

async function installRealtimeMock(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: any[] = [];
    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      CONNECTING = 0;
      OPEN = 1;
      CLOSING = 2;
      CLOSED = 3;
      readyState = 0;
      url = "";
      protocol = "";
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      constructor(url: string, protocols?: string | string[]) {
        if (!String(url).includes("supabase.test/realtime")) {
          return new NativeWebSocket(url, protocols as string[]) as any;
        }
        this.url = url;
        sockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        }, 0);
      }
      send(data: string | ArrayBuffer) {
        if (typeof data !== "string") return;
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) return;
        const [joinRef, ref, topic, event] = parsed;
        if (
          event === "phx_join" || event === "heartbeat" ||
          event === "access_token"
        ) {
          setTimeout(
            () =>
              this.onmessage?.({
                data: JSON.stringify([joinRef, ref, topic, "phx_reply", {
                  status: "ok",
                  response: {},
                }]),
              }),
            0,
          );
        }
      }
      close() {
        this.readyState = 3;
        this.onclose?.(new CloseEvent("close"));
      }
      addEventListener(type: string, listener: any) {
        (this as any)[`on${type}`] = listener;
      }
      removeEventListener(type: string, listener: any) {
        if ((this as any)[`on${type}`] === listener) {
          (this as any)[`on${type}`] = null;
        }
      }
    }
    (window as any).WebSocket = MockWebSocket;
    (window as any).__realtimeConnected = () =>
      sockets.some((socket) => socket.readyState === 1);
    (window as any).__realtimeBroadcast = () =>
      sockets.forEach((socket) =>
        socket.onmessage?.({
          data: JSON.stringify([
            null,
            null,
            "realtime:user:11111111-1111-1111-1111-111111111111",
            "broadcast",
            { event: "UPDATE", payload: {} },
          ]),
        })
      );
  });
}

async function mockBackend(page: Page, forcePassword = false) {
  const failed = job(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "failed",
    "retry target",
  );
  failed.worker_id = "home-4090";
  const finished = job(
    "dddddddd-dddd-dddd-dddd-dddddddddddd",
    "succeeded",
    "result target",
  );
  finished.result = {
    text: "generated answer",
    file: {
      bucket: "results",
      path: `${user.id}/${finished.id}/result.png`,
      filename: "result.png",
      mime: "image/png",
      bytes: 68,
    },
  };
  const jobs: any[] = [failed, finished];
  const state = {
    jobs,
    forcePassword,
    submittedPayload: null as any,
    uploaded: false,
    passwordChanged: false,
    invited: false,
    workerCreated: false,
    workerRevoked: false,
    userDeleted: false,
    adminJobWorkerFilter: null as string | null,
  };
  const invited = {
    id: "22222222-2222-2222-2222-222222222222",
    email: "invite@example.com",
    created_at: new Date().toISOString(),
    last_sign_in_at: null,
    profile: {
      status: "invited",
      force_password_change: true,
      max_active_jobs: 100,
      daily_job_limit: 500,
      retention_days: 30,
    },
  };
  const worker = {
    id: "home-4090",
    name: "home-4090",
    disabled_at: null,
    last_heartbeat: null,
    services: [],
  };
  await page.route("http://supabase.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/v1/token")) {
      await route.fulfill({
        json: {
          access_token: token(),
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: "refresh-token",
          user,
        },
      });
      return;
    }
    if (path.endsWith("/auth/v1/user")) {
      await route.fulfill({ json: user });
      return;
    }
    await route.fulfill({ status: 200, json: {} });
  });
  await page.route("http://storage.test/**", async (route) => {
    state.uploaded = route.request().method() === "PUT" || state.uploaded;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw5nAAAAAElFTkSuQmCC",
      "base64",
    );
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route("http://worker.test/**", async (route) => {
    await route.fulfill({
      status: 206,
      headers: {
        "access-control-allow-origin": "*",
        "content-range": "bytes 0-0/1",
      },
      contentType: "image/png",
      body: Buffer.from([0]),
    });
  });
  await page.route("http://api.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/v1/, "");
    const fulfill = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/me" && request.method() === "GET") {
      return fulfill({
        id: user.id,
        email: user.email,
        admin: true,
        profile: {
          status: "active",
          force_password_change: state.forcePassword,
        },
      });
    }
    if (path === "/me/password") {
      state.passwordChanged = true;
      state.forcePassword = false;
      return fulfill({ changed: true });
    }
    if (path === "/status") {
      return fulfill({
        queued: jobs.filter((item) => item.status === "queued").length,
        running: 0,
        workers_online: 1,
        services: {
          llm: { up: 1, total: 1, capacity: 1, queued: 0 },
          image: { up: 1, total: 1, capacity: 1, queued: 0 },
        },
        direct: { image: 1 },
        workers: [],
      });
    }
    if (path === "/inputs") {
      return fulfill({
        bucket: "inputs",
        path: `${user.id}/input/image.png`,
        filename: "image.png",
        mime: "image/png",
        signed_url: "http://storage.test/upload",
      }, 201);
    }
    if (path === "/jobs" && request.method() === "GET") {
      const search = url.searchParams.get("search")?.toLowerCase();
      const filtered = search
        ? jobs.filter((item) =>
          String(item.payload.prompt || item.payload.text).toLowerCase()
            .includes(search)
        )
        : jobs;
      return fulfill({ data: filtered, next_cursor: null });
    }
    if (path === "/jobs" && request.method() === "POST") {
      const input = request.postDataJSON();
      state.submittedPayload = input.payload;
      const created = job(
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "queued",
        input.payload.prompt,
      );
      created.payload = input.payload;
      jobs.unshift(created);
      return fulfill(created, 201);
    }
    const jobAction = path.match(
      /^\/jobs\/([0-9a-f-]+)(?:\/(cancel|rerun|result))?$/,
    );
    if (jobAction) {
      const [, id, action] = jobAction;
      const item = jobs.find((value) => value.id === id);
      if (action === "cancel") {
        item.status = "canceled";
        item.stage = "canceled";
        item.finished_at = new Date().toISOString();
        return fulfill({ status: "canceled" });
      }
      if (action === "rerun") {
        const created = job(
          "cccccccc-cccc-cccc-cccc-cccccccccccc",
          "queued",
          item.payload.prompt,
        );
        created.source_job_id = id;
        jobs.unshift(created);
        return fulfill(created, 201);
      }
      if (action === "result") {
        return fulfill({
          url: "http://storage.test/result.png",
          expires_in: 3600,
        });
      }
      if (!action && request.method() === "DELETE") {
        jobs.splice(jobs.indexOf(item), 1);
        return fulfill({ deletion_requested: true }, 202);
      }
    }
    if (path === "/keys" && request.method() === "GET") return fulfill([]);
    if (path === "/keys" && request.method() === "POST") {
      return fulfill("inferspool_test_once", 201);
    }
    if (path === "/admin/metrics") {
      return fulfill({
        hours: 24,
        queued: 0,
        running: 0,
        workers_online: 1,
        storage_bytes: 68,
        service_failures: 0,
        by_type: {
          llm: {
            total: 2,
            succeeded: 1,
            failed: 1,
            success_rate: 50,
            avg_queue_seconds: 1,
            avg_run_seconds: 2,
          },
        },
      });
    }
    if (path === "/admin/jobs") {
      state.adminJobWorkerFilter = url.searchParams.get("worker_id");
      const data = state.adminJobWorkerFilter &&
          failed.worker_id !== state.adminJobWorkerFilter
        ? []
        : [failed];
      return fulfill({ data, next_cursor: null });
    }
    if (/\/admin\/jobs\/.+\/rerun$/.test(path)) {
      return fulfill(
        job("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "queued", "retry target"),
        201,
      );
    }
    if (path === "/admin/users" && request.method() === "GET") {
      return fulfill({
        data: state.invited && !state.userDeleted ? [invited] : [],
      });
    }
    if (path === "/admin/users" && request.method() === "POST") {
      state.invited = true;
      return fulfill({
        id: invited.id,
        email: invited.email,
        temporary_password: "temporary-secret",
      }, 201);
    }
    if (/\/admin\/users\/.+\/delete$/.test(path)) {
      state.userDeleted = true;
      return fulfill({ deleted: true, objects_removed: 2 });
    }
    if (/\/admin\/users\/.+\/(reset-password|disable|enable)$/.test(path)) {
      return fulfill({ temporary_password: "reset-secret" });
    }
    if (
      /\/admin\/users\/[0-9a-f-]+$/.test(path) && request.method() === "PATCH"
    ) return fulfill(invited.profile);
    if (path === "/admin/workers" && request.method() === "GET") {
      return fulfill([worker]);
    }
    if (path === "/admin/workers" && request.method() === "POST") {
      state.workerCreated = true;
      return fulfill({
        env:
          "INFERSPOOL_URL=http://api.test\nINFERSPOOL_WORKER_ID=home-4090\nINFERSPOOL_WORKER_TOKEN=worker-secret\n",
      }, 201);
    }
    if (/\/admin\/workers\/.+\/rotate-token$/.test(path)) {
      return fulfill({ token: "rotated-secret" });
    }
    if (/\/admin\/workers\/.+\/revoke$/.test(path)) {
      state.workerRevoked = true;
      return fulfill({ revoked: true });
    }
    if (/\/admin\/workers\/.+\/(disable|enable)$/.test(path)) {
      return fulfill({ disabled: true });
    }
    return fulfill({ error: { code: "not_found", message: path } }, 404);
  });
  return state;
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("邮箱地址").fill(user.email);
  await page.getByLabel("密码").fill("temporary-password");
  await page.getByRole("button", { name: "登录" }).click();
}

test("user job lifecycle, results, multimodal input and realtime refresh", async ({ page }) => {
  await installRealtimeMock(page);
  const state = await mockBackend(page);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "今天想运行什么？" }))
    .toBeVisible();
  await expect(page.getByText("generated answer")).toBeVisible();
  await expect(
    page.locator('img[src="http://storage.test/result.png"]').first(),
  ).toBeVisible();

  const imageInput = page.locator('input[type="file"]');
  await imageInput.setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from("image fixture"),
  });
  await page.getByLabel("任务内容").fill("browser multimodal test");
  await page.getByRole("button", { name: "提交任务" }).click();
  await expect(page.locator("#history").getByText("browser multimodal test"))
    .toBeVisible();
  expect(state.uploaded).toBeTruthy();
  expect(state.submittedPayload.images).toHaveLength(1);

  const submitted = state.jobs.find((item) => item.id.startsWith("bbbb"));
  submitted.status = "succeeded";
  submitted.result = { text: "realtime answer" };
  submitted.finished_at = new Date().toISOString();
  await expect.poll(() =>
    page.evaluate(() => (window as any).__realtimeConnected())
  ).toBeTruthy();
  await page.evaluate(() => (window as any).__realtimeBroadcast());
  await expect(page.getByText("realtime answer")).toBeVisible({
    timeout: 1500,
  });

  const failedRow = page.locator(".task-row").filter({
    hasText: "retry target",
  });
  await failedRow.getByRole("button", { name: "再次运行" }).click();
  await expect(page.locator(".task-row").filter({ hasText: "retry target" }))
    .toHaveCount(2);
  const resultRow = page.locator(".task-row").filter({
    hasText: "result target",
  });
  await expect(resultRow.getByRole("button", { name: "再次运行" }))
    .toBeVisible();
  await resultRow.getByRole("button", { name: "删除" }).click();
  await expect(page.locator(".task-row").filter({ hasText: "result target" }))
    .toHaveCount(0);

  const queuedRow = page.locator(".task-row").filter({
    hasText: "retry target",
  }).filter({ hasText: "等待空闲容量" });
  await queuedRow.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.locator(".task-row").filter({ hasText: "retry target" }).filter({
      hasText: "已取消",
    }),
  ).toBeVisible();
});

test("file jobs can request LAN direct delivery", async ({ page }) => {
  await installRealtimeMock(page);
  const state = await mockBackend(page);
  await signIn(page);
  await page.getByRole("tab", { name: "图片生成" }).click();
  await page.getByLabel("任务内容").fill("LAN image");
  await page.getByLabel("当前设备临时获取").check();
  await expect(page.getByText(/生成文件不会上传云端/)).toBeVisible();
  await page.getByRole("button", { name: "提交任务" }).click();
  await expect.poll(() => state.submittedPayload?._result_delivery).toBe(
    "direct",
  );
});

test("jobs explain waits and temporary result availability", async ({ page }) => {
  await installRealtimeMock(page);
  const state = await mockBackend(page);
  const waiting = job(
    "12121212-1212-1212-1212-121212121212",
    "queued",
    "waiting image",
  );
  waiting.type = "image";
  waiting.stage = "waiting_for_service";
  const temporary = job(
    "34343434-3434-3434-3434-343434343434",
    "succeeded",
    "temporary image",
  );
  temporary.type = "image";
  temporary.result = {
    artifacts: [{
      kind: "image",
      url: "http://worker.test/result/token",
      filename: "result.png",
      mime: "image/png",
      bytes: 1,
      delivery: "direct",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }],
  };
  state.jobs.unshift(waiting, temporary);
  await signIn(page);

  await expect(page.getByText("等待模型服务启动或恢复")).toBeVisible();
  const temporaryRow = page.locator(".task-row").filter({
    hasText: "temporary image",
  });
  await expect(temporaryRow.getByText(/当前设备临时文件/)).toBeVisible();
  await expect(temporaryRow.getByRole("button", { name: "再次运行" }))
    .toBeVisible();
  await expect(temporaryRow.getByRole("button", { name: "删除" })).toBeVisible();

  await page.getByRole("tab", { name: "图片生成" }).click();
  await expect(page.getByText("高级设置")).toBeVisible();
  await expect(page.getByLabel("推理步数")).not.toBeVisible();
});

test("expired temporary results can be generated again", async ({ page }) => {
  await installRealtimeMock(page);
  const state = await mockBackend(page);
  const temporary = job(
    "56565656-5656-5656-5656-565656565656",
    "succeeded",
    "expired image",
  );
  temporary.type = "image";
  temporary.payload = { prompt: "expired image", _result_delivery: "direct" };
  temporary.result = {
    artifacts: [{
      kind: "image",
      url: "http://worker.test/result/expired",
      filename: "result.png",
      mime: "image/png",
      bytes: 1,
      delivery: "direct",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }],
  };
  state.jobs.unshift(temporary);
  await signIn(page);

  const row = page.locator(".task-row").filter({ hasText: "expired image" });
  await expect(row.getByText("临时文件已过期")).toBeVisible();
  await row.getByRole("button", { name: "再次运行" }).click();
  await expect.poll(() => state.jobs[0]?.source_job_id).toBe(temporary.id);
});

test("invited account changes password before entering workspace", async ({ page }) => {
  await installRealtimeMock(page);
  const state = await mockBackend(page, true);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "设置新密码" })).toBeVisible();
  await page.getByLabel("新密码").fill("new-password");
  await page.getByLabel("确认密码").fill("new-password");
  await page.getByRole("button", { name: "保存并继续" }).click();
  await expect(page.getByRole("heading", { name: "今天想运行什么？" }))
    .toBeVisible();
  expect(state.passwordChanged).toBeTruthy();
});

test("API keys and administrator product controls", async ({ page }) => {
  await installRealtimeMock(page);
  const state = await mockBackend(page);
  await signIn(page);
  await page.getByRole("button", { name: "CLI 密钥" }).click();
  await page.getByLabel("密钥名称").fill("browser test");
  await page.getByRole("button", { name: "创建密钥" }).click();
  await expect(page.getByText("inferspool_test_once")).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "管理" }).click();
  const admin = page.getByRole("main", { name: "InferSpool 管理台" });
  await expect(page.getByRole("dialog", { name: "InferSpool 管理台" }))
    .toHaveCount(0);
  await expect(admin.getByRole("heading", { name: "InferSpool 管理台" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "返回工作区" })).toBeVisible();
  await expect(admin.getByText("过去 24 小时")).toBeVisible();
  await admin.getByRole("button", { name: "任务", exact: true }).click();
  const workerFilter = admin.getByLabel("筛选 GPU 节点");
  await expect(workerFilter).toContainText("home-4090");
  await workerFilter.selectOption("home-4090");
  await expect.poll(() => state.adminJobWorkerFilter).toBe("home-4090");
  await admin.getByRole("button", { name: "再次运行" }).click();

  await admin.getByRole("button", { name: "用户", exact: true }).click();
  await admin.getByPlaceholder("user@example.com").fill("invite@example.com");
  await admin.getByRole("button", { name: "创建账号" }).click();
  await expect(admin.getByText("temporary-secret")).toBeVisible();
  const userActions = admin.locator(".users-table tbody tr").first()
    .locator(".admin-actions button");
  await expect(userActions).toHaveCount(4);
  await expect.poll(async () => {
    const tops = await userActions.evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().top))
    );
    return new Set(tops).size;
  }).toBe(1);
  await admin.locator(".admin-secret").getByRole("button").first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await admin.getByRole("button", { name: "删除", exact: true }).click();
  expect(state.userDeleted).toBeTruthy();

  await admin.getByRole("button", { name: "GPU 节点", exact: true }).click();
  const workerActions = admin.locator(".workers-table tbody tr").first()
    .locator(".admin-actions button");
  await expect(workerActions).toHaveCount(3);
  await expect.poll(async () => {
    const tops = await workerActions.evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().top))
    );
    return new Set(tops).size;
  }).toBe(1);
  await admin.getByPlaceholder("home-4090").fill("home-4090");
  await admin.getByRole("button", { name: "创建节点" }).click();
  await expect(admin.getByText("worker-secret")).toBeVisible();
  expect(state.workerCreated).toBeTruthy();
  await admin.locator(".admin-secret").getByRole("button").first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await admin.getByRole("button", { name: "撤销", exact: true }).click();
  expect(state.workerRevoked).toBeTruthy();
  await page.getByRole("button", { name: "返回工作区" }).click();
  await expect(page.getByRole("heading", { name: "今天想运行什么？" }))
    .toBeVisible();
});

test("administrator workspace adapts to mobile navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRealtimeMock(page);
  await mockBackend(page);
  await signIn(page);
  await page.getByRole("button", { name: "管理" }).click();

  const admin = page.getByRole("main", { name: "InferSpool 管理台" });
  await expect(admin).toBeVisible();
  await expect(page.getByRole("button", { name: "返回工作区" })).toBeVisible();
  await expect(admin.getByRole("button", { name: "GPU 节点" })).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBeTruthy();
});

test("language and theme use separate controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "切换为英文" }).first())
    .toBeVisible();
  const theme = page.getByRole("button", { name: /显示主题/ }).first();
  await expect(theme)
    .toBeVisible();
  await theme.click();
  await expect.poll(() => page.locator("html").getAttribute("data-theme"))
    .toBe("light");
  await theme.click();
  await expect.poll(() => page.locator("html").getAttribute("data-theme"))
    .toBe("dark");
  await page.getByRole("button", { name: "切换为英文" }).first().click();
  await expect(page.getByRole("heading", { name: "Welcome back" }))
    .toBeVisible();
});
