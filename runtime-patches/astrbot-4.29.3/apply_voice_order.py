"""Pinned, reversible disk patch. Never starts/stops services or reads credentials."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import tempfile

HERE = Path(__file__).resolve().parent
EXPECTED_PATHS = {
    "core/pipeline/result_decorate/stage.py",
    "core/pipeline/respond/stage.py",
    "core/pipeline/deferred_tts.py",
    "core/config/default.py",
}


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def safe_path(root, rel):
    path = root / rel
    if path.resolve().is_relative_to(root.resolve()) is False:
        raise RuntimeError("Path escapes target")
    for part in (path, *path.parents):
        if part.is_symlink() or part.is_junction():
            raise RuntimeError("Reparse points are not supported")
    return path


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".dfy-voice-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def inspect(bundle, package=HERE):
    manifest = json.loads((package / "manifest.json").read_text("utf-8"))
    records = manifest["files"]
    if manifest["astrbot_version"] != "4.29.3" or {r["path"] for r in records} != EXPECTED_PATHS or len(records) != 4:
        raise RuntimeError("Unexpected patch manifest")
    lib = safe_path(bundle, "astrbot/venv/Lib/site-packages")
    metadata = safe_path(lib, "astrbot-4.29.3.dist-info/METADATA")
    if "Version: 4.29.3" not in metadata.read_text("utf-8").splitlines():
        raise RuntimeError("Only AstrBot 4.29.3 is supported")
    root = safe_path(lib, "astrbot")
    states = []
    for r in records:
        payload = safe_path(package / "payload", r["path"]).read_bytes()
        if sha(payload) != r["patched"]:
            raise RuntimeError("Patch checksum mismatch")
        ast.parse(payload)
        target = safe_path(root, r["path"])
        previous = target.read_bytes() if target.exists() else None
        if sha(previous) not in {r["original"], r["patched"], *r.get("previous", [])}:
            raise RuntimeError("Installed source differs; preserved without changes")
        states.append((r, target, previous, payload))
    return root, states


def apply(bundle, mode="check", package=HERE):
    root, states = inspect(Path(bundle), Path(package))
    if mode == "check":
        return "already_patched" if all(sha(before) == r["patched"] for r, _, before, _ in states) else "compatible"
    backup = safe_path(root, ".dfy-voice-order-backup-v1")
    # Exclusive operation lock; do not take over another run or a crash residue.
    lock = safe_path(root, ".dfy-voice-order.lock")
    with lock.open("x", encoding="ascii") as stream:
        stream.write("v1\n")
    try:
        # Revalidate under the lock, before touching source files.
        root, states = inspect(Path(bundle), Path(package))
        if mode == "restore" and all(sha(before) == r["original"] for r, _, before, _ in states):
            return "already_original"
        originals = {}
        for r, target, before, payload in states:
            if r["original"] is None:
                originals[target] = None
                continue
            saved = safe_path(backup, r["path"])
            if saved.exists():
                original = saved.read_bytes()
                if sha(original) != r["original"]:
                    raise RuntimeError("Backup checksum mismatch")
            elif mode == "apply" and sha(before) == r["original"]:
                saved.parent.mkdir(parents=True, exist_ok=True)
                with saved.open("xb") as stream:
                    stream.write(before)
                original = before
            else:
                raise RuntimeError("Verified original backup is required")
            originals[target] = original
        previous = {target: before for _, target, before, _ in states}
        try:
            for r, target, before, payload in states:
                desired = payload if mode == "apply" else originals[target]
                if desired == before:
                    continue
                if desired is None:
                    target.unlink(missing_ok=True)
                else:
                    atomic_write(target, desired)
        except BaseException:
            for target, before in previous.items():
                if before is None:
                    target.unlink(missing_ok=True)
                elif not target.exists() or target.read_bytes() != before:
                    atomic_write(target, before)
            raise
        return "patched" if mode == "apply" else "restored"
    finally:
        lock.unlink(missing_ok=True)


def main():
    default = HERE.parents[1] if HERE.parent.name == "scripts" else HERE.parent / "dafy-bundle"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=default)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true")
    group.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    try:
        state = apply(args.bundle, "apply" if args.apply else "restore" if args.restore else "check")
    except Exception as exc:
        # Keep paths, arbitrary source contents and potential credentials out of output.
        print(f"未应用补丁（{type(exc).__name__}）：请检查版本、完整性或是否已修改源码；现有文件受保护。")
        return 1
    print(f"VOICE_ORDER: {state}")
    if args.apply or args.restore:
        print("仅更新了 AstrBot 代码文件；需要重启 AstrBot 才生效。本工具未停止/启动任何服务，未改账号配置。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
