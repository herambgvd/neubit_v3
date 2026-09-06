"""System resource sampling — CPU, RAM, disk, and (optionally) GPUs.

``sample_resources()`` returns one point-in-time snapshot, served by
``/api/system/resources`` and its WebSocket stream.

``psutil`` is a normal dependency. ``pynvml`` (the ``nvidia-ml-py`` package) is
imported lazily inside a try/except, so a host with no NVIDIA GPU or driver
reports ``"gpus": []`` instead of crashing.

Every size field is in bytes; percentages are 0–100 floats.
"""

from __future__ import annotations

import platform
import subprocess
from functools import lru_cache

import psutil

from ..core.logging import get_logger

log = get_logger("edge.system")


def _pretty_arch(arch: str | None) -> str:
    a = (arch or "").lower()
    if a in ("aarch64", "arm64"):
        return "ARM64"
    if a in ("x86_64", "amd64"):
        return "x86-64"
    return arch or "CPU"


@lru_cache(maxsize=1)
def _cpu_name() -> str | None:
    """Best-effort human CPU model name (e.g. "Intel Core i7-9750H", "Apple M2").

    Cached — the name never changes at runtime. Sources, in order:
      * Linux/x86 — the "model name" line in /proc/cpuinfo
      * lscpu     — a real "Model name", else "<Vendor> <Arch>" for ARM guests
                    whose /proc/cpuinfo carries no brand
      * macOS     — sysctl machdep.cpu.brand_string (native, non-containerised)
      * fallback  — a prettified arch label (ARM64 / x86-64)
    """
    try:
        with open("/proc/cpuinfo") as fh:
            for line in fh:
                if line.lower().startswith("model name"):
                    val = line.split(":", 1)[1].strip()
                    if val:
                        return val
    except Exception:
        pass
    try:
        out = subprocess.check_output(["lscpu"], text=True, timeout=1)
        fields = {}
        for line in out.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                fields[key.strip().lower()] = value.strip()
        model = fields.get("model name", "")
        if model and model not in ("-", "unknown"):
            return model
        vendor = fields.get("vendor id", "")
        arch = fields.get("architecture", "") or platform.machine()
        if vendor and vendor not in ("-", "unknown"):
            return f"{vendor} {_pretty_arch(arch)}"
        if arch:
            return _pretty_arch(arch)
    except Exception:
        pass
    try:
        if platform.system() == "Darwin":
            out = subprocess.check_output(
                ["sysctl", "-n", "machdep.cpu.brand_string"], text=True, timeout=1
            ).strip()
            if out:
                return out
    except Exception:
        pass
    raw = platform.processor() or platform.machine()
    return _pretty_arch(raw) if raw else None


def _sample_gpus() -> list[dict]:
    """Return per-GPU stats via NVML, or an empty list if unavailable.

    Everything NVIDIA-specific is here and imported lazily, so importing this
    module never requires ``pynvml`` or a driver. Any failure degrades to ``[]``.
    """
    try:
        import pynvml  # package: nvidia-ml-py — optional, GPU-only
    except ImportError:
        # No NVML bindings installed — treat as "no GPUs".
        return []

    gpus: list[dict] = []
    try:
        pynvml.nvmlInit()
    except Exception:  # pragma: no cover - depends on host having NVIDIA driver
        # Driver not present (CPU-only host) → no GPUs to report.
        return []

    try:
        count = pynvml.nvmlDeviceGetCount()
        for index in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            # Name comes back as bytes on some NVML versions — normalise to str.
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode()
            try:
                temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            except Exception:
                temp = None
            gpus.append(
                {
                    "index": index,
                    "name": name,
                    "mem_total": mem.total,        # bytes
                    "mem_used": mem.used,          # bytes
                    "util_percent": float(util.gpu),  # 0–100
                    "temp": temp,                  # °C or None
                }
            )
    except Exception as exc:  # pragma: no cover - hardware/driver dependent
        log.warning("GPU sampling failed: %s", exc)
        gpus = []
    finally:
        # Always release the NVML handle initialised above.
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass
    return gpus


def sample_resources() -> dict:
    """Return a one-shot snapshot of host CPU / RAM / disk / GPU utilisation.

    Shape::

        {
          "cpu_percent": 12.5,
          "ram":  {"total": <bytes>, "used": <bytes>, "percent": 43.1},
          "disk": {"total": <bytes>, "used": <bytes>, "percent": 71.0},
          "gpus": [ {"index", "name", "mem_total", "mem_used",
                     "util_percent", "temp"}, ... ]
        }
    """
    # interval=0.0 returns CPU % since the previous call without blocking; the
    # first call after import may read 0.0, fine for a live stream.
    cpu_percent = psutil.cpu_percent(interval=0.0)
    cpu_cores = psutil.cpu_count(logical=True)
    # cpu_freq() may return None or raise on some VMs/containers/macOS; degrade to
    # None rather than failing the whole snapshot.
    try:
        freq = psutil.cpu_freq()
        cpu_freq_ghz = round(freq.current / 1000, 1) if freq and freq.current else None
    except Exception:  # pragma: no cover - platform dependent
        cpu_freq_ghz = None

    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")

    return {
        "cpu_percent": float(cpu_percent),
        "cpu_name": _cpu_name(),
        "cpu_cores": cpu_cores,
        "cpu_freq_ghz": cpu_freq_ghz,
        "ram": {
            "total": vm.total,      # bytes
            "used": vm.used,        # bytes
            "percent": float(vm.percent),
        },
        "disk": {
            "total": disk.total,    # bytes
            "used": disk.used,      # bytes
            "percent": float(disk.percent),
        },
        "gpus": _sample_gpus(),
    }
