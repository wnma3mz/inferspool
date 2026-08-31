"use client";

import { useState } from "react";
import { Icon } from "./Icons";
import { usePreferences } from "./Preferences";
import { useQueueStats } from "../lib/useJobs";
import type { ServiceStat } from "../lib/types";

const LABELS: Record<string, string> = {
  image: "Image generation",
  video: "Video generation",
  tts: "Text to speech",
  llm: "Text generation",
};
const LABELS_ZH: Record<string, string> = {
  image: "图片生成",
  video: "视频生成",
  tts: "文本转语音",
  llm: "文本生成",
};

export function ServicePanel() {
  const { language } = usePreferences();
  const zh = language === "zh";
  const stats = useQueueStats();
  const [expanded, setExpanded] = useState(false);

  if (!stats) {
    return (
      <div
        className="metrics-grid metrics-loading"
        aria-label={zh ? "正在加载算力状态" : "Loading compute status"}
      />
    );
  }

  const types = Object.keys(stats.services).sort();
  const healthyServices = types.filter((t) => stats.services[t].up > 0).length;
  const stalled = types.filter((t) =>
    stats.services[t].queued > 0 && stats.services[t].up === 0
  );

  return (
    <section
      className="compute-overview"
      aria-label={zh ? "算力概览" : "Compute overview"}
    >
      <div className="metrics-grid">
        <Metric
          icon="server"
          tone="green"
          label={zh ? "在线节点" : "Online workers"}
          value={stats.workers_online}
          note={stats.workers_online
            ? (zh ? "可立即领取任务" : "Ready to take jobs")
            : (zh ? "暂无节点在线" : "No workers online")}
        />
        <Metric
          icon="activity"
          tone="blue"
          label={zh ? "可用能力" : "Available capabilities"}
          value={healthyServices}
          note={zh
            ? `共 ${types.length} 种任务类型`
            : `${types.length} job types configured`}
        />
        <Metric
          icon="queue"
          tone="amber"
          label={zh ? "等待任务" : "Waiting jobs"}
          value={stats.queued}
          note={stats.queued
            ? (zh ? "等待节点领取" : "Waiting for a worker")
            : (zh ? "当前没有排队任务" : "Nothing in the queue")}
        />
        <Metric
          icon="bolt"
          tone="violet"
          label={zh ? "运行中" : "Running now"}
          value={stats.running}
          note={stats.running
            ? (zh ? "GPU 正在执行" : "Running on GPUs")
            : (zh ? "当前没有运行任务" : "No jobs are running")}
        />
      </div>

      <div className="surface capacity-strip">
        <div className="capacity-heading">
          <div>
            <span
              className={`live-dot ${
                stats.workers_online ? "online" : "offline"
              }`}
            />
            <strong>
              {stats.workers_online
                ? (zh ? "算力池可用" : "GPU pool available")
                : (zh ? "暂无可用算力" : "No compute available")}
            </strong>
            <span>
              {stats.workers_online
                ? (zh ? "在线节点可以领取任务" : "Online workers can take jobs")
                : (zh
                  ? "已提交的任务会继续排队"
                  : "Submitted jobs will remain queued")}
            </span>
          </div>
          {stats.workers.some((worker) => worker.id) && (
            <button
              className="text-button"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? (zh ? "收起详情" : "Hide details")
                : (zh ? "节点详情" : "Worker details")}
              <Icon name="chevron" className={expanded ? "rotated" : ""} />
            </button>
          )}
        </div>

        {types.length > 0 && (
          <div className="service-pills">
            {types.map((type) => (
              <ServicePill
                key={type}
                type={type}
                stat={stats.services[type]}
                zh={zh}
              />
            ))}
          </div>
        )}

        {stalled.length > 0 && (
          <div className="alert alert-warning" role="status">
            <Icon name="queue" /> {zh
              ? `${
                stalled.map((type) => LABELS_ZH[type] ?? type).join("、")
              }任务正在等待支持对应能力的节点上线。`
              : `${
                stalled.map((type) => LABELS[type] ?? type).join(", ")
              } jobs are waiting for a compatible worker.`}
          </div>
        )}

        {expanded && (
          <div className="worker-grid">
            {stats.workers.map((worker, index) => (
              <article className="worker-card" key={worker.id ?? index}>
                <div className="worker-card-head">
                  <span className="worker-icon">
                    <Icon name="server" />
                  </span>
                  <div>
                    <strong>
                      {worker.id ?? (zh ? "GPU 节点" : "GPU worker")}
                    </strong>
                    <span>
                      {worker.online
                        ? (zh ? "在线" : "Online")
                        : (zh ? "离线" : "Offline")}
                    </span>
                  </div>
                  <span
                    className={`live-dot ${
                      worker.online ? "online" : "offline"
                    }`}
                  />
                </div>
                <div className="worker-services">
                  {(worker.services ?? []).length === 0
                    ? (
                      <span>
                        {zh ? "尚未上报能力" : "No capabilities reported"}
                      </span>
                    )
                    : (worker.services ?? []).map((service) => (
                      <span key={service.type}>
                        {service.name || LABELS[service.type] || service.type}
                        <b className={service.healthy ? "up" : "down"}>
                          {service.healthy
                            ? (zh
                              ? `就绪 · ${service.capacity} 个并发`
                              : `Ready · ${service.capacity} slot${
                                service.capacity === 1 ? "" : "s"
                              }`)
                            : (zh ? "不可用" : "Unavailable")}
                        </b>
                      </span>
                    ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Metric(
  { icon, tone, label, value, note }: {
    icon: string;
    tone: string;
    label: string;
    value: number;
    note: string;
  },
) {
  return (
    <article className="metric-card">
      <span className={`metric-icon ${tone}`}>
        <Icon name={icon} />
      </span>
      <div className="metric-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
    </article>
  );
}

function ServicePill(
  { type, stat, zh }: { type: string; stat: ServiceStat; zh: boolean },
) {
  const up = stat.up > 0;
  return (
    <div className={`service-pill ${up ? "available" : "unavailable"}`}>
      <span className="service-pill-name">
        {(zh ? LABELS_ZH[type] : LABELS[type]) ?? type}
      </span>
      <span className="service-pill-state">
        <i />
        {up
          ? (zh
            ? `${stat.capacity} 个并发`
            : `${stat.capacity} slot${stat.capacity === 1 ? "" : "s"}`)
          : (zh ? "离线" : "Offline")}
      </span>
      {stat.queued > 0 && (
        <span className="queue-count">
          {zh ? `${stat.queued} 个排队` : `${stat.queued} queued`}
        </span>
      )}
    </div>
  );
}
