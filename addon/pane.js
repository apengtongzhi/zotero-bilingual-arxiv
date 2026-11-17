/* global Zotero */

// Mktero 双语快照 — 偏好设置面板脚本
//
// 重要：本脚本在 Zotero 的 Cu.Sandbox(window) 里执行，Cc / Ci / Services / IOUtils
// 这些 XPCOM 全局【不保证存在】。_loadPane 会先加载脚本再插入 XHTML，
// 如果脚本顶层抛错，整个面板就加载失败（右侧空白）。
// 因此：
//   1. 顶层只做事件绑定，绝不触碰 XPCOM；
//   2. 所有 XPCOM 调用延迟到按钮点击时，用 Components.classes / Cu.import 动态获取；
//   3. 所有回调都用 try/catch 包住，异常只记日志，不向外抛。

var MkteroPrefs = { configPath: null, initialized: false };

function mkSafeError(label, e) {
  try { Zotero.logError(new Error("Mktero prefs " + label + ": " + (e && e.message ? e.message : e))); }
  catch (_) {}
}

function mkStatus(text, ok) {
  try {
    var el = document.getElementById("mktero-llm-status");
    if (!el) return;
    el.setAttribute("value", text);
    el.setAttribute("class", "mktero-status" +
      (ok === true ? " ok" : ok === false ? " err" : ""));
  } catch (e) { mkSafeError("status", e); }
}

function mkHome() {
  // 优先用标准目录服务；sandbox 里取不到时退回环境变量/常见路径
  try {
    var dirSvc = (typeof Components !== "undefined" && Components.classes)
      ? Components.classes["@mozilla.org/file/directory_service;1"]
          .getService(Components.interfaces.nsIProperties)
      : (typeof Services !== "undefined" ? Services.dirsvc : null);
    if (dirSvc) {
      var homeFile = dirSvc.get("Home", Components.interfaces.nsIFile);
      if (homeFile && homeFile.path) return homeFile.path;
    }
  } catch (e) { mkSafeError("home", e); }
  try { return Zotero.DataDirectory.dir + "/../../.."; } catch (e) {}
  return "";
}

function mkConfigPath() {
  if (MkteroPrefs.configPath) return MkteroPrefs.configPath;
  var home = mkHome();
  MkteroPrefs.configPath = (home ? home.replace(/\/$/, "") + "/" : "") + ".mktero_llm_config.json";
  return MkteroPrefs.configPath;
}

function mkReadFile(path) {
  try {
    if (typeof IOUtils !== "undefined" && IOUtils.readUTF8) return null; // async，走下面
    if (typeof Zotero !== "undefined" && Zotero.File && Zotero.File.getContentsAsync) return null;
    // 同步兜底：nsIFile + FileInputStream
    var Cc = Components.classes, Ci = Components.interfaces;
    var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    if (!f.exists()) return "";
    var stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    stream.init(f, 0x01, 0o444, 0);
    var cv = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
    cv.init(stream, "UTF-8", 4096, 0xFFFD);
    var out = {}, str = {};
    var parts = [];
    while (cv.readString(4096, out, str) && out.value > 0) parts.push(str.value);
    cv.close();
    return parts.join("");
  } catch (e) { mkSafeError("readFile", e); return ""; }
}

function mkWriteFile(path, text) {
  try {
    // 同步写，避免 sandbox 里 IOUtils Promise 的兼容问题
    var Cc = Components.classes, Ci = Components.interfaces;
    var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    var fo = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    fo.init(f, 0x02 | 0x08 | 0x20, 0o600, 0);  // WRONLY|CREATE|TRUNCATE, 权限 600
    var co = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
    co.init(fo, "UTF-8", 4096, 0);
    co.writeString(text);
    co.close();
    return true;
  } catch (e) { mkSafeError("writeFile", e); return false; }
}

function mkLoadConfig() {
  try {
    var path = mkConfigPath();
    var raw = mkReadFile(path);
    if (!raw) { mkStatus("尚未配置，请填写后保存"); return; }
    var cfg = JSON.parse(raw);
    var b = document.getElementById("mktero-base-url");
    var m = document.getElementById("mktero-model");
    var k = document.getElementById("mktero-api-key");
    if (b) b.value = cfg.base_url || "";
    if (m) m.value = cfg.model || "";
    if (k) k.value = "";   // 密钥不回显
    mkStatus("已读取本机配置（密钥未显示）", true);
  } catch (e) { mkStatus("读取配置失败", false); mkSafeError("loadConfig", e); }
}

