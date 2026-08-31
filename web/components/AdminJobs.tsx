"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, jsonBody } from "../lib/api";
import type { Job, JobStatus } from "../lib/types";
import { Icon } from "./Icons";
import { usePreferences } from "./Preferences";

type Tab = "overview" | "jobs" | "users" | "workers";
interface AdminUser {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  profile?: {
    status: string;
    force_password_change: boolean;
    max_active_jobs: number;
    daily_job_limit: number;
    max_priority: number;
    retention_days: number;
  };
}
interface AdminWorker {
  id: string;
  name: string;
  capabilities: string[];
  disabled_at: string | null;
  last_heartbeat: string | null;
  services: { type: string; healthy: boolean; detail?: string }[];
}
interface Metrics {
  hours: number;
  queued: number;
  running: number;
  workers_online: number;
  storage_bytes: number;
  service_failures: number;
  by_type: Record<
    string,
    {
      total: number;
      succeeded: number;
      failed: number;
      success_rate: number | null;
      avg_queue_seconds: number | null;
      avg_run_seconds: number | null;
    }
  >;
}

const terminal = new Set<JobStatus>(["succeeded", "failed", "canceled"]);
const labels: Record<Tab, [string, string]> = {
  overview: ["概览", "Overview"],
  jobs: ["任务", "Jobs"],
  users: ["用户", "Users"],
  workers: ["GPU 节点", "GPU workers"],
};

