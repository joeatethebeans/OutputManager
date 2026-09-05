import os
import re
import json
import subprocess
import time
import asyncio

import decky_plugin

SETTINGS_FILE = os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

DEFAULT_CONFIG = {
    "targetUid": 1000,
    "gamescopeUnitGlob": "gamescope-session-plus@*.service",
    "usernameOverride": None,
    "skipRestartWarning": False,
    "defaultDisplay": None,
}

RESUME_POLL_INTERVAL_SECONDS = 10
RESUME_GAP_THRESHOLD_SECONDS = 5

def _load_settings():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                data = json.load(f)
                data.setdefault("displays", {})
                data.setdefault("audio", {})
                data.setdefault("config", {})
                return data
        except Exception:
            pass
    return {"displays": {}, "audio": {}, "config": {}}


def _save_settings(data):
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(data, f)


def _get_config():
    settings = _load_settings()
    config = dict(DEFAULT_CONFIG)
    config.update(settings.get("config") or {})
    return config


def _clean_subprocess_env():
    environment = os.environ.copy()
    original = environment.pop("LD_LIBRARY_PATH_ORIG", None)
    if original:
        environment["LD_LIBRARY_PATH"] = original
    else:
        environment.pop("LD_LIBRARY_PATH", None)
    return environment


def _target_user():
    config = _get_config()
    override = (config.get("usernameOverride") or "").strip()
    if override:
        return override

    uid = config.get("targetUid", DEFAULT_CONFIG["targetUid"])
    try:
        result = subprocess.run(
            ["id", "-nu", str(uid)],
            capture_output=True, text=True, check=True,
            env=_clean_subprocess_env(),
        )
        user = result.stdout.strip()
    except Exception as e:
        decky_plugin.logger.error(f"_target_user: id lookup failed for uid {uid}, falling back to 'deck': {e}")
        user = "deck"
    return user

def _run_as_user(command):
    config = _get_config()
    uid = config.get("targetUid", DEFAULT_CONFIG["targetUid"])
    user = _target_user()
    full_command = [
        "runuser", "-u", user, "--",
        "env",
        f"XDG_RUNTIME_DIR=/run/user/{uid}",
        f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus",
    ] + command
    return subprocess.run(full_command, capture_output=True, text=True, env=_clean_subprocess_env())


def _current_gamescope_unit():
    config = _get_config()
    glob_pattern = config.get("gamescopeUnitGlob") or DEFAULT_CONFIG["gamescopeUnitGlob"]
    result = _run_as_user(
        ["systemctl", "--user", "list-units", "--type=service", "--no-legend", glob_pattern]
    )
    for line in result.stdout.splitlines():
        line = line.strip()
        if line:
            return line.split()[0]
    return None


def _list_connected_displays():
    outputs = []
    drm_dir = "/sys/class/drm"
    try:
        entries = os.listdir(drm_dir)
    except Exception as e:
        decky_plugin.logger.error(f"_list_connected_displays: couldn't list {drm_dir}: {e}")
        return outputs

    for name in entries:
        status_path = os.path.join(drm_dir, name, "status")
        if not os.path.isfile(status_path):
            continue
        try:
            with open(status_path, "r") as f:
                state = f.read().strip()
        except Exception as e:
            decky_plugin.logger.error(f"_list_connected_displays: couldn't read {status_path}: {e}")
            continue
        if state != "connected":
            continue
        connector = re.sub(r"^card\d+-", "", name)
        if connector not in outputs:
            outputs.append(connector)

    return sorted(outputs)


def _list_audio_sinks():
    result = _run_as_user(["pactl", "-f", "json", "list", "sinks"])
    if result.returncode == 0:
        try:
            data = json.loads(result.stdout)
            sinks = []
            for sink in data:
                name = sink.get("name")
                if not name:
                    continue
                description = sink.get("description") or name
                sinks.append({"id": name, "description": description})
            return sinks
        except Exception as e:
            decky_plugin.logger.warning(f"_list_audio_sinks: JSON parse failed, falling back to shortform: {e}")

    result = _run_as_user(["pactl", "list", "short", "sinks"])
    sinks = []
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            name = parts[1]
            sinks.append({"id": name, "description": name})
    return sinks


