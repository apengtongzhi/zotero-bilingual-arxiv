#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arxiv_translate.py — 把 arxiv_to_zotero.py 产出的结构化块翻译成中文。

读 arxiv_blocks.json 里每块的 text（公式是 ⟦F0⟧、引用是 ⟦引用⟧ 占位符），
分批送 OpenAI 兼容 LLM，产出 {block_id: 译文} 的 JSON，
再由 arxiv_to_zotero.py --translation 合成逐块双语 HTML。

设计：
  - 密钥只读 ~/.mktero_llm_config.json（权限 600），绝不写进脚本/日志/产物
  - 占位符保护：system 指令 + 译后校验，丢失占位符的批次自动重试
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
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".mktero_llm_config.json"

SYSTEM_PROMPT = """你是学术论文翻译助手，把给定英文逐条翻译成简体中文。严格规则：
1. 逐条翻译，每条输出格式必须是【bNNN】译文，bNNN 与输入标记完全一致，一条一行，不要遗漏、不要合并、不要加编号列表或额外说明。
2. 文本中的 ⟦F0⟧ ⟦F1⟧ ⟦引用⟧ 是占位符，必须原样逐字保留在译文对应位置，不得翻译、删除、改写或移动顺序。
3. 只翻译自然语言正文；不要解释，不要添加原文没有的内容。
4. 术语统一：Transformer=Transformer，attention=注意力，encoder=编码器，decoder=解码器，self-attention=自注意力，layer=层，token=词元，embedding=嵌入，softmax=softmax，dropout=dropout，state-of-the-art=最先进，ablation=消融实验。
5. 译文忠实、通顺、学术化，保留原文的语气与信息密度。"""

GLOSSARY_HINT = (
    "术语参考：Transformer / 注意力(attention) / 编码器(encoder) / 解码器(decoder) / "
    "自注意力(self-attention) / 词元(token) / 嵌入(embedding) 保持上述译法。"
)

MARK_RE = re.compile(r"【(b\d+|__title__)】")
PH_RE = re.compile(r"⟦(?:F\d+|引用)⟧")


def load_config(cli):
    cfg = {}
    cfg_path = Path(cli.config).expanduser().resolve() if cli.config else CONFIG
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    base = cli.base_url or cfg.get("base_url", "")
    model = cli.model or cfg.get("model", "")
    key = cli.api_key or cfg.get("api_key", "")
    if not (base and model and key):
        sys.exit("缺少 base_url / model / api_key：请建 %s（权限 600）或用命令行参数" % cfg_path)
    return base.rstrip("/"), model, key


def call_llm(base, model, key, text, attempts=3):
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": GLOSSARY_HINT + "\n\n请翻译：\n" + text},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"},
    )
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
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
    a = ap.parse_args()

    base, model, key = load_config(a)

    if a.test_llm:
        try:
            reply, usage = call_llm(base, model, key,
                                    "【b999】Reply with a single word: OK")
            if "OK" in reply.upper():
                print("连接成功：模型 %s 返回正常（tokens=%d）"
                      % (model, usage.get("total_tokens", 0)))
                return
            print("连接异常：返回内容不符合预期", file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            print("连接失败：%s" % str(e)[:200], file=sys.stderr)
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
    if out.exists():
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
        while i < len(todo) and len(batch) < a.batch:
            b = todo[i]
            line = "【%s】%s" % (b["id"], b["text"].strip())
            if batch and size + len(line) > a.max_chars:
                break
            batch.append((b, line))
            size += len(line)
            i += 1
        payload_text = "\n".join(line for _, line in batch)
        expected = {b["id"]: b for b, _ in batch}
        print("\n[%d/%d] 批次 %d 块，%d 字符" % (i, len(todo), len(batch), size), flush=True)

        try:
            reply, usage = call_llm(base, model, key, payload_text)
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
    if failed:
        print("失败块（重跑本命令会自动跳过已完成的）：" + ", ".join(failed[:40]))
        if len(failed) > 40:
            print("  ... 共 %d 个" % len(failed))


if __name__ == "__main__":
    main()
