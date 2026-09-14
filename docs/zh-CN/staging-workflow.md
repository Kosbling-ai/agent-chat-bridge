# Staging 分支流程

`staging` 是准备进入 `main` 的共享集成分支，初始基线为当前 0.2.3 开发代码。`main` 继续作为仓库默认分支和最终提升目标。

## 集成与测试

每项改动从最新 `staging` 开始，保持提交便于审阅；审阅后的改动进入 `staging` 做集成测试。在 staging 发现的修复仍先落回 `staging`，确保被测试的分支包含完整候选代码。

按改动范围运行检查。仓库当前没有托管 CI workflow，因此要记录实际命令结果，不能把分支更新本身当成检查通过：

```sh
npm ci
npm test
npm run check
npm run version:check
```

`npm run test:storage` 只通过任务自建并销毁的 MySQL 测试容器运行。真实 provider 或本机实例验收需要另行授权和隔离的 staging 配置，不能复用生产凭据、会话、数据库或 writer。仅改文档时通常运行 `npm run check`、`npm run version:check` 和空白/diff 检查。

## 提升到 main

集成候选稳定后，先 fetch 并核对准确差异：

```sh
git fetch origin
git log --oneline origin/main..origin/staging
git diff --stat origin/main..origin/staging
```

创建 head 为 `staging`、base 为 `main` 的 PR，由人审核并合并。不要绕过该流程，把未在 staging 测试的 topic 分支直接合入 `main`。若以后经授权先向 `main` 提交紧急修复，应在继续 staging 开发前把该修复同步回 `staging`，避免两条分支静默分叉。

## 发布边界

更新 `staging`、创建或合并提升 PR、发布是不同操作。本仓库的分支操作不会自动部署服务、执行数据库迁移、发布 npm、创建或移动 tag，也不会改变默认分支。迁移和部署必须分别按受审、获授权的流程执行。测试证据只覆盖实际运行过的环境，不代表生产或真实 provider 已验收。
