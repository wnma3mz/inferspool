export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type JobType = "image" | "video" | "tts" | "llm";

export type JobStage =
  | "waiting_for_worker"
  | "waiting_for_service"
  | "waiting_for_capacity"
  | "waiting_for_direct_worker"
  | "assigned"
  | "generating"
  | "encoding"
  | "delivering"
  | "completed"
  | "failed"
  | "canceled";

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
  stage?: JobStage;
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
  retained_until: string | null;
  tags: string[];
}

export interface Artifact {
  kind: "image" | "audio" | "video" | "file";
  bucket?: string;
  path?: string;
  url?: string;
  delivery?: "cloud" | "direct";
  expires_at?: string;
  filename: string;
  mime: string;
  bytes: number;
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
  /** Fresh services that can return file results directly to the client. */
  direct?: Record<string, number>;
  workers: {
    id: string | null;
    online: boolean;
    services: WorkerService[] | null;
  }[];
}

export const TERMINAL: JobStatus[] = ["succeeded", "failed", "canceled"];

export const isTerminal = (s: JobStatus) => TERMINAL.includes(s);