def _get_default_sink():
    result = _run_as_user(["pactl", "get-default-sink"])
    if result.returncode == 0:
        value = result.stdout.strip()
        return value or None
    return None

async def _set_default_sink_with_retry(sink_id, attempts=12, delay_seconds=1.0):
    """
    Some audio outputs sharing one gpu codec only expose their subdevice
    as a pipewire sink once their connector is active, and the time it
    takes to do so can vary wildly by device.
    """
    last_error = None
    for attempt in range(attempts):
        result = _run_as_user(["pactl", "set-default-sink", sink_id])
        if result.returncode == 0:
            return {"ok": True}
        last_error = result.stderr
        await asyncio.sleep(delay_seconds)
    return {
        "ok": False,
        "error": f"'{sink_id}' did not became available after {attempts} attempts: {last_error}",
    }

class Plugin:
    async def _main(self):
        decky_plugin.logger.info("Output Manager loaded")
        self._background_task = asyncio.create_task(self._background_loop())

    async def _unload(self):
        decky_plugin.logger.info("Output Manager unloaded")
        task = getattr(self, "_background_task", None)
        if task:
            task.cancel()

    async def get_config(self):
        return _get_config()

    async def set_config(self, patch: dict):
        settings = _load_settings()
        config = settings.setdefault("config", {})

        if "targetUid" in patch:
            try:
                config["targetUid"] = int(patch["targetUid"])
            except (TypeError, ValueError):
                return {"ok": False, "error": "Target UID must be a number"}

        if "gamescopeUnitGlob" in patch:
            value = (patch["gamescopeUnitGlob"] or "").strip()
            config["gamescopeUnitGlob"] = value or DEFAULT_CONFIG["gamescopeUnitGlob"]

        if "usernameOverride" in patch:
            value = (patch["usernameOverride"] or "").strip()
            config["usernameOverride"] = value or None

        if "skipRestartWarning" in patch:
            config["skipRestartWarning"] = bool(patch["skipRestartWarning"])

        if "defaultDisplay" in patch:
            value = (patch["defaultDisplay"] or "").strip()
            config["defaultDisplay"] = value or None

        _save_settings(settings)
        return {"ok": True}

    async def get_current_output(self):
        result = _run_as_user(["systemctl", "--user", "show-environment"])
        for line in result.stdout.splitlines():
            if line.startswith("OUTPUT_CONNECTOR="):
                return line.split("=", 1)[1]
        return None

    async def get_state(self):
        settings = _load_settings()
        display_settings = settings.get("displays", {})
        audio_settings = settings.get("audio", {})

        connected_displays = set(_list_connected_displays())
        all_display_ids = sorted(connected_displays | set(display_settings.keys()))
        displays = []
        for display_id in all_display_ids:
            config = display_settings.get(display_id, {})
            displays.append({
                "id": display_id,
                "label": config.get("label") or display_id,
                "hidden": bool(config.get("hidden", False)),
                "defaultAudio": config.get("defaultAudio"),
                "connected": display_id in connected_displays,
            })

        sinks = _list_audio_sinks()
        sink_descriptions = {s["id"]: s["description"] for s in sinks}
        connected_audio_ids = set(sink_descriptions.keys())
        all_audio_ids = sorted(connected_audio_ids | set(audio_settings.keys()))
        audio = []
        for audio_id in all_audio_ids:
            config = audio_settings.get(audio_id, {})
            fallback_label = sink_descriptions.get(audio_id, audio_id)
            audio.append({
                "id": audio_id,
                "label": config.get("label") or fallback_label,
                "hidden": bool(config.get("hidden", False)),
                "connected": audio_id in connected_audio_ids,
            })

        return {
            "displays": displays,
            "audio": audio,
            "currentDisplay": await self.get_current_output(),
            "currentAudio": _get_default_sink(),
        }

    async def forget_output(self, output_type: str, output_id: str):
        if output_type not in ("displays", "audio"):
            return {"ok": False, "error": f"unknown output type: {output_type}"}
        settings = _load_settings()
        section = settings.get(output_type, {})
        if output_id in section:
            del section[output_id]
            _save_settings(settings)
        return {"ok": True}

    async def update_output(self, output_type: str, output_id: str, patch: dict):
        if output_type not in ("displays", "audio"):
            return {"ok": False, "error": f"unknown output type: {output_type}"}

        settings = _load_settings()
        section = settings.setdefault(output_type, {})
        entry = section.setdefault(output_id, {})

        if "label" in patch:
            label = (patch["label"] or "").strip()
            entry["label"] = label or None
        if "hidden" in patch:
            entry["hidden"] = bool(patch["hidden"])
        if output_type == "displays" and "defaultAudio" in patch:
            entry["defaultAudio"] = patch["defaultAudio"] or None

        _save_settings(settings)
        return {"ok": True}

    async def switch_audio(self, sink_id: str):
        try:
            result = await _set_default_sink_with_retry(sink_id)
            if not result["ok"]:
                decky_plugin.logger.error(f"switch_audio failed: {result['error']}")
            return result
        except Exception as e:
            decky_plugin.logger.error(f"switch_audio failed: {e}")
            return {"ok": False, "error": str(e)}

    async def switch_display(self, connector: str):
        return await self._do_switch_display(connector)

    async def _do_switch_display(self, connector: str):
        try:
            gamescope_unit = _current_gamescope_unit()
            if not gamescope_unit:
                error = "Couldn't find a running gamescope-session-plus@ unit. Ensure you're in gaming mode."
                decky_plugin.logger.error(error)
                return {"ok": False, "error": error}

            set_env = _run_as_user(["systemctl", "--user", "set-environment", f"OUTPUT_CONNECTOR={connector}"])
            if set_env.returncode != 0:
                decky_plugin.logger.error(f"set-environment failed: {set_env.stderr}")
                return {"ok": False, "error": set_env.stderr}

            restart = _run_as_user(["systemctl", "--user", "restart", gamescope_unit])
            if restart.returncode != 0:
                decky_plugin.logger.error(f"restart failed: {restart.stderr}")
                return {"ok": False, "error": restart.stderr}

            await asyncio.sleep(2)

            audio_restart = _run_as_user(["systemctl", "--user", "restart", "wireplumber.service", "pipewire.service", "pipewire-pulse.service"])
            if audio_restart.returncode != 0:
                decky_plugin.logger.warning(f"Audio stack restart after switch encountered an issue: {audio_restart.stderr}")

            settings = _load_settings()
            default_audio = settings.get("displays", {}).get(connector, {}).get("defaultAudio")
            if default_audio:
                audio_result = await _set_default_sink_with_retry(default_audio)
                if not audio_result["ok"]:
                    decky_plugin.logger.warning(f"Couldn't set default audio for {connector}: {audio_result['error']}")

            return {"ok": True}
        except Exception as e:
            decky_plugin.logger.error(f"switch_display failed: {e}")
            return {"ok": False, "error": str(e)}

    async def _apply_default_display_if_configured(self, source: str):
        config = _get_config()
        default_display = config.get("defaultDisplay")
        if not default_display:
            return

        current = await self.get_current_output()
        if current == default_display:
            return

        decky_plugin.logger.info(f"Applying default display '{default_display}' ({source})")
        result = await self._do_switch_display(default_display)
        if not result.get("ok"):
            decky_plugin.logger.warning(f"Couldn't apply default display on {source}: {result.get('error')}")

    async def _background_loop(self):
        await asyncio.sleep(5)
        await self._apply_default_display_if_configured("gaming mode start")

        last_monotonic = time.monotonic()
        last_boottime = time.clock_gettime(time.CLOCK_BOOTTIME)

        while True:
            await asyncio.sleep(RESUME_POLL_INTERVAL_SECONDS)
            now_monotonic = time.monotonic()
            now_boottime = time.clock_gettime(time.CLOCK_BOOTTIME)
            mono_delta = now_monotonic - last_monotonic
            boot_delta = now_boottime - last_boottime
            last_monotonic = now_monotonic
            last_boottime = now_boottime

            gap = boot_delta - mono_delta
            if gap > RESUME_GAP_THRESHOLD_SECONDS:
                decky_plugin.logger.info(f"Detected resume from suspend (gap {gap:.1f}s)")
                await self._apply_default_display_if_configured("resume from suspend")
