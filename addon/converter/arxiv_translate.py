#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arxiv_translate.py — 把 arxiv_to_zotero.py 产出的结构化块翻译成中文。

读 arxiv_blocks.json 里每块的 text（公式是 ⟦F0⟧、引用是 ⟦引用⟧ 占位符），
分批送 OpenAI 兼容 LLM，产出 {block_id: 译文} 的 JSON，
再由 arxiv_to_zotero.py --translation 合成逐块双语 HTML。

设计：
  - 密钥只读 ~/.mktero_llm_config.json（权限 600），绝不写进脚本/日志/产物
  - 占位符保护：system 指令 + 译后多重集校验；丢失/改写占位符的块丢弃译文并记为失败，
    重跑（断点续传）时会自动重翻
  - 术语表：全文统一术语（Transformer/attention/encoder...），避免前后译名漂移
  - 断点续传：已翻译的块写进译文 JSON，重跑跳过；失败块单独记录
  - 每批多块，用【bNNN】标记切分，降低调用次数

用法：
  python3 arxiv_translate.py --blocks arxiv-out/arxiv_blocks.json --out arxiv-out/zh.json
  python3 arxiv_translate.py --blocks ... --out ... --batch 8 --model deepseek-v4-flash
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".mktero_llm_config.json"

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}

# 本地/内网服务常常不校验 key；与 bootstrap.js 一致地放行一个占位
LOCAL_PLACEHOLDER_KEY = "sk-local"


def chat_endpoint(base):
    """把用户填的 Base URL 归一成完整的 chat/completions 地址。

    ⚠️ 规则必须和 addon/bootstrap.js 的 chatCompletionsUrl() 完全一致，
    否则会出现「设置里测试连接成功、翻译却 404」这种最难查的错。
    """
    u = str(base or "").strip().rstrip("/")
    if not u:
        return ""
    if re.search(r"/chat/completions$", u, re.I):
        return u
    if re.search(r"/v\d+$", u, re.I):
        return u + "/chat/completions"
    path = urllib.parse.urlsplit(u).path
    if path in ("", "/"):
        return u + "/v1/chat/completions"
    return u + "/chat/completions"


def is_loopback(base):
    try:
        host = urllib.parse.urlsplit(str(base or "")).hostname or ""
    except ValueError:
        return False
    return host.lower() in LOOPBACK_HOSTS

LANG_NAMES = {
    "zh-CN": "简体中文", "zh-TW": "繁体中文",
    "en": "英文", "ja": "日文", "ko": "韩文", "de": "德文", "fr": "法文",
}

GLOSSARY_HINT = (
    "术语参考：Transformer / 注意力(attention) / 编码器(encoder) / 解码器(decoder) / "
    "自注意力(self-attention) / 词元(token) / 嵌入(embedding) 保持上述译法。"
)


def system_prompt(lang="zh-CN", glossary=True):
    target = LANG_NAMES.get(lang, lang)
    rules = [
        "你是学术论文翻译助手，把给定英文逐条翻译成%s。严格规则：" % target,
        "1. 逐条翻译，每条输出格式必须是【bNNN】译文，bNNN 与输入标记完全一致，一条一行，不要遗漏、不要合并、不要加编号列表或额外说明。",
        "2. 文本中的 ⟦F0⟧ ⟦F1⟧ ⟦cite_N⟧ ⟦ref_X⟧ 是占位符，必须原样逐字保留在译文对应位置，不得翻译、删除、改写。允许按%s语序调整位置。" % target,
        "3. 只翻译自然语言正文；不要解释，不要添加原文没有的内容。",
    ]
    if glossary:
        rules.append("4. 术语统一：Transformer=Transformer，attention=注意力，encoder=编码器，"
                     "decoder=解码器，self-attention=自注意力，layer=层，token=词元，"
                     "embedding=嵌入，softmax=softmax，dropout=dropout，"
                     "state-of-the-art=最先进，ablation=消融实验。")
    rules.append("5. 译文忠实、通顺、学术化，保留原文的语气与信息密度。")
    return "\n".join(rules)


# 默认设置（配置文件缺字段时用）
DEFAULT_SETTINGS = {
    "api": {"base_url": "", "model": "", "api_key": "",
            "temperature": 0.2, "timeout": 120},
    "translation": {"target_lang": "zh-CN", "batch": 8, "max_chars": 2600,
                     "glossary": True, "retries": 3, "resume": True},
    "files": {"output_dir": "", "keep_source": False, "keep_cache": False,
              "keep_blocks": False, "attach": True, "open_after": True},
    "advanced": {"converter_dir": "", "python": ""},
}


