"""仅初始化带哈希标记的干净发行模板；不重置现有账号。"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sysconfig
import tempfile


def auth_helpers():
    # 加载已安装版本的纯函数模块，避免导入整个应用触发配置初始化。
    path = Path(sysconfig.get_path("purelib")) / "astrbot/core/utils/auth_password.py"
    spec = importlib.util.spec_from_file_location("_dafy_auth_password", path)
    if spec is None or spec.loader is None:
        raise ValueError("缺少 AstrBot 密码模块，请先安装锁定依赖")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare(root, cfg, password):
    """只在内存中准备配置；返回附带写入项，调用者统一提交。"""
    root = Path(root).resolve()
    cfg = copy.deepcopy(cfg)
    dash = cfg.setdefault("dashboard", {})
    auth = auth_helpers()
    stored = dash.get("pbkdf2_password") or dash.get("password")
    if stored:
        if not auth.verify_dashboard_password(stored, password):
            raise ValueError("后台密码不匹配；没有修改已有密码或配置")
        return cfg, []

    marker = root / "scripts/fresh-template.json"
    try:
        expected = json.loads(marker.read_text("utf-8"))["config_sha256"]
    except (OSError, ValueError, KeyError) as exc:
        raise ValueError("缺少干净发行模板标记，拒绝初始化现有运行目录") from exc
    config_file = root / "astrbot/data/cmd_config.json"
    if hashlib.sha256(config_file.read_bytes()).hexdigest() != expected:
        raise ValueError("模板已变动，拒绝按首次安装重置认证材料")
    data = root / "astrbot/data"
    if any(p.is_file() and p.name.lower().endswith(
            (".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3")) for p in data.rglob("*")):
        raise ValueError("检测到已有数据库，拒绝首次初始化")
    candidates = list((root / "napcat").glob("*/versions/*/resources/app/napcat/config"))
    if len(candidates) != 1:
        raise ValueError("NapCat 版本目录缺失或不唯一，请人工确认版本")
    napcat = candidates[0]
    if not napcat.resolve().is_relative_to(root):
        raise ValueError("NapCat 配置目录超出当前安装目录")
    if list(napcat.glob("onebot11_*.json")) or (napcat / "onebot11.json").exists() or (napcat / "webui.json").exists():
        raise ValueError("检测到已有 NapCat 账号或网络配置，拒绝覆盖")
    platforms = cfg.get("platform", [])
    if len(platforms) != 1 or platforms[0].get("type") != "aiocqhttp":
        raise ValueError("首次模板必须只配置一个 aiocqhttp 平台")
    auth.validate_dashboard_password(password)
    dash.update(password=auth.hash_md5_dashboard_password(password),
                pbkdf2_password=auth.hash_dashboard_password(password),
                password_storage_upgraded=True, password_change_required=False,
                jwt_secret=secrets.token_urlsafe(32), host="127.0.0.1")
    token = secrets.token_urlsafe(32)
    platforms[0].update(ws_reverse_host="127.0.0.1", ws_reverse_port=6199,
                        ws_reverse_token=token)
    onebot = {"network": {"httpServers": [], "httpSseServers": [], "httpClients": [],
        "websocketServers": [], "websocketClients": [{"enable": True, "name": "AstrBot",
        "url": "ws://127.0.0.1:6199/ws", "reportSelfMessage": False,
        "messagePostFormat": "array", "token": token, "debug": False,
        "heartInterval": 30000, "reconnectInterval": 30000, "verifyCertificate": True}],
        "plugins": []}, "musicSignUrl": "", "enableLocalFile2Url": False,
        "parseMultMsg": False, "imageDownloadProxy": ""}
    webui = {"host": "127.0.0.1", "port": 6099, "token": secrets.token_urlsafe(32),
             "loginRate": 10, "autoLoginAccount": ""}
    return cfg, [(napcat / "onebot11.json", onebot), (napcat / "webui.json", webui)]


def atomic_write(path, content):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix=".dafy-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def save_configs(items):
    """文件异常时回滚已写项目；不吞回滚失败。进程被强杀仍需人工恢复。"""
    originals, completed = {}, []
    try:
        for path, value in items:
            path = Path(path)
            originals[path] = path.read_bytes() if path.exists() else None
            atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            completed.append(path)
    except BaseException:
        for path in reversed(completed):
            if originals[path] is None:
                path.unlink()
            else:
                atomic_write(path, originals[path])
        raise
