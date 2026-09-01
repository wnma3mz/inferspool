"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { usePreferences } from "./Preferences";
import {
  cancelJob,
  deleteJob,
  rerunJob,
  signedResultUrl,
} from "../lib/useJobs";
import {
  isTerminal,
  type Job,
  type JobStage,
  JOB_TYPE_LABELS,
  type Artifact,
} from "../lib/types";

const TYPE_LABELS: Record<Job["type"], [string, string]> = {
  ...JOB_TYPE_LABELS,
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

const STAGE_LABELS: Record<JobStage, [string, string]> = {
  waiting_for_worker: ["等待可用 GPU", "Waiting for a GPU"],
  waiting_for_service: ["等待模型服务启动或恢复", "Waiting for the model service"],
  waiting_for_capacity: ["等待空闲容量", "Waiting for available capacity"],
  waiting_for_direct_worker: [
    "等待支持临时获取的 GPU",
    "Waiting for a GPU with temporary delivery",
  ],
  assigned: ["已分配到 GPU", "Assigned to a GPU"],
  generating: ["正在生成", "Generating"],
  encoding: ["正在编码压缩", "Encoding and compressing"],
  delivering: ["正在传输结果", "Delivering the result"],
  completed: ["结果可用", "Result available"],
  failed: ["执行失败", "Execution failed"],
  canceled: ["已取消", "Canceled"],
};

function stageText(job: Job, zh: boolean) {
  if (job.stage && STAGE_LABELS[job.stage]) {
    return STAGE_LABELS[job.stage][zh ? 0 : 1];
  }
  return STATUS_LABELS[job.status][zh ? 0 : 1];
}

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

  const act = async (name: "rerun" | "delete") => {
    setActing(name);
    setCancelError(null);
    try {
      if (name === "rerun") await rerunJob(job.id);
      else await deleteJob(job.id);
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
            {stageText(job, zh)}
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
              <span>{job.progress_msg || stageText(job, zh)}</span>
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
        {job.status === "succeeded" && (
          <JobResult job={job} zh={zh} />
        )}
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
        {isTerminal(job.status) && job.type !== "embed" && (
          <button
            className="task-action"
            onClick={() => void act("rerun")}
            disabled={!!acting}
          >
            {acting === "rerun" ? "…" : (zh ? "再次运行" : "Run again")}
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

function artifactKind(mime: string): Artifact["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function resultArtifacts(job: Job): Artifact[] {
  const canonical = Array.isArray(job.result?.artifacts)
    ? job.result.artifacts
    : [];
  if (canonical.length) {
    return canonical.filter((item): item is Artifact =>
      !!item && typeof item === "object" &&
      (typeof (item as Artifact).path === "string" ||
        typeof (item as Artifact).url === "string")
    );
  }
  // Read-only compatibility for jobs created before artifacts were canonical.
  const files = Array.isArray(job.result?.files) ? job.result.files : [];
  const single = job.result?.file && typeof job.result.file === "object"
    ? [job.result.file]
    : [];
  return [...files, ...single].filter((file): file is Artifact =>
    !!file && typeof file === "object" &&
    (typeof (file as Artifact).path === "string" ||
      typeof (file as Artifact).url === "string")
  ).map((file) => ({ ...file, kind: file.kind ?? artifactKind(file.mime) }));
}

function useResultUrl(jobId: string, file: Artifact | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!file) return;
    if (file.delivery === "direct" && file.url) {
      setUrl(file.url);
      return () => {
        active = false;
      };
    }
    if (!file.bucket || !file.path) return;
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
  }, [jobId, file?.bucket, file?.path, file?.url, file?.delivery]);
  return url;
}

function ResultThumb({ job }: { job: Job }) {
  const file = resultArtifacts(job).find((item) => item.kind === "image");
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
  const files = resultArtifacts(job);
  if (!files.length) return null;
  return (
    <div className="result-files">
      {files.map((file) => (
        <ArtifactView
          key={file.path ?? file.url}
          jobId={job.id}
          file={file}
          zh={zh}
        />
      ))}
    </div>
  );
}

function ArtifactView(
  { jobId, file, zh }: {
    jobId: string;
    file: Artifact;
    zh: boolean;
  },
) {
  const url = useResultUrl(jobId, file);
  const expired = file.delivery === "direct" && !!file.expires_at &&
    Date.parse(file.expires_at) <= Date.now();
  const [directState, setDirectState] = useState<
    "checking" | "reachable" | "expired" | "unreachable"
  >(expired ? "expired" : "checking");

  useEffect(() => {
    if (file.delivery !== "direct" || !file.url || expired) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    void fetch(file.url, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
      signal: controller.signal,
    }).then((response) => {
      if (response.status === 410) setDirectState("expired");
      else if (response.ok || response.status === 206) {
        setDirectState("reachable");
      } else setDirectState("unreachable");
    }).catch(() => setDirectState("unreachable")).finally(() =>
      window.clearTimeout(timer)
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [file.delivery, file.url, expired]);

  if (file.delivery === "direct" && directState === "expired") {
    return (
      <div className="result-unavailable" role="status">
        <strong>{zh ? "临时文件已过期" : "Temporary file expired"}</strong>
        <span>
          {zh
            ? "任务记录仍保留，可使用右侧“再次运行”。"
            : "The job record remains; use Run again on this task."}
        </span>
      </div>
    );
  }
  if (file.delivery === "direct" && directState === "unreachable") {
    return (
      <div className="result-unavailable" role="status">
        <strong>{zh ? "当前设备无法访问 GPU" : "This device cannot reach the GPU"}</strong>
        <span>
          {zh
            ? "请连接对应局域网；如需云端保存，请在提交页重新提交。"
            : "Join the GPU network, or submit again from the form and save in cloud."}
        </span>
      </div>
    );
  }
  if (!url) {
    return (
      <span className="result-loading">
        {zh ? `正在加载 ${file.filename}…` : `Loading ${file.filename}…`}
      </span>
    );
	}
  const expiry = file.delivery === "direct" && file.expires_at
    ? (
      <small className="field-hint">
        {zh ? "当前设备临时文件，过期时间：" : "Temporary file, expires: "}
        {new Date(file.expires_at).toLocaleString()}
      </small>
    )
    : null;
  if (file.mime.startsWith("image/")) {
    return (
      <div>
        <a href={url} target="_blank" rel="noreferrer">
          <img className="result-image" src={url} alt={file.filename} />
        </a>
        {expiry}
      </div>
    );
  }
  if (file.mime.startsWith("audio/")) {
    return <div><audio controls src={url} />{expiry}</div>;
  }
  if (file.mime.startsWith("video/")) {
    return <div><video className="result-video" controls src={url} />{expiry}</div>;
  }
  return (
    <div>
      <a className="result-download" href={url} target="_blank" rel="noreferrer">
        {zh ? `下载 ${file.filename}` : `Download ${file.filename}`}
      </a>
      {expiry}
    </div>
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
        <strong>{zh ? "还没有任务" : "No jobs yet"}</strong>
        <p>
          {zh
            ? "提交后，进度和结果会显示在这里。"
            : "Submit a job to see its progress and results here."}
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