def deep_merge(base, override):
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_settings(config_path=""):
    """读配置：兼容旧版扁平格式与新版四段格式。返回 (settings, path)。"""
    path = Path(config_path).expanduser().resolve() if config_path else CONFIG
    raw = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
    s = deep_merge(DEFAULT_SETTINGS, raw)
    # 旧版扁平字段提升到 api 段
    if not s["api"]["base_url"] and raw.get("base_url"):
        s["api"]["base_url"] = raw["base_url"]
    if not s["api"]["model"] and raw.get("model"):
        s["api"]["model"] = raw["model"]
    if not s["api"]["api_key"] and raw.get("api_key"):
        s["api"]["api_key"] = raw["api_key"]
    return s, path

MARK_RE = re.compile(r"【(b\d+|__title__)】")
# 必须覆盖 arxiv_to_zotero 产出的全部占位符：⟦F0⟧ 公式、⟦cite_1⟧ / ⟦cite_1_2⟧ 引用、
# ⟦ref_图 2⟧ 交叉引用（另兼容早期版本的 ⟦引用⟧）。漏掉哪一类，模型丢了它都不会被发现。
PH_RE = re.compile(r"⟦(?:F\d+|cite_[0-9_?]+|ref_[^⟧]+|引用)⟧")


def load_config(cli):
    """返回 (base, model, key, settings)。CLI 参数优先于配置文件。"""
    s, cfg_path = load_settings(cli.config)
    api = s["api"]
    base = cli.base_url or api["base_url"]
    model = cli.model or api["model"]
    key = cli.api_key or api["api_key"]
    if not (base and model):
        sys.exit("缺少 base_url / model：请在设置面板配置，或用命令行参数")
    if not key:
        if is_loopback(base):
            key = LOCAL_PLACEHOLDER_KEY
        else:
            sys.exit("缺少 api_key：请在设置面板配置，或用命令行参数")
    return str(base).strip().rstrip("/"), model, key, s


def ping_llm(base, model, key, settings=None):
    """最小连通性探测：不带翻译提示词、只要几个 token。

    走 call_llm() 会把整套翻译 system prompt 发过去（几百 token、返回还是译文），
    用来判断「能不能连上」既贵又容易看错，所以单独发一条最短请求。
    """
    s = settings or DEFAULT_SETTINGS
    api = s["api"]
    timeout = int(api.get("timeout", 120)) or 120
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 8,
        "temperature": 0,
        "stream": False,
    }
    req = urllib.request.Request(
        chat_endpoint(base),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"},
    )
    with _open(req, timeout) as r:
        d = json.loads(r.read().decode("utf-8"))
    msg = d["choices"][0]["message"]
    return (msg.get("content") or msg.get("reasoning_content") or ""), d.get("usage", {})


# 网络代理。Zotero 拉起本脚本时环境里没有 HTTP(S)_PROXY，而不少机构网关
# （含 myai.bupt.edu.cn）必须过代理才握手得上，否则一律
# "EOF occurred in violation of protocol"。所以由插件探测系统代理再显式传进来。
_PROXY = ""
# 默认「不走代理」的 opener。macOS 上 urllib 会通过 _scproxy 自动读取系统代理，
# 而 Zotero 拉起的子进程没有环境变量可以覆盖这个行为——实测系统里的 Clash
# (127.0.0.1:7897) 会让 myai.bupt.edu.cn 直接 SSL_ERROR_SYSCALL，而直连正常。
# 所以这里显式决定：没配置就直连；配置了才走指定的代理。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def set_proxy(url):
    global _PROXY, _OPENER
    _PROXY = (url or "").strip()
    if _PROXY:
        handler = urllib.request.ProxyHandler({"http": _PROXY, "https": _PROXY})
        _OPENER = urllib.request.build_opener(handler)
    else:
        _OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _is_loopback(url):
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except Exception:
        return False
    return host in ("localhost", "127.0.0.1", "::1") or host.startswith("127.")


_SYS_PROXIES = None


def _system_proxies():
    """候选代理：macOS 系统代理 + 常见本地端口。只做一次 scutil。"""
    global _SYS_PROXIES
    if _SYS_PROXIES is not None:
        return _SYS_PROXIES
    out = []
    if sys.platform == "darwin":
        try:
            import subprocess
            r = subprocess.run(["/usr/sbin/scutil", "--proxy"],
                               capture_output=True, timeout=5)
            t = r.stdout.decode("utf-8", "replace")
            if re.search(r"HTTPEnable\s*:\s*1", t):
                h = (re.search(r"HTTPProxy\s*:\s*(\S+)", t) or [None, ""])[1]
                p = (re.search(r"HTTPPort\s*:\s*(\d+)", t) or [None, ""])[1]
                if h and p:
                    out.append("http://%s:%s" % (h, p))
        except Exception:
            pass
    out.extend(["http://127.0.0.1:7897", "http://127.0.0.1:7890"])
    _SYS_PROXIES = out
    return out


def _proxy_opener(url):
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": url, "https": url}))


