import {
    PanelSection,
    PanelSectionRow,
    ButtonItem,
    ToggleField,
    TextField,
    ConfirmModal,
    showModal,
    staticClasses,
    Navigation
} from "@decky/ui";

import { callable, definePlugin } from "@decky/api";
import { FC, useEffect, useState } from "react";
import { FaGithub, FaDisplay } from "react-icons/fa6";
import { SiBuymeacoffee } from "react-icons/si";

type OutputType = "displays" | "audio";

interface OutputItem {
    id: string;
    label: string;
    hidden: boolean;
    connected: boolean;
    defaultAudio?: string | null;
}

interface OutputState {
    displays: OutputItem[];
    audio: OutputItem[];
    currentDisplay: string | null;
    currentAudio: string | null;
}

interface ActionResult {
    ok: boolean;
    error?: string;
}

interface Config {
    targetUid: number;
    gamescopeUnitGlob: string;
    usernameOverride: string | null;
    skipRestartWarning: boolean;
    defaultDisplay: string | null;
}

const getState = callable<[], OutputState>("get_state");
const switchDisplay = callable<[string], ActionResult>("switch_display");
const switchAudio = callable<[string], ActionResult>("switch_audio");
const updateOutput = callable<[OutputType, string, Record<string, unknown>], ActionResult>(
    "update_output",
);
const forgetOutput = callable<[OutputType, string], ActionResult>("forget_output");
const getConfig = callable<[], Config>("get_config");
const setConfig = callable<[Record<string, unknown>], ActionResult>("set_config");

type View =
    | { name: "main" }
    | { name: "manage" }
    | { name: "edit"; outputType: OutputType; id: string }
    | { name: "pickAudio"; displayId: string }
    | { name: "settings" }
    | { name: "pickDefaultDisplay" }
    | { name: "about" };

