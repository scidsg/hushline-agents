from __future__ import annotations

import importlib.util
import os
import shutil
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/dev_storage.py"
spec = importlib.util.spec_from_file_location("dev_storage", SCRIPT)
assert spec
assert spec.loader
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


@pytest.fixture
def mounted(tmp_path: Path, monkeypatch: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    mount = tmp_path / "External Dev"
    root = mount / "dev"
    root.mkdir(parents=True)
    real_stat = Path.stat

    def stat(path: Path, *args: Any, **kwargs: Any) -> os.stat_result:
        original = real_stat(path, *args, **kwargs)
        if path == mount or path.is_relative_to(mount):
            fields = list(original)
            fields[2] = original.st_dev + 1
            return os.stat_result(fields)
        return original

    monkeypatch.setattr(Path, "stat", stat)
    usage_type = type(shutil.disk_usage(tmp_path))
    monkeypatch.setattr(
        shutil, "disk_usage", lambda _: usage_type(1000 * storage.GIB, 0, 100 * storage.GIB)
    )
    return (
        {"mount": str(mount), "root": str(root), "volume_uuid": "expected"},
        {"MountPoint": str(mount), "VolumeUUID": "expected", "Internal": False, "Locked": False},
    )


def test_expected_external_volume_passes(mounted: Any) -> None:
    storage.validate(*mounted)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("VolumeUUID", "other"),
        ("Internal", True),
        ("MountPoint", ""),
        ("Locked", True),
    ],
)
def test_wrong_or_unmounted_volume_fails_closed(mounted: Any, key: str, value: Any) -> None:
    config, volume = mounted
    volume[key] = value
    with pytest.raises(RuntimeError):
        storage.validate(config, volume)


def test_redirected_root_fails(mounted: Any, tmp_path: Path) -> None:
    config, volume = mounted
    config["root"] = str(tmp_path)
    with pytest.raises(RuntimeError):
        storage.validate(config, volume)


def test_low_free_space_fails(mounted: Any, monkeypatch: Any) -> None:
    usage_type = type(shutil.disk_usage(Path.home()))
    monkeypatch.setattr(shutil, "disk_usage", lambda _: usage_type(100, 99, 1))
    with pytest.raises(RuntimeError):
        storage.validate(*mounted)


def test_redirected_storage_link_fails(mounted: Any, tmp_path: Path) -> None:
    config, volume = mounted
    link = tmp_path / "colima"
    link.symlink_to(tmp_path, target_is_directory=True)
    config["links"] = [str(link)]
    with pytest.raises(RuntimeError):
        storage.validate(config, volume)
