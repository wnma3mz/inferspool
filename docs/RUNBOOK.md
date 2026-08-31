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
inferspool submit video "城市上空的云" --seconds 5 --fps 24
inferspool submit tts "请朗读这段话" --voice default --format wav

inferspool status
inferspool list --status failed --search 租约
inferspool watch <job-id>
inferspool cancel <job-id>
inferspool retry <job-id>
inferspool keep <job-id>          # 永久保留；--unkeep 恢复默认保留期
inferspool delete <job-id>
```

不加 `--wait` 时可创建带签名的完成通知：

```bash
inferspool webhook create https://example.com/jobs
inferspool webhook list
```

GPU 离线时任务会留在云端排队，上线后自动执行。配置位于系统标准配置目录，脚本也可直接设置 `INFERSPOOL_API_KEY`。

## GPU 提供者

向管理员领取一次性 `worker.env`，补上本机实际提供的推理端点。官方构建已内置服务地址；私有部署的 `worker.env` 还会包含 `INFERSPOOL_URL`：

```env
INFERSPOOL_WORKER_ID=home-4090
INFERSPOOL_WORKER_TOKEN=<token>
INFERSPOOL_LLM_URL=http://127.0.0.1:18080
INFERSPOOL_LLM_CAPACITY=1
```

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

Worker 只主动连云端，无需公网 IP 或入站端口。停止 GPU 不会丢任务。token 泄露时联系管理员执行 `rotate-token`；机器永久退役执行 `revoke`。
