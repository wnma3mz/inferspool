"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { usePreferences } from "./Preferences";
import {
  cancelJob,
  deleteJob,
  keepJob,
  retryJob,
  signedResultUrl,
} from "../lib/useJobs";
import { isTerminal, type Job, type ResultFile } from "../lib/types";

const TYPE_LABELS: Record<Job["type"], [string, string]> = {
  llm: ["文本", "Text"],
  image: ["图片", "Image"],
  video: ["视频", "Video"],
  tts: ["文本转语音", "Text to Speech"],
  embed: ["历史任务", "Legacy task"],
};

const TYPE_ICONS: Record<Job["type"], string> = {
  llm: "text",
  image: "image",
  video: "video",
  tts: "audio",
  embed: "text",
};

const STATUS_LABELS = {
  queued: ["排队中", "Queued"],
  running: ["运行中", "Running"],
  succeeded: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  canceled: ["已取消", "Canceled"],
} as const;

function describe(job: Job, zh: boolean): string {
  const prompt = job.payload.prompt ?? job.payload.text;
  if (typeof prompt === "string" && prompt.trim()) return prompt;
  return zh
    ? `${TYPE_LABELS[job.type][0]}任务`
    : `${TYPE_LABELS[job.type][1]} task`;
}

function relativeTime(value: string, zh: boolean): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return zh ? "刚刚" : "just now";
  if (seconds < 3600) {
    return zh
      ? `${Math.floor(seconds / 60)} 分钟前`
      : `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return zh
      ? `${Math.floor(seconds / 3600)} 小时前`
      : `${Math.floor(seconds / 3600)}h ago`;
  }
  if (seconds < 604800) {
    return zh
      ? `${Math.floor(seconds / 86400)} 天前`
      : `${Math.floor(seconds / 86400)}d ago`;
  }
  return new Date(value).toLocaleDateString(zh ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
  });
}

function duration(job: Job): string | null {
  const reported = job.result?.seconds;
  if (typeof reported === "number") return `${reported.toFixed(1)}s`;
  if (!job.started_at) return null;
  const end = job.finished_at
    ? new Date(job.finished_at).getTime()
    : Date.now();
  return `${
    Math.max(0, Math.floor((end - new Date(job.started_at).getTime()) / 1000))
  }s`;
}

export function JobRow(
  { job, onChanged }: { job: Job; onChanged?: () => void },
) {
  const { language } = usePreferences();
  const zh = language === "zh";
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const pct = job.progress != null ? Math.round(job.progress * 100) : null;
  const cancellable = !isTerminal(job.status);

  const cancel = async () => {
    setCanceling(true);
    setCancelError(null);
    try {
      await cancelJob(job.id);
    } catch (caught) {
      setCancelError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCanceling(false);
    }
  };

  const act = async (name: "retry" | "delete" | "keep") => {
    setActing(name);
    setCancelError(null);
    try {
      if (name === "retry") await retryJob(job.id);
      else if (name === "delete") await deleteJob(job.id);
      else await keepJob(job.id, !job.keep_result);
      onChanged?.();
    } catch (caught) {
      setCancelError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActing(null);
    }
  };

  return (
    <article className="task-row">
      <ResultThumb job={job} />
      <div className="task-main">
        <div className="task-title-row">
          <strong className="task-title" title={describe(job, zh)}>
            {describe(job, zh)}
          </strong>
          <span className={`status-pill ${job.status}`} role="status">
            <i />
            {STATUS_LABELS[job.status][zh ? 0 : 1]}
          </span>
        </div>
        <div className="task-meta">
          <span>
            <Icon name={TYPE_ICONS[job.type]} />
            {TYPE_LABELS[job.type][zh ? 0 : 1]}
          </span>
          <span>{relativeTime(job.created_at, zh)}</span>
          {duration(job) && <span>{duration(job)}</span>}
          {job.attempts > 1 && (
            <span>
              {zh
                ? `尝试 ${job.attempts}/${job.max_attempts}`
                : `Attempt ${job.attempts}/${job.max_attempts}`}
            </span>
          )}
        </div>

        {job.status === "running" && (
          <div className="task-progress-wrap">
            <div className="task-progress-copy">
              <span>{job.progress_msg || (zh ? "处理中" : "Processing")}</span>
              <span>{pct == null ? "" : `${pct}%`}</span>
            </div>
            <div
              className="task-progress"
              role="progressbar"
              aria-valuenow={pct ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={pct == null ? "indeterminate" : ""}
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {(job.error || cancelError) && (
          <div className="task-error" role="alert">
            {cancelError || job.error}
          </div>
        )}
        {job.status === "succeeded" && <JobResult job={job} zh={zh} />}
      </div>
      <div className="task-actions">
        {cancellable && (
          <button
            className="task-action"
            onClick={() => void cancel()}
            disabled={canceling}
          >
            {canceling
              ? (zh ? "取消中…" : "Canceling…")
              : (zh ? "取消" : "Cancel")}
          </button>
        )}
        {(job.status === "failed" || job.status === "canceled") && (
          <button
            className="task-action"
            onClick={() => void act("retry")}
            disabled={!!acting}
          >
            {acting === "retry" ? "…" : (zh ? "重试" : "Retry")}
          </button>
        )}
        {isTerminal(job.status) && (
          <button
            className="task-action"
            onClick={() => void act("keep")}
            disabled={!!acting}
          >
            {job.keep_result
              ? (zh ? "取消保留" : "Unkeep")
              : (zh ? "保留" : "Keep")}
          </button>
        )}
        {isTerminal(job.status) && (
          <button
            className="task-action danger"
            onClick={() => void act("delete")}
            disabled={!!acting}
          >
            {zh ? "删除" : "Delete"}
          </button>
        )}
      </div>
    </article>
  );
}

function resultFiles(job: Job): ResultFile[] {
  const files = Array.isArray(job.result?.files) ? job.result.files : [];
  const single = job.result?.file && typeof job.result.file === "object"
    ? [job.result.file]
    : [];
  return [...files, ...single].filter((file): file is ResultFile =>
    !!file && typeof file === "object" &&
    typeof (file as ResultFile).path === "string"
  );
}

function useResultUrl(jobId: string, file: ResultFile | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!file) return;
    void signedResultUrl(jobId, file.bucket, file.path)
      .then((value) => {
        if (active) setUrl(value);
      })
      .catch(() => {
        if (active) setUrl(null);
      });
    return () => {
      active = false;
    };
  }, [jobId, file?.bucket, file?.path]);
  return url;
}

function ResultThumb({ job }: { job: Job }) {
  const file = resultFiles(job).find((item) => item.mime?.startsWith("image/"));
  const url = useResultUrl(job.id, file);
  return (
    <div className={`task-thumb ${url ? "has-result" : ""}`}>
      {url ? <img src={url} alt="" /> : <Icon name={TYPE_ICONS[job.type]} />}
    </div>
  );
}

function JobResult({ job, zh }: { job: Job; zh: boolean }) {
  const result = job.result;
  if (!result) return null;
  if (typeof result.text === "string") {
    return <pre className="result-text">{result.text}</pre>;
  }
  const files = resultFiles(job);
  if (!files.length) return null;
  return (
    <div className="result-files">
      {files.map((file) => (
        <ResultFileView key={file.path} jobId={job.id} file={file} zh={zh} />
      ))}
    </div>
  );
}

function ResultFileView(
  { jobId, file, zh }: { jobId: string; file: ResultFile; zh: boolean },
) {
  const url = useResultUrl(jobId, file);
  if (!url) {
    return (
      <span className="result-loading">
        {zh ? `正在加载 ${file.filename}…` : `Loading ${file.filename}…`}
      </span>
    );
  }
  if (file.mime.startsWith("image/")) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img className="result-image" src={url} alt={file.filename} />
      </a>
    );
  }
  if (file.mime.startsWith("audio/")) return <audio controls src={url} />;
  if (file.mime.startsWith("video/")) {
    return <video className="result-video" controls src={url} />;
  }
  return (
    <a className="result-download" href={url} target="_blank" rel="noreferrer">
      {zh ? `下载 ${file.filename}` : `Download ${file.filename}`}
    </a>
  );
}

export function JobList(
  { jobs, loading, onChanged }: {
    jobs: Job[];
    loading: boolean;
    onChanged?: () => void;
  },
) {
  const { language } = usePreferences();
  const zh = language === "zh";
  if (loading) {
    return (
      <div
        className="task-list-loading"
        aria-label={zh ? "正在加载任务" : "Loading tasks"}
      >
        {[0, 1, 2].map((item) => (
          <div className="task-skeleton" key={item}>
            <span />
            <div>
              <i />
              <i />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <span>
          <Icon name="spark" />
        </span>
        <strong>{zh ? "暂无任务" : "No tasks yet"}</strong>
        <p>
          {zh
            ? "你提交的任务和结果会显示在这里。"
            : "Your submitted tasks and results will appear here."}
        </p>
      </div>
    );
  }
  return (
    <div className="task-list">
      {jobs.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
