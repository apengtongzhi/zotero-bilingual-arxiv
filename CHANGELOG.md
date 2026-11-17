# Changelog

## 0.6.0

新增「找 arXiv 版并生成双语快照（自动检索）」：论文来自 IEEE / Springer / ACM、条目里没有 arXiv ID 时，
自动去找它的 arXiv 预印本，再走 LaTeX 翻译流程。

- 匹配分四步：条目自带 ID（DOI `10.48550/arXiv.*` / URL / Extra 里的 `arXiv: 编号`）→ arXiv Atom API 按标题检索
  （`ti:` 落空自动放宽到 `all:`，https 不通退 http）→ 标题 Jaccard + 作者姓氏 + 年份打分 →
  分数不够高或有并列时交给大模型复核（只让它输出序号，输出 0 即判定都不是，不硬塞）
- 命中后弹确认框，列出 arXiv 编号、标题、作者、匹配度，确认了才下载，避免白等几分钟翻译一篇错的
- 没找到时明确提示，并给出绕行办法（手写 Extra、Google Scholar All versions）
- **修掉一个会下错论文的隐患**：旧的 ID 正则含一条裸「4 位.4~5 位」兜底，会把 IEEE DOI
  `10.1016/j.patcog.2019.1070` 里的 `2019.1070` 当成 arXiv 编号。现在裸编号只在 `extra` / `archiveID`
  这类本来就在讲 arXiv 的字段里才认，同时补了旧式 ID（`cs/0112017`）的支持
- Atom 解析改为按 localName 匹配：真实响应里 `<arxiv:comment>` 带命名空间前缀，按标签名查会漏
- 测试补齐：18 条新断言，并用 `scripts/fixtures/arxiv_attention.xml`（export.arxiv.org 的真实响应）
  验证解析；`MB_LIVE=1 node scripts/sandbox_check.js` 可跑一次真实网络检索

## 0.5.5

修「保存失败：file.exists is not a function」——0.5.4 修掉家目录之后紧接着撞上的第二个坑：

- `Zotero.File.putContents(file, data)` 的第一参**必须是 nsIFile**，函数体第一行就是 `file.exists()`；传路径字符串会抛这个错。现在改为传 `Zotero.File.pathToFile(路径)`。（注意与它不对称的 `putContentsAsync(path, data)` 是接受字符串的，所以光看名字容易写错）
- 顺手把 `new Zotero.ProgressWindow().ItemProgress(...)` 的参数改对：第一个参数是图标键 `"document"`，第二个才是文本，之前进度窗口里没图标
- 把用到的 Zotero API 全量对着 Zotero 自己的源码核了一遍（`Zotero.File.*` / `Attachments.importFromFile` / `PreferencePanes.register` / `Utilities.Internal.openPreferences` / `HTTP.request` / `ProgressWindow` / `IOUtils.*` 签名与选项名），没有其它对不上的
- `scripts/sandbox_check.js` 的 `putContents` 桩改为**照着真实实现挑错**：传字符串就抛 `TypeError("file.exists is not a function")`。之前这个桩接受字符串，又一次把 bug 让到了你机器上——桩比真实实现宽松，测试就等于没用

## 0.5.4

修复「点保存/测试连接一律显示『保存失败：找不到用户主目录』」：

- 根因：`PathUtils.homeDir` 在 Zotero 自带的 `PathUtils` 上并不存在，取它会抛异常，`catch` 之后 `path()` 返回空串，`write()` 就直接报「找不到用户主目录」。现在改为逐级回退：`PathUtils.homeDir` → `Services.dirsvc.get("Home")`（从活窗口借 `nsIFile` 常量，绕过沙箱没有 `Ci`）→ 由 `profileDir` 推断。解析结果缓存，避免每次读写都试一遍
- 报错不再是没头没脑的一句话，会提示去看调试输出日志；读配置失败时也会在日志里留一条
- 同一条提示在设置界面上会重复出现两次（`bs-status` 与 `bs-save-status` 被同时写入，看着像两个错）。现在各按钮只更新自己的状态位：测试连接写在按钮旁，保存写在底部
- 自检新增「用户主目录」「配置文件」两项，下次这类问题一眼可见
- `scripts/sandbox_check.js` 不再给 `PathUtils` 塞 `homeDir`——之前正是这个「贴心」的桩把真机上的问题遮住了；并补了回退链与状态位去重的断言

## 0.5.3

全功能自测后修掉的一批问题（三个入口逐个跑真实转换器验证）：

