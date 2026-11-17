# Changelog

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