const Content: FC = () => {
    const [state, setState] = useState<OutputState | null>(null);
    const [config, setConfigState] = useState<Config | null>(null);
    const [view, setView] = useState<View>({ name: "main" });
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = async () => {
        const s = await getState();
        setState(s);
    };

    const refreshConfig = async () => {
        const c = await getConfig();
        setConfigState(c);
    };

    useEffect(() => {
        refresh();
        refreshConfig();
    }, []);

    if (!state || !config) {
        return (
            <PanelSection>
                <PanelSectionRow>Loading…</PanelSectionRow>
            </PanelSection>
        );
    }

    if (view.name === "manage") {
        return (
            <ManageList
                state={state}
                onBack={() => setView({ name: "main" })}
                onSelect={(outputType, id) => setView({ name: "edit", outputType: outputType, id })}
            />
        );
    }

    if (view.name === "pickAudio") {
        const display = state.displays.find((d) => d.id === view.displayId);
        if (!display) {
            setView({ name: "manage" });
            return null;
        }
        return (
            <PickDefaultAudio
                current={display.defaultAudio ?? null}
                options={state.audio}
                onBack={() => setView({ name: "edit", outputType: "displays", id: view.displayId })}
                onPick={async (sinkId: any) => {
                    await updateOutput("displays", view.displayId, { defaultAudio: sinkId });
                    await refresh();
                    setView({ name: "edit", outputType: "displays", id: view.displayId });
                }}
            />
        );
    }

    if (view.name === "edit") {
        const list = state[view.outputType];
        const item = list.find((o: { id: any }) => o.id === view.id);
        if (!item) {
            setView({ name: "manage" });
            return null;
        }
        const defaultAudioLabel = item.defaultAudio
            ? (state.audio.find((a: { id: any }) => a.id === item.defaultAudio)?.label ??
              item.defaultAudio)
            : "None";
        return (
            <EditOutput
                outputType={view.outputType}
                item={item}
                defaultAudioLabel={defaultAudioLabel}
                onBack={() => setView({ name: "manage" })}
                onUpdate={async (patch: any) => {
                    await updateOutput(view.outputType, view.id, patch);
                    await refresh();
                }}
                onForget={async () => {
                    await forgetOutput(view.outputType, view.id);
                    await refresh();
                    setView({ name: "manage" });
                }}
                onPickDefaultAudio={
                    view.outputType === "displays"
                        ? () => setView({ name: "pickAudio", displayId: view.id })
                        : undefined
                }
            />
        );
    }

    if (view.name === "settings") {
        return (
            <SettingsPage
                config={config}
                displays={state.displays}
                onBack={() => setView({ name: "main" })}
                onUpdate={async (patch) => {
                    await setConfig(patch);
                    await refreshConfig();
                }}
                onPickDefaultDisplay={() => setView({ name: "pickDefaultDisplay" })}
            />
        );
    }

    if (view.name === "about") {
        return <AboutPage onBack={() => setView({ name: "main" })} />;
    }

    if (view.name === "pickDefaultDisplay") {
        return (
            <PickDefaultDisplay
                current={config.defaultDisplay ?? null}
                options={state.displays}
                onBack={() => setView({ name: "settings" })}
                onPick={async (id) => {
                    await setConfig({ defaultDisplay: id });
                    await refreshConfig();
                    setView({ name: "settings" });
                }}
            />
        );
    }

    const visibleDisplays = state.displays.filter((d) => !d.hidden && d.connected);
    const visibleAudio = state.audio.filter((a) => !a.hidden && a.connected);

    const doSwitchDisplay = async (id: string) => {
        setBusyId(id);
        setError(null);
        const result = await switchDisplay(id);
        setBusyId(null);
        if (result.ok) {
            refresh();
        } else {
            setError(result.error || "Switch failed");
        }
    };

    const onSwitchDisplay = (id: string) => {
        if (config.skipRestartWarning) {
            doSwitchDisplay(id);
            return;
        }
        showModal(
            <RestartWarningModal
                onConfirm={async (neverShowAgain) => {
                    if (neverShowAgain) {
                        await setConfig({ skipRestartWarning: true });
                        await refreshConfig();
                    }
                    doSwitchDisplay(id);
                }}
            />,
        );
    };

    const onSwitchAudio = async (id: string) => {
        setBusyId(id);
        setError(null);
        const result = await switchAudio(id);
        setBusyId(null);
        if (result.ok) {
            refresh();
        } else {
            setError(result.error || "Switch failed");
        }
    };

    return (
        <>
            <PanelSection title="Displays">
                {visibleDisplays.length === 0 && (
                    <PanelSectionRow>
                        No displays shown. Use "Manage Outputs" below to unhide one.
                    </PanelSectionRow>
                )}
                {visibleDisplays.map((d) => (
                    <PanelSectionRow key={d.id}>
                        <ButtonItem
                            layout="below"
                            disabled={busyId !== null}
                            onClick={() => onSwitchDisplay(d.id)}
                        >
                            {d.label}
                            {state.currentDisplay === d.id ? " • active" : ""}
                            {busyId === d.id ? " • switching…" : ""}
                        </ButtonItem>
                    </PanelSectionRow>
                ))}
            </PanelSection>

            <PanelSection title="Audio">
                {visibleAudio.length === 0 && (
                    <PanelSectionRow>
                        No audio outputs shown. Use "Manage Outputs" below to unhide one.
                    </PanelSectionRow>
                )}
                {visibleAudio.map((a) => (
                    <PanelSectionRow key={a.id}>
                        <ButtonItem
                            layout="below"
                            disabled={busyId !== null}
                            onClick={() => onSwitchAudio(a.id)}
                        >
                            {a.label}
                            {state.currentAudio === a.id ? " • active" : ""}
                            {busyId === a.id ? " • switching…" : ""}
                        </ButtonItem>
                    </PanelSectionRow>
                ))}
            </PanelSection>

            {error && (
                <PanelSection>
                    <PanelSectionRow>Error: {error}</PanelSectionRow>
                </PanelSection>
            )}

            <PanelSection>
                <PanelSectionRow>
                    <ButtonItem layout="below" onClick={() => setView({ name: "manage" })}>
                        Manage Outputs
                    </ButtonItem>
                </PanelSectionRow>
                <PanelSectionRow>
                    <ButtonItem layout="below" onClick={() => setView({ name: "settings" })}>
                        Settings
                    </ButtonItem>
                </PanelSectionRow>
                <PanelSectionRow>
                    <ButtonItem layout="below" onClick={() => setView({ name: "about" })}>
                        About
                    </ButtonItem>
                </PanelSectionRow>
            </PanelSection>
        </>
    );
};

