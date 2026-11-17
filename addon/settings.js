/* global Zotero, Services, Components */

// 独立设置窗口脚本。运行在普通 window 作用域（不是 preference pane 的 Cu.Sandbox），
// XPCOM 全局直接可用；全部同步实现，避免 jar: 路径下 Promise/IOUtils 的兼容问题。

var MkteroSettings = {
  configPath: null
};

MkteroSettings.path = function () {
  if (this.configPath) return this.configPath;
  var home = "";
  try {
    home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  } catch (e) {}
  this.configPath = (home ? home.replace(/\/$/, "") + "/" : "") + ".mktero_llm_config.json";
  return this.configPath;
};

MkteroSettings.status = function (text, ok) {
  var el = document.getElementById("s-status");
  if (!el) return;
  el.setAttribute("value", text || "");
  el.setAttribute("style", "margin-left:10px;" +
    (ok === true ? "color:#1a7f37;" : ok === false ? "color:#c0392b;" : ""));
};

MkteroSettings.readFile = function (path) {
  try {
    var Cc = Components.classes, Ci = Components.interfaces;
    var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    if (!f.exists()) return "";
    var stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    stream.init(f, 0x01, 0o444, 0);
    var cv = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
    cv.init(stream, "UTF-8", 4096, 0xFFFD);
    var out = {}, str = {}, parts = [];
    while (cv.readString(4096, out, str) && out.value > 0) parts.push(str.value);
    cv.close();
    return parts.join("");
  } catch (e) { return ""; }
};

MkteroSettings.writeFile = function (path, text) {
  try {
    var Cc = Components.classes, Ci = Components.interfaces;
    var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    var fo = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    fo.init(f, 0x02 | 0x08 | 0x20, 0o600, 0);
    var co = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
    co.init(fo, "UTF-8", 4096, 0);
    co.writeString(text);
    co.close();
    return true;
  } catch (e) {
    this.status("保存失败：" + (e && e.message ? e.message : e), false);
    return false;
  }
};

MkteroSettings.onLoad = function () {
  try {
    var path = this.path();
    var raw = this.readFile(path);
    if (raw) {
      var cfg = JSON.parse(raw);
      var b = document.getElementById("s-base");
      var m = document.getElementById("s-model");
      if (b) b.value = cfg.base_url || "";
      if (m) m.value = cfg.model || "";
      this.status("已读取本机配置（密钥未显示）", true);
    } else {
      this.status("尚未配置，请填写后保存");
    }
    try {
      var d = document.getElementById("s-dir");
      var p = document.getElementById("s-python");
      if (d) d.value = Zotero.Prefs.get("extensions.mkterobilang.converterDir", true) || "";
      if (p) p.value = Zotero.Prefs.get("extensions.mkterobilang.python", true) || "";
    } catch (e) {}
  } catch (e) {
    this.status("读取配置失败：" + (e && e.message ? e.message : e), false);
  }
};

MkteroSettings.toggleKey = function () {
  var k = document.getElementById("s-key");
  if (!k) return;
  var show = k.getAttribute("type") === "password";
  k.setAttribute("type", show ? "text" : "password");
};

MkteroSettings.save = function () {
  var path = this.path();
  var cfg = {};
  var raw = this.readFile(path);
  if (raw) { try { cfg = JSON.parse(raw); } catch (e) { cfg = {}; } }
  var b = document.getElementById("s-base");
  var m = document.getElementById("s-model");
  var k = document.getElementById("s-key");
  cfg.base_url = (b && b.value || "").trim();
  cfg.model = (m && m.value || "").trim();
  var newKey = (k && k.value || "").trim();
  if (newKey) cfg.api_key = newKey;
  if (!cfg.base_url || !cfg.model) {
    this.status("Base URL 和模型不能为空", false);
    return false;
  }
  if (!this.writeFile(path, JSON.stringify(cfg, null, 2))) return false;
  if (k) k.value = "";
  try {
    var d = document.getElementById("s-dir");
    var p = document.getElementById("s-python");
    if (d && d.value.trim()) Zotero.Prefs.set("extensions.mkterobilang.converterDir", d.value.trim(), true);
    if (p && p.value.trim()) Zotero.Prefs.set("extensions.mkterobilang.python", p.value.trim(), true);
  } catch (e) {}
  this.status("已保存（密钥仅存本机）", true);
  return true;
};

MkteroSettings.onSave = function () {
  try { return this.save(); }
  catch (e) { this.status("保存失败：" + (e && e.message ? e.message : e), false); return false; }
};

MkteroSettings.testLLM = function () {
  this.status("测试中…");
  if (!this.save()) return;
  try {
    var Cc = Components.classes, Ci = Components.interfaces;
    var py = "";
    var candidates = [
      (document.getElementById("s-python") || {}).value,
      "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(String(candidates[i]).trim());
      if (f.exists() && f.isFile()) { py = String(candidates[i]).trim(); break; }
    }
    if (!py) { this.status("找不到 python3", false); return; }
    var dir = ((document.getElementById("s-dir") || {}).value || "").trim();
    if (!dir) {
      try { dir = Zotero.Prefs.get("extensions.mkterobilang.converterDir", true) || ""; }
      catch (e) {}
    }
    var script = dir.replace(/\/$/, "") + "/arxiv_translate.py";
    var sf = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    sf.initWithPath(script);
    if (!sf.exists()) { this.status("找不到 arxiv_translate.py", false); return; }
    var exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    exe.initWithPath(py);
    var proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(exe);
    var args = [script, "--test-llm", "--config", this.path()];
    var self = this;
    proc.runAsync(args, args.length, {
      observe: function (subject, topic, data) {
        if (topic === "process-finished") self.status("连接成功", true);
        else if (topic === "process-failed") self.status("连接失败，请检查 URL / 模型 / 密钥", false);
      }
    });
  } catch (e) {
    this.status("测试失败：" + (e && e.message ? e.message : e), false);
  }
};
