#!/usr/bin/env node
/*
 * 假沙箱里跑 addon/bootstrap.js。
 *
 * 目的：Zotero 7~10 的插件沙箱只注入有限的全局（没有 Cc / Ci / Components）。
 * 在 Node 里直接用全局跑脚本是测不出来的——只有在「少给东西」的沙箱里跑，
 * 才会暴露 Cc is not defined / 接口签名不对 这类只在 Zotero 内部才炸的问题。
 *
 * 用法：node scripts/sandbox_check.js
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ADDON = path.join(ROOT, "addon");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mb-sandbox-"));
const PROFILE = path.join(TMP, "profile");
// 伪装成用户主目录：配置文件的期望落点
const HOME_DIR = path.join(TMP, "home");
fs.mkdirSync(HOME_DIR, { recursive: true });

let failures = 0;
function ok(cond, label, extra) {
  if (cond) {
    console.log("  PASS  " + label);
  } else {
    failures++;
    console.log("  FAIL  " + label + (extra ? "\n        " + extra : ""));
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, "expected " + JSON.stringify(expected)
    + ", got " + JSON.stringify(actual));
}

// ---------------- IOUtils（按真实签名的手写实现） ----------------
const IOUtils = {
  async exists(p) {
    try { await fsp.access(p); return true; } catch (e) { return false; }
  },
  async writeUTF8(p, data) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data, "utf8");
    return Buffer.byteLength(data);
  },
  async readUTF8(p) { return fsp.readFile(p, "utf8"); },
  async getChildren(p) {
    const kids = await fsp.readdir(p);
    return kids.map(k => path.join(p, k));
  },
  async stat(p) {
    const s = await fsp.stat(p);
    return { type: s.isDirectory() ? "directory" : "regular", lastModified: s.mtimeMs, size: s.size };
  },
  async makeDirectory(p, opts) {
    await fsp.mkdir(p, { recursive: !!opts && !!opts.createAncestors });
  },
  async setPermissions(p, mode) { await fsp.chmod(p, mode); },
  async remove(p, opts) {
    try { await fsp.rm(p, { recursive: true, force: true }); }
    catch (e) { if (!(opts && opts.ignoreAbsent)) throw e; }
  }
};

// ---------------- Zotero.File（nsIFile 的最小可用子集） ----------------
function fileObj(p) {
  return {
    path: p,
    exists() { return fs.existsSync(p); },
    isFile() { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
    isDirectory() { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } },
    get parent() { return fileObj(path.dirname(p)); },
    remove(recursive) {
      if (recursive) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    }
  };
}

// ---------------- 可控的 HTTP 桩 ----------------
let httpHandler = () => ({ status: 200, text: "{}" });
let lastRequest = null;

const prefs = new Map();
let mockSelected = [];
const mockViewed = [];
const mockImported = [];
const mockAlerts = [];
let mockItems = [];

const zotero = {
  version: "7.0.0",
  initializationPromise: Promise.resolve(),
  debug() {},
  logError(e) { if (process.env.MB_VERBOSE) console.error("[logError]", e); },
  warn() {},
  Prefs: {
    get(k) { return prefs.has(k) ? prefs.get(k) : undefined; },
    set(k, v) { prefs.set(k, v); },
    clear(k) { prefs.delete(k); }
  },
  File: {
    pathToFile: fileObj,
    // 真实实现第一参必须是 nsIFile：函数体第一行就是 file.exists()。
    // 传路径字符串会抛「file.exists is not a function」。这里如实照做——
    // 之前这个桩接受字符串，正好把这个 bug 遮到了用户机器上。
    putContents(file, data) {
      if (!file || typeof file !== "object" || typeof file.exists !== "function") {
        throw new TypeError("file.exists is not a function");
      }
      const p = file.path;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(data), "utf8");
    },
    // 与真实实现一致：getContents 允许传路径字符串
    getContents(file) {
      return fs.readFileSync(typeof file === "string" ? file : file.path, "utf8");
    },
    async getContentsAsync(p) { return fsp.readFile(p, "utf8"); },
    async putContentsAsync(p, data) { await IOUtils.writeUTF8(p, data); },
    // 模拟 jar: 读取：直接映射到源码目录
    async getResourceAsync(url) {
      const rel = url.split("!/").pop().replace(/^\//, "");
      // 模拟 build.py 生成的 MathJax 分片
      const pm = rel.match(/converter\/vendor\/tex-svg\.part(\d{2})$/);
      if (pm) {
        const full = fs.readFileSync(
          path.join(ADDON, "converter", "vendor", "tex-svg.js"), "utf8");
        const step = Math.ceil(full.length / 12);
        return full.slice(Number(pm[1]) * step, (Number(pm[1]) + 1) * step);
      }
      const src = path.join(ADDON, rel);
      if (!fs.existsSync(src)) throw new Error("no such resource: " + url);
      return fsp.readFile(src, "utf8");
    },
    async getContentsFromURLAsync() { throw new Error("not available"); }
  },
  HTTP: {
    request(method, url, options) {
      lastRequest = { method, url, options };
      return Promise.resolve().then(() => {
        const r = httpHandler(url, options);
        if (r instanceof Error) throw r;
        return {
          status: r.status,
          responseText: r.text,
          response: r.text
        };
      });
    }
  },
  getMainWindows() { return [mockMainWindow]; },
  getActiveZoteroPane() {
    return {
      getSelectedItems() { return mockSelected; },
      viewAttachment(id) { mockViewed.push(id); }
    };
  },
  Utilities: { Internal: { openPreferences() { return null; } } },
  FilePicker: FakeFilePicker,
  PreferencePanes: { async register() { return "pane-id"; } },
  Attachments: {
    LINK_MODE_IMPORTED_FILE: 0,
    async importFromFile(opts) {
      mockImported.push(opts);
      return {
        id: 900 + mockImported.length,
        addTag(t) { mockTags.push(t); },
        saveTx: async () => {}
      };
    }
  },
  Items: { get() { return mockItems; } },
  ProgressWindow: function () {
    this.changeHeadline = () => {};
    this.ItemProgress = function () { this.setProgress = () => {}; this.setText = () => {}; };
    this.show = () => {};
    this.startCloseTimer = () => {};
  }
};

const mockTags = [];

// 真实沙箱里没有 Ci，但活窗口的 Components 上能借到 nsIFile 常量；
// Services.dirsvc.get("Home", …) 就是靠它工作的。
class FakeNsIFile {
  constructor(p) { this.path = p; }
}
const mockMainWindow = {
  Components: { interfaces: { nsIFile: FakeNsIFile } }
};

const services = {
  prompt: {
    alert(win, title, text) { mockAlerts.push(title + "｜" + text); },
    confirm() { return true; },
    prompt() { return false; }
  },
  dirsvc: {
    get(name, iface) {
      if (name === "Home") {
        if (!iface) throw new Error("nsIFile interface required");
        return new FakeNsIFile(HOME_DIR);
      }
      throw new Error("unsupported dirsvc key: " + name);
    }
  },
  wm: { getEnumerator() { return { hasMoreElements() { return false; } }; } }
};

// Subprocess 桩：复刻真实签名（wait() → { exitCode }，stdout.readString()）
const subprocess = {
  call(options) {
    return new Promise((resolve, reject) => {
      const child = spawn(options.command, options.arguments || []);
      const outChunks = [];
      const errChunks = [];
      child.stdout.on("data", c => outChunks.push(c));
      child.stderr.on("data", c => errChunks.push(c));
      child.on("error", e => reject(e));
      child.on("close", code => {
        resolve({
          stdout: { readString: async () => Buffer.concat(outChunks).toString("utf8") },
          stderr: { readString: async () => Buffer.concat(errChunks).toString("utf8") },
          wait: async () => ({ exitCode: code })
        });
      });
    });
  }
};

// ---------------- 极简 XML DOM（DOMParser 桩，仅供 Atom 解析） ----------------
class XNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.text = ""; }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  // 与真实 DOM 一致：支持通配 "*"，并暴露 localName（带前缀的标签靠它匹配）
  get localName() { return this.tagName; }
  getElementsByTagName(name) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (name === "*" || c.tagName === name) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function parseXml(text) {
  const root = new XNode("#document");
  const stack = [root];
  const re = /<\/?([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const raw = m[0];
    if (m[3] !== undefined) { stack[stack.length - 1].text += m[3]; continue; }
    if (raw.startsWith("<?") || raw.startsWith("<!--")) continue;
    const closing = raw.startsWith("</");
    const selfClose = m[2] === "/";
    const tag = m[1].replace(/^.*:/, "");
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const node = new XNode(tag);
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function FakeDOMParser() {}
FakeDOMParser.prototype.parseFromString = function (text) { return parseXml(text); };

// ---------------- 组装沙箱（只给 Zotero 真给的那些） ----------------
const sandbox = {
  Zotero: zotero,
  Services: services,
  IOUtils,
  // ⚠️ 不要给 homeDir：实测 Zotero 自带的 PathUtils 上并没有这个属性，
  // 早先图省事在这里塞了一个，正好把「保存失败：找不到用户主目录」这个 bug 遮住了。
  PathUtils: { profileDir: PROFILE, join: path.join },
  ChromeUtils: {
    importESModule(url) {
      if (url.indexOf("Subprocess.sys.mjs") !== -1) return { Subprocess: subprocess };
      if (url.indexOf("filePicker.mjs") !== -1) return { FilePicker: FakeFilePicker };
      throw new Error("unexpected module: " + url);
    }
  },
  ChromeWorker: function () {},
  XMLSerializer: function () {},
  fetch: async () => { throw new Error("fetch unavailable in stub"); },
  setTimeout, clearTimeout, setInterval, clearInterval,
  TextEncoder, TextDecoder,
  URL, URLSearchParams,
  DOMParser: FakeDOMParser,
  console
};
// 刻意不提供：Cc / Ci / Components / ChromeUtils 之外的 XPCOM 入口
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(ADDON, "bootstrap.js"), "utf8");
vm.runInContext(code, sandbox, { filename: "bootstrap.js" });

let nextPickPath = null;
function FakeFilePicker() { this._file = ""; }
FakeFilePicker.prototype.init = function () {};
FakeFilePicker.prototype.appendFilter = function () {};
FakeFilePicker.prototype.show = async function () {
  if (!nextPickPath) return this.returnCancel;
  this._file = nextPickPath;
  nextPickPath = null;
  return this.returnOK;
};
Object.defineProperty(FakeFilePicker.prototype, "file", {
  get() { return this._file; }
});
FakeFilePicker.prototype.modeOpen = 0;
FakeFilePicker.prototype.modeGetFolder = 2;
FakeFilePicker.prototype.returnOK = 0;

// ---------------- 假设置面板 document ----------------
function makeDoc(values) {
  const els = new Map();
  const doc = {
    documentElement: { getAttribute() { return null; }, setAttribute() {} },
    getElementById(id) {
      if (id === "bs-prefpane") return {};
      if (!els.has(id)) {
        els.set(id, {
          id, value: values[id] !== undefined ? String(values[id]) : "",
          type: "text", checked: !!values[id], textContent: "",
          setAttribute(k, v) { this[k] = v; },
          getAttribute(k) { return this[k]; },
          addEventListener() {}
        });
      }
      return els.get(id);
    },
    querySelectorAll() { return []; }
  };
  return doc;
}
function ev(doc) { return { target: { ownerDocument: doc } }; }

function makeItemStub(fields, creators) {
  const f = fields || {};
  return {
    id: 1,
    isRegularItem: () => true,
    getField: (k) => (k in f ? f[k] : ""),
    getCreators: () => (creators || []).map((n) => ({ firstName: "", lastName: n })),
    addTag() {}
  };
}

function cfgStub() {
  return {
    api: { base_url: "https://api.example.com/v1", model: "m", api_key: "sk-x",
           temperature: 0, timeout: 30 },
    translation: {}, files: {}, advanced: {}
  };
}

// 构造 arXiv Atom 响应；comment 故意带命名空间前缀，贴近真实响应
function atomFeed(entries) {
  const body = entries.map((e) => `
  <entry>
    <id>http://arxiv.org/abs/${e.id}v1</id>
    <published>${e.published || "2022-01-01T00:00:00Z"}</published>
    <title>${e.title}</title>
    <summary>${e.summary || ""}</summary>
    <author><name>${e.author || ""}</name></author>
    ${e.comment ? `<arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">${e.comment}</arxiv:comment>` : ""}
  </entry>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">${body}</feed>`;
}

function statusOf(doc) { return doc.getElementById("bs-status").textContent; }
function footStatusOf(doc) { return doc.getElementById("bs-save-status").textContent; }


// ---------------- 假元素：菜单 / 面板共用 ----------------
function makeEl(tag) {
  const el = {
    tagName: tag, attrs: {}, children: [], parentNode: null, hidden: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
      return c;
    },
    addEventListener(type, fn) { (this._ls = this._ls || {})[type] = fn; },
    removeEventListener(type) { if (this._ls) delete this._ls[type]; },
    fire(type, e) { if (this._ls && this._ls[type]) this._ls[type].call(this, e || {}); }
  };
  return el;
}

// ---------------- 假设置面板（tabs / sections / 字段） ----------------
const PANE_FIELDS = [
  "bs-base-url", "bs-model", "bs-api-key", "bs-temperature", "bs-timeout",
  "bs-target-lang", "bs-batch", "bs-max-chars", "bs-retries", "bs-glossary",
  "bs-resume", "bs-output-dir", "bs-attach", "bs-open-after", "bs-keep-source",
  "bs-keep-cache", "bs-keep-blocks", "bs-converter-dir", "bs-python",
  "bs-status", "bs-save-status", "bs-test-btn"
];

function makePaneDoc(values) {
  values = values || {};
  const els = new Map();
  const tabs = ["api", "translation", "files", "advanced"].map(key => {
    const t = makeEl("button");
    t.setAttribute("data-bs-tab", key);
    t.setAttribute("aria-selected", key === "api" ? "true" : "false");
    return t;
  });
  const sections = ["api", "translation", "files", "advanced"].map(key => {
    const s = makeEl("div");
    s.setAttribute("data-bs-section", key);
    if (key !== "api") s.setAttribute("hidden", "hidden");
    return s;
  });
  const doc = {
    documentElement: makeEl("vbox"),
    getElementById(id) {
      if (id === "bs-prefpane") return {};
      if (!els.has(id)) {
        const el = makeEl("input");
        el.type = /glossary|resume|attach|open-after|keep-/.test(id) ? "checkbox" : "text";
        el.value = values[id] !== undefined ? String(values[id]) : "";
        el.checked = !!values[id];
        el.textContent = "";
        els.set(id, el);
      }
      return els.get(id);
    },
    querySelectorAll(sel) {
      if (sel === "[data-bs-tab]") return tabs;
      if (sel === "[data-bs-section]") return sections;
      return [];
    },
    _tabs: tabs,
    _sections: sections,
    clickTab(key) {
      const t = tabs.find(x => x.getAttribute("data-bs-tab") === key);
      t.fire("click", { target: { ownerDocument: doc } });
    },
    sectionHidden(key) {
      const s = sections.find(x => x.getAttribute("data-bs-section") === key);
      return s.getAttribute("hidden") !== null;
    },
    tabSelected(key) {
      const t = tabs.find(x => x.getAttribute("data-bs-tab") === key);
      return t.getAttribute("aria-selected");
    },
    setValue(id, v, type) {
      const el = this.getElementById(id);
      if (type === "checkbox") el.checked = !!v;
      else el.value = String(v);
    }
  };
  PANE_FIELDS.forEach(id => doc.getElementById(id));
  return doc;
}

// ---------------- 假菜单文档 ----------------
function makeMenuDoc() {
  const popups = {
    "zotero-itemmenu": makeEl("menupopup"),
    "menu_ToolsPopup": makeEl("menupopup")
  };
  const all = () => Object.values(popups)
    .reduce((acc, p) => acc.concat(p.children), []);
  const doc = {
    documentElement: makeEl("window"),
    createXULElement(tag) { return makeEl(tag); },
    createElementNS(ns, tag) { return makeEl(tag); },
    getElementById(id) { return popups[id] || null; },
    querySelectorAll(sel) {
      if (sel.indexOf("data-mktero-bilingual") >= 0) return all();
      return [];
    },
    count() { return all().length; },
    popupCount(id) { return popups[id].children.length; },
    firePopup(id) { popups[id].fire("popupshowing", {}); },
    itemMenuVisible() {
      return popups["zotero-itemmenu"].children.every(mi => !mi.hidden);
    }
  };
  return doc;
}

// ================= 用例 =================
(async () => {
  console.log("沙箱全局检查");
  ok(!("Cc" in sandbox), "沙箱里没有 Cc（与 Zotero 一致）");
  ok(!("Ci" in sandbox), "沙箱里没有 Ci（与 Zotero 一致）");

  const MB = sandbox.Zotero.MkteroBilingual;

  console.log("\nURL 拼装");
  eq(sandbox.chatCompletionsUrl("https://a.com/llm-gw/v1"), "https://a.com/llm-gw/v1/chat/completions", "…/v1 补 /chat/completions");
  eq(sandbox.chatCompletionsUrl("https://a.com/llm-gw/v1/"), "https://a.com/llm-gw/v1/chat/completions", "末尾斜杠被吃掉");
  eq(sandbox.chatCompletionsUrl("https://a.com/v1/chat/completions"), "https://a.com/v1/chat/completions", "已是完整端点不重复拼");
  eq(sandbox.chatCompletionsUrl("https://a.com"), "https://a.com/v1/chat/completions", "裸域名补 /v1");
  eq(sandbox.chatCompletionsUrl("https://a.com/openai"), "https://a.com/openai/chat/completions", "用户写了路径就尊重，不塞 /v1");
  eq(sandbox.chatCompletionsUrl("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/chat/completions", "/v4 这类版本号也认");

  console.log("\nBase URL 校验（对齐 Mktero 的 normalizeAIBaseURL）");
  ok(sandbox.validateApiBase("https://a.com/v1").ok, "合法 https 通过");
  ok(!sandbox.validateApiBase("http://a.com/v1").ok, "非 loopback 的 http 被拒");
  ok(sandbox.validateApiBase("http://localhost:11434/v1").ok, "localhost http 放行（本地模型）");
  ok(!sandbox.validateApiBase("https://a.com/v1?x=1").ok, "带 query 被拒");
  ok(!sandbox.validateApiBase("https://u:p@a.com/v1").ok, "带账号密码被拒");
  ok(!sandbox.validateApiBase("a.com/v1").ok, "缺协议被拒");

  console.log("\narXiv 版本自动检索：标题相似度");
  eq(sandbox.titleScore("Attention Is All You Need", "attention is all you need"),
     1, "同标题（仅大小写不同）得满分");
  ok(sandbox.titleScore("Attention Is All You Need", "Attention Is Not All You Need") < 0.85,
     "少一个词就明显掉分");
  eq(sandbox.titleScore("", "abc"), 0, "空标题得 0");
  ok(sandbox.titleScore("Deep Residual Learning for Image Recognition", "Deep Residual Learning")
     > 0.35, "子集标题仍有可用分数");

  console.log("\narXiv 版本自动检索：ID 提取不误伤外文库");
  const itemIEEE = makeItemStub({
    title: "Pattern Recognition", DOI: "10.1016/j.patcog.2019.1070", extra: ""
  });
  eq(sandbox.extractArxivId(itemIEEE), "",
     "IEEE DOI 里的 2019.1070 不会被当成 arXiv ID");
  eq(sandbox.extractArxivId(makeItemStub({ extra: "arXiv: 2201.12345" })), "2201.12345",
     "Extra 里的 arXiv: 编号能认出来");
  eq(sandbox.extractArxivId(makeItemStub({ DOI: "10.48550/arXiv.1706.03762" })), "1706.03762",
     "arXiv 自有 DOI 能认出来");
  eq(sandbox.extractArxivId(makeItemStub({ extra: "2201.12345" })), "2201.12345",
     "Extra 里只有裸编号也仍然认");

  console.log("\narXiv 版本自动检索：Atom 解析");
  const feed = atomFeed([
    { id: "2201.11111", title: "Attention Is All You Need",
      author: "Ashish Vaswani", published: "2017-06-12T00:00:00Z",
      summary: "The dominant sequence transduction models..." },
    { id: "2201.22222", title: "A Completely Different Paper",
      author: "Someone Else", published: "2020-01-01T00:00:00Z", summary: "nope" }
  ]);
  const parsed = sandbox.parseArxivAtom(feed);
  eq(parsed.length, 2, "两条候选都解析出来");
  eq(parsed[0].id, "2201.11111", "从 id 里抽出 arXiv 编号");
  eq(parsed[0].title, "Attention Is All You Need", "标题解析正确");
  eq(parsed[0].authors[0], "Ashish Vaswani", "作者解析正确");
  eq(parsed[0].published.slice(0, 4), "2017", "发布时间解析正确");
  eq(sandbox.parseArxivAtom("<broken").length, 0, "坏 XML 不会抛异常，返回空列表");

  // 真实响应：export.arxiv.org 抓的，带 arxiv: 命名空间前缀和 opensearch 元数据
  const realXml = fs.readFileSync(
    path.join(__dirname, "fixtures", "arxiv_attention.xml"), "utf8");
  const real = sandbox.parseArxivAtom(realXml);
  eq(real.length, 3, "真实响应解析出 3 条");
  eq(real[0].id, "1706.03762", "从带版本号的 id 里抽出编号（1706.03762v7 → 1706.03762）");
  eq(real[0].title, "Attention Is All You Need", "真实标题");
  ok(real[0].authors.length >= 5, "作者全解析出来", String(real[0].authors.length));
  ok(real[0].published.slice(0, 4) === "2017", "发布时间", real[0].published);
  ok(real[0].comment.length > 0, "带前缀的 arxiv:comment 也读得到", real[0].comment.slice(0, 40));

  console.log("\narXiv 版本自动检索：候选排序");
  const target = makeItemStub({
    title: "Attention Is All You Need", date: "2017",
    abstractNote: "sequence transduction"
  }, ["Vaswani", "Shazeer"]);
  const scored = parsed.map(c => ({ cand: c, score: sandbox.scoreCandidate(target, c) }))
    .sort((a, b) => b.score - a.score);
  eq(scored[0].cand.id, "2201.11111", "标题+作者都对的那条排第一");

  console.log("\narXiv 版本自动检索：高置信度直接命中（不打扰模型）");
  httpHandler = (url) => ({ status: 200, text: url.indexOf("export.arxiv.org") >= 0 ? atomFeed([
    { id: "1706.03762", title: "Attention Is All You Need", author: "Ashish Vaswani",
      published: "2017-06-12T00:00:00Z" }
  ]) : "{}" });
  let hit = await sandbox.resolveArxivVersion(null, target, cfgStub());
  eq(hit && hit.id, "1706.03762", "自动匹配到 arXiv 编号");
  ok(/自动匹配/.test(hit.how || ""), "说明是算法匹配的", hit.how);
  ok(lastRequest.url.indexOf("export.arxiv.org") >= 0, "确实查了 arXiv API");

  console.log("\narXiv 版本自动检索：不确定时交给大模型复核");
  const ambiguous = atomFeed([
    { id: "2101.00001", title: "Attention Is All You Need", author: "Anonymous",
      published: "2015-01-01T00:00:00Z" },
    { id: "2101.00002", title: "Attention Is All You Need Revisited", author: "Anonymous",
      published: "2021-01-01T00:00:00Z" }
  ]);
  httpHandler = (url, opts) => {
    if (url.indexOf("export.arxiv.org") >= 0) return { status: 200, text: ambiguous };
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "2" } }] }) };
  };
  hit = await sandbox.resolveArxivVersion(null, target, cfgStub());
  eq(hit && hit.id, "2101.00002", "采用大模型选的第 2 条");
  ok(/大模型/.test(hit.how || ""), "说明是大模型复核的", hit.how);

  console.log("\narXiv 版本自动检索：模型说都不是");
  httpHandler = (url) => {
    if (url.indexOf("export.arxiv.org") >= 0) return { status: 200, text: ambiguous };
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "0" } }] }) };
  };
  hit = await sandbox.resolveArxivVersion(null, target, cfgStub());
  eq(hit, null, "模型判定都不匹配时返回 null，不硬塞一个");

  console.log("\narXiv 版本自动检索：查询语法与放宽策略");
  const qs = sandbox.arxivQueries('BERT: Pre-training of Deep (Bidirectional) Transformers?');
  eq(qs.length, 2, "生成标题/全文两条查询");
  const inner = qs[0].replace(/^ti:"|"$/g, "");
  ok(!/[():?]/.test(inner), "短语内不再有括号冒号问号，不会打断 arXiv 语法", inner);
  eq(sandbox.arxivQueries("   ").length, 0, "空标题不产生查询");

  console.log("\narXiv 版本自动检索：标题检索落空时放宽到全文");
  const seenUrls = [];
  httpHandler = (url) => {
    const u = decodeURIComponent(url);
    seenUrls.push(u);
    if (u.indexOf("search_query=ti:") >= 0) {
      return { status: 200, text: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' };
    }
    return { status: 200, text: atomFeed([
      { id: "1706.03762", title: "Attention Is All You Need", author: "Ashish Vaswani",
        published: "2017-06-12T00:00:00Z" }
    ]) };
  };
  hit = await sandbox.resolveArxivVersion(null, target, cfgStub());
  eq(hit && hit.id, "1706.03762", "退到全文检索后命中");
  ok(seenUrls.some((u) => u.indexOf("search_query=all:") >= 0), "确实用了 all: 查询");

  console.log("\narXiv 版本自动检索：检索失败要说人话");
  httpHandler = () => new Error("NetworkError when attempting to fetch resource.");
  let errMsg = "";
  try { await sandbox.resolveArxivVersion(null, target, cfgStub()); }
  catch (e) { errMsg = String(e.message || e); }
  ok(/检索 arXiv 失败/.test(errMsg), "指出是检索失败", errMsg);
  ok(/Extra/.test(errMsg), "并告诉用户可以手填 Extra 绕过", errMsg);

  console.log("\n代理设置");
  prefs.delete("extensions.mkterobilang.proxy");
  eq(sandbox.proxyUrl(), "", "默认不套用系统代理（实测系统代理会让网关连不上）");
  prefs.set("extensions.mkterobilang.proxy", "http://127.0.0.1:7897");
  eq(sandbox.proxyUrl(), "http://127.0.0.1:7897", "手填的代理会传给转换器");

  console.log("\n配置读写（兼容旧扁平格式）");
  // PathUtils 上没有 homeDir 时，必须还能靠 dirsvc 拿到家目录，
  // 否则用户看到的是「保存失败：找不到用户主目录」（0.5.3 的真实 bug）
  eq(sandbox.resolveHomeDir(), HOME_DIR, "PathUtils 无 homeDir 时回退到 dirsvc");
  const cfg = sandbox.MkteroConfig;
  eq(cfg.path(), path.join(HOME_DIR, ".mktero_llm_config.json"),
     "配置文件落在用户主目录");
  const cfgPath = path.join(HOME_DIR, ".mktero_llm_config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    base_url: "https://myai.example.com/llm-gw/v1/",
    model: "deepseek-v4-flash",
    api_key: "sk-test-1234567890abcdef"
  }, null, 2), "utf8");
  const read1 = cfg.read();
  eq(read1.api.base_url, "https://myai.example.com/llm-gw/v1/", "旧字段提升到 api.base_url");
  eq(read1.api.model, "deepseek-v4-flash", "旧字段提升到 api.model");
  eq(read1.translation.batch, 8, "缺失段用默认值补齐");
  ok(cfg.write(read1) && JSON.parse(fs.readFileSync(cfgPath, "utf8")).api, "写回后同时保留四段结构");
  await new Promise(r => setTimeout(r, 50));   // setPermissions 是异步的
  eq(fs.statSync(cfgPath).mode & 0o777, 0o600, "配置文件权限收紧到 600");

  console.log("\n测试连接：成功");
  const doc1 = makeDoc({
    "bs-base-url": "https://myai.example.com/llm-gw/v1/",
    "bs-model": "deepseek-v4-flash",
    "bs-api-key": "sk-test-1234567890abcdef",
    "bs-temperature": 0.2, "bs-timeout": 120,
    "bs-target-lang": "zh-CN", "bs-batch": 8, "bs-max-chars": 2600, "bs-retries": 3,
    "bs-glossary": true, "bs-resume": true, "bs-attach": true, "bs-open-after": true
  });
  httpHandler = () => ({
    status: 200,
    text: JSON.stringify({ choices: [{ message: { content: "pong" } }] })
  });
  MB.testLLM(ev(doc1));
  await new Promise(r => setTimeout(r, 50));
  eq(lastRequest.url, "https://myai.example.com/llm-gw/v1/chat/completions", "请求打到正确的端点");
  eq(lastRequest.options.headers.Authorization, "Bearer sk-test-1234567890abcdef", "带上 Bearer 头");
  ok(/连接成功/.test(statusOf(doc1)), "状态显示连接成功", statusOf(doc1));

  console.log("\n测试连接：401");
  const doc2 = makeDoc({ "bs-base-url": "https://a.com/v1", "bs-model": "m", "bs-api-key": "bad" });
  httpHandler = () => ({ status: 401, text: '{"error":{"message":"invalid api key"}}' });
  MB.testLLM(ev(doc2));
  await new Promise(r => setTimeout(r, 50));
  ok(/HTTP 401/.test(statusOf(doc2)), "状态里出现 HTTP 401", statusOf(doc2));
  ok(/密钥无效/.test(statusOf(doc2)), "并给出密钥无效的提示", statusOf(doc2));
  ok(!/HTTP 401/.test(footStatusOf(doc2)), "同一条错误不会在底部再显示一遍",
     footStatusOf(doc2));

  console.log("\n测试连接：网络不可达");
  const doc3 = makeDoc({ "bs-base-url": "https://a.com/v1", "bs-model": "m" });
  httpHandler = () => new Error("NetworkError when attempting to fetch resource.");
  MB.testLLM(ev(doc3));
  await new Promise(r => setTimeout(r, 50));
  ok(/请求失败/.test(statusOf(doc3)), "状态显示请求失败而不是「测试失败」", statusOf(doc3));
  ok(/网络不可达/.test(statusOf(doc3)), "并说明是网络问题", statusOf(doc3));

  console.log("\n测试连接：字段没填");
  const doc4 = makeDoc({ "bs-base-url": "", "bs-model": "" });
  MB.testLLM(ev(doc4));
  ok(/Base URL/.test(statusOf(doc4)), "空 URL 直接提示", statusOf(doc4));

  console.log("\n测试连接：2xx 但不是 JSON（被网关登录页接走）");
  const doc5 = makeDoc({ "bs-base-url": "https://a.com/v1", "bs-model": "m", "bs-api-key": "k" });
  httpHandler = () => ({ status: 200, text: "<html><body>login</body></html>" });
  MB.testLLM(ev(doc5));
  await new Promise(r => setTimeout(r, 50));
  ok(/不是合法 JSON/.test(statusOf(doc5)), "明确指出不是 JSON", statusOf(doc5));

  console.log("\n测试连接：本地服务免 key");
  fs.writeFileSync(cfgPath, "{}", "utf8");     // 先清掉已保存的密钥
  const doc6 = makeDoc({ "bs-base-url": "http://localhost:11434/v1", "bs-model": "llama3" });
  httpHandler = () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) });
  MB.testLLM(ev(doc6));
  await new Promise(r => setTimeout(r, 50));
  ok(/连接成功/.test(statusOf(doc6)), "loopback 无 key 也能测通", statusOf(doc6));
  ok(!("Authorization" in lastRequest.options.headers), "没有凭空造 Authorization 头");

  console.log("\n测试连接：远程缺 key 要拦住");
  fs.writeFileSync(cfgPath, "{}", "utf8");
  const doc7 = makeDoc({ "bs-base-url": "https://a.com/v1", "bs-model": "m" });
  MB.testLLM(ev(doc7));
  ok(/API Key/.test(statusOf(doc7)), "远程地址缺 key 直接提示", statusOf(doc7));

  console.log("\n测试连接：连点防护");
  const doc8 = makeDoc({ "bs-base-url": "https://a.com/v1", "bs-model": "m", "bs-api-key": "k" });
  httpHandler = () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) });
  MB.testLLM(ev(doc8));
  const btn = doc8.getElementById("bs-test-btn");
  ok(btn.disabled === true, "请求期间按钮被禁用");
  MB.testLLM(ev(doc8));           // 第二次应立即返回
  await new Promise(r => setTimeout(r, 50));
  ok(btn.disabled === false, "结束后按钮恢复");

  console.log("\nLaTeX 清洗：标题作者不进正文 / bbl 参考文献");
  const { spawnSync } = require("child_process");
  const probe = spawnSync(process.env.MB_PY || "python3",
    [path.join(__dirname, "fixtures", "latex_probe.py")], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) {
    const r = JSON.parse(probe.stdout.trim());
    eq(r.clean, true, "\\title / \\author / \\bibliography 不残留到正文");
    eq(r.has_section, true, "章节命令保留");
    eq(r.has_body, true, "正文内容保留");
    eq(r.bbl_order.length, 2, "bbl 解析出 2 条文献");
    ok(/Pokhrel/.test(r.bbl_first) && /2022/.test(r.bbl_first),
       "文献条目有作者与年份，不再是 bibtex key", r.bbl_first);
    ok(!/\\emph|\\bibitem/.test(r.bbl_first), "LaTeX 命令已清掉");
    eq(/<sup>2<\/sup>/.test(r.sup), true, "$I^2$ 编译成上标", r.sup);
    eq(/<sub>\u221e<\/sub>/.test(r.sub), true, "H_\\infty 编译成下标", r.sub);
    eq(/<sup>2<\/sup>/.test(r.textsup), true, "\\textsuperscript 编译成上标", r.textsup);
    eq(JSON.stringify(r.ieee_l1), JSON.stringify(["I.", "II.", "IV."]),
       "IEEE 一级标题用罗马数字", JSON.stringify(r.ieee_l1));
    eq(JSON.stringify(r.ieee_l2), JSON.stringify(["A.", "B."]),
       "IEEE 二级标题用字母", JSON.stringify(r.ieee_l2));
    eq(JSON.stringify(r.ieee_l3), JSON.stringify(["1)", "2)"]),
       "IEEE 三级标题用数字右括号", JSON.stringify(r.ieee_l3));
    eq(r.ratio_full, 1, "只写 scale 时按整版心");
    ok(r.ratio_half < 0.6, "width=0.48\\linewidth 识别为并排子图",
       String(r.ratio_half));
    eq(r.refs["fig:one"], "图 1", "figure 内的 label 归属图 1", JSON.stringify(r.refs));
    eq(r.refs["fig:two"], "图 2", "第二个 figure 归属图 2");
    ok(!/\d+\.\d+\.\d+/.test(JSON.stringify(r.refs)),
       "不再拼出 4.7.6 这种假编号", JSON.stringify(r.refs));
    eq(r.css_override, true, "公式容器压紧样式存在");
    eq(r.secnum_inline, true, "章节序号与标题同行");
    eq(r.img_full, true, "图片统一占满版心");
  } else {
    ok(false, "python 探针可运行", String(probe.stderr || "").slice(0, 200));
  }

  console.log("\n设置面板与进度提示");
  const innerDoc = { getElementById: (id) => id === "bs-prefpane" ? { id } : null };
  const outerDoc = {
    getElementById: () => null,
    querySelectorAll: () => [{ contentDocument: innerDoc }]
  };
  eq(sandbox.findPaneDoc(outerDoc), innerDoc, "pane 在 iframe/browser 里也能定位到");
  eq(sandbox.findPaneDoc({ getElementById: () => null, querySelectorAll: () => [] }),
     null, "找不到 pane 时返回 null 而不是崩");
  const busyDoc = makeMenuDoc();
  sandbox.addMenus({ document: busyDoc });
  sandbox.setBusy("翻译中 3/79 块");
  const menuEls = () => busyDoc.querySelectorAll("[data-mktero-bilingual]");
  ok(menuEls().some((el) => /翻译中/.test(el.getAttribute("label") || "")),
     "运行时菜单项显示当前阶段");
  sandbox.setBusy(null);
  ok(menuEls().every((el) => !/⏳|翻译中/.test(el.getAttribute("label") || "")),
     "结束后菜单标签恢复");

  console.log("\njar 安装态：转换器解压");
  const mb = sandbox.MkteroBilingual;
  mb.rootURI = "jar:file:///tmp/fake-plugin.xpi!/";
  mb.version = "0.5.2";
  mb.converterDir = null;
  prefs.delete("extensions.mkterobilang.converterDir");
  const dir = await sandbox.ensureConverterDir();
  ok(!!dir, "解析出转换器目录", String(dir));
  ok(dir.indexOf(PROFILE) === 0, "解压到 profile 下，不是 jar 里", String(dir));
  for (const f of sandbox.CONVERTER_FILES) {
    ok(fs.existsSync(path.join(dir, f)), "解压出 " + f);
  }
  const vendorSize = fs.existsSync(path.join(dir, "vendor/tex-svg.js"))
    ? fs.statSync(path.join(dir, "vendor/tex-svg.js")).size : 0;
  ok(vendorSize > 1000000, "大文件 tex-svg.js 完整写盘", String(vendorSize));
  // 模拟「整块读不出来、只有分片」的场景
  fs.rmSync(path.join(dir, "vendor", "tex-svg.js"), { force: true });
  mb.converterDir = null;
  const dirFromParts = await sandbox.ensureConverterDir();
  const joined = path.join(dirFromParts, "vendor", "tex-svg.js");
  ok(fs.existsSync(joined) && fs.statSync(joined).size > 1000000,
     "分片能拼回完整的 MathJax", String(fs.existsSync(joined) ? fs.statSync(joined).size : 0));

  console.log("\n开发态：直接用源码目录");
  mb.rootURI = "file://" + ADDON + "/";
  mb.converterDir = null;
  const dir2 = await sandbox.ensureConverterDir();
  eq(dir2, path.join(ADDON, "converter"), "file:// 时直接指向 addon/converter");

  console.log("\n转换器目录：启动时序竞争（0.6.0 的真实报错）");
  mb.rootURI = "jar:file:///tmp/fake-plugin.xpi!/";
  mb.version = "0.6.0";
  mb.converterDir = null;
  prefs.delete("extensions.mkterobilang.converterDir");
  eq(sandbox.builtinConverterDir(), "", "解压完成前解析不出目录");
  eq(mb.converterDir, null, "空结果不写进缓存（否则以后一直报找不到转换器）");
  const onDemand = await sandbox.requireConverterDir();
  ok(!!onDemand && fs.existsSync(path.join(onDemand, "arxiv_to_zotero.py")),
     "真正要用的时候现场解压一次", String(onDemand));
  eq(await sandbox.requireConverterDir(), onDemand, "再取一次结果稳定（幂等）");

  console.log("\n菜单：startup 未就绪时不要挂");
  mb.started = false;
  const early = makeMenuDoc();
  sandbox.onMainWindowLoad({ window: { document: early } });
  eq(early.count(), 0, "startup 还没就绪时 onMainWindowLoad 不注菜单");
  mb.started = true;
  sandbox.onMainWindowLoad({ window: { document: early } });
  ok(early.count() > 0, "就绪后新窗口能正常注入", String(early.count()));

  console.log("\n进程调用（Subprocess 签名）");
  const r1 = await sandbox.runProcess("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 3"]);
  eq(r1.code, 3, "拿到真实退出码（wait() 返回 {exitCode}）");
  eq(r1.stdout.trim(), "out", "拿到 stdout");
  eq(r1.stderr.trim(), "err", "拿到 stderr");

  console.log("\n脚本失败时把 stderr 带进错误信息");
  let msg = "";
  try {
    await sandbox.runScript(["/bin/sh", "-c", "echo boom 1>&2; exit 2"]);
  } catch (e) { msg = e.message; }
  ok(/退出码 2/.test(msg), "错误里带退出码", msg);
  ok(/boom/.test(msg), "错误里带脚本 stderr", msg);

  console.log("\n目录扫描（IOUtils 版）");
  const scan = path.join(TMP, "scan");
  fs.mkdirSync(scan, { recursive: true });
  fs.writeFileSync(path.join(scan, "a.md"), "# a");
  fs.writeFileSync(path.join(scan, "old.html"), "<html>old</html>");
  fs.writeFileSync(path.join(scan, "new.html"), "<html>new</html>");
  fs.writeFileSync(path.join(scan, "x.stage.html"), "<html>skip</html>");
  fs.writeFileSync(path.join(scan, "_formula_1.html"), "<html>skip</html>");
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(scan, "old.html"), past, past);
  eq(await sandbox.firstMarkdown(scan), path.join(scan, "a.md"), "找到第一个 .md");
  eq(await sandbox.findHtml(scan), path.join(scan, "new.html"), "跳过 stage/formula 后取最新的 html");


  // ================= 设置面板 =================
  console.log("\n设置面板：把配置填进表单");
  const CONF = {
    api: { base_url: "https://gw.example.com/v1", model: "m1",
           api_key: "sk-secret-should-not-echo", temperature: 0.3, timeout: 90 },
    translation: { target_lang: "zh-TW", batch: 4, max_chars: 1800,
                   glossary: false, retries: 5, resume: true },
    files: { output_dir: "/tmp/out", keep_source: true, keep_cache: true,
             keep_blocks: true, attach: false, open_after: false },
    advanced: { converter_dir: "/tmp/conv", python: "/usr/bin/python3" }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(CONF, null, 1), "utf8");

  const pane = makePaneDoc();
  MB.attachDoc(pane);
  eq(pane.getElementById("bs-base-url").value, "https://gw.example.com/v1", "Base URL 回填");
  eq(pane.getElementById("bs-model").value, "m1", "模型回填");
  eq(pane.getElementById("bs-api-key").value, "", "密钥不回显");
  eq(pane.getElementById("bs-temperature").value, "0.3", "温度回填");
  eq(pane.getElementById("bs-target-lang").value, "zh-TW", "目标语言回填");
  eq(pane.getElementById("bs-batch").value, "4", "批大小回填");
  eq(pane.getElementById("bs-glossary").checked, false, "复选框回填 false");
  eq(pane.getElementById("bs-attach").checked, false, "自动挂附件回填 false");
  eq(pane.getElementById("bs-converter-dir").value, "/tmp/conv", "转换器目录回填");
  ok(pane.documentElement.getAttribute("data-bs-bound") === "1", "标记已绑定，避免重复监听");

  console.log("\n设置面板：标签页切换");
  pane.clickTab("translation");
  eq(pane.sectionHidden("api"), true, "API 页隐藏");
  eq(pane.sectionHidden("translation"), false, "翻译页显示");
  eq(pane.tabSelected("translation"), "true", "标签选中态同步");
  eq(pane.tabSelected("api"), "false", "其他标签取消选中");
  pane.clickTab("files");
  eq(pane.sectionHidden("files"), false, "文件页显示");
  eq(pane.sectionHidden("translation"), true, "翻译页隐藏");

  console.log("\n设置面板：保存");
  pane.setValue("bs-model", "m2");
  pane.setValue("bs-temperature", "9");        // 越界，应钳到 2
  pane.setValue("bs-batch", "100");            // 越界，应钳到 30
  pane.setValue("bs-api-key", "");             // 留空＝不改密钥
  pane.setValue("bs-attach", true, "checkbox");
  pane.setValue("bs-open-after", true, "checkbox");
  ok(MB.savePrefs(ev(pane)) === true, "savePrefs 返回 true");
  const saved = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  eq(saved.api.model, "m2", "模型已保存");
  eq(saved.api.api_key, "sk-secret-should-not-echo", "留空时保留旧密钥");
  eq(saved.api.temperature, 2, "温度越界被钳制");
  eq(saved.translation.batch, 30, "批大小越界被钳制");
  eq(saved.files.attach, true, "复选框改动已保存");
  eq(saved.translation.target_lang, "zh-TW", "没动的字段保持不变");
  ok(/已保存/.test(footStatusOf(pane)), "状态提示已保存", footStatusOf(pane));
  eq(pane.getElementById("bs-api-key").value, "", "保存后清空密钥输入框");

  console.log("\n设置面板：换密钥");
  pane.setValue("bs-api-key", "sk-new-key-123456");
  MB.savePrefs(ev(pane));
  eq(JSON.parse(fs.readFileSync(cfgPath, "utf8")).api.api_key, "sk-new-key-123456",
     "填了就覆盖旧密钥");

  console.log("\n设置面板：恢复默认（保留密钥）");
  MB.resetPrefs(ev(pane));
  eq(pane.getElementById("bs-model").value, "", "模型恢复默认");
  eq(pane.getElementById("bs-batch").value, "8", "批大小恢复默认");
  const afterReset = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  eq(afterReset.api.api_key, "sk-new-key-123456", "密钥不被重置");

  // ================= 菜单 =================
  console.log("\n菜单注入与清理");
  const mdoc = makeMenuDoc();
  const mwin = { document: mdoc, setTimeout: setTimeout };
  sandbox.addMenus(mwin);
  eq(mdoc.count(), 11, "共注入 11 个菜单项");
  eq(mdoc.popupCount("zotero-itemmenu"), 5, "右键菜单 5 项（4 个入口 + 设置）");
  eq(mdoc.popupCount("menu_ToolsPopup"), 6, "工具菜单 6 项（4 个入口 + 设置 + 自检）");
  // 再注入一次：不应出现重复
  sandbox.addMenus(mwin);
  eq(mdoc.count(), 11, "重复注入不会翻倍（先清理旧节点）");
  // 选中状态联动
  mockSelected = [{ isRegularItem: () => true }];
  mdoc.firePopup("zotero-itemmenu");
  ok(mdoc.itemMenuVisible(), "选中常规条目时右键项可见");
  mockSelected = [];
  mdoc.firePopup("zotero-itemmenu");
  ok(!mdoc.itemMenuVisible(), "没选中条目时右键项隐藏");
  mockSelected = [];
  sandbox.removeMenusForWindow(mwin);
  eq(mdoc.count(), 0, "卸载后菜单清干净");

  // ================= 端到端：文件夹入口 =================
  console.log("\n端到端：文件夹入口（真实 python 转换器）");
  const proj = path.join(TMP, "proj");
  fs.mkdirSync(path.join(proj, "assets"), { recursive: true });
  fs.writeFileSync(path.join(proj, "assets", "fig1.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(path.join(proj, "paper.md"),
    "# A Test Paper\n\n# 测试论文\n\n## Method\n\n## 方法\n\nWe use $x^2$ here.\n\n我们在这里用 $x^2$。\n", "utf8");

  sandbox.MkteroBilingual.rootURI = "file://" + ADDON + "/";
  sandbox.MkteroBilingual.converterDir = null;
  prefs.delete("extensions.mkterobilang.converterDir");
  const convDir = await sandbox.ensureConverterDir();
  eq(convDir, path.join(ADDON, "converter"), "开发态直接用源码转换器");

  const zwin = { document: makeMenuDoc(), setTimeout: setTimeout };
  const fakeItem = {
    id: 42,
    isRegularItem: () => true,
    getField: () => "A: Test / Paper",
    getAttachments: () => []
  };
  mockSelected = [fakeItem];

  // 第一次：不挂附件、不打开、保留中间产物
  fs.writeFileSync(cfgPath, JSON.stringify({
    api: { base_url: "https://gw.example.com/v1", model: "m", api_key: "k" },
    files: { attach: false, open_after: false, keep_blocks: true }
  }), "utf8");
  mockImported.length = 0; mockViewed.length = 0; mockAlerts.length = 0;
  nextPickPath = proj;
  await sandbox.run(zwin, "folder");
  const htmlName = sandbox.paperName("A: Test / Paper");
  const htmlPath = path.join(proj, htmlName + ".html");
  ok(fs.existsSync(htmlPath), "生成 HTML（文件名已净化）", htmlName);
  eq(mockImported.length, 0, "attach=false 时不挂附件");
  eq(mockViewed.length, 0, "open_after=false 时不打开阅读器");
  ok(fs.existsSync(path.join(proj, "_mktero_result.txt")), "keep_blocks=true 保留中间产物");
  ok(mockAlerts.join(" ").indexOf("按设置未自动挂到 Zotero") >= 0, "提示里说明未挂附件");
  const html1 = fs.readFileSync(htmlPath, "utf8");
  ok(html1.indexOf('class="pair') > 0, "确实生成了双语对照");
  ok(html1.indexOf("&lt;a ") < 0, "没有标签二次转义");
  ok(html1.indexOf('class="doc-title-zh"') > 0, "有中文标题");

  // 第二次：挂附件 + 自动打开 + 不保留中间产物
  fs.writeFileSync(cfgPath, JSON.stringify({
    api: { base_url: "https://gw.example.com/v1", model: "m", api_key: "k" },
    files: { attach: true, open_after: true, keep_blocks: false }
  }), "utf8");
  mockImported.length = 0; mockViewed.length = 0; mockAlerts.length = 0;
  nextPickPath = proj;
  await sandbox.run(zwin, "folder");
  eq(mockImported.length, 1, "attach=true 时挂一个附件");
  eq(mockImported[0].title, htmlName, "附件标题＝论文名");
  eq(mockImported[0].contentType, "text/html", "附件类型 text/html");
  ok(mockTags.indexOf("双语") >= 0, "打上「双语」标签");
  eq(mockViewed.length, 1, "open_after=true 时打开阅读器");
  ok(!fs.existsSync(path.join(proj, "_mktero_result.txt")), "keep_blocks=false 清掉中间产物");
  ok(fs.existsSync(htmlPath), "HTML 本身保留");

  console.log("\n端到端：md 单文件入口");
  mockImported.length = 0; mockViewed.length = 0;
  nextPickPath = path.join(proj, "paper.md");
  fs.writeFileSync(cfgPath, JSON.stringify({
    api: { base_url: "https://gw.example.com/v1", model: "m", api_key: "k" },
    files: { attach: true, open_after: false, keep_blocks: true }
  }), "utf8");
  await sandbox.run(zwin, "file");
  eq(mockImported.length, 1, "选 md 文件也能挂附件");
  eq(mockViewed.length, 0, "open_after=false 不打开");
  ok(fs.existsSync(path.join(proj, "_mktero_result.txt")), "保留中间产物");

  console.log("\n端到端：没有选中条目时给出提示而不是崩");
  mockSelected = [];
  mockAlerts.length = 0;
  await sandbox.run(zwin, "file");
  ok(mockAlerts.join(" ").indexOf("请先在文献列表中选中") >= 0, "提示先选条目");

  // MB_LIVE=1：额外跑一次真实 arXiv 检索，验证查询语法与真实响应格式。
  // 需要能访问 export.arxiv.org（走了代理的话继承 HTTPS_PROXY）。
  if (process.env.MB_LIVE) {
    console.log("\n[LIVE] 真实 arXiv 检索（export.arxiv.org）");
    const { execFileSync } = require("child_process");
    httpHandler = (url) => {
      try {
        const out = execFileSync("curl",
          ["-sL", "--http1.1", "--max-time", "45", url],
          { encoding: "utf8", env: process.env, maxBuffer: 8 << 20 });
        return { status: 200, text: out };
      } catch (e) {
        return new Error("curl failed: " + e.message);
      }
    };
    const liveItem = makeItemStub(
      { title: "Attention Is All You Need", date: "2017" }, ["Vaswani"]);
    const live = await sandbox.searchArxivByTitle("Attention Is All You Need", 5);
    ok(live.ok && live.candidates.length > 0, "真实检索拿到候选",
       String(live.candidates && live.candidates.length));
    if (live.ok && live.candidates.length) {
      const ranked = live.candidates
        .map((c) => ({ c, s: sandbox.scoreCandidate(liveItem, c) }))
        .sort((a, b) => b.s - a.s);
      eq(ranked[0].c.id, "1706.03762", "真实候选里排序第一的是正确那篇");
      ok(ranked[0].s >= 0.86, "分数够高，不需要惊动大模型",
         String(Math.round(ranked[0].s * 100) / 100));
    }
  }

  console.log("\n" + (failures ? failures + " 个用例失败" : "全部通过"));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error("harness 崩了：", e);
  process.exit(1);
});
