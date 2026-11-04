"""写 AstrBot 配置，并（可选）把 answers 通过标准输入交给导入工具。

要点：
  * 默认只写配置：不生成额外回答文件；正式 cmd_config.json 仍保存用户模型凭证（旧的 scripts/回答.json 不再创建）。
  * `--import` 时 answers 只在内存里拼 JSON，经 stdin 传给
    `import_dafeiyu.py --answers -`，不落盘。
  * 密钥可走命令行（兼容旧调用），也可走环境变量：
        DAFY_DEEPSEEK_KEY / DAFY_OWNER / DAFY_SF_KEY
        DAFY_VOLC_ID / DAFY_VOLC_TOKEN / DAFY_DASHBOARD_PASSWORD
    安装器用环境变量，避免密钥出现在命令行与进程列表里。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "astrbot", "data", "cmd_config.json")
IMPORTER = os.path.join(ROOT, "config-pack", "tools", "import_dafeiyu.py")
CONFIG_PACK = os.path.join(ROOT, "config-pack")


def load(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def build_answers(cfg, owner, dash_pass, sf_key, volc_id, volc_token):
    dash = cfg.get("dashboard") or {}
    answers = {
        "base_url": "http://127.0.0.1:6185",
        "username": dash.get("username") or "astrbot",
        # 没填硅基 key 时用本地向量，而不是「关掉记忆」
        "memory": "2" if sf_key else "local",
        "voice": "3" if (volc_id and volc_token) else "1",
        "owner_qq": owner,
        "password": dash_pass,
    }
    if sf_key:
        answers["siliconflow_key"] = sf_key
    if volc_id and volc_token:
        answers["volc_app_id"] = volc_id
        answers["volc_access_token"] = volc_token
    return answers


def run_import(answers):
    """answers 经 stdin 交给导入工具，不生成临时文件。"""
    if not os.path.isfile(IMPORTER):
        print(f"[错误] 找不到导入工具：{IMPORTER}")
        return 2
    payload = json.dumps(answers, ensure_ascii=False)
    print("正在导入插件与人格（输出见下）…")
    try:
        proc = subprocess.run(
            [sys.executable, "-X", "utf8", IMPORTER, "--answers", "-"],
            input=payload,
            cwd=CONFIG_PACK,
            encoding="utf-8",
            shell=False,
            timeout=20 * 60,
            env={key: value for key, value in os.environ.items()
                 if not (key.upper().startswith("DAFY_") and any(word in key.upper() for word in ("KEY", "TOKEN", "PASSWORD")))},
        )
    except (OSError, subprocess.TimeoutExpired):
        print("[错误] 导入进程无法启动或已超时")
        return 2
    if proc.returncode != 0:
        print(f"[错误] 导入失败，返回码 {proc.returncode}")
        return proc.returncode
    print("导入完成")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deepseek-key", default=os.environ.get("DAFY_DEEPSEEK_KEY", ""))
    ap.add_argument("--owner", default=os.environ.get("DAFY_OWNER", ""))
    ap.add_argument("--sf-key", default=os.environ.get("DAFY_SF_KEY", ""))
    ap.add_argument("--volc-id", default=os.environ.get("DAFY_VOLC_ID", ""))
    ap.add_argument("--volc-token", default=os.environ.get("DAFY_VOLC_TOKEN", ""))
    ap.add_argument("--dashboard-password", default=os.environ.get("DAFY_DASHBOARD_PASSWORD", ""))
    ap.add_argument("--initialize-if-empty", action="store_true",
                    help="初始化带哈希标记的干净发行模板；已有认证只校验，不重置")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--import-only", action="store_true", help="只导入，不写磁盘主配置（供已写配置并启动后的安装器使用）")
    mode.add_argument("--import", dest="do_import", action="store_true",
                    help="写完配置后立即调用导入工具（answers 走 stdin）")
    a = ap.parse_args()
    if a.initialize_if_empty and a.import_only:
        ap.error("首次初始化不能与 --import-only 同用")

    if not a.deepseek_key:
        ap.error("缺 DeepSeek Key（--deepseek-key 或 DAFY_DEEPSEEK_KEY）")
    if not a.owner:
        ap.error("缺主人 QQ（--owner 或 DAFY_OWNER）")
    if not (a.owner.isascii() and a.owner.isdigit() and 5 <= len(a.owner) <= 20):
        ap.error("主人 QQ 应为 5 至 20 位数字")
    if not a.deepseek_key.startswith("sk-"):
        print("[警告] DeepSeek key 看起来不太对（一般以 sk- 开头），仍然写入")

    cfg = load(CFG)
    dash = cfg.get("dashboard") or {}
    stored = str(dash.get("password") or "")
    is_digest = len(stored) in (32, 64) and all(ch in "0123456789abcdefABCDEF" for ch in stored)
    dash_pass = a.dashboard_password or (stored if not is_digest and not dash.get("pbkdf2_password") else "")
    if not dash_pass:
        ap.error("需要 AstrBot 后台登录密码；通过 DAFY_DASHBOARD_PASSWORD 环境变量或 --dashboard-password 提供。不能把存储哈希当作登录密码。")

    if not a.import_only:
        source = next((item for item in cfg.get("provider_sources", []) if item.get("id") == "deepseek"), None)
        if source is None:
            ap.error("配置缺少 deepseek provider source，未写入")
        extra_configs = []
        if a.initialize_if_empty:
            from first_run import prepare
            try:
                cfg, extra_configs = prepare(ROOT, cfg, dash_pass)
            except ValueError as exc:
                ap.error(str(exc))
            except OSError:
                ap.error("首次认证文件检查失败；未写入配置")
            source = next(item for item in cfg["provider_sources"] if item.get("id") == "deepseek")
        source["key"] = [a.deepseek_key]
        admins = cfg.setdefault("admins_id", [])
        if a.owner not in admins:
            admins.append(a.owner)
        from first_run import save_configs
        save_configs([*extra_configs, (CFG, cfg)])
        print("已写入 DeepSeek key、主人 QQ：", a.owner)

    answers = build_answers(cfg, a.owner, dash_pass, a.sf_key, a.volc_id, a.volc_token)
    print("记忆：", "硅基流动" if a.sf_key else "本地模型",
          "；语音：", "豆包" if answers["voice"] == "3" else "Edge")

    if a.do_import or a.import_only:
        return run_import(answers)
    print("（未指定 --import：只写了配置，没有生成回答文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