- **Markdown / 文件夹两个入口完全没读「文件与输出」设置**：自动挂附件、生成后打开、保留中间产物这三项只有 arXiv 入口生效。现在三个入口共用 `attachSnapshot` / `openAttachment` / `cleanupTempFiles`，行为一致
- **短中文标题被判成英文原文**：`## 引言`「研究背景」这类三四字标题 CJK 占比高但字数少，旧的判定逻辑把它们当英文，导致双语对不齐、目录空、中文大标题不生成。重写 `is_zh()`：短块（≤12 字）占比 ≥0.5 即判中文，长块要求 CJK ≥3 且占比 ≥0.12
- **连续多行标题被塞进同一个块**：`## 一` + `## 二` 相邻时消失成一行。新增 `split_heading_runs()`
- **章节标记粘连导致整篇被逐行拆碎**：`<!-- /mktero-section -->` 紧贴上一行正文时，整块被当成坏块逐行拆开，表格数量从 1 变 0、列表被打散。新增 `isolate_section_markers()` 让标记独占一块
- **元信息行混进正文**：`__title__:` / `__meta__:` 这类行改成先行展开再分块（`expand_meta_blocks()`），不再出现在正文里
- **论文标题含 `/`、`:`、`*`、`?` 等字符时直接崩**（`FileNotFoundError`）：两个转换器都加 `safe_name()`，把非法字符换成全角或 `-`，并截断到 120 字
- **占位符完整性校验漏掉引用和交叉引用**：`PH_RE` 只认 `⟦F\d+⟧` 和旧式 `⟦引用⟧`，模型丢了 `⟦cite_1⟧` / `⟦ref_图 2⟧` 不会被发现。现已覆盖公式、单/多引用、交叉引用四类，用多重集签名比对，允许语序调整但次数必须一致
- **CLI `--test-llm` 白烧 600+ tokens**：原来走翻译的 system prompt，现在改用独立的 `ping_llm()`（`max_tokens=8`），一次探测只要 13 tokens
- `scripts/sandbox_check.js` 扩到约 90 个断言：补上 md 入口、文件夹入口的真实 python 端到端、非法文件名净化、文件设置生效、未选条目提示等

## 0.5.2

修复「设置能打开、但点测试连接只显示一句『测试失败』」——根因是插件沙箱里根本没有 `Cc` / `Ci`：

- Zotero 7+ 的 bootstrap 沙箱只注入 `Zotero / Services / IOUtils / PathUtils / ChromeUtils / fetch`，不注入 `Cc` / `Ci` / `Components`。旧代码里 `Cc["@mozilla.org/process/util;1"]`、`Ci.nsIFilePicker.*` 全部抛 `ReferenceError`，被 `catch` 吞成「测试失败」。现已全部改用等价新 API：Subprocess（进程）、`chrome://zotero/content/modules/filePicker.mjs`（选择器）、`IOUtils` / `PathUtils`（文件与目录）
- 「测试连接」改为纯 JS 直连 API，不再依赖 python 和转换器：成功显示模型返回，失败显示 HTTP 状态码 + 网关原文（401/403 提示密钥、404 提示路径或模型名、超时与网络不可达分别提示）
- 从 .xpi 安装时 `rootURI` 是 `jar:file://…!/`，里面的 `.py` 无法直接执行。现在启动时会把转换器解压到 `<profile>/mktero-bilingual-converter/<版本>/`（含 `vendor/tex-svg.js`），并在自检里显示实际目录
- 转换失败时把脚本的 stderr 末段一起弹出来，不再是「进程退出异常」
- 文件选择器改用 Zotero 的 FilePicker 封装；目录扫描改用 IOUtils（不再 `QueryInterface(Ci.nsIFile)`）
- 设置里字段读不到时不再把已有 Base URL / 模型清空；Base URL 与模型为空时仍允许保存其他项，只提示翻译不可用
- 新增 `scripts/sandbox_check.js`：在「只给沙箱该给的全局」的环境里跑 bootstrap.js，本地即可复现这类 ReferenceError
- 参考 Mktero 的 AI 配置层补齐几处：
  - Base URL 归一化规则统一到 JS 与 Python 两侧（`chatCompletionsUrl()` / `chat_endpoint()`），11 种写法逐一交叉验证一致，杜绝「测试连接成功、翻译却 404」
  - 填完整端点、只填域名、写成 `/v4` 这类版本路径都能正确拼出 `/chat/completions`；用户明确写了路径时不再擅自塞 `/v1`
  - Base URL 校验：非法网址、http:// （本地 localhost 除外）、带 `?`/`#`、带账号密码都在测试前直接指出
  - 本地/内网服务（localhost / 127.0.0.1 / ::1）没填 Key 时放行：JS 不发 Authorization 头，Python 用占位 key
  - 2xx 但响应不是 JSON 时单独提示「可能被网关登录页拦截」，不再当成成功
  - 测试期间禁用按钮，避免连点叠出并发请求；CLI `--test-llm` 不再强求回复里带 OK，并打印实际请求地址

