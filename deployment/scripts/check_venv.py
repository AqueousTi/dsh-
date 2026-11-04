"""只读检查 venv 绑定路径及 Windows 入口，不创建、删除或执行环境。"""
import argparse
import os
import re
from pathlib import Path


def canonical(value):
    return os.path.normcase(os.path.realpath(os.fspath(value)))


def check(venv, runtime):
    venv, runtime = Path(venv), Path(runtime)
    cfg = venv / 'pyvenv.cfg'
    if not cfg.is_file() or not (venv / 'Scripts/python.exe').is_file():
        return False, '缺少 venv/pyvenv.cfg 或解释器，请在目标位置初始化环境'
    homes = [line.partition('=')[2].strip() for line in cfg.read_text(encoding='utf-8-sig').splitlines()
             if line.partition('=')[0].strip().lower() == 'home']
    if len(homes) != 1 or canonical(homes[0]) != canonical(runtime):
        return False, 'venv 绑定了其他路径；请保留或备份旧环境，从干净包在目标位置重建'
    launcher = venv / 'Scripts/astrbot.exe'
    if launcher.is_file():
        candidates = re.findall(rb'#!([^\r\n]+)', launcher.read_bytes())
        interpreters = [value.strip().strip(b'"') for value in candidates if b'python.exe' in value.lower()]
        if not interpreters:
            return False, '无法识别 AstrBot 入口解释器，拒绝复用此环境'
        try:
            if any(canonical(value.decode('utf-8')) != canonical(venv / 'Scripts/python.exe') for value in interpreters):
                return False, 'AstrBot 入口仍指向旧 venv，请在目标位置重新安装入口'
        except UnicodeError:
            return False, 'AstrBot 入口路径编码无效'
    return True, 'venv 路径检查通过'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--venv', required=True)
    parser.add_argument('--runtime', required=True)
    args = parser.parse_args()
    try:
        valid, message = check(args.venv, args.runtime)
    except (OSError, UnicodeError):
        valid, message = False, '无法读取环境元数据，请检查路径和权限'
    print(message)
    return 0 if valid else 1


if __name__ == '__main__':
    raise SystemExit(main())
