"""The disk gauge watches the disk the data is on.

On the native Windows appliance the program lives on C: and the data root
follows the big disk, so `/` (the current drive) would report the wrong one.
"""

from pathlib import Path

from app.core.config import get_settings
from app.system import resources


def test_measures_the_storage_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "storage_local_dir", str(tmp_path))
    assert Path(resources._data_disk_path()) == tmp_path.resolve()


def test_not_created_yet_measures_the_nearest_ancestor(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "storage_local_dir", str(tmp_path / "a" / "b"))
    assert Path(resources._data_disk_path()) == tmp_path.resolve()
