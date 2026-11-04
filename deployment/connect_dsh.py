"""Run only in the test VM, from the release root; never sends QQ messages."""
import csv
import getpass
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


class SetupError(Exception):
    pass


def patch_text(bundle, password):
    # JSON string literals are valid YAML double-quoted scalars.
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    return (
        "# 本机连接配置，包含后台密码；请勿分享此文件。\n"
        "- insert:\n"
        "    - id: dafeiyu-console\n"
        "      name: dsh-dafeiyu-console\n"
        "      config:\n"
        f"        bundlePath: {quote(bundle.as_posix())}\n"
        "        astrbotUser: astrbot\n"
        f"        astrbotPassword: {quote(password)}\n"
        "        astrbotPort: 6185\n"
    )


def login(password):
    # Match the existing importer; no redirects or system proxy for local secrets.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for candidate in (password, hashlib.md5(password.encode()).hexdigest()):
        request = urllib.request.Request(
            "http://127.0.0.1:6185/api/v1/auth/login",
            json.dumps({"username": "astrbot", "password": candidate}).encode(),
            {"Content-Type": "application/json"}, method="POST",
        )
        try:
            with opener.open(request, timeout=10) as response:
                result = json.loads(response.read(1_000_000))
        except urllib.error.HTTPError as error:
            if error.code in (400, 401, 403):
                continue
            raise SetupError("后台 HTTP 错误，请先确认 6185 可以登录。") from None
        except (OSError, ValueError):
            raise SetupError("无法访问后台，请先确认 6185 可以打开。") from None
        if isinstance(result, dict):
            data = result.get("data")
            if isinstance(data, dict) and data.get("token"):
                return
    raise SetupError("后台登录未通过；未修改插件配置。请核对本机密码。")


def write_patch(target, content):
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=target.parent, delete=False) as stream:
            pending = Path(stream.name)
            stream.write(content)
        os.replace(pending, target)
    finally:
        if pending is not None and pending.exists():
            pending.unlink()


def seed_bili_defaults(home):
    """First install only; preserve existing settings/credentials without reading them."""
    directory = Path(home) / "bili-duty"
    target = directory / "config.json"
    if target.exists():
        return False
    if directory.is_symlink() or directory.is_junction():
        raise SetupError("B站配置目录含重解析链接，未写入默认设置。")
    directory.mkdir(parents=True, exist_ok=True)
    patch = {"dmWatch": False, "dmWatchMinutes": 1, "dmReplyPerDay": 0,
             "dmMode": "off", "peakValley": False, "autoComment": False,
             "replyToComments": False}
    patch["_set"] = list(patch)
    try:
        with target.open("x", encoding="utf-8") as stream:
            json.dump(patch, stream, ensure_ascii=False, indent=2)
    except FileExistsError:
        return False
    return True


def main():
    if sys.platform != "win32":
        raise SetupError("此工具用于 Windows 虚拟机。")
    root = Path(__file__).resolve().parent
    bundle = root / "dafy-bundle"
    plugins = root / "dsh-plugins"
    names = ("dsh-dafeiyu-console", "dsh-restart-app", "dsh-bili-scroll")
    dsh = Path(r"C:\DSH")
    executable = dsh / "DeepSeek Harness.exe"
    archive = dsh / "resources" / "app.asar"
    cli = archive / "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
    profile = Path(os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")) / "profiles/desktop"
    required = [executable, archive, profile / "package.json",
                bundle / "astrbot/.astrbot", bundle / "astrbot/tools/embed_server.py"]
    required += [plugins / name / "package.json" for name in names]
    if not all(path.is_file() for path in required):
        raise SetupError("文件不齐：请把工具放在解压目录根部，并确认 C:\\DSH 已首次打开。")
    check = subprocess.run(["tasklist.exe", "/FI", "IMAGENAME eq DeepSeek Harness.exe",
                            "/FO", "CSV", "/NH"], capture_output=True, text=True,
                           errors="replace", timeout=20)
    if check.returncode:
        raise SetupError("无法核对 DSH 进程，未修改配置。")
    if any(row and row[0].casefold() == "deepseek harness.exe"
           for row in csv.reader(io.StringIO(check.stdout))):
        raise SetupError("请从虚拟机右下角托盘完全退出 DSH（关窗口会留后台），再运行工具。")

    print("仅连接本机已有机器人；不会重启 QQ/AstrBot 或重新导入人格。")
    password = getpass.getpass("虚拟机 AstrBot 后台密码（输入不显示）：")
    if not password:
        raise SetupError("密码不能为空。")
    login(password)
    if seed_bili_defaults(profile.parents[1]):
        print("首次B站设置：自动私信、自动评论和自动刷均关闭；需要时请本人开启。")
    write_patch(plugins / "dsh-dafeiyu-console/cordis.patch.yml", patch_text(bundle, password))
    print("后台登录通过，本机控制台配置已写入。请勿分享含密码的插件目录。")
    print("开始用 DSH 自带 CLI 安装三个随包插件；依赖下载可能需要几分钟……", flush=True)
    env = os.environ.copy()
    env["ELECTRON_RUN_AS_NODE"] = "1"
    command = [str(executable), "--expose-internals", str(cli), "plugin", "--profile",
               "desktop", "add"] + ["file:" + (plugins / name).as_posix() for name in names]
    result = subprocess.run(command, cwd=root, env=env, capture_output=True,
                            encoding="utf-8", errors="replace")
    output = result.stdout + "\n" + result.stderr
    for secret in (password, hashlib.md5(password.encode()).hexdigest()):
        output = output.replace(secret, "***")
    print(output[-16000:])
    if result.returncode:
        raise SetupError("插件安装未成功，请保留最后几行错误；不要粘贴配置文件。")
    print("插件安装完成。请重新打开 DSH，在设置里查看 Bot 和刷B站。")


if __name__ == "__main__":
    try:
        main()
    except SetupError as error:
        print("接入未完成：" + str(error))
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print("已取消。")
        sys.exit(1)
    except Exception as error:
        print("接入未完成（" + type(error).__name__ + "），请保留此提示。")
        sys.exit(1)
