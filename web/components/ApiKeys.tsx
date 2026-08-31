"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { usePreferences } from "./Preferences";
import { supabase } from "../lib/supabase";
import { api, jsonBody } from "../lib/api";

interface ApiKey {
  id: string;
  prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function ApiKeys() {
  const { language } = usePreferences();
  const zh = language === "zh";
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    try {
      setKeys(await api<ApiKey[]>("/keys"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const create = async () => {
    setError(null);
    setBusy(true);
    let data: string | null = null;
    let caught: unknown;
    try {
      data = await api<string>("/keys", {
        method: "POST",
        body: jsonBody({ label: label.trim() || null }),
      });
    } catch (error) {
      caught = error;
    }
    setBusy(false);
    if (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    setFresh(data);
    setLabel("");
    setCopied(false);
    void refresh();
  };

  const revoke = async (id: string) => {
    try {
      await api(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      void refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const copy = async () => {
    if (!fresh) return;
    await navigator.clipboard.writeText(fresh);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      <button className="topbar-button" onClick={() => setOpen(true)}>
        <Icon name="key" />
        <span>{zh ? "CLI 密钥" : "CLI keys"}</span>
      </button>
      {open && typeof document !== "undefined" &&
        createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <section
              className="modal key-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="keys-title"
            >
              <div className="modal-header">
                <div className="modal-title">
                  <span className="modal-icon">
                    <Icon name="key" />
                  </span>
                  <div>
                    <h2 id="keys-title">{zh ? "CLI 密钥" : "CLI keys"}</h2>
                    <p>
                      {zh
                        ? "创建或撤销用于 CLI 登录的密钥。"
                        : "Create or revoke keys used to sign in from the CLI."}
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
              <div className="modal-body">
                {fresh && (
                  <div className="fresh-key">
                    <div>
                      <Icon name="shield" />
                      <span>
                        <strong>
                          {zh
                            ? "现在复制并保存密钥"
                            : "Copy and save this key now"}
                        </strong>
                        <small>
                          {zh
                            ? "关闭窗口后无法再次查看。"
                            : "You cannot view it again after closing this window."}
                        </small>
                      </span>
                    </div>
                    <div className="key-value">
                      <code>{fresh}</code>
                      <button onClick={() => void copy()}>
                        <Icon name="copy" />
                        {copied
                          ? (zh ? "已复制" : "Copied")
                          : (zh ? "复制" : "Copy")}
                      </button>
                    </div>
                  </div>
                )}

                <div className="key-create">
                  <label htmlFor="key-label">
                    {zh ? "密钥名称" : "Key name"}
                  </label>
                  <div>
                    <input
                      id="key-label"
                      value={label}
                      placeholder={zh
                        ? "例如：MacBook Pro"
                        : "e.g. MacBook Pro"}
                      maxLength={80}
                      onChange={(event) => setLabel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void create();
                      }}
                    />
                    <button
                      className="button-primary"
                      onClick={() => void create()}
                      disabled={busy}
                    >
                      {busy
                        ? (zh ? "创建中…" : "Creating…")
                        : (zh ? "创建密钥" : "Create key")}
                    </button>
                  </div>
                </div>
                {error && (
                  <div className="alert alert-error" role="alert">{error}</div>
                )}

                <div className="key-list-heading">
                  <span>{zh ? "有效密钥" : "Active keys"}</span>
                  <span>{keys.length}</span>
                </div>
                {keys.length === 0
                  ? (
                    <div className="modal-empty">
                      {zh ? "还没有 CLI 密钥。" : "No CLI keys yet."}
                    </div>
                  )
                  : (
                    <div className="key-list">
                      {keys.map((key) => (
                        <div className="key-row" key={key.id}>
                          <span className="key-row-icon">
                            <Icon name="key" />
                          </span>
                          <div>
                            <strong>
                              {key.label || (zh ? "未命名密钥" : "Unnamed key")}
                            </strong>
                            <code>inferspool_{key.prefix}_••••••••</code>
                            <small>
                              {zh
                                ? `创建于 ${
                                  new Date(key.created_at).toLocaleDateString(
                                    "zh-CN",
                                  )
                                } · ${
                                  key.last_used_at
                                    ? `最后使用 ${
                                      new Date(key.last_used_at)
                                        .toLocaleDateString("zh-CN")
                                    }`
                                    : "从未使用"
                                }`
                                : `Created ${
                                  new Date(key.created_at).toLocaleDateString(
                                    "en",
                                  )
                                } · ${
                                  key.last_used_at
                                    ? `Last used ${
                                      new Date(key.last_used_at)
                                        .toLocaleDateString("en")
                                    }`
                                    : "Never used"
                                }`}
                            </small>
                          </div>
                          <button
                            className="danger-text-button"
                            onClick={() => void revoke(key.id)}
                          >
                            {zh ? "撤销" : "Revoke"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
