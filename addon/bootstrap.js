/* global Zotero, Services, IOUtils, PathUtils, ChromeUtils, fetch, ChromeWorker */

// ⚠️ 重要：Zotero 7~10 的 bootstrap 沙箱里【没有】Cc / Ci / Components。
// 加载器（chrome/content/zotero/xpcom/plugins.js 的 _loadScope）只注入：
//   Zotero, Services, IOUtils, PathUtils, ChromeUtils, Localization, ChromeWorker,
//   Worker, XMLSerializer, fetch, setTimeout/…, atob/btoa/Blob/crypto/DOMParser/…
// 以前直接写 Cc["@mozilla.org/process/util;1"] 会抛 ReferenceError: Cc is not defined，
// 被 catch 吞成「测试失败」这类无信息提示。本文件一律改用等价新 API：
//   nsIFile       -> Zotero.File.pathToFile() / IOUtils / PathUtils
//   nsIProcess    -> resource://gre/modules/Subprocess.sys.mjs
//   nsIFilePicker -> chrome://zotero/content/modules/filePicker.mjs
//   Services.dirsvc("Home") -> resolveHomeDir()（PathUtils.homeDir 并非各版本都有，见下）
var MB_PICK_OPEN = 0;      // FilePicker#modeOpen
var MB_PICK_FOLDER = 2;    // FilePicker#modeGetFolder

// Mktero 双语阅读快照 — Zotero 7-10 bootstrapped plugin
// 选中条目 -> 自己选双语 md 文件或论文目录 -> 调用本机转换器
// -> 输出以原论文名命名的单文件 HTML -> 作为 text/html 附件挂回条目

var MkteroBilingual = {
  id: null,
  version: null,
  rootURI: null,
  converterDir: null,   // 运行时解析出的转换器目录（jar 包会解压到 profile 下）
  started: false,       // startup 全部就绪后才允许挂菜单
  registrations: []
};

// ---- 平台适配层（替代 Cc / Ci） ----

// 外部进程：Subprocess 是异步的，不阻塞 UI，还能拿到 stdout/stderr
function getSubprocess() {
  return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
}

// 运行外部命令，返回 { code, stdout, stderr }
async function runProcess(command, args) {
  var Subprocess = getSubprocess();
  var proc;
  try {
    proc = await Subprocess.call({
      command: command,
      arguments: args || [],
      stdout: "pipe",
      stderr: "pipe"
    });
  } catch (e) {
    throw new Error("无法启动 " + command + "："
      + String(e && e.message ? e.message : e));
  }
  // 必须并行读管道，否则输出量大时子进程会写满缓冲区卡死
  var outP = proc.stdout ? proc.stdout.readString() : Promise.resolve("");
  var errP = proc.stderr ? proc.stderr.readString() : Promise.resolve("");
  // 注意：Subprocess 的 wait() 解析成 { exitCode } 对象，不是裸数字
  var done = await proc.wait();
  var code = (done && typeof done === "object" && "exitCode" in done) ? done.exitCode : done;
  var out = "";
  var err = "";
  try { out = await outP; } catch (e) {}
  try { err = await errP; } catch (e) {}
  return { code: code, stdout: out || "", stderr: err || "" };
}

// 把 jar 内的文件读成文本。插件 id 里带 '@'，jar: URL 直接 fetch/XHR 会被
// 「userinfo@host」规则解析歪掉；Zotero 的 getResourceAsync 走 nsIChannel，
// 正是为这种情况准备的（见 Zotero 自己读插件 locale 的代码）。
async function fetchText(url) {
  var F = Zotero.File;
  if (typeof F.getResourceAsync === "function") {
    try {
      var t = await F.getResourceAsync(url);
      if (t) return String(t);
    } catch (e) {
      Zotero.logError(e);
    }
  }
  if (typeof F.getResource === "function") {
    try {
      var t2 = F.getResource(url);
      if (t2) return String(t2);
    } catch (e) {
      Zotero.logError(e);
    }
  }
  try {
    var resp = await fetch(url);
    if (resp && resp.ok) return await resp.text();
  } catch (e) {
    Zotero.logError(e);
  }
  return String(await Zotero.File.getContentsFromURLAsync(url));
}

