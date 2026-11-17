# 发布指南

## 先说清一件事：Zotero 官方插件库

**截至 2026-05，Zotero 官方没有插件目录。** 官方文档 [Plugins for Zotero](https://www.zotero.org/support/plugins) 原文：

> We don't currently provide a list of available plugins, but most plugins are announced and discussed in the Zotero Forums. An official plugin directory is planned.

所以没有"提交到 Zotero 官方插件库"这一步。可行的分发渠道：

1. **GitHub Releases**（主渠道）——用户从 release 页下载 xpi，或装一次后用 `update_url` 自动更新
2. **Zotero 中文社区插件商店**（社区目录）——[zotero-chinese/zotero-plugins](https://github.com/zotero-chinese/zotero-plugins)，见下文
3. **Zotero 论坛**发一个发布帖（www.zotero.org/forum）

## 一、上传到 GitHub

本机用 `git` + 网页建仓即可推送（不需要 `gh` CLI）。确认 `git config user.name` / `user.email` 已配置；若不想公开真实邮箱，可用 GitHub 的 noreply 地址（见 GitHub → Settings → Emails → Keep my email addresses private）。用网页建仓 + 本地 push：

### 1. 在 GitHub 网页建空仓库

打开 https://github.com/new ：

- Repository name：`zotero-bilingual-arxiv`
- 选 **Public**（插件商店与自动更新都需要公开）
- **不要**勾选 Initialize with README / LICENSE / .gitignore（本地已有）
- 点 Create repository

### 2. 本地初始化并推送

```bash
cd /path/to/zotero-bilingual-arxiv   # 本仓库根目录

git init
git add .
git status                 # 确认没有 .mktero_llm_config.json、没有论文数据
git commit -m "Initial release v0.4.0"
git branch -M main
git remote add origin https://github.com/apengtongzhi/zotero-bilingual-arxiv.git
git push -u origin main
```

> 若 push 时要求登录：GitHub 自 2021 起不再接受密码，需用 Personal Access Token（https://github.com/settings/tokens，勾 `repo`），在提示输入密码时粘贴 token。

### 3. 发布第一个 Release（xpi + update.json）

```bash
git tag v0.4.0
git push origin v0.4.0
```

推送 tag 会触发 `.github/workflows/release.yml`：校验 manifest 版本 = tag、扫描密钥泄漏、打包 xpi、生成 `update.json`、创建 release 上传 xpi，并把 `update.json` 挂到长期存在的 `release` tag 上。

首次运行后确认两件事：

- https://github.com/apengtongzhi/zotero-bilingual-arxiv/releases 下有 `v0.4.0` 和 xpi
- 有一个名为 `release` 的 release，里面有 `update.json`

`manifest.json` 里的 `update_url` 已经指向后者，Zotero 会自动检查更新。

## 二、提交到 Zotero 中文社区插件商店

仓库 [zotero-chinese/zotero-plugins](https://github.com/zotero-chinese/zotero-plugins) 的 README 写明接受 issue 或 PR 提交。

### 方式 A：开 issue（最简单）

到 https://github.com/zotero-chinese/zotero-plugins/issues/new ，按 README 要求提供：

- 仓库 URL：`https://github.com/apengtongzhi/zotero-bilingual-arxiv`
- 简短描述：把 Mktero 双语 md 或 arXiv LaTeX 转成 Zotero 双语 HTML 快照
- 下载链接：`https://github.com/apengtongzhi/zotero-bilingual-arxiv/releases`
- 支持的 Zotero 版本：7.0 – 11.*

### 方式 B：提 PR（能直接进目录）

Fork 仓库，在 `src/plugins.ts` 按仓库名字母序加一条：

```ts
{
  repo: "apengtongzhi/zotero-bilingual-arxiv",
  tags: ["translation", "markdown", "latex", "reading"],
  releases: [],
  discoverReleases: true,
  nameZh: "双语阅读快照",
  summaryZh: "把 Mktero 双语 Markdown 或 arXiv LaTeX 转成可批注的双语 HTML 快照",
}
```

`releases: []` + `discoverReleases: true` 让采集器自动发现最新稳定版，以后发版无需手动改目录。

提交 PR 后等待审核合并；上架后可在 README 顶部加徽章：

```markdown
[![Listed in Zotero Chinese](https://zotero-chinese.com/badges/listed.svg)](https://zotero-chinese.com/plugins/)
```

## 三、以后每次发版

1. 改 `addon/manifest.json` 的 `version`（如 `0.4.1`），同步更新 `CHANGELOG.md`
2. 本地验证：`python3 scripts/build.py`，把 `dist/bilingual-snapshot.xpi` 装进 Zotero 试一次
3. 提交并打 tag：
   ```bash
   git add -A && git commit -m "Release v0.4.1"
   git push origin main
   git tag v0.4.1 && git push origin v0.4.1
   ```
4. GitHub Actions 自动发版并刷新 `update.json`；已安装用户会在 Zotero 里收到更新提示
5. 不需要去插件商店手动改版本（`discoverReleases: true` 会自动跟随最新 release）

## 四、发布前的安全检查

- [ ] `git status` 里没有 `.mktero_llm_config.json`、没有 `arxiv-out/`、没有论文数据
- [ ] 全仓搜索 `sk-` 无任何真实密钥（CI 里也有自动检查，发现就拒绝发布）
- [ ] `manifest.json` 的 `strict_max_version` 是你**实际测过**的版本，不要为了"兼容未来"写过宽
- [ ] `update_url` 指向你自己的 GitHub 仓库（若 fork 了仓库，记得改）
- [ ] 若改了插件 ID，旧版用户会被当成两个插件，需要在 README 里说明

## 五、本机没有 gh CLI 怎么办

完全不影响——上面流程用 `git` + GitHub 网页就够了。如果想装 `gh` 方便以后操作：

```bash
brew install gh
gh auth login
```

装了之后可以用 `gh release view`、`gh pr create` 等命令，但**不是必需**。