def _open(req, timeout):
    # 本机服务一律不代理，避免「代理连不上 localhost」
    if _is_loopback(getattr(req, "full_url", "")):
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({})).open(req, timeout=timeout)
    # 直连（或指定代理）优先；连不上再依次试系统代理与常见本地端口。
    # 这样「为了 arXiv 填了代理」不会反过来把翻译接口弄挂。
    # 候选顺序：指定/默认 → 直连 → 系统代理 → 常见本地端口
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    candidates = [_OPENER, direct]
    for p in _system_proxies():
        if p != _PROXY:
            candidates.append(_proxy_opener(p))
    # 每个候选必须用全新的 Request：第一个代理失败后原 req 的状态已被
    # urllib 改过，直接复用会让后面本来能通的直连也一起失败。
    def clone(r):
        return urllib.request.Request(
            r.full_url, data=r.data, headers=dict(r.headers),
            method=r.get_method())
    last = None
    for op in candidates:
        try:
            return op.open(clone(req), timeout=timeout)
        except Exception as e:
            last = e
    if last:
        raise last
    return _OPENER.open(clone(req), timeout=timeout)


def call_llm(base, model, key, text, attempts=3, settings=None):
    s = settings or DEFAULT_SETTINGS
    api, tr = s["api"], s["translation"]
    prompt = system_prompt(tr.get("target_lang", "zh-CN"),
                           tr.get("glossary", True))
    hint = (GLOSSARY_HINT + "\n\n") if tr.get("glossary", True) else ""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": hint + "请翻译：\n" + text},
        ],
        "temperature": float(api.get("temperature", 0.2)),
        "stream": False,
    }
    req = urllib.request.Request(
        chat_endpoint(base),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"},
    )
    attempts = int(tr.get("retries", attempts)) or 1
    timeout = int(api.get("timeout", 120)) or 120
    last = None
    for i in range(attempts):
        try:
            with _open(req, timeout) as r:
                d = json.loads(r.read().decode("utf-8"))
            return d["choices"][0]["message"]["content"], d.get("usage", {})
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            last = "HTTP %d: %s" % (e.code, body[:200])
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 * (i + 1))
                continue
            break
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, str(e)[:200])
            time.sleep(2 * (i + 1))
    raise RuntimeError(last or "LLM 调用失败")


def parse_translation(out_text, expected):
    """返回 {id: 译文}；只接受标记为 expected 的条目。"""
    result = {}
    # 先按标记切块
    parts = list(MARK_RE.finditer(out_text))
    for i, m in enumerate(parts):
        bid = m.group(1)
        if bid not in expected:
            continue
        end = parts[i + 1].start() if i + 1 < len(parts) else len(out_text)
        seg = out_text[m.end():end].strip()
        seg = re.sub(r"^\s*[\*\-]\s*", "", seg)          # 去掉误加的列表符
        seg = re.sub(r"^【[^】]+】\s*", "", seg)
        if seg:
            result[bid] = seg.strip()
    return result