// 用户主目录。PathUtils.profileDir 各版本都有，但 homeDir 不一定——取不到时
// 会抛异常，被上层 catch 吞成「找不到用户主目录」这种看似莫名的提示。
// 逐级回退，并且把结果缓存下来（配置文件路径每次读写都要用）。
var _homeDirCache = null;
function resolveHomeDir() {
  if (_homeDirCache !== null) return _homeDirCache;
  var found = "";
  // 1) PathUtils.homeDir（新版 Gecko 才有）
  try {
    var h = PathUtils.homeDir;
    if (typeof h === "string" && h) found = h;
  } catch (e) {}
  // 2) Services.dirsvc 的 "Home"。沙箱里没有 Ci，只能从活窗口借 nsIFile 常量
  if (!found) {
    try {
      var wins = (Zotero.getMainWindows ? Zotero.getMainWindows() : []) || [];
      var win = wins[0] || (Zotero.getMainWindow ? Zotero.getMainWindow() : null);
      var Ci = win && win.Components && win.Components.interfaces;
      if (Ci && Ci.nsIFile) {
        var f = Services.dirsvc.get("Home", Ci.nsIFile);
        if (f && f.path) found = f.path;
      }
    } catch (e) {}
  }
  // 3) 再退一步：从 profileDir 往上找家目录（…/Library/Application Support/Zotero/Profiles/x.default）
  if (!found) {
    try {
      var p = String(PathUtils.profileDir || "");
      var m = p.match(/^(.*?)\/Library\/Application Support\/Zotero\/Profiles\//);
      if (m && m[1]) found = m[1];
    } catch (e) {}
  }
  if (found) {
    try { Zotero.debug("[Mktero Bilingual] homeDir = " + found); } catch (e) {}
  }
  _homeDirCache = found;
  return found;
}

// 插件打包成 .xpi 后 rootURI 是 jar:file:///…!/，里面的 .py 不能直接执行，
// 必须解压到 profile 下一个稳定目录；开发态（file://）直接用源码目录。
var CONVERTER_FILES = [
  "arxiv_to_zotero.py",
  "arxiv_translate.py",
  "bilingual_to_zotero.py",
  "formula_svg.py",
  "vendor/tex-svg.js"
];

function converterDirFromRootURI() {
  try {
    var uri = MkteroBilingual.rootURI || "";
    if (uri.indexOf("file:") !== 0) return "";
    var path = decodeURIComponent(uri.replace(/^file:\/\//, "").replace(/\/$/, ""));
    var dir = path + "/converter";
    return Zotero.File.pathToFile(dir).exists() ? dir : "";
  } catch (e) {
    Zotero.logError(e);
    return "";
  }
}

async function ensureConverterDir() {
  // 1) 用户在设置里显式指定的目录最优先
  var custom = "";
  try { custom = Zotero.Prefs.get(PREFIX + "converterDir", true) || ""; } catch (e) {}
  if (custom && Zotero.File.pathToFile(custom).exists()) {
    MkteroBilingual.converterDir = custom;
    return custom;
  }
  // 2) 开发态：源码目录
  var src = converterDirFromRootURI();
  if (src) {
    MkteroBilingual.converterDir = src;
    return src;
  }
  // 3) 安装态：从 xpi 解压
  var uri = MkteroBilingual.rootURI || "";
  if (!uri) return "";
  var target = PathUtils.join(
    PathUtils.profileDir,
    "mktero-bilingual-converter",
    String(MkteroBilingual.version || "0")
  );
  // 主脚本在就认为已经解压过：不再每次重试那 2MB 的 tex-svg.js
  // （它解压失败也没关系，formula_svg.py 会自己从 xpi 里读）
  var mainPath = PathUtils.join(target, "bilingual_to_zotero.py");
  var mainReady = false;
  try { mainReady = await IOUtils.exists(mainPath); } catch (e) {}
  var missing = [];
  for (var i = 0; i < CONVERTER_FILES.length && !mainReady; i++) {
    var ok = false;
    try { ok = await IOUtils.exists(PathUtils.join(target, CONVERTER_FILES[i])); } catch (e) {}
    if (!ok) missing.push(CONVERTER_FILES[i]);
  }
  if (missing.length) {
    try {
      await IOUtils.makeDirectory(target, { ignoreExisting: true, createAncestors: true });
      await IOUtils.makeDirectory(PathUtils.join(target, "vendor"),
        { ignoreExisting: true, createAncestors: true });
    } catch (e) {
      Zotero.logError(e);
    }
    for (var j = 0; j < missing.length; j++) {
      var rel = missing[j];
      var dest = PathUtils.join(target, rel);
      try {
        var text = await fetchText(uri + "converter/" + rel);
        if (!text) throw new Error("内容为空");
        await IOUtils.writeUTF8(dest, text, { tmpPath: dest + ".tmp" });
      } catch (e) {
        Zotero.logError(e);
        Zotero.debug("[Mktero Bilingual] 解压失败 " + rel + ": " + e);
      }
    }
  }
  var main = PathUtils.join(target, "bilingual_to_zotero.py");
  var exists = false;
  try { exists = await IOUtils.exists(main); } catch (e) {}
  MkteroBilingual.converterDir = exists ? target : "";
  return MkteroBilingual.converterDir;
}

// ---- 网络代理 ----
// 只认设置里手填的地址，不再自动套用系统代理。
// 原因：macOS 上 python 的 urllib 会自己读取系统代理，而实测系统里的
// Clash(127.0.0.1:7897) 会让 myai.bupt.edu.cn 直接 SSL_ERROR_SYSCALL，
// 直连反而正常。自动套用会把「本来能通的」弄成不通，所以默认直连，
// 需要代理的人显式填写。
function proxyUrl() {
  try {
    return String(Zotero.Prefs.get(PREFIX + "proxy", true) || "").trim();
  } catch (e) {
    return "";
  }
}

// ---- OpenAI 兼容接口地址 ----
// ⚠️ 这里的规则必须和 converter/arxiv_translate.py 的 chat_endpoint() 完全一致，
// 否则会出现「测试连接成功、翻译却 404」这种最难查的错。
function apiPathOf(u) {
  var m = String(u || "").match(/^[a-z]+:\/\/[^/]+(\/.*)?$/i);
  return m && m[1] ? m[1] : "";
}

function chatCompletionsUrl(base) {
  var u = String(base || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  // 用户直接贴了完整端点：原样用
  if (/\/chat\/completions$/i.test(u)) return u;
  // 以 /v1、/v4 这类版本结尾：补端点
  if (/\/v\d+$/i.test(u)) return u + "/chat/completions";
  // 只给了域名（没写路径）才补 /v1；用户明确写了路径就尊重它
  var p = apiPathOf(u);
  if (!p || p === "/") return u + "/v1/chat/completions";
  return u + "/chat/completions";
}

// 校验 Base URL，返回 { ok, error, loopback }
function validateApiBase(base) {
  var raw = String(base || "").trim();
  if (!raw) return { ok: false, error: "请先填 Base URL" };
  var u = null;
  try {
    u = new URL(raw);
  } catch (e) {
    return { ok: false, error: "Base URL 不是合法网址：" + raw };
  }
  if (u.username || u.password) {
    return { ok: false, error: "Base URL 里不要带账号密码" };
  }
  if (u.search || u.hash) {
    return { ok: false, error: "Base URL 不要带 ? 或 # 参数" };
  }
  var loop = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) {
    return { ok: false, error: "Base URL 必须是 https://（本地 localhost 可用 http://）" };
  }
  return { ok: true, url: u, loopback: loop };
}

// preference pane 的 XHTML 在设置窗口作用域里执行，访问不到 bootstrap 的局部变量。
// 挂到 Zotero 全局，供片段里的 oncommand 调用。
Zotero.MkteroBilingual = {
  openSettings: function () {
    var win = Zotero.getMainWindow();
    if (win) openSettings(win);
  },
  selfCheck: function () {
    var win = Zotero.getMainWindow();
    if (win) selfCheck(win);
  },
  getConfig: function () { return MkteroConfig; },

  // ---- 设置面板逻辑（挂在全局，避免 pane 沙箱脚本） ----
  paneDoc: null,

  _paneDoc: function (ev) {
    // 优先用事件自带的 document（最可靠，且不受窗口切换影响）
    try {
      if (ev) {
        var d = ev.target ? ev.target.ownerDocument
              : (ev.view && ev.view.document);
        if (d && d.getElementById("bs-prefpane")) {
          this.paneDoc = d;
          return d;
        }
      }
    } catch (e) {}
    if (this.paneDoc && this.paneDoc.getElementById("bs-prefpane")) return this.paneDoc;
    try {
      var enumr = Services.wm.getEnumerator(null);
      while (enumr.hasMoreElements()) {
        var w = enumr.getNext();
        var wd = w && (w.document || (w.content && w.content.document));
        if (wd && wd.getElementById && wd.getElementById("bs-prefpane")) {
          this.paneDoc = wd;
          return wd;
        }
      }
    } catch (e2) {}
    return null;
  },

  _set: function (id, val, ev) {
    var d = this._paneDoc(ev);
    if (!d) return;
    var el = d.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!val;
    else el.value = (val === undefined || val === null) ? "" : String(val);
  },

  _get: function (id, fallback, ev) {
    var d = this._paneDoc(ev);
    if (!d) return fallback;
    var el = d.getElementById(id);
    if (!el) return fallback;
    return el.type === "checkbox" ? el.checked : el.value;
  },

  // target：只写指定的那个状态位。不传则两处都写（加载时的通用提示）。
  // 有 target 时另一处保持原样，避免同一条错误在界面上出现两遍。
  _status: function (text, ok, ev, target) {
    var d = this._paneDoc(ev);
    if (!d) return;
    var ids = target ? [target] : ["bs-status", "bs-save-status"];
    ids.forEach(function (id) {
      var el = d.getElementById(id);
      if (el) {
        el.textContent = text || "";
        el.setAttribute("class", "bs-status" +
          (ok === true ? " ok" : ok === false ? " err" : ""));
      }
    });
  },

  // 侧栏 pane 与独立设置窗口共用：传入各自的 document，绑定 tab 并填表
  attachDoc: function (doc) {
    var self = this;
    if (!doc) return;
    this.paneDoc = doc;
    var pseudoEv = { target: { ownerDocument: doc } };
    // 幂等，避免重复绑定
    if (doc.documentElement.getAttribute("data-bs-bound") === "1") {
      this.loadPrefs(pseudoEv);
      return;
    }
    doc.documentElement.setAttribute("data-bs-bound", "1");
    var tabs = doc.querySelectorAll("[data-bs-tab]");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (e) {
        var key = this.getAttribute("data-bs-tab");
        var d = self._paneDoc(e);
        if (!d) return;
        var ts = d.querySelectorAll("[data-bs-tab]");
        for (var j = 0; j < ts.length; j++) {
          ts[j].setAttribute("aria-selected",
            ts[j].getAttribute("data-bs-tab") === key ? "true" : "false");
        }
        var ss = d.querySelectorAll("[data-bs-section]");
        for (var k = 0; k < ss.length; k++) {
          var sec = ss[k];
          if (sec.getAttribute("data-bs-section") === key) sec.removeAttribute("hidden");
          else sec.setAttribute("hidden", "hidden");
        }
      });
    }
    this.loadPrefs(pseudoEv);
  },

  onPaneLoad: function (ev) {
    try {
      var d = ev && (ev.target ? ev.target.ownerDocument : ev.view && ev.view.document);
      if (d) this.attachDoc(d);
    } catch (e) { Zotero.logError(e); }
  },

  loadPrefs: function (ev) {
    var s;
    try { s = MkteroConfig.read(); }
    catch (e) { this._status("读取配置失败", false, ev); return; }
    this._set("bs-base-url", s.api.base_url, ev);
    this._set("bs-model", s.api.model, ev);
    this._set("bs-api-key", "", ev);            // 密钥不回显
    this._set("bs-temperature", s.api.temperature, ev);
    this._set("bs-timeout", s.api.timeout, ev);
    this._set("bs-target-lang", s.translation.target_lang, ev);
    this._set("bs-batch", s.translation.batch, ev);
    this._set("bs-max-chars", s.translation.max_chars, ev);
    this._set("bs-retries", s.translation.retries, ev);
    this._set("bs-glossary", s.translation.glossary, ev);
    this._set("bs-resume", s.translation.resume, ev);
    this._set("bs-output-dir", s.files.output_dir, ev);
    this._set("bs-attach", s.files.attach, ev);
    this._set("bs-open-after", s.files.open_after, ev);
    this._set("bs-keep-source", s.files.keep_source, ev);
    this._set("bs-keep-cache", s.files.keep_cache, ev);
    this._set("bs-keep-blocks", s.files.keep_blocks, ev);
    this._set("bs-converter-dir", s.advanced.converter_dir, ev);
    this._set("bs-python", s.advanced.python, ev);
    this._set("bs-proxy", s.advanced.proxy, ev);
  },

  // 表单没加载出来（_get 返回 fallback）时保留原配置，避免把已有设置清空；
  // 表单存在时以用户输入为准（包括用户主动清空）。
  collectPrefs: function (existing, ev) {
    var s = existing ? JSON.parse(JSON.stringify(existing)) : MkteroConfig.read();
    var e = existing || s;
    var num = function (id, def, lo, hi) {
      var v = parseFloat(Zotero.MkteroBilingual._get(id, def, ev));
      if (isNaN(v)) return def;
      if (lo !== undefined && v < lo) v = lo;
      if (hi !== undefined && v > hi) v = hi;
      return v;
    };
    s.api.base_url = String(this._get("bs-base-url", e.api.base_url || "", ev)).trim();
    s.api.model = String(this._get("bs-model", e.api.model || "", ev)).trim();
    var key = String(this._get("bs-api-key", "", ev)).trim();
    if (key) s.api.api_key = key;         // 留空保留旧密钥
    s.api.temperature = num("bs-temperature", e.api.temperature, 0, 2);
    s.api.timeout = num("bs-timeout", e.api.timeout, 10, 600);
    s.translation.target_lang = String(
      this._get("bs-target-lang", e.translation.target_lang, ev));
    s.translation.batch = Math.round(num("bs-batch", e.translation.batch, 1, 30));
    s.translation.max_chars = Math.round(
      num("bs-max-chars", e.translation.max_chars, 500, 12000));
    s.translation.retries = Math.round(num("bs-retries", e.translation.retries, 1, 10));
    s.translation.glossary = !!this._get("bs-glossary", e.translation.glossary, ev);
    s.translation.resume = !!this._get("bs-resume", e.translation.resume, ev);
    s.files.output_dir = String(
      this._get("bs-output-dir", e.files.output_dir || "", ev)).trim();
    s.files.attach = !!this._get("bs-attach", e.files.attach, ev);
    s.files.open_after = !!this._get("bs-open-after", e.files.open_after, ev);
    s.files.keep_source = !!this._get("bs-keep-source", e.files.keep_source, ev);
    s.files.keep_cache = !!this._get("bs-keep-cache", e.files.keep_cache, ev);
    s.files.keep_blocks = !!this._get("bs-keep-blocks", e.files.keep_blocks, ev);
    s.advanced.converter_dir = String(
      this._get("bs-converter-dir", e.advanced.converter_dir || "", ev)).trim();
    s.advanced.python = String(this._get("bs-python", e.advanced.python || "", ev)).trim();
    s.advanced.proxy = String(this._get("bs-proxy", e.advanced.proxy || "", ev)).trim();
    return s;
  },

  savePrefs: function (ev) {
    try {
      var old = MkteroConfig.read();
      var s = this.collectPrefs(old, ev);
      MkteroConfig.write(s);
      // 同步转换器/python 到旧 prefs（runPython 等仍在用）
      if (s.advanced.converter_dir) setPref("converterDir", s.advanced.converter_dir);
      if (s.advanced.python) setPref("python", s.advanced.python);
      setPref("proxy", s.advanced.proxy || "");
      var d = this._paneDoc(ev);
      if (d) { var k = d.getElementById("bs-api-key"); if (k) k.value = ""; }
      var incomplete = !s.api.base_url || !s.api.model;
      this._status(incomplete
        ? "已保存，但 Base URL / 模型还空着，翻译仍不可用"
        : "已保存（密钥仅存本机）", !incomplete, ev, "bs-save-status");
      return true;
    } catch (e) {
      this._status("保存失败：" + (e && e.message ? e.message : e), false, ev, "bs-save-status");
      Zotero.logError(e);
      return false;
    }
  },

  resetPrefs: function (ev) {
    try {
      var old = MkteroConfig.read();
      var s = JSON.parse(JSON.stringify(MkteroConfig.DEFAULT));
      s.api.api_key = old.api.api_key;   // 保留密钥
      this._set("bs-base-url", s.api.base_url, ev);
      this._set("bs-model", s.api.model, ev);
      this._set("bs-temperature", s.api.temperature, ev);
      this._set("bs-timeout", s.api.timeout, ev);
      this._set("bs-target-lang", s.translation.target_lang, ev);
      this._set("bs-batch", s.translation.batch, ev);
      this._set("bs-max-chars", s.translation.max_chars, ev);
      this._set("bs-retries", s.translation.retries, ev);
      this._set("bs-glossary", s.translation.glossary, ev);
      this._set("bs-resume", s.translation.resume, ev);
      this._set("bs-output-dir", s.files.output_dir, ev);
      this._set("bs-attach", s.files.attach, ev);
      this._set("bs-open-after", s.files.open_after, ev);
      this._set("bs-keep-source", s.files.keep_source, ev);
      this._set("bs-keep-cache", s.files.keep_cache, ev);
      this._set("bs-keep-blocks", s.files.keep_blocks, ev);
      this._set("bs-converter-dir", s.advanced.converter_dir, ev);
      this._set("bs-python", s.advanced.python, ev);
      this._set("bs-proxy", s.advanced.proxy, ev);
      this._status("已恢复默认，点「保存设置」生效", true, ev, "bs-save-status");
    } catch (e) { this._status("重置失败", false, ev, "bs-save-status"); }
  },

  // 纯 JS 直连 API 做一次最小请求：不依赖 python、不依赖转换器目录，
  // 失败时把 HTTP 状态码和网关返回的原文显示出来，而不是一句「测试失败」。
  testLLM: function (ev) {
    var self = this;
    if (!this.savePrefs(ev)) {
      // 保存失败的原因刚写在底部状态位，这里挪到按钮旁边，避免同一条错误
      // 在上下两处同时出现（看着像两个错）
      var d0 = this._paneDoc(ev);
      var foot = d0 && d0.getElementById("bs-save-status");
      var msg = foot && foot.textContent;
      if (msg) {
        this._status(msg, false, ev, "bs-status");
        this._status("", undefined, ev, "bs-save-status");
      }
      return;
    }

    var s;
    try { s = MkteroConfig.read(); }
    catch (e) { this._status("读取配置失败：" + (e && e.message ? e.message : e), false, ev, "bs-status"); return; }

    var base = String(s.api.base_url || "").trim();
    var model = String(s.api.model || "").trim();
    var key = String(s.api.api_key || "").trim();

    var v = validateApiBase(base);          // 先看地址，比模型名更基础
    if (!v.ok) { this._status(v.error, false, ev, "bs-status"); return; }
    if (!model) { this._status("请先填模型名", false, ev, "bs-status"); return; }
    // 本地/内网服务常常不需要 key，不要因此拦住测试（正式翻译同样放行）
    if (!key && !v.loopback) {
      this._status("还没填 API Key（本地或内网免 key 的服务可忽略）", false, ev, "bs-status");
      return;
    }

    var url = chatCompletionsUrl(base);
    var timeout = Math.round(Number(s.api.timeout) || 120);
    if (!(timeout >= 10)) timeout = 10;
    if (timeout > 600) timeout = 600;

    // 防止连点叠出一堆并发请求
    var btn = null;
    try { var d0 = this._paneDoc(ev); btn = d0 && d0.getElementById("bs-test-btn"); } catch (e) {}
    if (btn) { if (btn.disabled) return; btn.disabled = true; }
    this._status("测试中…（" + url + "）", undefined, ev, "bs-status");

    var done = function (text, ok) {
      if (btn) btn.disabled = false;
      self._status(text, ok, ev, "bs-status");
    };

    var headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = "Bearer " + key;
    var body = JSON.stringify({
      model: model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4,
      temperature: 0
    });

    Zotero.HTTP.request("POST", url, {
      headers: headers,
      body: body,
      responseType: "text",
      timeout: timeout * 1000,
      successCodes: false     // 非 2xx 也走 then，方便自己判断并显示原因
    }).then(function (xhr) {
      var code = xhr.status;
      var text = "";
      try { text = String(xhr.responseText || ""); } catch (e) {}
      var brief = text.replace(/\s+/g, " ").trim();
      if (brief.length > 240) brief = brief.slice(0, 240) + "…";
      if (code >= 200 && code < 300) {
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) {}
        if (!parsed) {
          // 2xx 但不是 JSON：多半是被门户/代理的登录页或 HTML 错误页接走了
          done("HTTP " + code + " 但不是合法 JSON（可能被网关登录页拦截）："
            + brief, false);
          return;
        }
        var reply = "";
        try {
          reply = (parsed.choices && parsed.choices[0] && parsed.choices[0].message
            && parsed.choices[0].message.content) || "";
        } catch (e) {}
        done("连接成功：" + model
          + (reply ? "（返回 " + String(reply).trim().slice(0, 20) + "）" : " 返回正常"),
          true);
        return;
      }
      var hint = "";
      if (code === 401 || code === 403) hint = "，密钥无效或没有该模型的权限";
      else if (code === 404) hint = "，接口路径或模型名不对（当前请求 " + url + "）";
      else if (code === 429) hint = "，触发限流，稍后再试";
      else if (code >= 500) hint = "，网关或上游模型出错";
      done("HTTP " + code + hint + (brief ? "：" + brief : ""), false);
    }, function (err) {
      var msg = String(err && err.message ? err.message : err);
      if (/timeout|timed out/i.test(msg)) {
        msg = "超时（" + timeout + " 秒内没响应）";
      } else if (/NetworkError|Network Error|nsresult/i.test(msg)) {
        msg = "网络不可达，检查 Base URL 是否能访问（代理 / 内网网关）";
      }
      done("请求失败：" + msg, false);
    });
  }
};

