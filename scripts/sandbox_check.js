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
  async setPermissions(p, mode) { await fsp.chmod(p, mode); }
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
    putContents(p, data) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(data), "utf8");
    },
    getContents(p) { return fs.readFileSync(p, "utf8"); },
    async getContentsAsync(p) { return fsp.readFile(p, "utf8"); },
    async putContentsAsync(p, data) { await IOUtils.writeUTF8(p, data); },
    // 模拟 jar: 读取：直接映射到源码目录
    async getResourceAsync(url) {
      const rel = url.split("!/").pop().replace(/^\//, "");
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
  getMainWindows() { return []; },
  getActiveZoteroPane() { return { getSelectedItems() { return []; } }; },
  Utilities: { Internal: { openPreferences() { return null; } } },
  PreferencePanes: { async register() { return "pane-id"; } },
  Attachments: { importFromFile: async () => ({ addTag() {}, saveTx: async () => {} }) },
  Items: { get() { return []; } },
  ProgressWindow: function () {
    this.changeHeadline = () => {};
    this.ItemProgress = function () { this.setProgress = () => {}; this.setText = () => {}; };
    this.show = () => {};
    this.startCloseTimer = () => {};
  }
};

const services = {
  prompt: {
    alert() {},
    confirm() { return true; },
    prompt() { return false; }
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

// ---------------- 组装沙箱（只给 Zotero 真给的那些） ----------------
const sandbox = {
  Zotero: zotero,
  Services: services,
  IOUtils,
  PathUtils: { homeDir: TMP, profileDir: PROFILE, join: path.join },
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
  console
};
// 刻意不提供：Cc / Ci / Components / ChromeUtils 之外的 XPCOM 入口
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(ADDON, "bootstrap.js"), "utf8");
vm.runInContext(code, sandbox, { filename: "bootstrap.js" });

function FakeFilePicker() {}
FakeFilePicker.prototype.init = function () {};
FakeFilePicker.prototype.appendFilter = function () {};
FakeFilePicker.prototype.show = async function () { return 1; };
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
function statusOf(doc) { return doc.getElementById("bs-status").textContent; }

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

  console.log("\n配置读写（兼容旧扁平格式）");
  const cfgPath = path.join(TMP, ".mktero_llm_config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    base_url: "https://myai.example.com/llm-gw/v1/",
    model: "deepseek-v4-flash",
    api_key: "sk-test-1234567890abcdef"
  }, null, 2), "utf8");
  const cfg = sandbox.MkteroConfig;
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

  console.log("\n开发态：直接用源码目录");
  mb.rootURI = "file://" + ADDON + "/";
  mb.converterDir = null;
  const dir2 = await sandbox.ensureConverterDir();
  eq(dir2, path.join(ADDON, "converter"), "file:// 时直接指向 addon/converter");

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

  console.log("\n" + (failures ? failures + " 个用例失败" : "全部通过"));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error("harness 崩了：", e);
  process.exit(1);
});
