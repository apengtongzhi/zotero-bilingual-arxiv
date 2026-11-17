# Bilingual Snapshot for Zotero

[![Release](https://img.shields.io/github/v/release/apengtongzhi/zotero-bilingual-arxiv)](https://github.com/apengtongzhi/zotero-bilingual-arxiv/releases)

把论文转成**自包含、可批注的双语 HTML 快照**，挂回 Zotero 条目。三种入口共用同一套排版：

1. **Mktero 双语 Markdown**（手动导出）
2. **Mktero 论文目录**（含 `.md` + `assets/`）
3. **arXiv LaTeX 源码**（自动从条目 URL / Extra / DOI 提取 arXiv ID，下载源码、解析、翻译）

产物保留了原论文结构：双语标题、目录、逐段对照、内联 SVG 公式、内嵌图片、原生表格，以及可点击跳转的文献引用。

## 安装

1. 从 [Releases](https://github.com/apengtongzhi/zotero-bilingual-arxiv/releases) 下载 `bilingual-snapshot.xpi`
2. Zotero → 工具 → 插件 → 齿轮图标 → Install Add-on From File… → 选中 xpi
3. 在 工具 → 设置 → **双语快照 / arXiv 翻译** 里配置 LLM API 并点「测试连接」

> 首次安装后插件 ID 为 `bilingual-snapshot@apengtongzhi.github.io`。如果你之前装过 ID 为 `mktero-bilingual@workbuddy.local` 的本地测试版，两者会并存，可在插件管理里禁用旧版。

## 使用

选中一条文献（不是附件/笔记），右键：

- **生成双语阅读快照（选 md 文件）…** — 选 Mktero 导出的双语 md
- **生成双语阅读快照（选论文目录）…** — 选含 md 和 assets 的目录
- **从 arXiv 生成双语快照…** — 自动识别 arXiv ID，或弹框输入

等待进度完成（arXiv 全文翻译约 8–10 分钟），同名 HTML 附件挂到条目下，双击即可高亮、批注、同步。

## LLM 配置（API 可替换）

任意 **OpenAI 兼容**的 `/chat/completions` 服务均可，在设置面板里改三个字段：

- Base URL，例如 `https://api.deepseek.com/v1` 或你机构的网关
- 模型名，例如 `deepseek-v4-flash`
- API Key

密钥只写入本机 `~/.mktero_llm_config.json`（权限 600），**不写进插件包、日志或 Zotero 同步数据**。面板里密钥框不回显；留空表示沿用已保存的密钥。

翻译器的设计：
- 公式、引用在翻译成 `⟦F0⟧`、`⟦cite_1⟧` 占位符后送进 LLM，译文回来再还原成内联 SVG / 可点引用，公式不会被模型改坏
- 按段落分批 + 断点续传，失败块重跑时自动跳过已完成的
- 术语表统一译名（Transformer / 注意力 / 编码器 等）

## 依赖

- Zotero 7 / 8 / 9 / 10 / 11
- macOS / Linux / Windows 均可（需本机 `python3`）
- 公式渲染需要本机 Chrome / Chromium / Edge（找不到时公式降级为 LaTeX 文本，主流程不中断）

## 开发者：本地构建

```bash
git clone https://github.com/apengtongzhi/zotero-bilingual-arxiv.git
cd zotero-bilingual-arxiv
python3 scripts/build.py          # 生成 dist/bilingual-snapshot.xpi 与 dist/update.json
```

目录结构：

```
addon/                  # 插件源码
  bootstrap.js          # 生命周期、菜单、设置面板注册、挂附件
  prefs.xhtml           # 设置面板（偏好设置侧栏里的 XUL 片段）
  settings.css          # 面板样式（跟随 Zotero 深浅色）
  manifest.json         # 插件 ID、版本、兼容范围、update_url
  converter/            # Python 转换器（随 xpi 一起安装）
    bilingual_to_zotero.py   # md/文件夹入口
    arxiv_to_zotero.py       # arXiv 解析与排版
    arxiv_translate.py       # LLM 翻译器
    formula_svg.py           # MathJax 公式预渲染
    vendor/tex-svg.js        # 离线 MathJax
scripts/build.py        # 打包 + 生成 update.json
scripts/sandbox_check.js # 在「只给沙箱该给的全局」的环境里跑 bootstrap.js
.github/workflows/release.yml  # tag 自动发布
```

## 发布与更新

见 [docs/RELEASING.md](docs/RELEASING.md)。简要：

```bash
# 更新 addon/manifest.json 的 version，然后
git tag v0.4.1
git push origin main --tags
# GitHub Actions 自动打包、发 release、更新 update.json
```

## 排错

设置面板里的「测试连接」现在会直接告出原因，而不是一句「测试失败」：

| 提示 | 含义与处理 |
| --- | --- |
| `HTTP 401` / `HTTP 403`，密钥无效 | API Key 不对，或该 key 没有这个模型的权限 |
| `HTTP 404`，接口路径或模型名不对 | 提示里会带上实际请求的 URL；检查 Base URL 是否需要 `/v1`、模型名是否拼对 |
| `超时（N 秒内没响应）` | 网关慢或不可达；调大「请求超时」，或确认内网/VPN 是否连通 |
| `网络不可达` | Base URL 主机访问不到（代理、防火墙、内网限制） |
| `找不到转换器：…` | 从「高级」里手动指定转换器目录，或重装插件让它重新解压 |
| `找不到 python3` | 在「高级」里填 `python3` 的绝对路径（`which python3`） |

转换失败时弹窗会带出脚本 stderr 的最后几行，通常已足够定位（缺 python 包、Chrome 找不到、arXiv 下载失败等）。

插件沙箱里**没有** `Cc` / `Ci`。如果你要改 `bootstrap.js`，改完先跑一遍：

```bash
node scripts/sandbox_check.js
```

它会在只暴露 `Zotero / Services / IOUtils / PathUtils / ChromeUtils / fetch` 的假沙箱里执行整个 `bootstrap.js`，能提前抓到 `Cc is not defined` 这类只在 Zotero 里才炸的问题。

## 许可

MIT — 见 [LICENSE](LICENSE)。