// 统一配置读写：api / translation / files / advanced 四段。
// 兼容旧的扁平格式（base_url / model / api_key 在顶层）。
var MkteroConfig = {
  DEFAULT: {
    api: { base_url: "", model: "", api_key: "", temperature: 0.2, timeout: 120 },
    translation: { target_lang: "zh-CN", batch: 8, max_chars: 2600,
                   glossary: true, retries: 3, resume: true },
    files: { output_dir: "", keep_source: false, keep_cache: false,
             keep_blocks: false, attach: true, open_after: true },
    advanced: { converter_dir: "", python: "", proxy: "" }
  },

  path: function () {
    var home = resolveHomeDir();
    if (!home) return "";
    try {
      return PathUtils.join(home, ".mktero_llm_config.json");
    } catch (e) {
      Zotero.logError(e);
      return "";
    }
  },

  read: function () {
    var raw = {};
    try {
      var p = this.path();
      if (p) raw = JSON.parse(Zotero.File.getContents(p) || "{}");
      else {
        try { Zotero.debug("[Mktero Bilingual] 读配置：定位不到用户主目录，用默认值"); }
        catch (e) {}
      }
    } catch (e) { raw = {}; }
    var s = this.merge(this.DEFAULT, raw);
    // 旧版扁平字段提升
    if (!s.api.base_url && raw.base_url) s.api.base_url = raw.base_url;
    if (!s.api.model && raw.model) s.api.model = raw.model;
    if (!s.api.api_key && raw.api_key) s.api.api_key = raw.api_key;
    return s;
  },

  merge: function (base, over) {
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(over || {}).forEach(function (k) {
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k])
          && out[k] && typeof out[k] === "object") {
        out[k] = MkteroConfig.merge(out[k], over[k]);
      } else {
        out[k] = over[k];
      }
    });
    return out;
  },

  write: function (s) {
    var p = this.path();
    if (!p) {
      throw new Error("定位不到用户主目录，配置未写入。" +
        "请打开「帮助 → 调试输出日志」搜 Mktero Bilingual 查看详情。");
    }
    // 保留旧扁平字段，兼容命令行直接调用脚本
    var out = JSON.parse(JSON.stringify(s));
    out.base_url = s.api.base_url;
    out.model = s.api.model;
    if (s.api.api_key) out.api_key = s.api.api_key;
    // ⚠️ Zotero.File.putContents(file, str) 第一参必须是 nsIFile：
    // 它内部直接 file.exists()，传字符串会抛「file.exists is not a function」。
    // （同名的 putContentsAsync 倒是接受路径字符串，两者不对称）
    Zotero.File.putContents(Zotero.File.pathToFile(p), JSON.stringify(out, null, 2));
    // 密钥文件收紧到 600（异步执行，失败不影响保存结果）
    try {
      IOUtils.setPermissions(p, 0o600).catch(function () {});
    } catch (e) {}
    return p;
  }
};

var PREFIX = "extensions.mkterobilang.";

var DEFAULTS = {
  converterDir: "",        // 运行时从插件内置 converter/ 目录解析
  proxy: "",               // 手动指定代理；留空自动探测系统代理
  python: "/usr/bin/python3",
  lastDir: ""
};