## 0.5.1

- 合并设置界面：删除独立设置窗口，工具菜单/右键的「设置」改为调用 Zotero.Utilities.Internal.openPreferences(paneID) 直接定位到设置侧栏 pane，两个入口指向同一个界面，不再出现一个能填一个空白
- 面板逻辑改为事件驱动定位 document（_paneDoc(ev)），不再依赖可被覆盖的全局单例；打开 pane 后主动延迟补填表，兜底 onload 不触发的情况

## 0.5.0

- 设置界面按 Mktero 的 UI 风格重做：Canvas 主题变量、卡片式两栏设置行、分段标签页（API 接口 / 翻译设置 / 文件与输出 / 高级），自动适配深浅色
- 设置项全部真正生效：目标语言、批大小、字符上限、温度、超时、重试、术语统一、断点续传；默认输出目录、自动挂附件、自动打开、保留源码/缓存/中间产物；转换器目录与 python 路径
- 配置结构升级为 api / translation / files / advanced 四段，兼容旧扁平格式；侧栏面板与独立设置窗口共用同一套读写逻辑与配置
- 密钥仍只写本机 ~/.mktero_llm_config.json（权限 600），不回显

## 0.4.6

- 恢复设置侧栏项：改用极简纯 XUL 片段（无 XML 声明、无命名空间前缀、无内嵌脚本/样式表），避开之前的解析与沙箱坑
- 侧栏按钮通过 Zotero.MkteroBilingual 全局入口打开同一个独立设置窗口，并附文字指引作兜底
- 两处入口（设置侧栏 / 工具菜单）指向同一设置窗口，不再是两个独立界面

## 0.4.5

- 彻底移除 preference pane：设置只保留一个入口（工具/右键菜单 → API 与环境设置…），消除设置侧栏出现第二个入口的困惑
- 菜单注入前清理历史残留节点，防止工具菜单里出现两条完全相同的设置项
- 移除 prefs.xhtml / pane.js / prefs.css 死文件

## 0.4.4

- 设置改为独立的 XUL 对话框窗口（工具/右键菜单「API 与环境设置…」），不再依赖 preference pane 片段解析与 sandbox；窗口打不开时自动退回逐项输入弹窗，保证任何环境下设置都能改
- 修复多个插件实例并存时固定 pane ID 冲突导致新版面板注册失败的问题（pane ID 随机化，且降级为可选视图）

## 0.4.3

- 修复设置面板仍为空白：片段缺少 xmlns:html 声明，Zotero 严格 XML 解析抛 unbound prefix 导致窗格加载失败
- 面板脚本改为沙箱安全版：顶层不触碰 XPCOM，全部延迟到交互并逐层异常兜底，避免脚本报错中断窗格加载

## 0.4.2

- 修复设置面板：prefs.xhtml 改为 Zotero 要求的 XUL 片段格式（去掉 XML 声明与内嵌 style），CSS 独立注册；窗格内容不再加载失败
- 面板脚本初始化改为多时机兜底，确保按钮事件正确绑定

## 0.4.1

- 修复自动更新清单 update.json 的 update_link 指向错误（应指向版本 release 的 xpi，而非只放清单的 release tag）

## 0.4.0

- 新增可视化设置面板（工具 → 设置 → 双语快照 / arXiv 翻译），API 的 Base URL / 模型 / Key 可替换，带「测试连接」
- 插件内置 Python 转换器，安装后无需另配转换器目录
- 三种入口（md 文件 / 论文目录 / arXiv LaTeX）统一排版与 CSS
- arXiv 引用编号：文献按首次引用编号并可点击跳转，交叉引用解析为图/表/节号
- 修复引用标签被二次转义成可见文本的问题
- 修复 HTML 内嵌表格、脚注、图注标注、文件名编码损坏等问题
- 翻译器支持断点续传、术语统一、公式/引用占位符保护

## 0.3.x

- arXiv LaTeX 路线初版：e-print 下载、源码解析、宏展开、LLM 翻译、双语 HTML
- Zotero 插件菜单（`nsIProcess` 调用本机转换器，`importFromFile` 挂附件）

## 0.2.x

- Mktero 双语 md → 自包含 HTML，公式内联 SVG、图片 base64
- 文件选择器修复、粘贴路径兜底、文件名 UTF-8 传递
