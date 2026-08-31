"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { usePreferences } from "./Preferences";
import { submitJob, uploadInputImage, useSubmitting } from "../lib/useJobs";
import { JOB_TYPE_LABELS, type JobType } from "../lib/types";

const TYPES: { value: JobType; label: [string, string]; icon: string }[] = [
  { value: "llm", label: JOB_TYPE_LABELS.llm, icon: "text" },
  { value: "image", label: JOB_TYPE_LABELS.image, icon: "image" },
  { value: "video", label: JOB_TYPE_LABELS.video, icon: "video" },
  { value: "tts", label: JOB_TYPE_LABELS.tts, icon: "audio" },
];

const PLACEHOLDERS: Record<JobType, [string, string]> = {
  image: ["描述你想生成的图片…", "Describe the image you want to create…"],
  video: ["描述你想生成的视频…", "Describe the video you want to generate…"],
  tts: ["输入需要转换成语音的文本…", "Enter text to convert into speech…"],
  llm: ["向模型提问…", "Ask your model anything…"],
};

function ImagePreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url ? <img src={url} alt={file.name} /> : null;
}

export function SubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const { language } = usePreferences();
  const zh = language === "zh";
  const [type, setType] = useState<JobType>("llm");
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("2048");
  const [size, setSize] = useState("1024x1024");
  const [steps, setSteps] = useState("30");
  const [seconds, setSeconds] = useState("5");
  const [fps, setFps] = useState("24");
  const [voice, setVoice] = useState("default");
  const [speed, setSpeed] = useState("1");
  const [format, setFormat] = useState("wav");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const { run } = useSubmitting();

  const submit = () =>
    void run(async () => {
      if (!text.trim()) return;
      setError(null);
      setSubmitted(false);
      try {
        const payload: Record<string, unknown> = type === "tts"
          ? { text }
          : { prompt: text };
        if (type === "llm") {
          payload.temperature = Number(temperature);
          payload.max_tokens = Number(maxTokens);
        }
        if (type === "image" || type === "video") {
          payload.size = size;
          payload.num_inference_steps = Number(steps);
          payload.seed = Math.floor(Math.random() * 1e6);
        }
        if (type === "video") {
          payload.seconds = Number(seconds);
          payload.fps = Number(fps);
        }
        if (type === "tts") {
          payload.voice = voice;
          payload.speed = Number(speed);
          payload.response_format = format;
        }
        if (type === "llm" && images.length > 0) {
          payload.images = await Promise.all(images.map(uploadInputImage));
        }
        await submitJob(type, payload);
        setText("");
        setImages([]);
        setSubmitted(true);
        onSubmitted();
        window.setTimeout(() => setSubmitted(false), 3000);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    });

  return (
    <section id="submit" className="surface composer">
      <div className="section-heading composer-heading">
        <div>
          <span className="section-kicker">{zh ? "新任务" : "New job"}</span>
          <h2>{zh ? "选择任务类型并提交" : "Choose a job type and submit"}</h2>
        </div>
        <span className="secure-label">
          <Icon name="shield" /> {zh ? "加密传输" : "Encrypted in transit"}
        </span>
      </div>

      <div
        className="type-tabs"
        role="tablist"
        aria-label={zh ? "任务类型" : "Task type"}
      >
        {TYPES.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={type === item.value}
            className={type === item.value ? "active" : ""}
            onClick={() => {
              setType(item.value);
              setText("");
              setImages([]);
            }}
          >
            <Icon name={item.icon} />
            {item.label[zh ? 0 : 1]}
          </button>
        ))}
      </div>

      <div className="prompt-box">
        {type === "llm" && images.length > 0 && (
          <div className="input-image-list">
            {images.map((file, index) => (
              <div
                className="input-image"
                key={`${file.name}-${file.lastModified}`}
              >
                <ImagePreview file={file} />
                <span title={file.name}>{file.name}</span>
                <button
                  type="button"
                  aria-label={zh ? `移除 ${file.name}` : `Remove ${file.name}`}
                  onClick={() =>
                    setImages((current) =>
                      current.filter((_, item) => item !== index)
                    )}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          id="job-prompt"
          value={text}
          rows={4}
          aria-label={zh ? "任务内容" : "Job input"}
          placeholder={PLACEHOLDERS[type][zh ? 0 : 1]}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) && event.key === "Enter"
            ) submit();
          }}
        />
        <div className="parameter-grid">
          {type === "llm" && (
            <>
              <Parameter
                label={zh ? "温度" : "Temperature"}
                value={temperature}
                setValue={setTemperature}
                type="number"
                min="0"
                max="2"
                step="0.1"
              />
              <Parameter
                label={zh ? "最大输出长度" : "Maximum output"}
                value={maxTokens}
                setValue={setMaxTokens}
                type="number"
                min="1"
                max="131072"
              />
            </>
          )}
          {(type === "image" || type === "video") && (
            <>
              <Parameter
                label={zh ? "尺寸" : "Size"}
                value={size}
                setValue={setSize}
              />
              <Parameter
                label={zh ? "推理步数" : "Steps"}
                value={steps}
                setValue={setSteps}
                type="number"
                min="1"
                max="200"
              />
            </>
          )}
          {type === "video" && (
            <>
              <Parameter
                label={zh ? "时长（秒）" : "Seconds"}
                value={seconds}
                setValue={setSeconds}
                type="number"
                min="0.01"
                max="300"
                step="0.1"
              />
              <Parameter
                label={zh ? "帧率" : "FPS"}
                value={fps}
                setValue={setFps}
                type="number"
                min="1"
                max="240"
              />
            </>
          )}
          {type === "tts" && (
            <>
              <Parameter
                label={zh ? "音色" : "Voice"}
                value={voice}
                setValue={setVoice}
              />
              <Parameter
                label={zh ? "语速" : "Speed"}
                value={speed}
                setValue={setSpeed}
                type="number"
                min="0.25"
                max="4"
                step="0.05"
              />
              <label>
                <span>{zh ? "格式" : "Format"}</span>
                <select
                  aria-label={zh ? "格式" : "Format"}
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                >
                  {["wav", "mp3", "flac", "pcm", "opus"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <div className="prompt-actions">
          <span className="prompt-tools">
            {type === "llm" && (
              <label className="attach-button">
                <Icon name="image" /> {zh ? "添加图片" : "Add images"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  hidden
                  onChange={(event) => {
                    const selected = Array.from(event.target.files ?? []);
                    if (selected.some((file) => file.size > 20 * 1024 * 1024)) {
                      setError(
                        zh
                          ? "每张图片不能超过 20 MB"
                          : "Each image must be 20 MB or smaller",
                      );
                    } else {
                      setError(null);
                      setImages((current) =>
                        [...current, ...selected].slice(0, 8)
                      );
                    }
                    event.target.value = "";
                  }}
                />
              </label>
            )}
            <span>
              <kbd>⌘</kbd>
              <kbd>Enter</kbd> {zh ? "提交" : "to submit"}
            </span>
          </span>
          <button
            className="button-primary submit-button"
            onClick={submit}
            disabled={!text.trim()}
          >
            <Icon name="send" /> {zh ? "提交任务" : "Submit task"}
          </button>
        </div>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {submitted && (
        <div className="alert alert-success" role="status">
          {zh
            ? "任务已提交，正在等待 GPU 节点领取。"
            : "Job submitted and waiting for a GPU worker."}
        </div>
      )}
    </section>
  );
}

function Parameter(
  { label, value, setValue, type = "text", min, max, step }: {
    label: string;
    value: string;
    setValue: (value: string) => void;
    type?: string;
    min?: string;
    max?: string;
    step?: string;
  },
) {
  return (
    <label>
      <span>{label}</span>
      <input
        aria-label={label}
        type={type}
        min={min}
        max={max}
        step={step}
        value={value}
        required
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}
