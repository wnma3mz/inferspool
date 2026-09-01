# InferSpool

在任何地方提交 AI 任务，在自己的 GPU 机器上执行。GPU 端只需要出站 HTTPS，不需要公网 IP、端口转发或打洞；机器离线时任务留在队列中，执行中断后可由租约机制恢复。

InferSpool 面向少量受邀用户，不开放公共注册。当前支持：

- `llm`：vLLM 兼容的文本与多图片输入
- `image`：vLLM-Omni 图片生成
- `video`：vLLM-Omni 视频生成
- `tts`：vLLM-Omni 文本转语音

网页版：<https://wnma3mz.github.io/inferspool/>

```console
$ inferspool submit llm "描述这张图片" --image photo.jpg --wait
画面中……

$ inferspool status
1 worker(s) online · 3 queued · 1 running

TYPE     BACKENDS   SLOTS    QUEUED
image    1/1        1        2
llm      1/1        8        1
tts      0/1        0        0
```

## 架构

```text
用户端（Go CLI / Web）
          │ HTTPS
          ▼
云端（Supabase + Next.js）
          ▲
          │ HTTPS，仅出站
GPU 端（Go Worker → vLLM / vLLM-Omni）
```

- `cmd/inferspool/`：用户 CLI，单个 Go 二进制
- `cmd/inferspool-worker/`：GPU Worker，探活、领取、执行与传输任务
- `supabase/`：Postgres schema、RLS、RPC、Storage 与 Edge Functions
- `web/`：Next.js 用户界面和管理员界面
- `scripts/`、`packaging/`：安装脚本和发布包模板

Postgres 中的 `jobs` 表同时保存队列状态和用户历史，是任务的唯一事实来源。CLI 与 Worker 通过稳定的 `/v1` 产品 API 工作；浏览器使用 Supabase Auth 会话和 Realtime 私有频道。Worker 不加载模型，只调用 GPU 机器上已有的 HTTP 推理服务。

## 用户快速开始

管理员创建账号后会提供邮箱和临时密码：

```bash
inferspool login user@example.com
inferspool password                         # 首次登录更换临时密码

inferspool submit llm "解释数据库租约" --wait
inferspool submit llm "比较两张图" --image a.jpg --image https://example.com/b.png -w
inferspool submit image "一只猫骑自行车" --size 1024x1024
inferspool submit image "一只猫骑自行车" --direct --wait
inferspool submit video "城市上空的云" --seconds 5 --fps 24
inferspool submit tts "请朗读这段话" --voice default --format wav

inferspool status
inferspool list --status failed --search 租约
inferspool rerun <job-id>
inferspool delete <job-id>
```

首次改密后 CLI 会自动创建本机 API key。脚本和 CI 可设置 `INFERSPOOL_API_KEY`，不需要保存账号密码。`--wait` 成功时退出 0，失败时退出 1。

用户只选择任务类型和通用生成参数，不指定具体模型；模型由执行任务的 GPU Worker 及其本地后端决定。排队任务会说明是在等待 GPU、模型服务还是空闲容量。

图片、视频和语音任务加 `--direct` 时，只会由当前在线且支持临时获取的 Worker 执行；生成文件不上传云端 Storage，但任务描述和状态仍通过云端调度。默认不加该参数时使用私有云存储。

批量提交和 Webhook 属于高级自动化能力，见 [使用手册](docs/RUNBOOK.md#高级自动化)。普通任务按用户公平轮转，结果按管理员设置的固定期限保留。

## GPU Worker 快速开始

管理员创建 Worker 后会一次性提供 `worker.env`。补上本机实际提供的推理端点：

```env
INFERSPOOL_WORKER_ID=home-4090
INFERSPOOL_WORKER_TOKEN=<token>
INFERSPOOL_LLM_URL=http://127.0.0.1:8000
INFERSPOOL_IMAGE_URL=http://127.0.0.1:8091
```

```bash
inferspool-worker doctor --env-file worker.env
inferspool-worker run --env-file worker.env
```

Worker 会自动探活这些端点并上报当前能力。云端只向最近上报为健康的服务派发任务；新增一种现有任务类型时，只需增加对应 URL 并重启 Worker，无需修改云端 Worker 类型。

默认由 GPU 用户自行管理 vLLM / vLLM-Omni。也可以为某种任务配置按需启动：

```env
INFERSPOOL_IMAGE_LAUNCH=vllm serve /path/to/image-model --omni --port 8091
INFERSPOOL_IMAGE_IDLE_TIMEOUT=600
INFERSPOOL_IMAGE_READY_TIMEOUT=900
```

没有配置 `LAUNCH` 时，Worker 只探活，不会启动或停止后端。默认启用单卡独占保护：启动一个受管后端前会停止另一个，避免消费级 GPU 同时加载多个模型导致 OOM。显存充足时可设置 `INFERSPOOL_EXCLUSIVE_GPU=0`。

每种类型支持以下变量，其中 `<TYPE>` 为 `LLM`、`IMAGE`、`VIDEO` 或 `TTS`：

| 变量 | 作用 |
|---|---|
| `INFERSPOOL_<TYPE>_URL` | 本地推理服务地址 |
| `INFERSPOOL_<TYPE>_CAPACITY` | 可接受的并发任务数 |
| `INFERSPOOL_<TYPE>_LAUNCH` | 可选的启动命令 |
| `INFERSPOOL_<TYPE>_STOP` | 外部进程管理器对应的停止命令 |
| `INFERSPOOL_<TYPE>_IDLE_TIMEOUT` | 空闲停止秒数，`0` 表示常驻 |
| `INFERSPOOL_<TYPE>_READY_TIMEOUT` | 启动后的就绪等待秒数 |
| `INFERSPOOL_<TYPE>_CWD` | 启动命令工作目录 |

完整示例见 `cmd/inferspool-worker/.env.example`。

## 许可

MIT，见 [LICENSE](LICENSE)。
