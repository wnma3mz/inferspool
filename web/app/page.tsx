"use client";

import { useEffect, useState } from "react";
import { ApiKeys } from "../components/ApiKeys";
import { AdminJobs } from "../components/AdminJobs";
import { JobList } from "../components/JobList";
import { Icon } from "../components/Icons";
import {
  PreferenceControls,
  PreferencesProvider,
  usePreferences,
} from "../components/Preferences";
import { ServicePanel } from "../components/ServicePanel";
import { SubmitForm } from "../components/SubmitForm";
import { api, jsonBody } from "../lib/api";
import { supabase } from "../lib/supabase";
import { exportJobs, type JobFilters, useJobs } from "../lib/useJobs";
import { JOB_TYPE_LABELS, type JobType } from "../lib/types";

const JOB_STATUS_OPTIONS = [
  ["queued", "排队中", "Queued"],
  ["running", "运行中", "Running"],
  ["succeeded", "已完成", "Completed"],
  ["failed", "失败", "Failed"],
  ["canceled", "已取消", "Canceled"],
] as const;

export default function Home() {
  return (
    <PreferencesProvider>
      <Workspace />
    </PreferencesProvider>
  );
}

function Workspace() {
  const { language } = usePreferences();
  const zh = language === "zh";
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [accountReady, setAccountReady] = useState(false);
  const [forcePassword, setForcePassword] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [view, setView] = useState<"workspace" | "admin">("workspace");
  const [filters, setFilters] = useState<JobFilters>({});
  const { jobs, loading, error, refresh, nextCursor, loadMore } = useJobs(
    30,
    filters,
    email !== null && accountReady && !forcePassword && view === "workspace",
  );

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setEmail(session?.user?.email ?? null);
      if (!session) {
        setIsAdmin(false);
        setView("workspace");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let active = true;
    if (!email) {
      setForcePassword(false);
      setAccountReady(true);
      return;
    }
    setAccountReady(false);
    void api<{
      admin?: boolean;
      profile?: { force_password_change?: boolean };
    }>("/me")
      .then((me) => {
        if (active) {
          setIsAdmin(me.admin === true);
          setForcePassword(me.profile?.force_password_change === true);
          setAccountReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setIsAdmin(false);
          setEmail(null);
          setAccountReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [email]);

  if (checking || !accountReady) {
    return (
      <div
        className="loading-screen"
        aria-label={zh ? "正在加载工作区" : "Loading workspace"}
      >
        <BrandMark />
        <span className="loading-spinner" />
      </div>
    );
  }

  if (!email) {
    return <SignIn />;
  }
  if (forcePassword) {
    return (
      <ChangePassword
        email={email}
        onDone={() => {
          setForcePassword(false);
          setAccountReady(true);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BrandMark />
          <BrandName />
        </div>
        <nav
          className="sidebar-nav"
          aria-label={view === "admin"
            ? (zh ? "管理导航" : "Admin navigation")
            : (zh ? "主导航" : "Main navigation")}
        >
          {view === "admin"
            ? (
              <>
                <button className="nav-item active" type="button">
                  <Icon name="admin" /> {zh ? "管理中心" : "Admin center"}
                </button>
                <button
                  className="nav-item"
                  type="button"
                  onClick={() => setView("workspace")}
                >
                  <Icon name="arrow" />{" "}
                  {zh ? "返回工作区" : "Back to workspace"}
                </button>
              </>
            )
            : (
              <>
                <a className="nav-item active" href="#workspace">
                  <Icon name="grid" /> {zh ? "工作区" : "Workspace"}
                </a>
                <a className="nav-item" href="#submit">
                  <Icon name="spark" /> {zh ? "新建任务" : "New task"}
                </a>
                <a className="nav-item" href="#history">
                  <Icon name="history" /> {zh ? "任务历史" : "Task history"}
                </a>
              </>
            )}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-foot-label">
            {zh ? "闲置 GPU 算力池" : "Idle GPU pool"}
          </div>
          <div className="sidebar-foot-copy">
            {zh
              ? "节点主动领取任务，无需开放入站端口。"
              : "Workers pull jobs without opening inbound ports."}
          </div>
        </div>
      </aside>

      <div className="app-content">
        <header className="topbar">
          <div className="mobile-brand">
            <BrandMark />
            <BrandName />
          </div>
          {view === "admin" && (
            <button
              className="topbar-button admin-back-button"
              onClick={() => setView("workspace")}
              aria-label={zh ? "返回工作区" : "Back to workspace"}
            >
              <Icon name="arrow" />
              <span>{zh ? "返回工作区" : "Workspace"}</span>
            </button>
          )}
          <div className="topbar-spacer" />
          <PreferenceControls compact />
          {view === "workspace" && isAdmin && (
            <button
              className="topbar-button"
              onClick={() => setView("admin")}
              aria-label={zh ? "管理" : "Admin"}
            >
              <Icon name="admin" />
              <span>{zh ? "管理" : "Admin"}</span>
            </button>
          )}
          {view === "workspace" && <ApiKeys />}
          <div className="account-menu">
            <span className="avatar">{email.slice(0, 1).toUpperCase()}</span>
            <span className="account-copy">
              <strong>{email.split("@")[0]}</strong>
              <small>{email}</small>
            </span>
            <button
              className="signout-button"
              onClick={() => void supabase.auth.signOut()}
            >
              <Icon name="logout" />
              <span>{zh ? "退出" : "Sign out"}</span>
            </button>
          </div>
        </header>

        {isAdmin && (
          <div hidden={view !== "admin"}>
            <AdminJobs />
          </div>
        )}
        {view === "workspace" && (
          <main id="workspace" className="workspace">
            <section className="page-heading">
              <div>
                <span className="eyebrow">
                  {zh ? "任务中心" : "Task center"}
                </span>
                <h1>
                  {zh ? "今天想运行什么？" : "What would you like to run?"}
                </h1>
                <p>
                  {zh
                    ? "提交文本、图片、视频或语音任务，进度和结果都在这里。"
                    : "Submit text, image, video, or speech jobs and track every result here."}
                </p>
              </div>
            </section>

            <ServicePanel />
            <SubmitForm onSubmitted={refresh} />

            <section id="history" className="surface history-surface">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">
                    {zh ? "任务记录" : "Job history"}
                  </span>
                  <h2>{zh ? "最近任务" : "Recent tasks"}</h2>
                </div>
                <button
                  className="button-secondary compact"
                  onClick={() => void refresh()}
                >
                  <Icon name="refresh" /> {zh ? "刷新" : "Refresh"}
                </button>
              </div>
              {error && (
                <div className="alert alert-error" role="alert">{error}</div>
              )}
              <HistoryFilters
                zh={zh}
                filters={filters}
                setFilters={setFilters}
                onExport={() => void exportJobs(filters)}
              />
              <JobList
                jobs={jobs}
                loading={loading}
                onChanged={() => void refresh()}
              />
              {nextCursor && (
                <button
                  className="button-secondary load-more"
                  onClick={() => void loadMore()}
                >
                  {zh ? "加载更多" : "Load more"}
                </button>
              )}
            </section>
          </main>
        )}
      </div>
    </div>
  );
}

function HistoryFilters(
  { zh, filters, setFilters, onExport }: {
    zh: boolean;
    filters: JobFilters;
    setFilters: (value: JobFilters) => void;
    onExport: () => void;
  },
) {
  const patch = (key: keyof JobFilters, value: string) =>
    setFilters({ ...filters, [key]: value || undefined });
  return (
    <div className="history-filters">
      <input
        aria-label={zh ? "搜索任务" : "Search jobs"}
        value={filters.search || ""}
        onChange={(e) => patch("search", e.target.value)}
        placeholder={zh ? "搜索提示词…" : "Search prompts…"}
      />
      <select
        aria-label={zh ? "状态" : "Status"}
        value={filters.status || ""}
        onChange={(e) => patch("status", e.target.value)}
      >
        <option value="">{zh ? "全部状态" : "All statuses"}</option>
        {JOB_STATUS_OPTIONS.map(([value, labelZh, labelEn]) => (
          <option key={value} value={value}>{zh ? labelZh : labelEn}</option>
        ))}
      </select>
      <select
        aria-label={zh ? "任务类型" : "Task type"}
        value={filters.type || ""}
        onChange={(e) => patch("type", e.target.value)}
      >
        <option value="">{zh ? "全部任务" : "All tasks"}</option>
        {(["llm", "image", "video", "tts"] as JobType[]).map((value) => (
          <option key={value} value={value}>
            {JOB_TYPE_LABELS[value][zh ? 0 : 1]}
          </option>
        ))}
      </select>
      <input
        aria-label={zh ? "标签" : "Tag"}
        value={filters.tag || ""}
        onChange={(e) => patch("tag", e.target.value.trim())}
        placeholder={zh ? "标签" : "Tag"}
      />
      <input
        aria-label={zh ? "开始日期" : "Start date"}
        type="date"
        value={filters.after?.slice(0, 10) || ""}
        onChange={(e) =>
          patch(
            "after",
            e.target.value
              ? new Date(`${e.target.value}T00:00:00`).toISOString()
              : "",
          )}
      />
      <input
        aria-label={zh ? "结束日期" : "End date"}
        type="date"
        value={filters.before?.slice(0, 10) || ""}
        onChange={(e) =>
          patch(
            "before",
            e.target.value
              ? new Date(`${e.target.value}T23:59:59.999`).toISOString()
              : "",
          )}
      />
      <button className="button-secondary compact" onClick={onExport}>
        {zh ? "导出 CSV" : "Export CSV"}
      </button>
    </div>
  );
}

function ChangePassword(
  { email, onDone }: { email: string; onDone: () => void },
) {
  const { language } = usePreferences();
  const zh = language === "zh";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const change = async () => {
    if (password !== confirm) {
      setError(zh ? "两次输入的密码不一致。" : "Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/me/password", {
        method: "POST",
        body: jsonBody({ password }),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page single-auth">
      <section className="auth-form-panel">
        <div className="login-card">
          <div className="login-heading">
            <span className="mobile-auth-brand">
              <span>
                <BrandMark />
                <BrandName />
              </span>
              <PreferenceControls compact />
            </span>
            <h2>{zh ? "设置新密码" : "Set a new password"}</h2>
            <p>
              {zh
                ? `首次登录 ${email}，请先设置一个新密码。`
                : `Set a new password for ${email} before continuing.`}
            </p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void change();
            }}
          >
            <div className="field">
              <label htmlFor="new-password">
                {zh ? "新密码" : "New password"}
              </label>
              <div className="input-wrap">
                <Icon name="lock" />
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="confirm-password">
                {zh ? "确认密码" : "Confirm password"}
              </label>
              <div className="input-wrap">
                <Icon name="lock" />
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </div>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button
              className="button-primary login-button"
              disabled={busy || password.length < 8 || confirm.length < 8}
            >
              {busy
                ? (zh ? "保存中…" : "Saving…")
                : (zh ? "保存并继续" : "Save and continue")}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

function SignIn() {
  const { language } = usePreferences();
  const zh = language === "zh";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setError(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setBusy(false);
    if (error) setError(error.message);
  };

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <div className="auth-brand">
          <BrandMark />
          <BrandName />
          <span className="auth-preferences">
            <PreferenceControls compact />
          </span>
        </div>
        <div className="auth-message">
          <span className="auth-tag">
            <span className="status-pulse" />{" "}
            {zh ? "闲置 GPU 算力池" : "Idle GPU pool"}
          </span>
          <h1>
            {zh
              ? (
                <>
                  让闲置 GPU<br />跑起 AI 任务。
                </>
              )
              : (
                <>
                  Put idle GPUs<br />back to work.
                </>
              )}
          </h1>
          <p>
            {zh
              ? "闲置 GPU 主动从队列领取任务，全程无需开放入站端口。"
              : "Idle GPUs pull jobs from the queue without opening inbound ports."}
          </p>
        </div>
        <div className="auth-proof">
          <div>
            <Icon name="shield" />
            <span>
              <strong>{zh ? "无需开放端口" : "No inbound ports"}</strong>
              <small>
                {zh ? "GPU 节点主动领取任务" : "GPU workers pull jobs"}
              </small>
            </span>
          </div>
          <div>
            <Icon name="bolt" />
            <span>
              <strong>{zh ? "离线也不丢任务" : "Jobs survive downtime"}</strong>
              <small>
                {zh
                  ? "继续排队，失败自动重试"
                  : "Queued safely with automatic retries"}
              </small>
            </span>
          </div>
        </div>
        <div className="auth-grid" aria-hidden="true" />
      </section>

      <section className="auth-form-panel">
        <div className="login-card">
          <div className="login-heading">
            <span className="mobile-auth-brand">
              <span>
                <BrandMark />
                <BrandName />
              </span>
              <PreferenceControls compact />
            </span>
            <h2>{zh ? "欢迎回来" : "Welcome back"}</h2>
            <p>
              {zh
                ? "登录后提交任务、查看进度和获取结果。"
                : "Sign in to submit jobs, track progress, and collect results."}
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className="field">
              <label htmlFor="email">{zh ? "邮箱地址" : "Email address"}</label>
              <div className="input-wrap">
                <Icon name="mail" />
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder={zh ? "你的邮箱" : "you@company.com"}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="password">{zh ? "密码" : "Password"}</label>
              <div className="input-wrap">
                <Icon name="lock" />
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder={zh ? "请输入密码" : "Enter your password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            {error && (
              <div className="alert alert-error" role="alert">{error}</div>
            )}
            <button
              className="button-primary login-button"
              type="submit"
              disabled={busy || !email.includes("@") || !password}
            >
              {busy
                ? (
                  <>
                    <span className="button-spinner" />{" "}
                    {zh ? "正在登录…" : "Signing in…"}
                  </>
                )
                : (
                  <>
                    {zh ? "登录" : "Sign in"} <Icon name="arrow" />
                  </>
                )}
            </button>
          </form>
          <p className="login-help">
            {zh
              ? "仅限管理员创建的账号登录。需要账号请联系管理员。"
              : "Only administrator-created accounts can sign in. Contact an administrator for access."}
          </p>
        </div>
      </section>
    </main>
  );
}

function BrandMark() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return (
    <span className="brand-mark" aria-hidden="true">
      <img src={`${basePath}/inferspool-logo.svg`} alt="" />
    </span>
  );
}

function BrandName() {
  return (
    <span className="brand-name">
      Infer<span>Spool</span>
    </span>
  );
}
