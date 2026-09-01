# InferSpool 管理员手册

本文只覆盖管理员日常操作。系统安装与 GitHub Pages 配置见 [DEPLOYMENT.md](DEPLOYMENT.md)，普通用户和 GPU 提供者的操作见 [RUNBOOK.md](RUNBOOK.md)。

## 首次管理员

关闭公共注册后，先在 Supabase Auth 中创建第一个账号，再通过 SQL Editor 完成一次性 bootstrap。将 `<auth-user-uuid>` 替换为该账号的 UUID：

```sql
insert into admins (user_id) values ('<auth-user-uuid>');
```

`admins` 没有客户端写策略。完成首次授权后，日常任务、账号和 Worker 管理都通过网页管理台或 `inferspool admin` 完成。

## 用户管理

系统不开放公共注册。创建用户时会一次性输出临时密码，用户首次登录后必须改密：

```bash
inferspool admin user create user@example.com
inferspool admin user list
```

`list` 输出用户 UUID，后续管理命令使用该 UUID：

```bash
inferspool admin user reset-password <user-id>
inferspool admin user disable <user-id>
inferspool admin user enable <user-id>
inferspool admin user delete <user-id>
```

重置密码会生成新的临时密码。删除用户会同时删除其任务和文件，执行前应确认确实不再需要这些数据。

## GPU Worker 管理

创建 Worker 身份：

```bash
inferspool admin worker create home-4090 --name "Home 4090"
```

命令会一次性输出完整 Worker 凭据。将其保存为 `worker.env` 后交给 GPU 提供者；数据库只保存 token 的 bcrypt hash，之后无法找回原 token。
Worker 会根据 `worker.env` 中配置的本地推理端点自动探活并上报能力，不需要在云端重复选择任务类型。新增或移除模型服务后重启 Worker 即可更新能力。

```bash
inferspool admin worker list
inferspool admin worker rotate-token home-4090
inferspool admin worker disable home-4090
inferspool admin worker enable home-4090
inferspool admin worker revoke home-4090
```

`rotate-token` 会立即废止旧 token 并输出新 token。`disable` 可临时停用节点，`revoke` 会清除有效凭据并禁用节点；被 revoke 的节点即使重新 enable，也必须再次 rotate token 后才能连接。

## 网页管理台

管理员登录网页后，右上角会出现“管理”入口，可以查看和操作：

- 过去 24 小时任务成功率、排队时间、执行时间、服务失败和存储用量
- 跨用户任务筛选、取消和再次运行
- 受邀账号、临时密码、禁用、删除和配额
- Worker 服务、健康状态、最近心跳、token 轮换和撤销

生产环境的用户额度和保留期应在网页管理台中调整，避免直接修改数据库破坏审计关系。