// 插件自带的转换器目录：安装态由 ensureConverterDir() 从 xpi 解压到 profile，
// 开发态直接用源码目录。缓存结果，避免每次 getPref 都去碰磁盘。
function builtinConverterDir() {
  // 只缓存解析成功的结果。以前会把 "" 也缓存下来，一旦在解压完成前被问过一次，
  // 后面一直拿到空串，报「找不到 arXiv 转换器：/arxiv_to_zotero.py」。
  if (MkteroBilingual.converterDir) return MkteroBilingual.converterDir;
  var dir = converterDirFromRootURI();
  if (dir) MkteroBilingual.converterDir = dir;
  return dir || "";
}

// 真正要用转换器时的统一入口：内存里没有就现场解压一次（幂等），
// 免得受启动时序影响——onMainWindowLoad 可能比 startup 里的解压更早跑到。
async function requireConverterDir() {
  var dir = getPref("converterDir") || builtinConverterDir();
  if (dir && Zotero.File.pathToFile(dir).exists()) return dir;
  try {
    dir = await ensureConverterDir();
  } catch (e) {
    Zotero.logError(e);
  }
  return dir || "";
}

function converterMissingError(dir) {
  return "找不到转换器脚本（目录：" + (dir || "空") + "）。\n"
    + "插件版本：" + (MkteroBilingual.version || "?") + "\n"
    + "安装位置：" + (MkteroBilingual.rootURI || "?") + "\n\n"
    + "请打开「工具 → 双语快照：自检…」看「转换器目录」一行；"
    + "若为空，重启一次 Zotero 通常就会解压好。";
}

function getPref(name) {
  try {
    var v = Zotero.Prefs.get(PREFIX + name, true);
    if (v !== undefined && v !== null && v !== "") return v;
  } catch (e) {}
  if (name === "converterDir") {
    var builtin = builtinConverterDir();
    if (builtin) return builtin;
  }
  return DEFAULTS[name];
}

function setPref(name, value) {
  try {
    Zotero.Prefs.set(PREFIX + name, value, true);
  } catch (e) {
    Zotero.logError(e);
  }
}

function alertWin(win, title, text) {
  try {
    Services.prompt.alert(win, title, text);
    return;
  } catch (e) {
    Zotero.logError(e);
  }
  try {
    Zotero.alert(win, title, text);
    return;
  } catch (e) {
    Zotero.logError(e);
  }
  try {
    win.alert(title + "\n\n" + text);
  } catch (e) {
    Zotero.logError(e);
  }
}

