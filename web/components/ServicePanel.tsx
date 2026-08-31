"use client";

import { useState } from "react";
import { Icon } from "./Icons";
import { usePreferences } from "./Preferences";
import { useQueueStats } from "../lib/useJobs";
import type { ServiceStat } from "../lib/types";

const LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  tts: "Text to Speech",
  llm: "Text",
};
const LABELS_ZH: Record<string, string> = {
  image: "图片",
  video: "视频",
  tts: "文本转语音",
  llm: "文本",
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
          label={zh ? "GPU 节点" : "GPU workers"}
          value={stats.workers_online}
          note={stats.workers_online
            ? (zh ? "在线并已就绪" : "Online and ready")
            : (zh ? "等待节点上线" : "Waiting for a worker")}
        />
        <Metric
          icon="activity"
          tone="blue"
          label={zh ? "可用服务" : "Active services"}
          value={healthyServices}
          note={zh ? `已配置 ${types.length} 个` : `${types.length} configured`}
        />
        <Metric
          icon="queue"
          tone="amber"
          label={zh ? "排队中" : "In queue"}
          value={stats.queued}
          note={stats.queued
            ? (zh ? "等待执行" : "Waiting to run")
            : (zh ? "队列为空" : "Queue is clear")}
        />
        <Metric
          icon="bolt"
          tone="violet"
          label={zh ? "运行中" : "Running now"}
          value={stats.running}
          note={stats.running
            ? (zh ? "正在处理任务" : "Processing workloads")
            : (zh ? "暂无运行任务" : "No active tasks")}
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
                ? (zh ? "算力池运行正常" : "Compute pool operational")
                : (zh ? "算力池离线" : "Compute pool offline")}
            </strong>
            <span>
              {stats.workers_online
                ? (zh ? "节点正在接收任务" : "Workers are accepting tasks")
                : (zh
                  ? "任务将安全保留在队列中"
                  : "Tasks remain safely queued")}
            </span>
          </div>
          {stats.workers.some((worker) => worker.id) && (
            <button
              className="text-button"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? (zh ? "收起详情" : "Hide details")
                : (zh ? "查看节点" : "View workers")}
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
              }任务将等待对应后端恢复。`
              : `${
                stalled.map((type) => LABELS[type] ?? type).join(", ")
              } tasks are queued until a matching backend returns.`}
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
                    ? <span>{zh ? "未上报服务" : "No services reported"}</span>
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
