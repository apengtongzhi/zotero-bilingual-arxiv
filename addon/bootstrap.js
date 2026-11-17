/* global Zotero, Services, Cc, Ci */

// Mktero 双语阅读快照 — Zotero 7-10 bootstrapped plugin
// 选中条目 -> 自己选双语 md 文件或论文目录 -> 调用本机转换器
// -> 输出以原论文名命名的单文件 HTML -> 作为 text/html 附件挂回条目

var MkteroBilingual = {
  id: null,
  version: null,
  rootURI: null,
  registrations: []
};

var PREFIX = "extensions.mkterobilang.";

var DEFAULTS = {
  converterDir: "",        // 运行时从插件内置 converter/ 目录解析
  python: "/usr/bin/python3",
  lastDir: ""
};

// 插件自带的转换器目录（打进 xpi 的 converter/ 子目录）
function builtinConverterDir() {
  try {
    var uri = MkteroBilingual.rootURI;
    if (!uri) return "";
    // rootURI 形如 file:///path/to/addon/ —— 转成系统路径
    var path = decodeURIComponent(uri.replace(/^file:\/\//, "").replace(/\/$/, ""));
    var dir = path + "/converter";
    return Zotero.File.pathToFile(dir).exists() ? dir : "";
  } catch (e) {
    Zotero.logError(e);
    return "";
  }
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
  var targets = [
    { popupID: "zotero-itemmenu", label: "生成双语阅读快照（选 md 文件）…", command: "file", itemMenu: true },
    { popupID: "zotero-itemmenu", label: "生成双语阅读快照（选论文目录）…", command: "folder", itemMenu: true },
    { popupID: "zotero-itemmenu", label: "从 arXiv 生成双语快照…", command: "arxiv", itemMenu: true },
    { popupID: "menu_ToolsPopup", label: "生成双语阅读快照（选 md 文件）…", command: "file" },
    { popupID: "menu_ToolsPopup", label: "生成双语阅读快照（选论文目录）…", command: "folder" },
    { popupID: "menu_ToolsPopup", label: "从 arXiv 生成双语快照…", command: "arxiv" },
    { popupID: "menu_ToolsPopup", label: "双语快照：设置路径…", command: "settings" },
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

  // 注册可视化设置面板（工具 → 设置 → Mktero 双语快照）
  // 面板脚本只操作本机 ~/.mktero_llm_config.json，不把密钥写入 Zotero prefs
  try {
    if (Zotero.PreferencePanes && typeof Zotero.PreferencePanes.register === "function") {
      var prefId = await Zotero.PreferencePanes.register({
        pluginID: id,
        id: "mktero-bilingual-prefs",
        src: rootURI + "prefs.xhtml",
        label: "双语快照 / arXiv 翻译",
        scripts: [rootURI + "pane.js"]
      });
      MkteroBilingual.prefPaneId = prefId;
    }
  } catch (e) {
    Zotero.logError(e);
  }

  Zotero.getMainWindows().forEach(function (win) {
    if (win && win.document) {
      addMenus(win);
    }
  });
}

function onMainWindowLoad({ window }) {
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
  try {
    if (MkteroBilingual.prefPaneId && Zotero.PreferencePanes) {
      Zotero.PreferencePanes.unregister(MkteroBilingual.prefPaneId);
      MkteroBilingual.prefPaneId = null;
    }
  } catch (e) {
    Zotero.logError(e);
  }
}

function uninstall(data, reason) {}

function firstMarkdown(dir) {
  try {
    var entries = dir.directoryEntries;
    while (entries.hasMoreElements()) {
      var f = entries.getNext().QueryInterface(Ci.nsIFile);
      if (f.isFile() && /\.md$/i.test(f.leafName)) {
        return f.path;
      }
    }
  } catch (e) {
    Zotero.logError(e);
  }
  return null;
}

// 文件选择器不可用/被取消时，退回「粘贴路径」，保证流程不会静默中断
function promptPath(win, title, mode) {
  var hint = (mode === Ci.nsIFilePicker.modeGetFolder)
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
    try {
      var fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      // Firefox 140 需要 browsingContext；传 window 会抛异常并被静默吞掉
      var parent = win.browsingContext || win;
      fp.init(parent, title, mode);
      if (mode === Ci.nsIFilePicker.modeOpen) {
        fp.appendFilter("Markdown", "*.md");
      }
      var last = getPref("lastDir");
      if (last) {
        try {
          var d = Zotero.File.pathToFile(last);
          if (d.exists() && d.isDirectory()) {
            fp.displayDirectory = d;
          }
        } catch (e) {
          Zotero.logError(e);
        }
      }
      fp.open(function (rv) {
        if (rv !== Ci.nsIFilePicker.returnOK) {
          resolve(null);
          return;
        }
        var p = fp.file.path;
        try {
          var dir = (mode === Ci.nsIFilePicker.modeGetFolder)
            ? p
            : Zotero.File.pathToFile(p).parent.path;
          setPref("lastDir", dir);
        } catch (e) {
          Zotero.logError(e);
        }
        resolve(p);
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
  return new Promise(function (resolve, reject) {
    try {
      var py = resolvePython();
      if (!py) {
        reject(new Error("找不到 python3，请在「双语快照：设置路径…」里指定"));
        return;
      }
      var scriptPath = getPref("converterDir") + "/bilingual_to_zotero.py";
      var script = Zotero.File.pathToFile(scriptPath);
      if (!script.exists()) {
        reject(new Error("找不到转换器：" + scriptPath));
        return;
      }
      var exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      exe.initWithPath(py);
      if (!exe.exists()) {
        reject(new Error("找不到 python3：" + py));
        return;
      }
      var proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      proc.init(exe);
      var args = [
        script.path, "--md", mdPath, "--out", outDir,
        "--name-file", nameFile, "--no-pdf"
      ];
      proc.runAsync(args, args.length, {
        observe: function (subject, topic, data) {
          if (topic === "process-finished") {
            resolve();
          } else if (topic === "process-failed") {
            reject(new Error("转换进程退出异常"));
          }
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// 通用：异步跑一个 python 脚本，返回退出码（0=成功）
function runScript(args) {
  return new Promise(function (resolve, reject) {
    try {
      var py = resolvePython();
      if (!py) {
        reject(new Error("找不到 python3，请在「双语快照：设置路径…」里指定"));
        return;
      }
      var exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      exe.initWithPath(py);
      if (!exe.exists()) {
        reject(new Error("找不到 python3：" + py));
        return;
      }
      var proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      proc.init(exe);
      proc.runAsync(args, args.length, {
        observe: function (subject, topic, data) {
          if (topic === "process-finished") {
            resolve(0);
          } else if (topic === "process-failed") {
            reject(new Error("进程退出异常：" + args[0]));
          }
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// 从 Zotero 条目的 URL / Extra / DOI 里提取 arXiv ID
function extractArxivId(item) {
  var text = "";
  try {
    ["url", "DOI", "extra", "archiveID", "repository"].forEach(function (f) {
      try { text += " " + (item.getField(f) || ""); } catch (e) {}
    });
  } catch (e) {}
  var pats = [
    /arxiv\.org\/(?:abs|pdf|e-print)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i,
    /arxiv:([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i,
    /10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})/i,
    /\b([0-9]{4}\.[0-9]{4,5})\b/
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = text.match(pats[i]);
    if (m) return m[1];
  }
  return "";
}

// 从 arXiv LaTeX 源码生成双语快照：下载→解析→翻译→排版→挂回 Zotero
async function runArxiv(win) {
  var items = [];
  try {
    items = Zotero.getActiveZoteroPane().getSelectedItems() || [];
  } catch (e) { Zotero.logError(e); }
  var item = items.filter(function (i) { return i.isRegularItem(); })[0];
  if (!item) {
    alertWin(win, "arXiv 双语快照", "请先在文献列表中选中一个文献条目（不是附件或笔记）。");
    return;
  }

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

  // 让用户选输出目录（源码、译文、HTML 都放这里）
  var outDir = await pickPath(
    win, "选择 arXiv 双语快照的输出目录（源码/译文/HTML 存这里）",
    Ci.nsIFilePicker.modeGetFolder
  );
  if (!outDir) {
    outDir = promptPath(win, "arXiv 输出目录", Ci.nsIFilePicker.modeGetFolder);
  }
  if (!outDir) return;

  var name = paperName(item.getField("title"));
  var nameFile = outDir + "/_mktero_name.txt";
  try {
    await IOUtils.writeUTF8(nameFile, name);
  } catch (e) {
    try { await Zotero.File.putContentsAsync(nameFile, name); } catch (e2) {}
  }
  var converter = getPref("converterDir");
  var py = resolvePython();
  if (!py) {
    alertWin(win, "arXiv 双语快照", "找不到 python3，请在设置里指定。");
    return;
  }
  var parseScript = converter + "/arxiv_to_zotero.py";
  var transScript = converter + "/arxiv_translate.py";
  if (!Zotero.File.pathToFile(parseScript).exists() ||
      !Zotero.File.pathToFile(transScript).exists()) {
    alertWin(win, "arXiv 双语快照",
      "找不到 arXiv 转换器：" + parseScript + "\n请确认转换器目录设置正确、脚本已放入。");
    return;
  }

  var finish = progress("正在从 arXiv「" + arxivId + "」下载并解析 LaTeX…");
  try {
    // 第一步：下载 + 解析（产出 arxiv_blocks.json 与单语预览）
    await runScript([py, parseScript, "--id", arxivId, "--out", outDir,
                     "--name-file", nameFile]);
    finish(true);

    // 第二步：翻译（调用本机私有 API 配置，约 3-5 分钟）
    var finish2 = progress("正在翻译全文（约 3-5 分钟，请勿关闭 Zotero）…");
    var blocksPath = outDir + "/arxiv_blocks.json";
    var zhPath = outDir + "/_arxiv_zh.json";
    // 显式传 LLM 配置路径，避免插件进程 HOME 不同导致读不到密钥
    var llmCfg = "";
    try {
      llmCfg = Services.dirsvc.get("Home", Ci.nsIFile).path +
               "/.mktero_llm_config.json";
    } catch (e) {}
    var transArgs = [py, transScript, "--blocks", blocksPath,
                     "--out", zhPath, "--title", item.getField("title") || ""];
    if (llmCfg && Zotero.File.pathToFile(llmCfg).exists()) {
      transArgs.push("--config", llmCfg);
    }
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
      html = findHtml(outDir);
    }
    if (!html) {
      throw new Error("未找到生成的 HTML，输出目录：" + outDir);
    }

    var att = await Zotero.Attachments.importFromFile({
      file: html,
      parentItemID: item.id,
      title: name,
      contentType: "text/html",
      charset: "utf-8",
      fileBaseName: name
    });
    att.addTag("双语");
    att.addTag("arXiv");
    await att.saveTx();
    try {
      var zp = Zotero.getActiveZoteroPane();
      if (typeof zp.viewAttachment === "function") zp.viewAttachment(att.id);
    } catch (e) {}
    alertWin(win, "arXiv 双语快照",
      "已完成：\n\n" + html + "\n\n已挂到条目「" + item.getField("title") +
      "」下，双击即可阅读、高亮、做笔记。");
  } catch (e) {
    Zotero.logError(e);
    finish(false);
    alertWin(win, "arXiv 双语快照 — 失败", String(e && e.message ? e.message : e));
  }
}

// 兜底：结果清单读不到时，扫描输出目录里最新的 HTML
function findHtml(outDir) {
  try {
    var dir = Zotero.File.pathToFile(outDir);
    if (!dir.exists()) {
      return null;
    }
    var best = null;
    var bestTime = -1;
    var entries = dir.directoryEntries;
    while (entries.hasMoreElements()) {
      var f = entries.getNext().QueryInterface(Ci.nsIFile);
      if (!f.isFile() || !/\.html$/i.test(f.leafName)) {
        continue;
      }
      if (/\.stage\.html$/i.test(f.leafName) || f.leafName.indexOf("_formula_") === 0) {
        continue;
      }
      var t = f.lastModifiedTime;
      if (t > bestTime) {
        bestTime = t;
        best = f.path;
      }
    }
    return best;
  } catch (e) {
    Zotero.logError(e);
    return null;
  }
}

function progress(text) {
  try {
    var pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("Mktero 双语阅读快照");
    var item = new pw.ItemProgress(text);
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
      Ci.nsIFilePicker.modeGetFolder
    );
    if (!dirPath) {
      dirPath = promptPath(win, "选择论文目录", Ci.nsIFilePicker.modeGetFolder);
    }
    if (!dirPath) {
      return;
    }
    mdPath = firstMarkdown(Zotero.File.pathToFile(dirPath));
    if (!mdPath) {
      alertWin(win, "双语阅读快照", "这个目录里没有找到 .md 文件，请重新选择。");
      return;
    }
  } else {
    mdPath = await pickPath(
      win,
      "选择 Mktero 导出的双语 Markdown（*.md）",
      Ci.nsIFilePicker.modeOpen
    );
    if (!mdPath) {
      mdPath = promptPath(win, "选择双语 md", Ci.nsIFilePicker.modeOpen);
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
      html = findHtml(outDir);
    }
    if (!html) {
      throw new Error("转换完成但没找到 HTML。输出目录：" + outDir
        + "\n请查看 Zotero 错误控制台。");
    }

    var att = await Zotero.Attachments.importFromFile({
      file: html,
      parentItemID: item.id,
      title: name,
      contentType: "text/html",
      charset: "utf-8",
      fileBaseName: name
    });
    att.addTag("双语");
    await att.saveTx();

    try {
      var zp = Zotero.getActiveZoteroPane();
      if (typeof zp.viewAttachment === "function") {
        zp.viewAttachment(att.id);
      }
    } catch (e) {
      Zotero.logError(e);
    }

    finish(true);
    alertWin(
      win,
      "双语阅读快照",
      "已完成：\n\n" + html + "\n\n"
      + "同名附件已挂到条目「" + item.getField("title") + "」下，双击即可阅读、高亮、做笔记。"
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
  probe("右键菜单容器", function () { return !!win.document.getElementById("zotero-itemmenu"); });
  probe("Tools 菜单容器", function () { return !!win.document.getElementById("menu_ToolsPopup"); });
  probe("本插件菜单项数", function () {
    return win.document.querySelectorAll('[data-mktero-bilingual="1"]').length;
  });
  probe("选中条目", function () {
    var items = Zotero.getActiveZoteroPane().getSelectedItems() || [];
    return items.length + (items.length ? " / " + (items[0].isRegularItem() ? "常规" : "非常规") : "");
  });
  probe("python", function () { return resolvePython(); });
  probe("转换器目录", function () { return getPref("converterDir"); });
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
  probe("filePicker.modeGetFolder", function () { return Ci.nsIFilePicker.modeGetFolder; });
  alertWin(win, "双语快照自检", lines.join("\n"));
  return lines.join("\n");
}

async function openSettings(win) {
  var fields = [
    ["converterDir", "转换器目录（含 bilingual_to_zotero.py）："],
    ["python", "python3 可执行文件绝对路径："]
  ];
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i][0];
    var obj = { value: getPref(key) };
    var ok = Services.prompt.prompt(win, "双语快照设置", fields[i][1], obj, null, { value: false });
    if (!ok) {
      return;
    }
    setPref(key, obj.value);
  }
  alertWin(win, "双语快照设置", "已保存。");
}
