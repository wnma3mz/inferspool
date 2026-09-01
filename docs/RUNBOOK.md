# InferSpool 使用手册

云端长期在线。这里仅站在普通用户和 GPU 提供者两个视角。

返回[项目首页](../README.md)。管理员操作见 [ADMIN.md](ADMIN.md)，私有部署见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 普通用户

安装管理员提供的二进制或 Release 安装脚本，然后验证：

```bash
inferspool version
inferspool login user@example.com
```

管理员第一次给的是临时密码。CLI 提示改密时执行：

```bash
inferspool password
```

改密完成会自动创建本机 API key。之后常用命令：

```bash
inferspool submit llm "用一句话介绍杭州" --wait
inferspool submit llm "描述这两张图" --image a.jpg --image https://example.com/b.png -w
inferspool submit image "一只猫骑自行车" --size 1024x1024 --steps 30
inferspool submit image "一只猫骑自行车" --direct --wait
inferspool submit video "城市上空的云" --seconds 5 --fps 24
inferspool submit tts "请朗读这段话" --voice default --format wav

inferspool status
inferspool list --status failed --search 租约
inferspool cancel <job-id>
inferspool rerun <job-id>
inferspool delete <job-id>
```

GPU 离线时任务会留在云端排队，上线后自动执行。配置位于系统标准配置目录，脚本也可直接设置 `INFERSPOOL_API_KEY`。
CLI 和 Web 会区分等待 GPU、等待模型服务和等待空闲容量。图片、视频和语音任务加 `--direct` 后，生成文件会跳过云端 Storage，由在线 Worker 返回局域网临时 URL；任务描述和状态仍通过云端调度。不加时默认使用私有云存储。CLI 所在机器必须能够访问 Worker 上报的地址。

### 高级自动化

下面这些能力保留给脚本、CI 和管理员使用，不属于常规交互流程：

```bash
inferspool batch llm prompts.txt --wait
inferspool watch <job-id>
inferspool webhook create https://example.com/jobs
inferspool webhook list
inferspool submit image "测试" --experimental-json '{"seed":42}'
```

普通任务由服务端按用户公平轮转，不提供手动插队参数。参数通过稳定的 Web/CLI 入口提交；Worker 动态上报自己支持的参数范围。云端结果按管理员配置的固定期限保留，用户可以提前删除。
`--experimental-json` 仅用于尚未形成稳定 CLI 选项的参数；API 只接受当前 Worker 动态 schema 已声明的字段和取值，不能覆盖 prompt、输入文件或结果传输方式。

## GPU 提供者

向管理员领取一次性 `worker.env`，补上本机实际提供的推理端点。官方构建已内置服务地址；私有部署的 `worker.env` 还会包含 `INFERSPOOL_URL`：

```env
INFERSPOOL_WORKER_ID=home-4090
INFERSPOOL_WORKER_TOKEN=<token>
INFERSPOOL_LLM_URL=http://127.0.0.1:18080
INFERSPOOL_LLM_CAPACITY=1
```

配置决定 Worker 上报的能力，不需要再在云端维护一份任务类型列表。新增或移除端点后重启 Worker；服务探活失败时该类型会自动停止接单。

先启动 vLLM / vLLM-Omni，再启动 Worker：

```bash
chmod 600 worker.env
CUDA_VISIBLE_DEVICES=0 vllm serve /path/to/model --host 127.0.0.1 --port 18080

inferspool-worker doctor --env-file worker.env
inferspool-worker run --env-file worker.env
```

后台运行可交给 systemd。临时测试可用：

```bash
setsid nohup inferspool-worker run --env-file worker.env >worker.log 2>&1 &
echo $! >worker.pid
```

停止时先让 Worker 排空，再停模型服务：

```bash
kill -TERM "$(cat worker.pid)"
tail -f worker.log                 # 等待 drained, exiting
```

`INFERSPOOL_LOG_LEVEL=INFO` 记录每次推理请求的任务 ID、服务、接口、HTTP
状态、耗时和请求/响应字节数。排障时可设为 `DEBUG`，额外记录最多 4 KiB 的
脱敏请求/响应 JSON。token、签名 URL、base64 图片与音视频二进制始终省略。
Worker 只写 stdout/stderr，由 systemd、Docker 或 shell 重定向负责落盘轮转。

### 结果传输

默认 `cloud` 模式把压缩后的结果上传到私有 Supabase Storage。Worker 会在 JPEG
确实更小时把无透明通道的 PNG 转成 quality 88 JPEG；Web 的 TTS 默认请求 Opus；
视频保留模型已经压缩好的编码，避免有损二次转码。

同一局域网可启用 `direct`：

```env
INFERSPOOL_DIRECT_LISTEN=192.168.1.20:9090
INFERSPOOL_DIRECT_URL=https://gpu.home.example:9090
INFERSPOOL_DIRECT_TTL_SECS=600
```

直传结果只驻留 Worker 内存，通过 256-bit 随机 URL 下载，过期自动删除，生成文件不经过
Supabase Storage；任务描述和状态仍经过云端控制平面。Worker 默认不开启监听；两项配置必须同时存在。`DIRECT_URL`
必须是用户浏览器可达的地址，而且 HTTPS 网页必须使用浏览器信任的 HTTPS
Worker 地址。直传缓冲区最多 1 GiB；满时任务明确失败，用户可改用 cloud。
Worker 内置的是 HTTP 服务；HTTPS 页面使用直传时，需要在局域网反向代理上配置
受浏览器信任的证书，并将 `DIRECT_URL` 指向该 HTTPS 入口。

Worker 只主动连云端，无需公网 IP 或入站端口。停止 GPU 不会丢任务。token 泄露时联系管理员执行 `rotate-token`；机器永久退役执行 `revoke`。
