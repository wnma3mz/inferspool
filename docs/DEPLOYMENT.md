# InferSpool 私有部署与发布

本文覆盖 Supabase、GitHub Pages 和 CLI Release。日常管理员操作见 [ADMIN.md](ADMIN.md)，普通用户和 GPU 提供者操作见 [RUNBOOK.md](RUNBOOK.md)。

## Supabase

创建 Supabase 项目，关联项目并应用数据库迁移：

```bash
supabase link --project-ref <project-ref>
supabase db push
```

为维护任务生成两个不同的强随机 secret，然后部署产品 API 与后台函数：

```bash
supabase secrets set CRON_SECRET='<random>' WEBHOOK_ENCRYPTION_KEY='<different-random>'
supabase functions deploy api --no-verify-jwt
supabase functions deploy webhook-dispatch --no-verify-jwt
supabase functions deploy cleanup-results --no-verify-jwt
```

这些函数自行验证用户 session、API key、Worker token 或维护 secret。产品凭据不全是 Supabase JWT，因此部署时使用 `--no-verify-jwt`。部署后关闭公共注册，并按 [ADMIN.md](ADMIN.md) 创建第一个管理员。

## GitHub Pages 网页

网页是 Next.js 静态导出，`.github/workflows/pages.yml` 会在 `main` 更新后构建并发布到 `https://<owner>.github.io/<repository>/`。当前仓库对应的默认地址是 `https://wnma3mz.github.io/inferspool/`。

首次启用时，在 GitHub 仓库中完成两项设置：

1. 在 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。
2. 在 **Settings → Secrets and variables → Actions → Variables** 中创建以下公开变量：

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL，例如 `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable/anon key |
| `NEXT_PUBLIC_API_URL` | 可选的产品 API 地址；不填时使用 `<SUPABASE_URL>/functions/v1/api` |

这些值会出现在浏览器构建产物中，只能使用 Supabase 设计为公开的 publishable/anon key，绝不能填写 service-role key、数据库密码或访问 token。Pages workflow 会自动设置仓库子路径，不需要手工填写 `NEXT_PUBLIC_BASE_PATH`。

本地验证 Pages 子路径构建：

```bash
cd web
NEXT_PUBLIC_BASE_PATH=/inferspool pnpm build
```

## 本地网页

本地开发不使用 Pages 子路径：

```bash
cd web
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

## CLI 与 Worker Release

`.github/workflows/release.yml` 支持两种发布方式：

- 推送形如 `v1.2.3` 的 tag，自动构建并发布。
- 在 GitHub **Actions → start release → Run workflow** 中输入 `1.2.3`。该 workflow 自动创建 `v1.2.3` tag，并在 tag 上启动 `release` workflow。

每个 Release 包含 macOS、Linux 和 Windows 的 amd64/arm64 CLI 与 Worker 二进制，以及：

- `VERSION` 与 `SHA256SUMS`
- Sigstore `SHA256SUMS.bundle`
- macOS/Linux 安装脚本 `install.sh`
- Windows 安装脚本 `install.ps1`
- Homebrew Formula `inferspool.rb`

发布 workflow 会拒绝不符合 `X.Y.Z` 的版本、已存在的 tag 和已有的 Release。手动发布必须从 `main` 分支运行，且应在 CI 通过后执行。Release 发布完成后，独立的 `homebrew` job 会把 Formula 更新到 `wnma3mz/homebrew-tap` 的 `Formula/inferspool.rb`。

跨仓库更新需要在 InferSpool 仓库的 **Settings → Secrets and variables → Actions → Secrets** 中添加 `HOMEBREW_TAP_TOKEN`。使用 fine-grained personal access token，只授予 `wnma3mz/homebrew-tap` 仓库的 **Contents: Read and write** 权限。不要把 token 写进 workflow、Formula 或任何 `.env` 文件。

Homebrew 用户安装：

```bash
brew tap wnma3mz/tap
brew install inferspool
```

用户可以从 Release 页面下载对应平台的 `inferspool-*`，或运行 Release 附件中的安装脚本。正式 Release 构建内置更新地址，因此之后可以使用：

```bash
inferspool update --check
inferspool update
```

私有 fork 构建自己的二进制时，可通过 `INFERSPOOL_BUILD_URL`、`INFERSPOOL_BUILD_GATEWAY_KEY` 和 `INFERSPOOL_BUILD_RELEASE_URL` 运行 `cmd/inferspool/build.sh`；Worker 使用前两个变量运行 `cmd/inferspool-worker/build.sh`。不要把这些变量写入源码或提交本地 `.env`。