// 保留原论文标题作为文件名，只替换文件系统不安全的字符
function paperName(s) {
  return String(s || "Untitled")
    .replace(/:/g, "：")
    .replace(/[\\/*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Untitled";
}

function makeMenuItem(doc) {
  try {
    return doc.createXULElement("menuitem");
  } catch (e) {
    return doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
      "menuitem"
    );
  }
}

function addMenus(win) {
  var doc = win.document;
  // 先清掉本插件历史上注入过、但未被 removeMenusForWindow 清理干净的旧菜单项，
  // 再重新注入。这样即使旧版本留下了重复节点，也不会看到两个相同入口。
  try {
    var stale = doc.querySelectorAll("[data-mktero-bilingual]");
    for (var si = 0; si < stale.length; si++) {
      if (stale[si].parentNode) stale[si].parentNode.removeChild(stale[si]);
    }
  } catch (e) {}
  var targets = [
    { popupID: "zotero-itemmenu", label: "生成双语阅读快照（选 md 文件）…", command: "file", itemMenu: true },
    { popupID: "zotero-itemmenu", label: "生成双语阅读快照（选论文目录）…", command: "folder", itemMenu: true },
    { popupID: "zotero-itemmenu", label: "找 arXiv 版并生成双语快照（自动检索）…", command: "arxivAuto", itemMenu: true },
    { popupID: "zotero-itemmenu", label: "从 arXiv 生成双语快照…", command: "arxiv", itemMenu: true },
    { popupID: "menu_ToolsPopup", label: "生成双语阅读快照（选 md 文件）…", command: "file" },
    { popupID: "menu_ToolsPopup", label: "生成双语阅读快照（选论文目录）…", command: "folder" },
    { popupID: "menu_ToolsPopup", label: "找 arXiv 版并生成双语快照（自动检索）…", command: "arxivAuto" },
    { popupID: "menu_ToolsPopup", label: "从 arXiv 生成双语快照…", command: "arxiv" },
    { popupID: "zotero-itemmenu", label: "双语快照：API 与环境设置…", command: "settings", itemMenu: true },
    { popupID: "menu_ToolsPopup", label: "双语快照：API 与环境设置…", command: "settings" },
    { popupID: "menu_ToolsPopup", label: "双语快照：自检…", command: "check" }
  ];

  var itemMenuItems = [];

  targets.forEach(function (t) {
    var popup = doc.getElementById(t.popupID);
    if (!popup) {
      return;
    }
    var mi = makeMenuItem(doc);
    mi.setAttribute("label", t.label);
    mi.setAttribute("data-mktero-bilingual", "1");
    mi.addEventListener("command", function () {
      var task;
      if (t.command === "settings") {
        task = openSettings(win);
      } else if (t.command === "check") {
        task = selfCheck(win);
      } else if (t.command === "arxiv") {
        task = runArxiv(win);
      } else if (t.command === "arxivAuto") {
        task = runArxivAuto(win);
      } else {
        task = run(win, t.command);
      }
      Promise.resolve(task).catch(function (e) {
        Zotero.logError(e);
        alertWin(win, "双语阅读快照 — 错误", String(e && e.message ? e.message : e));
      });
    });
    popup.appendChild(mi);
    MkteroBilingual.registrations.push({ win: win, el: mi });
    if (t.itemMenu) {
      itemMenuItems.push(mi);
    }
  });

  if (itemMenuItems.length) {
    var popup = doc.getElementById("zotero-itemmenu");
    var listener = function () {
      var items = [];
      try {
        items = Zotero.getActiveZoteroPane().getSelectedItems() || [];
      } catch (e) {
        Zotero.logError(e);
      }
      var visible = items.length === 1 && items[0].isRegularItem();
      itemMenuItems.forEach(function (mi) {
        mi.hidden = !visible;
      });
    };
    if (popup) {
      popup.addEventListener("popupshowing", listener);
      MkteroBilingual.registrations.push({ win: win, popup: popup, listener: listener });
    }
  }
}

function removeMenusForWindow(win) {
  try {
    if (win.document && win.document.documentElement) {
      win.document.documentElement.removeAttribute("data-mktero-bilingual-menus");
    }
  } catch (e) {}
  var rest = [];
  MkteroBilingual.registrations.forEach(function (r) {
    if (r.win !== win) {
      rest.push(r);
      return;
    }
    try {
      if (r.el && r.el.parentNode) {
        r.el.parentNode.removeChild(r.el);
      }
      if (r.popup && r.listener) {
        r.popup.removeEventListener("popupshowing", r.listener);
      }
    } catch (e) {
      Zotero.logError(e);
    }
  });
  MkteroBilingual.registrations = rest;
}

function install(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
  MkteroBilingual.id = id;
  MkteroBilingual.version = version;
  MkteroBilingual.rootURI = rootURI;
  await Zotero.initializationPromise;

  // 装上 .xpi 时 rootURI 是 jar:file:///…!/，里面的 .py 不能直接执行，
  // 这里先解压到 profile/mktero-bilingual-converter/<version>/ 再跑。
  try {
    await ensureConverterDir();
    Zotero.debug("[Mktero Bilingual] converter dir = " + MkteroBilingual.converterDir);
  } catch (e) {
    Zotero.logError(e);
  }

  // 设置侧栏项：极简纯 XUL 片段（无 XML 声明、无 html: 前缀、无内嵌 style 标签、
  // 不加载 scripts / stylesheets），避开之前踩过的解析与沙箱坑。
  // 片段里只有一个按钮，点击后调用 Zotero.MkteroBilingual.openSettings()
  // 打开独立设置窗口——两处入口指向同一个窗口，不会有两个独立设置界面。
  try {
    if (Zotero.PreferencePanes && typeof Zotero.PreferencePanes.register === "function") {
      var paneId = "mktero-prefs-" + Math.random().toString(36).slice(2, 10);
      MkteroBilingual.prefPaneId = await Zotero.PreferencePanes.register({
        pluginID: id,
        id: paneId,
        src: rootURI + "prefs.xhtml",
        label: "双语快照 / arXiv 翻译",
        stylesheets: [rootURI + "settings.css"]
      });
    }
  } catch (e) {
    // 侧栏项注册失败也不影响工具菜单入口
    Zotero.logError(e);
  }

  Zotero.getMainWindows().forEach(function (win) {
    if (win && win.document) {
      addMenus(win);
    }
  });
  MkteroBilingual.started = true;
}

function onMainWindowLoad({ window }) {
  // Zotero 可能在 startup 的异步解压还没结束时就调到这里。那时候挂菜单，
  // 用户马上点会拿到空的转换器目录（0.6.0 的真实报错）。startup 结束时本来就会
  // 给所有窗口挂一遍菜单，这里只需在「已就绪」后处理后续新开的窗口。
  if (!MkteroBilingual.started) return;
  addMenus(window);
}

function onMainWindowUnload({ window }) {
  removeMenusForWindow(window);
}

function shutdown({ id, version, rootURI }, reason) {
  var wins = [];
  try {
    wins = Zotero.getMainWindows();
  } catch (e) {
    Zotero.logError(e);
  }
  wins.forEach(function (win) {
    removeMenusForWindow(win);
  });
  MkteroBilingual.registrations = [];
}

function uninstall(data, reason) {}

// 目录里第一个 .md（用 IOUtils 列目录，不需要 Ci.nsIFile）
async function firstMarkdown(dirPath) {
  try {
    var names = await IOUtils.getChildren(dirPath);
    for (var i = 0; i < names.length; i++) {
      if (/\.md$/i.test(names[i])) {
        var st = await IOUtils.stat(names[i]);
        if (st.type === "regular") return names[i];
      }
    }
  } catch (e) {
    Zotero.logError(e);
  }
  return null;
}

// 文件选择器不可用/被取消时，退回「粘贴路径」，保证流程不会静默中断
function promptPath(win, title, mode) {
  var hint = (mode === MB_PICK_FOLDER)
    ? "粘贴「论文目录」的绝对路径（Finder 里选中文件夹按 ⌥⌘C 复制路径）。\n留空则放弃："
    : "粘贴双语 .md 文件的绝对路径（Finder 里选中文件按 ⌥⌘C 复制路径）。\n留空则放弃：";
  var obj = { value: "" };
  var ok = Services.prompt.prompt(win, title, hint, obj, null, { value: false });
  if (!ok || !obj.value) {
    return null;
  }
  return String(obj.value).trim();
}

// 每次由用户自己选，记住上次所在目录方便下次定位，不预设任何 inbox
function pickPath(win, title, mode) {
  return new Promise(function (resolve) {
    var FilePicker;
    try {
      // 用 Zotero 自己的 FilePicker 包装（内部持有 nsIFilePicker），
      // 插件沙箱里拿不到 Ci，直接用会抛 ReferenceError。
      FilePicker = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs").FilePicker;
    } catch (e) {
      Zotero.logError(e);
      resolve(null);
      return;
    }
    try {
      var fp = new FilePicker();
      fp.init(win, title, mode);
      if (mode === MB_PICK_OPEN) {
        fp.appendFilter("Markdown", "*.md");
      }
      var last = getPref("lastDir");
      if (last) {
        try {
          var d = Zotero.File.pathToFile(last);
          if (d.exists() && d.isDirectory()) {
            fp.displayDirectory = last;   // 新版接口要字符串路径
          }
        } catch (e) {
          Zotero.logError(e);
        }
      }
      fp.show().then(function (rv) {
        if (rv !== fp.returnOK) {
          resolve(null);
          return;
        }
        var p = fp.file;   // 已经是路径字符串
        try {
          var dir = (mode === MB_PICK_FOLDER)
            ? p
            : Zotero.File.pathToFile(p).parent.path;
          setPref("lastDir", dir);
        } catch (e) {
          Zotero.logError(e);
        }
        resolve(p || null);
      }, function (e) {
        Zotero.logError(e);
        resolve(null);
      });
    } catch (e) {
      Zotero.logError(e);
      alertWin(win, "双语阅读快照", "文件选择器打开失败：\n"
        + String(e && e.message ? e.message : e)
        + "\n\n请改用下一步的粘贴路径。");
      resolve(null);
    }
  });
}

// 系统 python 优先；WorkBuddy 自带 python 只作为最后兜底，避免其升级后路径失效
function resolvePython() {
  var candidates = [
    getPref("python"),
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3"
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var f = Zotero.File.pathToFile(candidates[i]);
      if (f.exists() && f.isFile()) {
        return candidates[i];
      }
    } catch (e) {
      Zotero.logError(e);
    }
  }
  return null;
}

async function runPython(mdPath, outDir, name) {
  // 文件名通过 UTF-8 文件传递，避免 nsIProcess 参数把非 ASCII 字符（如全角冒号）损坏
  var nameFile = outDir + "/_mktero_name.txt";
  try {
    await IOUtils.writeUTF8(nameFile, name);
  } catch (e) {
    Zotero.logError(e);
    try {
      await Zotero.File.putContentsAsync(nameFile, name);
    } catch (e2) {
      Zotero.logError(e2);
    }
  }
  var py = resolvePython();
  if (!py) throw new Error("找不到 python3，请在设置「高级」里指定可执行文件路径");
  var converterDir = await requireConverterDir();
  var scriptPath = converterDir ? converterDir + "/bilingual_to_zotero.py" : "";
  if (!scriptPath || !Zotero.File.pathToFile(scriptPath).exists()) {
    throw new Error(converterMissingError(converterDir));
  }
  var res = await runProcess(py, [
    scriptPath, "--md", mdPath, "--out", outDir,
    "--name-file", nameFile, "--no-pdf"
  ]);
  if (res.code !== 0) {
    var tail = tailText(res.stderr || res.stdout, 400);
    throw new Error("转换器退出码 " + res.code + (tail ? "：\n" + tail : ""));
  }
}

// 取日志末尾若干字符，报错时给用户看最关键的那几行
function tailText(s, n) {
  var t = String(s || "").trim();
  if (!t) return "";
  return t.length > n ? "…" + t.slice(t.length - n) : t;
}

// 通用：异步跑一个外部脚本，args[0] 是可执行文件（通常是 python3），其余是参数
async function runScript(args) {
  var py = String(args[0] || "").trim() || resolvePython();
  if (!py) throw new Error("找不到 python3，请在设置「高级」里指定可执行文件路径");
  var res = await runProcess(py, args.slice(1));
  if (res.code !== 0) {
    var tail = tailText(res.stderr || res.stdout, 600);
    throw new Error("脚本执行失败（退出码 " + res.code + "）" + (tail ? "：\n" + tail : ""));
  }
  return res;
}

// 从 Zotero 条目的 URL / Extra / DOI 里提取 arXiv ID
function extractArxivId(item) {
  // 只在明确写了 arXiv 的地方认新式 ID。旧版还有一条「裸 4 位.4~5 位」的兜底正则，
  // 它会从 IEEE 的 DOI（如 10.1016/j.patcog.2019.1070）里抓出 2019.1070 这种假 ID，
  // 所以现在只在 extra / archiveID 这类「本来就在讲 arXiv」的字段里才允许裸 ID。
  var strong = "";
  var weak = "";
  try {
    ["url", "DOI", "repository"].forEach(function (f) {
      try { strong += " " + (item.getField(f) || ""); } catch (e) {}
    });
    ["extra", "archiveID", "callNumber"].forEach(function (f) {
      try { weak += " " + (item.getField(f) || ""); } catch (e) {}
    });
  } catch (e) {}
  var pats = [
    /arxiv\.org\/(?:abs|pdf|e-print)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i,
    /arxiv:\s*([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i,
    /10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})/i
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = strong.match(pats[i]) || weak.match(pats[i]);
    if (m) return m[1];
  }
  // arXiv 支持旧式 ID（如 cs/0112017），只在字段里明确带 arXiv 时才认
  var old = (strong + " " + weak).match(/arxiv[:\s/]*([a-z\-]+(?:\.[A-Z]{2})?\/[0-9]{7})/i);
  if (old) return old[1];
  // 最后才用裸 ID，且仅限 extra / archiveID
  var bare = weak.match(/\b([0-9]{4}\.[0-9]{4,5})\b/);
  if (bare) return bare[1];
  return "";
}

// ---- 自动找 arXiv 预印本 ----
// 论文常常来自 IEEE / ACM / Springer，这些条目里没有 arXiv ID，但很多都有预印本。
// 顺序：条目字段里能看出 ID 就不搜 → arXiv Atom API 按标题检索 → 打分排序 →
// 分数不够高或有并列时，交给配置好的大模型复核（它同时看标题、作者、摘要摘要）。
// 命中的话仍然弹一次确认框：下载 + 翻译要好几分钟，不能让机器自作主张。

// 标题归一化：去 LaTeX 命令、标点、大小写差异
function normTitle(s) {
  return String(s || "")
    .replace(/\\[a-zA-Z]+\s*/g, " ")          // \emph \mathrm 之类
    .replace(/[{}$^_~]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 词集合 Jaccard，再乘长度比惩罚：防止「Attention Is All You Need」命中
// 一堆标题里都含 attention 的文章
function titleScore(a, b) {
  var A = normTitle(a).split(" ").filter(Boolean);
  var B = normTitle(b).split(" ").filter(Boolean);
  if (!A.length || !B.length) return 0;
  var setA = {}, setB = {};
  A.forEach(function (w) { setA[w] = 1; });
  B.forEach(function (w) { setB[w] = 1; });
  var inter = 0;
  Object.keys(setA).forEach(function (w) { if (setB[w]) inter++; });
  if (!inter) return 0;
  var uni = Object.keys(setA).length + Object.keys(setB).length - inter;
  var jac = inter / uni;
  var lenRatio = Math.min(A.length, B.length) / Math.max(A.length, B.length);
  return jac * (0.55 + 0.45 * lenRatio);
}

// Atom 里有的字段带命名空间前缀（<arxiv:comment>），直接按标签名查会漏。
// 统一取全部后代再比 localName（真实 DOM 上 tagName 是 "arxiv:comment"，
// localName 才是 "comment"）。
function atomText(el, name) {
  if (!el) return "";
  var all = [];
  try { all = el.getElementsByTagName("*") || []; } catch (e) { return ""; }
  for (var i = 0; i < all.length; i++) {
    var n = all[i];
    var t = String(n.localName || n.tagName || "").toLowerCase();
    if (t === name) return String(n.textContent || "").trim();
  }
  return "";
}

// 解析 arXiv API 的 Atom 响应
function parseArxivAtom(xml) {
  var out = [];
  var doc = null;
  try {
    doc = new DOMParser().parseFromString(String(xml || ""), "application/xml");
  } catch (e) {
    return out;
  }
  if (!doc) return out;
  var entries = doc.getElementsByTagName("entry");
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var idText = atomText(e, "id");                       // http://arxiv.org/abs/2201.12345v1
    var m = idText.match(/abs\/([^v\s]+?)(?:v\d+)?$/i) || idText.match(/([0-9]{4}\.[0-9]{4,5})/);
    if (!m) continue;
    var authors = [];
    var names = e.getElementsByTagName("name");
    for (var j = 0; j < names.length; j++) {
      authors.push(String(names[j].textContent || "").trim());
    }
    out.push({
      id: m[1],
      title: atomText(e, "title").replace(/\s+/g, " "),
      summary: atomText(e, "summary").replace(/\s+/g, " "),
      published: atomText(e, "published"),
      updated: atomText(e, "updated"),
      comment: atomText(e, "comment"),
      authors: authors
    });
  }
  return out;
}

function httpText(method, url, timeoutMs) {
  return Zotero.HTTP.request(method, url, {
    responseType: "text",
    timeout: timeoutMs || 20000,
    successCodes: false
  }).then(function (xhr) {
    var text = "";
    try { text = String(xhr.responseText || ""); } catch (e) {}
    return { status: xhr.status, text: text };
  });
}

// arXiv 检索。先用标题精确检索，落空就放宽到全文；https 不通再退回 http
// （国内网络环境下 export.arxiv.org 的 https 偶尔连不上）
function arxivQueries(title) {
  // 括号、冒号、引号会破坏 arXiv 的查询语法，先清掉
  var clean = String(title || "")
    .replace(/["\\(){}[\]:'?;,!]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  if (!clean) return [];
  return ['ti:"' + clean + '"', 'all:"' + clean + '"'];
}

async function searchArxivByTitle(title, maxResults) {
  var queries = arxivQueries(title);
  if (!queries.length) return { ok: true, candidates: [], endpoint: "" };
  var hosts = ["https://export.arxiv.org", "http://export.arxiv.org"];
  var lastErr = null;
  var gotAny = false;
  for (var qi = 0; qi < queries.length; qi++) {
    for (var hi = 0; hi < hosts.length; hi++) {
      var url = hosts[hi] + "/api/query?search_query=" + encodeURIComponent(queries[qi])
        + "&start=0&max_results=" + (maxResults || 8);
      try {
        var r = await httpText("GET", url, 25000);
        if (r.status >= 200 && r.status < 300) {
          var cands = parseArxivAtom(r.text);
          if (cands.length) return { ok: true, candidates: cands, endpoint: url };
          gotAny = true;              // 通了，只是这条查询没结果
          break;                      // 同一查询不必再试 http
        }
        lastErr = "HTTP " + r.status;
      } catch (e) {
        lastErr = String(e && e.message ? e.message : e);
      }
    }
    if (gotAny && qi === 0) {
      // 标题检索没命中，给它一点间隔再试全文检索（arXiv 要求别连打）
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
  }
  if (gotAny) return { ok: true, candidates: [], endpoint: "" };
  return { ok: false, error: lastErr || "未知错误" };
}

// 候选打分：标题为主，作者姓氏、年份辅助
function scoreCandidate(item, c) {
  var tScore = titleScore(item.getField("title"), c.title);
  var surnames = [];
  try {
    (item.getCreators() || []).forEach(function (cr) {
      var s = String(cr.lastName || "").toLowerCase().trim();
      if (s) surnames.push(s);
    });
  } catch (e) {}
  var authorText = (c.authors || []).join(" ").toLowerCase();
  var hit = 0;
  surnames.forEach(function (s) { if (authorText.indexOf(s) >= 0) hit++; });
  var aScore = surnames.length ? hit / surnames.length : 0;

  var yItem = String(item.getField("date") || "").match(/\d{4}/);
  var yCand = String(c.published || "").match(/\d{4}/);
  var yScore = 0.5;
  if (yItem && yCand) {
    var d = Math.abs(parseInt(yItem[0], 10) - parseInt(yCand[0], 10));
    yScore = d === 0 ? 1 : d === 1 ? 0.7 : d === 2 ? 0.4 : 0.1;
  }
  return 0.72 * tScore + 0.2 * aScore + 0.08 * yScore;
}

// 通用 LLM 调用（非 UI），返回纯文本
async function callChat(settings, messages, maxTokens) {
  var base = String(settings.api.base_url || "").trim();
  var model = String(settings.api.model || "").trim();
  var key = String(settings.api.api_key || "").trim();
  var v = validateApiBase(base);
  if (!v.ok) throw new Error(v.error);
  if (!model) throw new Error("还没配置模型名");
  var headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  var timeout = Math.round(Number(settings.api.timeout) || 120);
  if (!(timeout >= 10)) timeout = 10;
  var r = await Zotero.HTTP.request("POST", chatCompletionsUrl(base), {
    headers: headers,
    body: JSON.stringify({
      model: model, messages: messages,
      max_tokens: maxTokens || 16, temperature: 0
    }),
    responseType: "text",
    timeout: timeout * 1000,
    successCodes: false
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error("HTTP " + r.status + "：" +
      String(r.responseText || "").replace(/\s+/g, " ").slice(0, 200));
  }
  var parsed = JSON.parse(String(r.responseText || "{}"));
  return String((parsed.choices && parsed.choices[0] && parsed.choices[0].message
    && parsed.choices[0].message.content) || "").trim();
}

// 让大模型在候选里挑一个。只让它输出序号，解析失败就当作「没把握」
async function llmPickArxiv(settings, item, cands) {
  var lines = [];
  lines.push("我在为一篇文献匹配它的 arXiv 预印本。请判断下面哪个候选是同一篇论文（同一工作的预印本也算），只输出一个序号数字，不要解释。");
  lines.push("");
  lines.push("【待匹配文献】");
  lines.push("标题：" + (item.getField("title") || ""));
  try {
    var people = (item.getCreators() || []).map(function (c) {
      return [c.firstName, c.lastName].filter(Boolean).join(" ");
    }).slice(0, 6);
    if (people.length) lines.push("作者：" + people.join(", "));
  } catch (e) {}
  var date = "";
  try { date = item.getField("date") || ""; } catch (e) {}
  if (date) lines.push("年份：" + date);
  var abs = "";
  try { abs = String(item.getField("abstractNote") || "").slice(0, 600); } catch (e) {}
  if (abs) lines.push("摘要：" + abs);
  lines.push("");
  lines.push("【候选】");
  cands.forEach(function (c, i) {
    lines.push((i + 1) + ". 标题：" + c.title);
    lines.push("   作者：" + (c.authors || []).slice(0, 6).join(", "));
    lines.push("   发布：" + (c.published || "").slice(0, 10)
      + (c.comment ? "　备注：" + c.comment.slice(0, 120) : ""));
    lines.push("   摘要：" + (c.summary || "").slice(0, 400));
  });
  lines.push("");
  lines.push("如果都不是同一篇，输出 0。只输出数字。");

  var reply = await callChat(settings, [
    { role: "system", content: "你是文献匹配助手，只输出数字。" },
    { role: "user", content: lines.join("\n") }
  ], 8);
  var m = String(reply).match(/\b(\d{1,2})\b/);
  if (!m) return 0;
  var n = parseInt(m[1], 10);
  return n >= 1 && n <= cands.length ? n : 0;
}

// 选出最可能的 arXiv 版本，返回 {id, cand, how, score} 或 null
async function resolveArxivVersion(win, item, settings) {
  var direct = extractArxivId(item);
  if (direct) return { id: direct, cand: null, how: "条目字段里已有 arXiv ID" };

  var title = "";
  try { title = item.getField("title") || ""; } catch (e) {}
  if (!title) return null;

  var res = await searchArxivByTitle(title, 8);
  if (!res.ok) {
    throw new Error("检索 arXiv 失败（" + res.error + "）。\n"
      + "如果是网络原因，可以先在「设置 → 高级」里配好能访问 arXiv 的网络，"
      + "或者手动把 ID 写进条目的 Extra 字段，例如：arXiv: 2201.12345");
  }
  if (!res.candidates.length) return null;

  var scored = res.candidates.map(function (c) {
    return { cand: c, score: scoreCandidate(item, c) };
  }).sort(function (x, y) { return y.score - x.score; });

  var best = scored[0];
  var second = scored[1];
  // 分数足够高、且与第二名拉开距离，就不用麻烦模型了
  var confident = best.score >= 0.86 && (!second || best.score - second.score >= 0.06);

  if (!confident) {
    // 交给大模型复核（用户配了 API 才有意义；没配就退回纯算法结果）
    var canLLM = false;
    try { canLLM = !!(settings.api.base_url && settings.api.model); } catch (e) {}
    if (canLLM) {
      var top = scored.slice(0, Math.min(5, scored.length));
      var pick = 0;
      try {
        pick = await llmPickArxiv(settings, item,
          top.map(function (s) { return s.cand; }));
      } catch (e) {
        Zotero.logError(e);
        pick = 0;
      }
      if (pick === 0) return null;          // 模型明确说都不是
      if (pick > 0) {
        return {
          id: top[pick - 1].cand.id,
          cand: top[pick - 1].cand,
          score: top[pick - 1].score,
          how: "大模型复核后认定"
        };
      }
    }
  }
  return { id: best.cand.id, cand: best.cand, score: best.score, how: "标题/作者自动匹配" };
}

function confirmMatch(win, item, hit) {
  var title = "";
  try { title = item.getField("title") || ""; } catch (e) {}
  var lines = [];
  lines.push("条目：" + title);
  lines.push("");
  if (hit.cand) {
    lines.push("找到 arXiv 预印本：" + hit.id + "（" + hit.how + "）");
    lines.push("标题：" + hit.cand.title);
    lines.push("作者：" + (hit.cand.authors || []).slice(0, 4).join(", "));
    lines.push("发布：" + String(hit.cand.published || "").slice(0, 10));
    lines.push("匹配度：" + Math.round((hit.score || 0) * 100) + "%");
  } else {
    lines.push("条目字段里的 arXiv ID：" + hit.id);
  }
  lines.push("");
  lines.push("用它下载 LaTeX 源码并生成双语快照吗？");
  return Services.prompt.confirm(win, "找到 arXiv 版本", lines.join("\n"));
}

function selectedRegularItem(win, titleForMsg) {
  var items = [];
  try {
    items = Zotero.getActiveZoteroPane().getSelectedItems() || [];
  } catch (e) { Zotero.logError(e); }
  var item = items.filter(function (i) { return i.isRegularItem(); })[0];
  if (!item) {
    alertWin(win, titleForMsg || "arXiv 双语快照",
      "请先在文献列表中选中一个文献条目（不是附件或笔记）。");
    return null;
  }
  return item;
}

// 入口一：手动 —— 用条目里的 arXiv ID，没有就让人输
async function runArxiv(win) {
  var item = selectedRegularItem(win);
  if (!item) return;

  var arxivId = extractArxivId(item);
  if (!arxivId) {
    var obj = { value: "" };
    var ok = Services.prompt.prompt(
      win, "arXiv 双语快照",
      "没能从条目字段里找到 arXiv ID。\n请输入 arXiv ID（如 1706.03762）或 abs 链接：",
      obj, null, { value: false }
    );
    if (!ok || !obj.value) return;
    var m = String(obj.value).match(/([0-9]{4}\.[0-9]{4,5})/);
    if (!m) {
      alertWin(win, "arXiv 双语快照", "没识别出 arXiv ID，请检查输入。");
      return;
    }
    arxivId = m[1];
  }
  await generateFromArxiv(win, item, arxivId);
}

// 入口二：自动 —— 论文来自 IEEE/Science 等，先去找它的 arXiv 预印本
async function runArxivAuto(win) {
  var item = selectedRegularItem(win, "自动检索 arXiv");
  if (!item) return;

  var settings;
  try { settings = MkteroConfig.read(); }
  catch (e) { settings = MkteroConfig.DEFAULT; }

  var id = "";
  try {
    var finish = progress("正在检索 arXiv 预印本…");
    var hit = await resolveArxivVersion(win, item, settings);
    finish(!!hit);
    if (!hit) {
      alertWin(win, "没找到 arXiv 版本",
        "按标题没有检索到对应的 arXiv 预印本（也有可能这篇确实没挂在 arXiv 上）。\n\n"
        + "你可以：\n"
        + "· 自己搜到后把「arXiv: 编号」写进条目的 Extra 字段，再点「从 arXiv 生成」\n"
        + "· 或在 Google Scholar 里点 All versions，看有没有 arXiv 版");
      return;
    }
    if (!confirmMatch(win, item, hit)) return;
    id = hit.id;
  } catch (e) {
    Zotero.logError(e);
    alertWin(win, "自动检索 arXiv", String(e && e.message ? e.message : e));
    return;
  }
  await generateFromArxiv(win, item, id);
}

// 从 arXiv LaTeX 源码生成双语快照：下载→解析→翻译→排版→挂回 Zotero
async function generateFromArxiv(win, item, arxivId) {
  // 输出目录：设置里配了默认目录就直接用，否则每次询问
  var settings;
  try { settings = MkteroConfig.read(); }
  catch (e) { settings = MkteroConfig.DEFAULT; }
  var fileCfg = settings.files || MkteroConfig.DEFAULT.files;
  var advCfg = settings.advanced || MkteroConfig.DEFAULT.advanced;
  var outDir = "";
  if (fileCfg.output_dir && Zotero.File.pathToFile(fileCfg.output_dir).exists()) {
    outDir = fileCfg.output_dir;
  } else {
    outDir = await pickPath(
      win, "选择 arXiv 双语快照的输出目录（源码/译文/HTML 存这里）",
      MB_PICK_FOLDER
    );
    if (!outDir) {
      outDir = promptPath(win, "arXiv 输出目录", MB_PICK_FOLDER);
    }
  }
  if (!outDir) return;
  // 转换器与 python：设置优先，否则自动检测
  if (advCfg.converter_dir) setPref("converterDir", advCfg.converter_dir);
  if (advCfg.python) setPref("python", advCfg.python);

  var name = paperName(item.getField("title"));
  var nameFile = outDir + "/_mktero_name.txt";
  try {
    await IOUtils.writeUTF8(nameFile, name);
  } catch (e) {
    try { await Zotero.File.putContentsAsync(nameFile, name); } catch (e2) {}
  }
  var converter = await requireConverterDir();
  var py = resolvePython();
  if (!py) {
    alertWin(win, "arXiv 双语快照", "找不到 python3，请在设置里指定。");
    return;
  }
  var parseScript = converter + "/arxiv_to_zotero.py";
  var transScript = converter + "/arxiv_translate.py";
  if (!converter
      || !Zotero.File.pathToFile(parseScript).exists()
      || !Zotero.File.pathToFile(transScript).exists()) {
    alertWin(win, "arXiv 双语快照", converterMissingError(converter));
    return;
  }

  var proxy = proxyUrl();
  var finish = progress("正在从 arXiv「" + arxivId + "」下载并解析 LaTeX…");
  try {
    // 第一步：下载 + 解析（产出 arxiv_blocks.json 与单语预览）
    var parseArgs = [py, parseScript, "--id", arxivId, "--out", outDir,
                     "--name-file", nameFile];
    if (proxy) parseArgs.push("--proxy", proxy);
    await runScript(parseArgs);
    finish(true);

    // 第二步：翻译（调用本机私有 API 配置，约 3-5 分钟）
    var finish2 = progress("正在翻译全文（约 3-5 分钟，请勿关闭 Zotero）…");
    var blocksPath = outDir + "/arxiv_blocks.json";
    var zhPath = outDir + "/_arxiv_zh.json";
    // 显式传 LLM 配置路径，避免插件进程 HOME 不同导致读不到密钥
    var llmCfg = "";
    try {
      llmCfg = MkteroConfig.path();
    } catch (e) {}
    var transArgs = [py, transScript, "--blocks", blocksPath,
                     "--out", zhPath, "--title", item.getField("title") || ""];
    if (llmCfg && Zotero.File.pathToFile(llmCfg).exists()) {
      transArgs.push("--config", llmCfg);
    }
    if (proxy) transArgs.push("--proxy", proxy);
    try {
      await runScript(transArgs);
      finish2(true);
    } catch (e) {
      finish2(false);
      throw e;
    }

    // 第三步：合成 Mktero 格式双语 HTML
    var finish3 = progress("正在生成双语快照（公式渲染约需 2-3 分钟）…");
    await runScript([py, parseScript, "--src", outDir + "/_arxiv_src",
                     "--out", outDir, "--name-file", nameFile,
                     "--translation", zhPath]);
    finish3(true);

    // 读结果清单拿实际 HTML 路径
    var html = "";
    try {
      html = String(await IOUtils.readUTF8(outDir + "/_arxiv_result.txt")).trim();
    } catch (e) {
      html = "";
    }
    if (!html || !Zotero.File.pathToFile(html).exists()) {
      html = await findHtml(outDir);
    }
    if (!html) {
      throw new Error("未找到生成的 HTML，输出目录：" + outDir);
    }

    var attId = await safeAttach(win, item, html, name, ["arXiv"], fileCfg);

    // 按文件设置清理中间产物
    try {
      var cleanup = [];
      if (!fileCfg.keep_blocks) {
        cleanup.push(outDir + "/arxiv_blocks.json", outDir + "/_arxiv_zh.json",
                    outDir + "/_mktero_name.txt", outDir + "/_arxiv_result.txt");
      }
      if (!fileCfg.keep_source) cleanup.push(outDir + "/_arxiv_src");
      if (!fileCfg.keep_cache) cleanup.push(outDir + "/_arxiv_cache");
      cleanup.forEach(function (p) {
        try {
          var f = Zotero.File.pathToFile(p);
          if (f.exists()) {
            if (f.isDirectory()) f.remove(true);
            else f.remove(false);
          }
        } catch (e) {}
      });
    } catch (e) { Zotero.logError(e); }

    alertWin(win, "arXiv 双语快照",
      "已完成：\n\n" + html +
      (attId ? "\n\n已挂到条目「" + item.getField("title") + "」下，双击即可阅读、高亮、做笔记。"
             : "\n\n（按设置未自动挂到 Zotero，文件已保存在输出目录。）"));
  } catch (e) {
    Zotero.logError(e);
    finish(false);
    alertWin(win, "arXiv 双语快照 — 失败", String(e && e.message ? e.message : e));
  }
}

// 兜底：结果清单读不到时，扫描输出目录里最新的 HTML（IOUtils，无需 Ci）
async function findHtml(outDir) {
  try {
    var kids = await IOUtils.getChildren(outDir);
  } catch (e) {
    Zotero.logError(e);
    return null;
  }
  var best = null;
  var bestTime = -1;
  for (var i = 0; i < kids.length; i++) {
    var full = kids[i];
    var leaf = full.replace(/^.*[\\/]/, "");
    if (!/\.html$/i.test(leaf)) continue;
    if (/\.stage\.html$/i.test(leaf) || leaf.indexOf("_formula_") === 0) continue;
    try {
      var st = await IOUtils.stat(full);
      if (st.type !== "regular") continue;
      if (st.lastModified > bestTime) {
        bestTime = st.lastModified;
        best = full;
      }
    } catch (e) {
      Zotero.logError(e);
    }
  }
  return best;
}

function progress(text) {
  try {
    var pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("Mktero 双语阅读快照");
    // ItemProgress(itemType, text)：第一个参数是图标键，不是文本
    var item = new pw.ItemProgress("document", text);
    pw.show();
    return function (done) {
      try {
        item.setProgress(100);
        item.setText(done ? "完成" : "失败");
        pw.startCloseTimer(4000);
      } catch (e) {
        Zotero.logError(e);
      }
    };
  } catch (e) {
    Zotero.logError(e);
    return function () {};
  }
}

// 挂附件 + 打开：md / 文件夹 / arXiv 三个入口共用，设置里的开关对所有入口一致生效
async function attachSnapshot(item, html, name, extraTags) {
  var att = await Zotero.Attachments.importFromFile({
    file: html,
    parentItemID: item.id,
    title: name,
    contentType: "text/html",
    charset: "utf-8",
    fileBaseName: name
  });
  att.addTag("双语");
  (extraTags || []).forEach(function (t) { try { att.addTag(t); } catch (e) {} });
  await att.saveTx();
  return att.id;
}

// 挂附件失败不能连累已经生成好的 HTML：把原因说清楚，文件照样留给用户
async function safeAttach(win, item, html, name, extraTags, fileCfg) {
  if (!fileCfg || fileCfg.attach === false) return null;
  try {
    var attId = await attachSnapshot(item, html, name, extraTags);
    if (attId && fileCfg.open_after !== false) openAttachment(attId);
    return attId;
  } catch (e) {
    Zotero.logError(e);
    alertWin(win, "快照已生成，但没能挂到条目上",
      "HTML 已生成：\n" + html + "\n\n"
      + "挂载失败原因：\n" + String(e && e.message ? e.message : e) + "\n\n"
      + "可以直接双击上面的文件阅读；也可以手动拖进 Zotero 条目当附件。");
    return null;
  }
}

function openAttachment(attId) {
  try {
    var zp = Zotero.getActiveZoteroPane();
    if (typeof zp.viewAttachment === "function") zp.viewAttachment(attId);
  } catch (e) {
    Zotero.logError(e);
  }
}

// 「保留中间产物」关闭时清掉临时清单文件（keep_blocks 打开则全部保留）
async function cleanupTempFiles(outDir, fileCfg, names) {
  if (!fileCfg || fileCfg.keep_blocks) return;
  for (var i = 0; i < names.length; i++) {
    try {
      await IOUtils.remove(PathUtils.join(outDir, names[i]), { ignoreAbsent: true });
    } catch (e) {}
  }
}

async function run(win, mode) {
  var items = [];
  try {
    items = Zotero.getActiveZoteroPane().getSelectedItems() || [];
  } catch (e) {
    Zotero.logError(e);
  }
  var item = items.filter(function (i) { return i.isRegularItem(); })[0];
  if (!item) {
    alertWin(win, "双语阅读快照", "请先在文献列表中选中一个文献条目（不是附件或笔记）。");
    return;
  }

  var mdPath = null;
  if (mode === "folder") {
    var dirPath = await pickPath(
      win,
      "选择 Mktero 导出的论文目录（含 md 与 assets）",
      MB_PICK_FOLDER
    );
    if (!dirPath) {
      dirPath = promptPath(win, "选择论文目录", MB_PICK_FOLDER);
    }
    if (!dirPath) {
      return;
    }
    mdPath = await firstMarkdown(dirPath);
    if (!mdPath) {
      alertWin(win, "双语阅读快照", "这个目录里没有找到 .md 文件，请重新选择。");
      return;
    }
  } else {
    mdPath = await pickPath(
      win,
      "选择 Mktero 导出的双语 Markdown（*.md）",
      MB_PICK_OPEN
    );
    if (!mdPath) {
      mdPath = promptPath(win, "选择双语 md", MB_PICK_OPEN);
    }
    if (!mdPath) {
      return;
    }
  }

  // 不覆盖已有快照：已有高亮留在旧附件上，新建会另起一个附件，先征求同意
  var existingHTML = [];
  try {
    var atts = Zotero.Items.get(item.getAttachments()) || [];
    existingHTML = atts.filter(function (a) {
      return a && a.attachmentContentType === "text/html"
        && a.attachmentLinkMode === Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
    });
  } catch (e) {
    Zotero.logError(e);
  }
  if (existingHTML.length) {
    var proceed = Services.prompt.confirm(
      win,
      "双语阅读快照",
      "该条目下已有 " + existingHTML.length + " 个 HTML 快照附件。\n\n"
      + "继续会再新建一个附件，旧附件和它上面的标注都会保留。继续吗？"
    );
    if (!proceed) {
      return;
    }
  }

  var name = paperName(item.getField("title"));
  var outDir = Zotero.File.pathToFile(mdPath).parent.path;
  var settings;
  try { settings = MkteroConfig.read(); }
  catch (e) { settings = MkteroConfig.DEFAULT; }
  var fileCfg = settings.files || MkteroConfig.DEFAULT.files;
  setPref("lastDir", outDir);
  var finish = progress("正在生成双语网页快照（公式渲染约需 2-3 分钟）…");

  try {
    await runPython(mdPath, outDir, name);

    // 优先读转换器回写的实际路径，再退化为扫描目录，绝不靠猜文件名
    var html = null;
    try {
      html = String(await IOUtils.readUTF8(outDir + "/_mktero_result.txt")).trim();
    } catch (e) {
      Zotero.logError(e);
      try {
        html = String(await Zotero.File.getContentsAsync(outDir + "/_mktero_result.txt")).trim();
      } catch (e2) {
        Zotero.logError(e2);
      }
    }
    if (!html || !Zotero.File.pathToFile(html).exists()) {
      html = await findHtml(outDir);
    }
    if (!html) {
      throw new Error("转换完成但没找到 HTML。输出目录：" + outDir
        + "\n请查看 Zotero 错误控制台。");
    }

    var attId = await safeAttach(win, item, html, name, [], fileCfg);
    await cleanupTempFiles(outDir, fileCfg, ["_mktero_result.txt", "_mktero_name.txt"]);

    finish(true);
    alertWin(
      win,
      "双语阅读快照",
      "已完成：\n\n" + html + "\n\n"
      + (attId
         ? "同名附件已挂到条目「" + item.getField("title") + "」下，双击即可阅读、高亮、做笔记。"
         : "（按设置未自动挂到 Zotero，文件已保存在输出目录。）")
    );
  } catch (e) {
    Zotero.logError(e);
    finish(false);
    alertWin(win, "双语阅读快照 — 失败", String(e && e.message ? e.message : e));
  }
}

async function selfCheck(win) {
  var lines = [];
  function probe(label, fn) {
    try {
      lines.push(label + ": " + fn());
    } catch (e) {
      lines.push(label + ": ERR " + String(e && e.message ? e.message : e));
    }
  }
  probe("Zotero", function () { return Zotero.version; });
  probe("插件版本", function () { return MkteroBilingual.version; });
  probe("用户主目录", function () { return resolveHomeDir() || "未解析（配置无法保存）"; });
  probe("配置文件", function () { return MkteroConfig.path() || "未解析"; });
  probe("右键菜单容器", function () { return !!win.document.getElementById("zotero-itemmenu"); });
  probe("Tools 菜单容器", function () { return !!win.document.getElementById("menu_ToolsPopup"); });
  probe("本插件菜单项数", function () {
    return win.document.querySelectorAll('[data-mktero-bilingual="1"]').length;
  });
  probe("选中条目", function () {
    var items = Zotero.getActiveZoteroPane().getSelectedItems() || [];
    return items.length + (items.length ? " / " + (items[0].isRegularItem() ? "常规" : "非常规") : "");
  });
  probe("python", function () { return resolvePython() || "未找到"; });
  probe("rootURI", function () { return MkteroBilingual.rootURI; });
  probe("转换器目录", function () { return getPref("converterDir") || "未解析（见下方各项）"; });
  probe("主脚本存在", function () {
    return Zotero.File.pathToFile(getPref("converterDir") + "/bilingual_to_zotero.py").exists();
  });
  probe("公式脚本存在", function () {
    return Zotero.File.pathToFile(getPref("converterDir") + "/formula_svg.py").exists();
  });
  probe("MathJax 存在", function () {
    return Zotero.File.pathToFile(getPref("converterDir") + "/vendor/tex-svg.js").exists();
  });
  probe("arXiv 解析脚本", function () {
    return Zotero.File.pathToFile(getPref("converterDir") + "/arxiv_to_zotero.py").exists();
  });
  probe("arXiv 翻译脚本", function () {
    return Zotero.File.pathToFile(getPref("converterDir") + "/arxiv_translate.py").exists();
  });
  probe("filePicker.modeGetFolder", function () { return MB_PICK_FOLDER; });
  alertWin(win, "双语快照自检", lines.join("\n"));
  return lines.join("\n");
}

// 设置入口：优先打开独立 XUL 对话框（可视化、API 可替换）；
// 窗口机制万一不可用，自动退回已验证可靠的 Services.prompt 逐项输入，
// 保证任何环境下设置都能改，绝不会出现「点击没反应」。
function promptFallbackSettings(win) {
  var fields = [
    ["llmBase", "LLM Base URL（OpenAI 兼容）："],
    ["llmModel", "LLM 模型名："],
    ["llmKey", "API Key（留空表示不修改）："],
    ["converterDir", "转换器目录（含 arxiv_to_zotero.py）："],
    ["python", "python3 可执行文件绝对路径："]
  ];
  var cur = MkteroConfig.read();
  var vals = {};
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i][0];
    var init = (key === "llmBase" ? cur.api.base_url
      : key === "llmModel" ? cur.api.model
      : key === "llmKey" ? "" : getPref(key));
    var obj = { value: init || "" };
    var ok = Services.prompt.prompt(win, "双语快照设置 (" + (i + 1) + "/" + fields.length + ")",
      fields[i][1], obj, null, { value: false });
    if (!ok) return;
    vals[key] = obj.value;
  }
  try {
    if (vals.llmBase) cur.api.base_url = vals.llmBase.trim();
    if (vals.llmModel) cur.api.model = vals.llmModel.trim();
    if (vals.llmKey) cur.api.api_key = vals.llmKey.trim();
    if (vals.converterDir) cur.advanced.converter_dir = vals.converterDir.trim();
    if (vals.python) cur.advanced.python = vals.python.trim();
    MkteroConfig.write(cur);
  } catch (e) { Zotero.logError(e); }
  if (vals.converterDir) setPref("converterDir", vals.converterDir.trim());
  if (vals.python) setPref("python", vals.python.trim());
  alertWin(win, "双语快照设置", "已保存。");
}

function openSettings(win) {
  // 直接打开 Zotero 设置窗口并定位到本插件的 pane。
  // 与设置侧栏是同一个界面，不再另开独立窗口，避免出现两个不一致的设置界面。
  try {
    var paneId = MkteroBilingual.prefPaneId;
    if (paneId && Zotero.Utilities && Zotero.Utilities.Internal
        && typeof Zotero.Utilities.Internal.openPreferences === "function") {
      var prefWin = Zotero.Utilities.Internal.openPreferences(paneId);
      // 片段的 onload 不一定触发，主动补一次填表（DOM 就绪后延迟执行）
      var self = Zotero.MkteroBilingual;
      var tries = 0;
      var fill = function () {
        try {
          var doc = prefWin && prefWin.document;
          if (doc && doc.getElementById("bs-prefpane")) {
            self.attachDoc(doc);
            return;
          }
        } catch (e) {}
        if (tries++ < 12) win.setTimeout(fill, 250);
      };
      win.setTimeout(fill, 200);
      return;
    }
  } catch (e) {
    Zotero.logError(e);
  }
  // pane 未注册成功时退回逐项输入，保证设置仍可修改
  promptFallbackSettings(win);
}
