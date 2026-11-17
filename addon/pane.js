/* global Zotero, Cc, Ci, IOUtils, Services */

// Mktero 双语快照 — 偏好设置面板脚本
// 负责：加载/保存 LLM 配置到 ~/.mktero_llm_config.json（权限 600），测试连接。
// 转换器目录与 python 路径由 XHTML 的 preference 属性直接绑定，不在这里处理。

var MkteroPrefs = {
  configPath: null,
  loaded: false
};

function mkteroHome() {
  try {
    return Services.dirsvc.get("Home", Ci.nsIFile).path;
  } catch (e) {
    return "";
  }
}

function mkteroConfigPath() {
  if (MkteroPrefs.configPath) return MkteroPrefs.configPath;
  var home = mkteroHome();
  MkteroPrefs.configPath = (home ? home + "/" : "") + ".mktero_llm_config.json";
  return MkteroPrefs.configPath;
}

function mkteroSetStatus(text, ok) {
  try {
    var el = document.getElementById("mktero-llm-status");
    if (!el) return;
    el.setAttribute("value", text);
    el.setAttribute("class", "mktero-status" +
      (ok === true ? " ok" : ok === false ? " err" : ""));
  } catch (e) {
    Zotero.logError(e);
  }
}

async function mkteroLoadConfig() {
  var base = document.getElementById("mktero-base-url");
  var model = document.getElementById("mktero-model");
  var key = document.getElementById("mktero-api-key");
  var path = mkteroConfigPath();
  if (!path) {
    mkteroSetStatus("找不到用户主目录", false);
    return;
  }
  try {
    var f = Zotero.File.pathToFile(path);
    if (f.exists()) {
      var cfg = JSON.parse(await IOUtils.readUTF8(path));
      if (base) base.value = cfg.base_url || "";
      if (model) model.value = cfg.model || "";
      // 密钥不回显，留空表示不修改
      if (key) key.value = "";
      MkteroPrefs.loaded = true;
      mkteroSetStatus("已读取本机配置（密钥未显示）", true);
    } else {
      if (base) base.value = "";
      if (model) model.value = "";
      MkteroPrefs.loaded = false;
      mkteroSetStatus("尚未配置，请填写后保存");
    }
  } catch (e) {
    Zotero.logError(e);
    mkteroSetStatus("读取配置失败：" + (e && e.message ? e.message : e), false);
  }
}

async function mkteroSaveConfig() {
  var base = document.getElementById("mktero-base-url");
  var model = document.getElementById("mktero-model");
  var key = document.getElementById("mktero-api-key");
  var path = mkteroConfigPath();
  if (!path) {
    mkteroSetStatus("找不到用户主目录", false);
    return;
  }
  var cfg = {};
  try {
    var f = Zotero.File.pathToFile(path);
    if (f.exists()) cfg = JSON.parse(await IOUtils.readUTF8(path));
  } catch (e) {
    cfg = {};
  }
  cfg.base_url = (base && base.value || "").trim();
  cfg.model = (model && model.value || "").trim();
  var newKey = (key && key.value || "").trim();
  if (newKey) cfg.api_key = newKey;   // 留空则保留旧密钥
  if (!cfg.base_url || !cfg.model) {
    mkteroSetStatus("Base URL 和模型不能为空", false);
    return;
  }
  try {
    await IOUtils.writeUTF8(path, JSON.stringify(cfg, null, 2));
    if (key) key.value = "";
    MkteroPrefs.loaded = true;
    mkteroSetStatus("已保存（密钥仅存本机）", true);
  } catch (e) {
    Zotero.logError(e);
    mkteroSetStatus("保存失败：" + (e && e.message ? e.message : e), false);
  }
}

// 测试连接：先保存当前输入，再调用 arxiv_translate.py --test-llm，
// 密钥走本机配置文件，不拼进命令行参数。
async function mkteroTestLLM() {
  mkteroSetStatus("测试中…");
  await mkteroSaveConfig();
  var statusEl = document.getElementById("mktero-llm-status");
  if (statusEl && (statusEl.getAttribute("class") || "").indexOf("err") >= 0) return;

  var py = "";
  try {
    var candidates = [
      Zotero.Prefs.get("extensions.mkterobilang.python", true),
      "/usr/bin/python3",
      "/opt/homebrew/bin/python3"
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      var pf = Zotero.File.pathToFile(candidates[i]);
      if (pf.exists() && pf.isFile()) { py = candidates[i]; break; }
    }
  } catch (e) {}
  if (!py) { mkteroSetStatus("找不到 python3", false); return; }

  var converter = "";
  try {
    converter = Zotero.Prefs.get("extensions.mkterobilang.converterDir", true) || "";
  } catch (e) {}
  var script = converter + "/arxiv_translate.py";
  if (!Zotero.File.pathToFile(script).exists()) {
    mkteroSetStatus("找不到 arxiv_translate.py，请检查转换器目录", false);
    return;
  }

  return new Promise(function (resolve) {
    try {
      var exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      exe.initWithPath(py);
      var proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      proc.init(exe);
      var args = [script, "--test-llm", "--config", mkteroConfigPath()];
      proc.runAsync(args, args.length, {
        observe: function (subject, topic, data) {
          if (topic === "process-finished") {
            mkteroSetStatus("连接成功", true);
            resolve(true);
          } else if (topic === "process-failed") {
            mkteroSetStatus("连接失败，请检查 URL / 模型 / 密钥", false);
            resolve(false);
          }
        }
      });
    } catch (e) {
      Zotero.logError(e);
      mkteroSetStatus("测试失败：" + (e && e.message ? e.message : e), false);
      resolve(false);
    }
  });
}

function mkteroInit() {
  if (MkteroPrefs.initialized) return;
  try {
    var saveBtn = document.getElementById("mktero-save");
    var testBtn = document.getElementById("mktero-test-llm");
    var toggleBtn = document.getElementById("mktero-toggle-key");
    if (!saveBtn && !testBtn && !toggleBtn) return;  // DOM 尚未注入，留待下次
    MkteroPrefs.initialized = true;
    if (saveBtn) saveBtn.addEventListener("command", mkteroSaveConfig);
    if (testBtn) testBtn.addEventListener("command", mkteroTestLLM);
    if (toggleBtn) {
      toggleBtn.addEventListener("command", function () {
        var key = document.getElementById("mktero-api-key");
        if (!key) return;
        var show = key.getAttribute("type") === "password";
        key.setAttribute("type", show ? "text" : "password");
        toggleBtn.setAttribute("label", show ? "隐藏" : "显示");
      });
    }
    mkteroLoadConfig();
  } catch (e) {
    Zotero.logError(e);
  }
}

// 偏好面板脚本在片段注入后执行，此时宿主窗口可能早已触发 load，
// 因此立即初始化一次，并保留 DOMContentLoaded / load 作为兜底。
// mkteroInit 内部用 getElementById 找元素，重复调用也只是重复绑定一次，安全。
mkteroInit();
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mkteroInit, { once: true });
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("load", mkteroInit, { once: true });
}