export function AdminJobs() {
  const { language } = usePreferences();
  const zh = language === "zh";
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => {
    void api<{ admin: boolean }>("/me").then((value) => setAllowed(value.admin))
      .catch(() => setAllowed(false));
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  if (!allowed) return null;
  return (
    <>
      <button className="topbar-button" onClick={() => setOpen(true)}>
        <Icon name="admin" />
        <span>{zh ? "管理" : "Admin"}</span>
      </button>
      {open && typeof document !== "undefined" &&
        createPortal(
          <div
            className="modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <section
              className="modal admin-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="admin-title"
            >
              <div className="modal-header">
                <div className="modal-title">
                  <span className="modal-icon admin">
                    <Icon name="admin" />
                  </span>
                  <div>
                    <h2 id="admin-title">
                      {zh ? "InferSpool 管理台" : "InferSpool administration"}
                    </h2>
                    <p>
                      {zh
                        ? "用户、任务、共享 GPU 与运行状态。"
                        : "Users, jobs, shared GPUs and operations."}
                    </p>
                  </div>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setOpen(false)}
                  aria-label={zh ? "关闭" : "Close"}
                >
                  <Icon name="close" />
                </button>
              </div>
              <nav className="admin-tabs">
                {(Object.keys(labels) as Tab[]).map((value) => (
                  <button
                    key={value}
                    className={tab === value ? "active" : ""}
                    onClick={() => setTab(value)}
                  >
                    {labels[value][zh ? 0 : 1]}
                  </button>
                ))}
              </nav>
              <div className="admin-content">
                {tab === "overview"
                  ? <Overview zh={zh} />
                  : tab === "jobs"
                  ? <Jobs zh={zh} />
                  : tab === "users"
                  ? <Users zh={zh} />
                  : <Workers zh={zh} />}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

function Overview({ zh }: { zh: boolean }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Metrics>("/admin/metrics?hours=24").then(setMetrics).catch((e) =>
      setError(e.message)
    );
  }, []);
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!metrics) {
    return <div className="admin-empty">{zh ? "加载中…" : "Loading…"}</div>;
  }
  return (
    <>
      <div className="admin-metrics">
        <Metric label={zh ? "排队" : "Queued"} value={metrics.queued} />
        <Metric label={zh ? "运行中" : "Running"} value={metrics.running} />
        <Metric
          label={zh ? "在线节点" : "Workers online"}
          value={metrics.workers_online}
        />
        <Metric
          label={zh ? "服务失败（24h）" : "Service failures (24h)"}
          value={metrics.service_failures}
        />
        <Metric
          label={zh ? "结果存储" : "Result storage"}
          value={formatBytes(metrics.storage_bytes)}
        />
      </div>
      <div className="admin-panel-heading">
        <strong>{zh ? "过去 24 小时" : "Past 24 hours"}</strong>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table metrics-table">
          <thead>
            <tr>
              <th>{zh ? "类型" : "Type"}</th>
              <th>{zh ? "任务" : "Jobs"}</th>
              <th>{zh ? "成功率" : "Success"}</th>
              <th>{zh ? "平均排队" : "Avg queue"}</th>
              <th>{zh ? "平均运行" : "Avg run"}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(metrics.by_type || {}).map(([type, value]) => (
              <tr key={type}>
                <td>
                  <strong>{type}</strong>
                </td>
                <td>{value.total}</td>
                <td>
                  {value.success_rate == null ? "—" : `${value.success_rate}%`}
                </td>
                <td>{seconds(value.avg_queue_seconds)}</td>
                <td>{seconds(value.avg_run_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Jobs({ zh }: { zh: boolean }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [userId, setUserId] = useState("");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  const queryString = useCallback((cursor?: string | null) => {
    const query = new URLSearchParams({ limit: "100" });
    if (status) query.set("status", status);
    if (type) query.set("type", type);
    if (userId) query.set("user_id", userId);
    if (search) query.set("search", search);
    if (tag) query.set("tag", tag);
    if (after) query.set("after", new Date(`${after}T00:00:00`).toISOString());
    if (before) {
      query.set("before", new Date(`${before}T23:59:59.999`).toISOString());
    }
    if (cursor) query.set("cursor", cursor);
    return query;
  }, [status, type, userId, search, tag, after, before]);
  const refresh = useCallback(async () => {
    try {
      const page = await api<{ data: Job[]; next_cursor: string | null }>(
        `/admin/jobs?${queryString()}`,
      );
      setJobs(page.data);
      setNextCursor(page.next_cursor);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [queryString]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void api<{ data: AdminUser[] }>("/admin/users").then((value) =>
      setUsers(value.data)
    ).catch(() => undefined);
  }, []);
  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const page = await api<{ data: Job[]; next_cursor: string | null }>(
        `/admin/jobs?${queryString(nextCursor)}`,
      );
      setJobs((current) => [...current, ...page.data]);
      setNextCursor(page.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const act = async (job: Job) => {
    setActing(job.id);
    try {
      await api(
        `/admin/jobs/${job.id}/${
          terminal.has(job.status) ? "retry" : "cancel"
        }`,
        { method: "POST", body: "{}" },
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing("");
    }
  };
  return (
    <>
      <div className="admin-toolbar admin-job-filters">
        <div className="filter-field">
          <label>{zh ? "状态" : "Status"}</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{zh ? "全部" : "All"}</option>
            {["queued", "running", "succeeded", "failed", "canceled"].map((
              v,
            ) => <option key={v}>{v}</option>)}
          </select>
        </div>
        <div className="filter-field">
          <label>{zh ? "类型" : "Type"}</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{zh ? "全部" : "All"}</option>
            {["llm", "image", "video", "tts"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label>{zh ? "用户" : "User"}</label>
          <select
            aria-label={zh ? "筛选用户" : "Filter user"}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">{zh ? "全部用户" : "All users"}</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>{user.email}</option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label>{zh ? "搜索" : "Search"}</label>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={zh ? "提示词" : "Prompt"}
          />
        </div>
        <div className="filter-field">
          <label>{zh ? "标签" : "Tag"}</label>
          <input
            aria-label={zh ? "筛选标签" : "Filter tag"}
            value={tag}
            onChange={(e) => setTag(e.target.value.trim())}
            placeholder={zh ? "标签" : "Tag"}
          />
        </div>
        <div className="filter-field">
          <label>{zh ? "开始日期" : "Start date"}</label>
          <input
            aria-label={zh ? "管理员开始日期" : "Admin start date"}
            type="date"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
        </div>
        <div className="filter-field">
          <label>{zh ? "结束日期" : "End date"}</label>
          <input
            aria-label={zh ? "管理员结束日期" : "Admin end date"}
            type="date"
            value={before}
            onChange={(e) => setBefore(e.target.value)}
          />
        </div>
        <button
          className="button-secondary admin-refresh"
          onClick={() => void refresh()}
        >
          <Icon name="refresh" />
          {zh ? "刷新" : "Refresh"}
        </button>
      </div>
      {error && <div className="alert alert-error admin-alert">{error}</div>}
      <div className="admin-summary">
        <span>
          <strong>{jobs.length}</strong> {zh ? "个任务" : "jobs"}
        </span>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{zh ? "任务" : "Job"}</th>
              <th>{zh ? "用户" : "User"}</th>
              <th>{zh ? "创建时间" : "Created"}</th>
              <th>{zh ? "状态" : "Status"}</th>
              <th>{zh ? "节点" : "Worker"}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <strong>
                    {String(job.payload.prompt || job.payload.text || job.type)}
                  </strong>
                  <small>{job.type} · {job.id.slice(0, 8)}</small>
                </td>
                <td>
                  <code>
                    {users.find((user) => user.id === job.user_id)?.email ||
                      `${job.user_id.slice(0, 8)}…`}
                  </code>
                </td>
                <td>
                  {new Date(job.created_at).toLocaleString(zh ? "zh-CN" : "en")}
                </td>
                <td>
                  <span className={`status-pill ${job.status}`}>
                    <i />
                    {job.status}
                  </span>
                </td>
                <td>{job.worker_id || "—"}</td>
                <td>
                  <button
                    className={`table-action ${
                      terminal.has(job.status) ? "" : "danger"
                    }`}
                    disabled={acting === job.id}
                    onClick={() => void act(job)}
                  >
                    {terminal.has(job.status)
                      ? (zh ? "重试" : "Retry")
                      : (zh ? "取消" : "Cancel")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {nextCursor && (
          <button
            className="button-secondary load-more"
            onClick={() => void loadMore()}
          >
            {zh ? "加载更多" : "Load more"}
          </button>
        )}
      </div>
    </>
  );
}

function Users({ zh }: { zh: boolean }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [credential, setCredential] = useState("");
  const refresh = async () => {
    try {
      setUsers((await api<{ data: AdminUser[] }>("/admin/users")).data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const invite = async () => {
    try {
      const value = await api<{ email: string; temporary_password: string }>(
        "/admin/users",
        { method: "POST", body: jsonBody({ email }) },
      );
      setCredential(`${value.email}\n${value.temporary_password}`);
      setEmail("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const action = async (
    user: AdminUser,
    name: "reset-password" | "disable" | "enable" | "delete",
  ) => {
    if (
      name === "delete" && !window.confirm(
        zh
          ? `永久删除 ${user.email} 及其任务和文件？`
          : `Permanently delete ${user.email}, including jobs and files?`,
      )
    ) return;
    try {
      const value = await api<{ temporary_password?: string }>(
        `/admin/users/${user.id}/${name}`,
        { method: "POST", body: "{}" },
      );
      if (value.temporary_password) {
        setCredential(`${user.email}\n${value.temporary_password}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const editQuota = async (user: AdminUser) => {
    const current = user.profile;
    const active = window.prompt(
      zh ? "最大排队/运行任务数" : "Maximum active jobs",
      String(current?.max_active_jobs ?? 100),
    );
    if (active == null) return;
    const daily = window.prompt(
      zh ? "每日任务额度" : "Daily job limit",
      String(current?.daily_job_limit ?? 500),
    );
    if (daily == null) return;
    const priority = window.prompt(
      zh ? "普通用户最高优先级（0-10）" : "Maximum priority (0-10)",
      String(current?.max_priority ?? 5),
    );
    if (priority == null) return;
    const retention = window.prompt(
      zh ? "默认保留天数" : "Default retention days",
      String(current?.retention_days ?? 30),
    );
    if (retention == null) return;
    const values = [active, daily, priority, retention].map(Number);
    if (values.some((value) => !Number.isInteger(value))) {
      setError(zh ? "配额必须是整数。" : "Quota values must be integers.");
      return;
    }
    try {
      await api(`/admin/users/${user.id}`, {
        method: "PATCH",
        body: jsonBody({
          max_active_jobs: values[0],
          daily_job_limit: values[1],
          max_priority: values[2],
          retention_days: values[3],
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="admin-create">
        <div>
          <label>{zh ? "邀请用户" : "Invite user"}</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
          />
        </div>
        <button
          className="button-primary"
          disabled={!email.includes("@")}
          onClick={() => void invite()}
        >
          {zh ? "创建账号" : "Create account"}
        </button>
      </div>
      {credential && (
        <SecretBox
          zh={zh}
          value={credential}
          onClose={() => setCredential("")}
        />
      )}
      {error && <div className="alert alert-error admin-alert">{error}</div>}
      <div className="admin-table-wrap">
        <table className="admin-table users-table">
          <thead>
            <tr>
              <th>{zh ? "账号" : "Account"}</th>
              <th>{zh ? "状态" : "Status"}</th>
              <th>{zh ? "活跃/日额度" : "Active / daily"}</th>
              <th>{zh ? "优先级/保留" : "Priority / retention"}</th>
              <th>{zh ? "最近登录" : "Last sign-in"}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.email}</strong>
                  <small>{user.id.slice(0, 8)}</small>
                </td>
                <td>
                  {user.profile?.status || "active"}
                  {user.profile?.force_password_change
                    ? ` · ${zh ? "待改密" : "password pending"}`
                    : ""}
                </td>
                <td>
                  {user.profile?.max_active_jobs ?? 100} /{" "}
                  {user.profile?.daily_job_limit ?? 500}
                </td>
                <td>
                  {user.profile?.max_priority ?? 5} /{" "}
                  {user.profile?.retention_days ?? 30}d
                </td>
                <td>
                  {user.last_sign_in_at
                    ? new Date(user.last_sign_in_at).toLocaleString(
                      zh ? "zh-CN" : "en",
                    )
                    : "—"}
                </td>
                <td className="admin-actions">
                  <button
                    className="table-action"
                    onClick={() => void editQuota(user)}
                  >
                    {zh ? "配额" : "Quota"}
                  </button>
                  <button
                    className="table-action"
                    onClick={() => void action(user, "reset-password")}
                  >
                    {zh ? "重置密码" : "Reset"}
                  </button>
                  <button
                    className="table-action danger"
                    onClick={() =>
                      void action(
                        user,
                        user.profile?.status === "disabled"
                          ? "enable"
                          : "disable",
                      )}
                  >
                    {user.profile?.status === "disabled"
                      ? (zh ? "启用" : "Enable")
                      : (zh ? "禁用" : "Disable")}
                  </button>
                  <button
                    className="table-action danger"
                    onClick={() => void action(user, "delete")}
                  >
                    {zh ? "删除" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Workers({ zh }: { zh: boolean }) {
  const [workers, setWorkers] = useState<AdminWorker[]>([]);
  const [id, setId] = useState("");
  const [types, setTypes] = useState("llm");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      setWorkers(await api<AdminWorker[]>("/admin/workers"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const create = async () => {
    try {
      const value = await api<{ env: string }>("/admin/workers", {
        method: "POST",
        body: jsonBody({
          id,
          name: id,
          types: types.split(",").map((v) => v.trim()).filter(Boolean),
        }),
      });
      setSecret(value.env);
      setId("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const action = async (
    worker: AdminWorker,
    name: "rotate-token" | "disable" | "enable" | "revoke",
  ) => {
    if (
      name === "revoke" && !window.confirm(
        zh
          ? `撤销 ${worker.id} 的令牌并禁用节点？`
          : `Revoke ${worker.id}'s token and disable it?`,
      )
    ) return;
    try {
      const value = await api<{ token?: string }>(
        `/admin/workers/${worker.id}/${name}`,
        { method: "POST", body: "{}" },
      );
      if (value.token) {
        setSecret(
          `INFERSPOOL_WORKER_ID=${worker.id}\nINFERSPOOL_WORKER_TOKEN=${value.token}\n`,
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="admin-create worker-create">
        <div>
          <label>{zh ? "节点 ID" : "Worker ID"}</label>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder="home-4090"
          />
        </div>
        <div>
          <label>{zh ? "能力（逗号分隔）" : "Capabilities"}</label>
          <input
            value={types}
            onChange={(e) => setTypes(e.target.value)}
            placeholder="llm,image"
          />
        </div>
        <button
          className="button-primary"
          disabled={id.length < 3}
          onClick={() => void create()}
        >
          {zh ? "创建节点" : "Create worker"}
        </button>
      </div>
      {secret && (
        <SecretBox
          zh={zh}
          value={secret}
          onClose={() => setSecret("")}
        />
      )}
      {error && <div className="alert alert-error admin-alert">{error}</div>}
      <div className="admin-table-wrap">
        <table className="admin-table workers-table">
          <thead>
            <tr>
              <th>{zh ? "节点" : "Worker"}</th>
              <th>{zh ? "能力" : "Capabilities"}</th>
              <th>{zh ? "服务" : "Services"}</th>
              <th>{zh ? "最近心跳" : "Last heartbeat"}</th>
              <th>{zh ? "状态" : "Status"}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {workers.map((worker) => (
              <tr key={worker.id}>
                <td>
                  <strong>{worker.name || worker.id}</strong>
                  <small>{worker.id}</small>
                </td>
                <td>{worker.capabilities.join(", ")}</td>
                <td>
                  {(worker.services || []).map((service) =>
                    `${service.type}:${service.healthy ? "up" : "down"}`
                  ).join(" · ") || "—"}
                </td>
                <td>
                  {worker.last_heartbeat
                    ? new Date(worker.last_heartbeat).toLocaleString(
                      zh ? "zh-CN" : "en",
                    )
                    : "—"}
                </td>
                <td>
                  {worker.disabled_at
                    ? (zh ? "已禁用" : "Disabled")
                    : (zh ? "启用" : "Enabled")}
                </td>
                <td className="admin-actions">
                  <button
                    className="table-action"
                    onClick={() => void action(worker, "rotate-token")}
                  >
                    {zh ? "换令牌" : "Rotate"}
                  </button>
                  <button
                    className="table-action danger"
                    onClick={() =>
                      void action(
                        worker,
                        worker.disabled_at ? "enable" : "disable",
                      )}
                  >
                    {worker.disabled_at
                      ? (zh ? "启用" : "Enable")
                      : (zh ? "禁用" : "Disable")}
                  </button>
                  <button
                    className="table-action danger"
                    onClick={() => void action(worker, "revoke")}
                  >
                    {zh ? "撤销" : "Revoke"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SecretBox(
  { zh, value, onClose }: { zh: boolean; value: string; onClose: () => void },
) {
  return (
    <div className="fresh-key admin-secret">
      <div>
        <Icon name="shield" />
        <span>
          <strong>
            {zh ? "仅显示一次，请立即保存" : "Shown once—save it now"}
          </strong>
          <small>
            {zh
              ? "密码或令牌不会再次显示。"
              : "The password or token cannot be shown again."}
          </small>
        </span>
        <button className="icon-button" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="key-value">
        <pre>{value}</pre>
        <button onClick={() => void navigator.clipboard.writeText(value)}>
          <Icon name="copy" />
          {zh ? "复制" : "Copy"}
        </button>
      </div>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function seconds(value: number | null) {
  return value == null
    ? "—"
    : value < 60
    ? `${value}s`
    : `${(value / 60).toFixed(1)}m`;
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