function mkSaveConfig() {
  try {
    var path = mkConfigPath();
    var cfg = {};
    var raw = mkReadFile(path);
    if (raw) { try { cfg = JSON.parse(raw); } catch (e) { cfg = {}; } }
    var b = document.getElementById("mktero-base-url");
    var m = document.getElementById("mktero-model");
    var k = document.getElementById("mktero-api-key");
    cfg.base_url = (b && b.value || "").trim();
    cfg.model = (m && m.value || "").trim();
    var newKey = (k && k.value || "").trim();
    if (newKey) cfg.api_key = newKey;
    if (!cfg.base_url || !cfg.model) { mkStatus("Base URL 和模型不能为空", false); return; }
    if (!mkWriteFile(path, JSON.stringify(cfg, null, 2))) {
      mkStatus("保存失败，请检查目录权限", false); return;
    }
    if (k) k.value = "";
    mkStatus("已保存（密钥仅存本机）", true);
  } catch (e) { mkStatus("保存失败", false); mkSafeError("saveConfig", e); }
}

function mkTestLLM() {
  mkStatus("测试中…");
  mkSaveConfig();
  try {
    var st = document.getElementById("mktero-llm-status");
    if (st && (st.getAttribute("class") || "").indexOf("err") >= 0) return;
    var Cc = Components.classes, Ci = Components.interfaces;
    var py = "";
    var candidates = [
      (Zotero.Prefs ? Zotero.Prefs.get("extensions.mkterobilang.python", true) : ""),
      "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(candidates[i]);
      if (f.exists() && f.isFile()) { py = candidates[i]; break; }
    }
    if (!py) { mkStatus("找不到 python3", false); return; }
    var converter = Zotero.Prefs.get("extensions.mkterobilang.converterDir", true) || "";
    var script = converter + "/arxiv_translate.py";
    var sf = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    sf.initWithPath(script);
    if (!sf.exists()) { mkStatus("找不到 arxiv_translate.py，请检查转换器目录", false); return; }
    var exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    exe.initWithPath(py);
    var proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(exe);
    var args = [script, "--test-llm", "--config", mkConfigPath()];
    proc.runAsync(args, args.length, {
      observe: function (subject, topic, data) {
        try {
          if (topic === "process-finished") mkStatus("连接成功", true);
          else if (topic === "process-failed") mkStatus("连接失败，请检查 URL / 模型 / 密钥", false);
        } catch (e) { mkSafeError("testCallback", e); }
      }
    });
  } catch (e) { mkStatus("测试失败", false); mkSafeError("testLLM", e); }
}

function mkInit() {
  if (MkteroPrefs.initialized) return;
  try {
    var save = document.getElementById("mktero-save");
    var test = document.getElementById("mktero-test-llm");
    var toggle = document.getElementById("mktero-toggle-key");
    if (!save && !test && !toggle) return;   // 片段尚未插入，等待下次
    MkteroPrefs.initialized = true;
    if (save) save.addEventListener("command", function () { try { mkSaveConfig(); } catch (e) { mkSafeError("onSave", e); } });
    if (test) test.addEventListener("command", function () { try { mkTestLLM(); } catch (e) { mkSafeError("onTest", e); } });
    if (toggle) toggle.addEventListener("command", function () {
      try {
        var k = document.getElementById("mktero-api-key");
        if (!k) return;
        var show = k.getAttribute("type") === "password";
        k.setAttribute("type", show ? "text" : "password");
        toggle.setAttribute("label", show ? "隐藏" : "显示");
      } catch (e) { mkSafeError("onToggle", e); }
    });
    mkLoadConfig();
  } catch (e) { mkSafeError("init", e); }
}

// 顶层：只绑定，不触碰任何 XPCOM 全局
mkInit();
try {
  if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mkInit, { once: true });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("load", mkInit, { once: true });
  }
} catch (e) { mkSafeError("bind", e); }