def placeholder_signature(s):
    """占位符多重集签名：允许 LLM 按中文语序调整位置，但每个占位符出现次数必须一致。"""
    from collections import Counter
    return tuple(sorted(Counter(PH_RE.findall(s)).items()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", default="", help="arxiv_blocks.json 路径")
    ap.add_argument("--out", default="", help="译文 JSON 输出路径")
    ap.add_argument("--batch", type=int, default=8, help="每批块数（默认 8）")
    ap.add_argument("--max-chars", type=int, default=2600,
                    help="每批原文字符上限（默认 2600，防止超 context）")
    ap.add_argument("--limit", type=int, default=0, help="只翻译前 N 块（调试用，0=全部）")
    ap.add_argument("--title", default="", help="论文英文标题，单独翻译成中文写进 __title__")
    ap.add_argument("--config", default="",
                    help="LLM 配置文件路径（默认 ~/.mktero_llm_config.json）")
    ap.add_argument("--test-llm", action="store_true",
                    help="只测试 API 连通性；成功退出码 0，失败非 0（不输出密钥）")
    ap.add_argument("--base-url", default="")
    ap.add_argument("--model", default="")
    ap.add_argument("--api-key", default="")
    ap.add_argument("--proxy", default="",
                    help="HTTP 代理，如 http://127.0.0.1:7897（插件会自动探测）")
    a = ap.parse_args()

    base, model, key, settings = load_config(a)
    tr = settings["translation"]
    # CLI 显式传入时覆盖配置；否则用配置值
    batch_size = a.batch if a.batch != 8 else int(tr.get("batch", 8))
    max_chars = a.max_chars if a.max_chars != 2600 else int(tr.get("max_chars", 2600))
    resume = bool(tr.get("resume", True))

    set_proxy(a.proxy)
    if a.test_llm:
        try:
            reply, usage = ping_llm(base, model, key, settings=settings)
            text = (reply or "").strip()
            if text:
                print("连接成功：%s → %s（tokens=%d）"
                      % (chat_endpoint(base), model,
                         usage.get("total_tokens", 0)))
                print("         返回：%s" % text[:60])
                return
            print("连接异常：模型返回了空内容（%s）" % chat_endpoint(base),
                  file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            print("连接失败：%s\n        请求地址：%s"
                  % (str(e)[:300], chat_endpoint(base)), file=sys.stderr)
            sys.exit(1)

    if not a.blocks or not a.out:
        sys.exit("需要 --blocks 与 --out（或用 --test-llm 只测连接）")
    src = Path(a.blocks).expanduser().resolve()
    if not src.exists():
        sys.exit("找不到 blocks 文件：" + str(src))
    blocks = json.loads(src.read_text(encoding="utf-8"))

    out = Path(a.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    done = {}
    if out.exists() and resume:
        try:
            done = json.loads(out.read_text(encoding="utf-8"))
        except Exception:
            done = {}

    todo = [b for b in blocks
            if b.get("text", "").strip()
            and b["type"] not in ("math", "table", "tabular")
            and b["id"] not in done]
    if a.limit:
        todo = todo[:a.limit]
    total = len(todo)
    print("待翻译 %d 块，已完成 %d 块，模型 %s" % (total, len(done), model))
    if not total:
        print("没有需要翻译的块。")
        return

    def save():
        out.write_text(json.dumps(done, ensure_ascii=False, indent=2), encoding="utf-8")

    ok, failed, used_tokens = 0, [], 0

    # 单独翻标题，用作页头中文副标题（对齐 Mktero 的 doc-title-zh）
    if a.title and "__title__" not in done:
        try:
            reply, usage = call_llm(
                base, model, key,
                "【__title__】" + a.title,
                settings=settings,
            )
            used_tokens += usage.get("total_tokens", 0)
            got = parse_translation(reply, {"__title__": {"text": a.title}})
            if got.get("__title__"):
                done["__title__"] = got["__title__"]
                save()
                print("标题译文：%s" % done["__title__"], flush=True)
        except Exception as e:
            print("  ! 标题翻译失败：%s" % e, flush=True)
    i = 0
    while i < len(todo):
        # 组装一批：按块数和字符上限双重约束
        batch, size = [], 0
        while i < len(todo) and len(batch) < batch_size:
            b = todo[i]
            line = "【%s】%s" % (b["id"], b["text"].strip())
            if batch and size + len(line) > max_chars:
                break
            batch.append((b, line))
            size += len(line)
            i += 1
        payload_text = "\n".join(line for _, line in batch)
        expected = {b["id"]: b for b, _ in batch}
        print("\n[%d/%d] 批次 %d 块，%d 字符" % (i, len(todo), len(batch), size), flush=True)

        try:
            reply, usage = call_llm(base, model, key, payload_text,
                                    settings=settings)
            used_tokens += usage.get("total_tokens", 0)
            got = parse_translation(reply, expected)
        except Exception as e:
            print("  ! 调用失败：%s" % e, flush=True)
            failed.extend(b["id"] for b, _ in batch)
            save()
            continue

        for b, _ in batch:
            bid = b["id"]
            zh = got.get(bid, "")
            # 占位符签名必须一致，否则视为翻译损坏，留空等重跑
            if zh and placeholder_signature(zh) == placeholder_signature(b["text"]):
                done[bid] = zh
                ok += 1
            else:
                failed.append(bid)
                if zh:
                    print("  ! %s 占位符不一致，丢弃译文中转" % bid, flush=True)
                else:
                    print("  ! %s 未产出译文" % bid, flush=True)
        save()
        print("  累计成功 %d，失败 %d，tokens %d" % (ok, len(failed), used_tokens), flush=True)
        time.sleep(0.5)

    print("\n完成：成功 %d，失败 %d，总 tokens %d" % (ok, len(failed), used_tokens))
    print("译文文件：" + str(out))
    if not ok:
        # 全失败却退 0，插件会以为翻译完成、把整篇当「无译文」排版出单语 HTML。
        # 这里必须让上游看见失败原因。
        print("错误：所有块都翻译失败，已中止。" + (
              "（已设置代理：" + _PROXY + "）" if _PROXY else
              "（当前为直连；若你的网络必须过代理才能访问该接口，"
              "请在设置 → 高级 → 网络代理里填地址，例如 http://127.0.0.1:7897）"),
              file=sys.stderr)
        sys.exit(3)
    if failed:
        print("失败块（重跑本命令会自动跳过已完成的）：" + ", ".join(failed[:40]))
        if len(failed) > 40:
            print("  ... 共 %d 个" % len(failed))


if __name__ == "__main__":
    main()
