export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type JobType = "image" | "video" | "tts" | "llm";

export const JOB_TYPE_LABELS: Record<JobType, [string, string]> = {
  llm: ["文本生成", "Text generation"],
  image: ["图片生成", "Image generation"],
  video: ["视频生成", "Video generation"],
  tts: ["文本转语音", "Text to speech"],
};

export interface Job {
  id: string;
  user_id: string;
  /** "embed" is retained only so historical rows remain readable. */
  type: JobType | "embed";
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  progress: number | null;
  progress_msg: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  source_job_id: string | null;
  keep_result: boolean;
  retained_until: string | null;
  tags: string[];
}

export interface ResultFile {
  bucket: string;
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  kind?: string;
}

export interface ServiceStat {
  /** Backends of this type that are healthy right now. */
  up: number;
  /** Backends registered for this type, healthy or not. */
  total: number;
  /** Total concurrent jobs the healthy backends accept. */
  capacity: number;
  queued: number;
}

export interface WorkerService {
  type: string;
  name: string | null;
  healthy: boolean;
  detail: string | null;
  models: string[] | null;
  capacity: number;
}

export interface QueueStats {
  queued: number;
  running: number;
  workers_online: number;
  services: Record<string, ServiceStat>;
  workers: {
    id: string | null;
    capabilities: string[] | null;
    online: boolean;
    services: WorkerService[] | null;
  }[];
}

export const TERMINAL: JobStatus[] = ["succeeded", "failed", "canceled"];

export const isTerminal = (s: JobStatus) => TERMINAL.includes(s);