const ManageList: FC<{
    state: OutputState;
    onBack: () => void;
    onSelect: (outputType: OutputType, id: string) => void;
}> = ({ state, onBack, onSelect }) => (
    <>
        <PanelSection title="Manage Outputs">
            <PanelSectionRow>
                <ButtonItem layout="below" onClick={onBack}>
                    ← Back
                </ButtonItem>
            </PanelSectionRow>
        </PanelSection>

        <PanelSection title="Displays">
            {state.displays.map((d) => (
                <PanelSectionRow key={d.id}>
                    <ButtonItem layout="below" onClick={() => onSelect("displays", d.id)}>
                        {d.label}
                        {!d.connected ? " (unplugged)" : ""}
                        {d.hidden ? " (hidden)" : ""}
                    </ButtonItem>
                </PanelSectionRow>
            ))}
        </PanelSection>

        <PanelSection title="Audio">
            {state.audio.map((a) => (
                <PanelSectionRow key={a.id}>
                    <ButtonItem layout="below" onClick={() => onSelect("audio", a.id)}>
                        {a.label}
                        {!a.connected ? " (unplugged)" : ""}
                        {a.hidden ? " (hidden)" : ""}
                    </ButtonItem>
                </PanelSectionRow>
            ))}
        </PanelSection>
    </>
);

const PickDefaultAudio: FC<{
    current: string | null;
    options: OutputItem[];
    onBack: () => void;
    onPick: (id: string | null) => void;
}> = ({ current, options, onBack, onPick }) => (
    <PanelSection title="Default Audio Device">
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={onBack}>
                ← Back
            </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => onPick(null)}>
                None
                {current === null ? " • selected" : ""}
            </ButtonItem>
        </PanelSectionRow>
        {options.map((a) => (
            <PanelSectionRow key={a.id}>
                <ButtonItem layout="below" onClick={() => onPick(a.id)}>
                    {a.label}
                    {current === a.id ? " • selected" : ""}
                </ButtonItem>
            </PanelSectionRow>
        ))}
    </PanelSection>
);

const PickDefaultDisplay: FC<{
    current: string | null;
    options: OutputItem[];
    onBack: () => void;
    onPick: (id: string | null) => void;
}> = ({ current, options, onBack, onPick }) => (
    <PanelSection title="Default Display">
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={onBack}>
                ← Back
            </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => onPick(null)}>
                None
                {current === null ? " • selected" : ""}
            </ButtonItem>
        </PanelSectionRow>
        {options.map((d) => (
            <PanelSectionRow key={d.id}>
                <ButtonItem layout="below" onClick={() => onPick(d.id)}>
                    {d.label}
                    {current === d.id ? " • selected" : ""}
                </ButtonItem>
            </PanelSectionRow>
        ))}
    </PanelSection>
);

const EditOutput: FC<{
    outputType: OutputType;
    item: OutputItem;
    defaultAudioLabel: string;
    onBack: () => void;
    onUpdate: (patch: Record<string, unknown>) => void;
    onForget: () => void;
    onPickDefaultAudio?: () => void;
}> = ({
    outputType: outputType,
    item,
    defaultAudioLabel,
    onBack,
    onUpdate,
    onForget,
    onPickDefaultAudio,
}) => {
    const [label, setLabel] = useState(item.label);

    return (
        <PanelSection title={outputType === "displays" ? "Edit Display" : "Edit Audio Output"}>
            <PanelSectionRow>
                <ButtonItem layout="below" onClick={onBack}>
                    ← Back
                </ButtonItem>
            </PanelSectionRow>

            {!item.connected && (
                <PanelSectionRow>This device isn't currently connected.</PanelSectionRow>
            )}

            <PanelSectionRow>
                <TextField
                    label="Display name"
                    value={label}
                    onChange={(e) => {
                        setLabel(e.target.value);
                        onUpdate({ label: e.target.value });
                    }}
                />
            </PanelSectionRow>

            <PanelSectionRow>
                <ToggleField
                    label="Hidden"
                    checked={item.hidden}
                    onChange={(checked) => onUpdate({ hidden: checked })}
                />
            </PanelSectionRow>

            {outputType === "displays" && onPickDefaultAudio && (
                <PanelSectionRow>
                    <ButtonItem layout="below" onClick={onPickDefaultAudio}>
                        Default audio: {defaultAudioLabel}
                    </ButtonItem>
                </PanelSectionRow>
            )}

            {!item.connected && (
                <PanelSectionRow>
                    <ButtonItem layout="below" onClick={onForget}>
                        Forget this output
                    </ButtonItem>
                </PanelSectionRow>
            )}
        </PanelSection>
    );
};

