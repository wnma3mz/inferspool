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
  const [filters, setFilters] = useState<JobFilters>({});
  const { jobs, loading, error, refresh, nextCursor, loadMore } = useJobs(
    30,
    filters,
    email !== null && accountReady && !forcePassword,
  );

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setEmail(session?.user?.email ?? null);
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
    void api<{ profile?: { force_password_change?: boolean } }>("/me")
      .then((me) => {
        if (active) {
          setForcePassword(me.profile?.force_password_change === true);
          setAccountReady(true);
        }
      })
      .catch(() => {
        if (active) {
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
          aria-label={zh ? "主导航" : "Main navigation"}
        >
          <a className="nav-item active" href="#workspace">
            <Icon name="grid" /> {zh ? "工作区" : "Workspace"}
          </a>
          <a className="nav-item" href="#submit">
            <Icon name="spark" /> {zh ? "新建任务" : "New task"}
          </a>
          <a className="nav-item" href="#history">
            <Icon name="history" /> {zh ? "任务历史" : "Task history"}
          </a>
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-foot-label">
            {zh ? "分布式算力" : "Distributed compute"}
          </div>
          <div className="sidebar-foot-copy">
            {zh
              ? "你的任务、你的 GPU，一条可靠队列。"
              : "Your workloads, your GPUs, one reliable queue."}
          </div>
        </div>
      </aside>

      <div className="app-content">
        <header className="topbar">
          <div className="mobile-brand">
            <BrandMark />
            <BrandName />
          </div>
          <div className="topbar-spacer" />
          <PreferenceControls compact />
          <AdminJobs />
          <ApiKeys />
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

        <main id="workspace" className="workspace">
          <section className="page-heading">
            <div>
              <span className="eyebrow">
                {zh ? "算力工作区" : "Compute workspace"}
              </span>
              <h1>{zh ? "欢迎回来。" : "Good to see you."}</h1>
              <p>
                {zh
                  ? "在一个界面提交任务并监控 GPU 算力池。"
                  : "Submit workloads and monitor your GPU pool from one place."}
              </p>
            </div>
            <a className="docs-link" href="#submit">
              <Icon name="spark" /> {zh ? "新建任务" : "New task"}
            </a>
          </section>

          <ServicePanel />
          <SubmitForm onSubmitted={refresh} />

          <section id="history" className="surface history-surface">
            <div className="section-heading">
              <div>
                <span className="section-kicker">
                  {zh ? "动态" : "Activity"}
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
        {["queued", "running", "succeeded", "failed", "canceled"].map((
          value,
        ) => <option key={value}>{value}</option>)}
      </select>
      <select
        aria-label={zh ? "任务类型" : "Task type"}
        value={filters.type || ""}
        onChange={(e) => patch("type", e.target.value)}
      >
        <option value="">{zh ? "全部类型" : "All types"}</option>
        {["llm", "image", "video", "tts"].map((value) => (
          <option key={value}>{value}</option>
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
                ? `${email} 首次登录，需要先更换临时密码。`
                : `${email} must replace the temporary password before continuing.`}
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
            {zh ? "私有 GPU 调度" : "Private GPU orchestration"}
          </span>
          <h1>
            {zh
              ? (
                <>
                  你的算力。<br />一条可靠队列。
                </>
              )
              : (
                <>
                  Your compute.<br />One reliable queue.
                </>
              )}
          </h1>
          <p>
            {zh
              ? "在你已有的 GPU 上运行 AI 任务，无需开放任何入站端口。"
              : "Run AI workloads across the GPUs you already own, without exposing a single inbound port."}
          </p>
        </div>
        <div className="auth-proof">
          <div>
            <Icon name="shield" />
            <span>
              <strong>{zh ? "隐私优先" : "Private by design"}</strong>
              <small>
                {zh ? "仅使用出站连接" : "Outbound connections only"}
              </small>
            </span>
          </div>
          <div>
            <Icon name="bolt" />
            <span>
              <strong>{zh ? "故障可恢复" : "Built to recover"}</strong>
              <small>
                {zh ? "任务租约与自动重试" : "Leased jobs, automatic retry"}
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
                ? "登录你的 InferSpool 工作区。"
                : "Sign in to your InferSpool workspace."}
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
              ? "仅限受邀用户访问。如需账号，请联系管理员。"
              : "Access is invite-only. Contact your administrator if you need an account."}
          </p>
        </div>
      </section>
    </main>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <img src="/inferspool-logo.svg" alt="" />
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