const RestartWarningModal: FC<{
    closeModal?: () => void;
    onConfirm: (neverShowAgain: boolean) => void;
}> = ({ closeModal, onConfirm }) => {
    const [neverShowAgain, setNeverShowAgain] = useState(false);

    return (
        <ConfirmModal
            strTitle="Switch Display?"
            strDescription="Switching displays restarts Gaming Mode. Any open games/applications will close. Are you sure you wish to proceed?"
            strOKButtonText="Switch"
            strCancelButtonText="Cancel"
            onOK={() => {
                onConfirm(neverShowAgain);
                closeModal?.();
            }}
            onCancel={() => closeModal?.()}
        >
            <PanelSectionRow></PanelSectionRow>
            <PanelSectionRow>
                <ToggleField
                    label="Don't show this again"
                    checked={neverShowAgain}
                    onChange={setNeverShowAgain}
                />
            </PanelSectionRow>
        </ConfirmModal>
    );
};

const SettingsPage: FC<{
    config: Config;
    displays: OutputItem[];
    onBack: () => void;
    onUpdate: (patch: Record<string, unknown>) => void;
    onPickDefaultDisplay: () => void;
}> = ({ config, displays, onBack, onUpdate, onPickDefaultDisplay }) => {
    const [uid, setUid] = useState(String(config.targetUid));
    const [glob, setGlob] = useState(config.gamescopeUnitGlob);
    const [username, setUsername] = useState(config.usernameOverride ?? "");

    const defaultDisplayLabel = config.defaultDisplay
        ? (displays.find((d) => d.id === config.defaultDisplay)?.label ?? config.defaultDisplay)
        : "None";

    return (
        <PanelSection title="Settings">
            <PanelSectionRow>
                <ButtonItem layout="below" onClick={onBack}>
                    ← Back
                </ButtonItem>
            </PanelSectionRow>

            <PanelSectionRow>
                <ButtonItem layout="below" onClick={onPickDefaultDisplay}>
                    Default display: {defaultDisplayLabel}
                </ButtonItem>
            </PanelSectionRow>

            <PanelSectionRow></PanelSectionRow>

            <PanelSectionRow>
                Only change the below settings if you know what you're doing. Incorrect values will
                break the plugin.
            </PanelSectionRow>

            <PanelSectionRow>
                <TextField
                    label="Target UID"
                    description="The uid of your desktop user (typically 1000)"
                    value={uid}
                    onChange={(e) => {
                        setUid(e.target.value);
                        const parsed = parseInt(e.target.value, 10);
                        if (!Number.isNaN(parsed)) {
                            onUpdate({ targetUid: parsed });
                        }
                    }}
                />
            </PanelSectionRow>

            <PanelSectionRow>
                <TextField
                    label="Gamescope unit glob"
                    description="systemd --user unit pattern used to find the gaming mode session"
                    value={glob}
                    onChange={(e) => {
                        setGlob(e.target.value);
                        onUpdate({ gamescopeUnitGlob: e.target.value });
                    }}
                />
            </PanelSectionRow>

            <PanelSectionRow>
                <TextField
                    label="Username override"
                    description="Leave blank to auto-detect from Target UID or fallback to 'deck'"
                    value={username}
                    onChange={(e) => {
                        setUsername(e.target.value);
                        onUpdate({ usernameOverride: e.target.value });
                    }}
                />
            </PanelSectionRow>

        </PanelSection>
    );
};

const AboutPage: FC<{ onBack: () => void }> = ({ onBack }) => (
    <PanelSection title="About">
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={onBack}>
                ← Back
            </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
            Output Manager v1.0.0 — switches display and audio outputs from the
            Quick Access Menu.
        </PanelSectionRow>
        <PanelSectionRow>
            Made by: joeatethebeans
        </PanelSectionRow>
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => Navigation.NavigateToExternalWeb("https://github.com/joeatethebeans/OutputManager")}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                    <FaGithub />
                    <span>View on GitHub</span>
                </div>
            </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => Navigation.NavigateToExternalWeb("https://buymeacoffee.com/joeatethebeans")}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                    <SiBuymeacoffee />
                    <span>Buy me a Coffee</span>
                </div>
            </ButtonItem>
        </PanelSectionRow>
    </PanelSection>
);

export default definePlugin(() => {
    return {
        name: "Output Manager",
        titleView: <div className={staticClasses.Title}>Output Manager</div>,
        content: <Content />,
        icon: <FaDisplay />
  };
});