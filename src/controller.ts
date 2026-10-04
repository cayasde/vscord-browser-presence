import { type Disposable, type Memento, type WindowState, debug, languages, window, workspace } from "vscode";
import { type SetActivity } from "@xhayper/discord-rpc";
import { SocialSdkClient, type SecureSecretStorage } from "./socialSdkClient";
import type { GatewayActivityButton } from "discord-api-types/v10";
import { getApplicationId } from "./helpers/getApplicationId";
import { activity, onDiagnosticsChange } from "./activity";
import { StatusBarMode, editor } from "./editor";
import { validURL } from "./helpers/validURL";
import { throttle } from "./helpers/throttle";
import { logError, logInfo } from "./logger";
import { CONFIG_KEYS } from "./constants";
import { getConfig } from "./config";
import { dataClass } from "./data";

const ELAPSED_TIME_STORAGE_KEY = "elapsedTimeSession";
const MAX_ELAPSED_TIME_RESUME_GAP_MS = 20 * 60 * 1000;

type PersistedElapsedTime = {
    startTimestamp: number;
    savedAt: number;
};

export class RPCController {
    listeners: Disposable[] = [];
    enabled = true;
    canSendActivity = true;
    manualIdleMode = false;
    manualIdling = false;
    state: SetActivity = {};
    debug = false;
    client: SocialSdkClient;

    private idleTimeout: NodeJS.Timeout | undefined;
    private iconTimeout: NodeJS.Timeout | undefined;
    private globalState: Memento | undefined;
    private activityThrottle = throttle(
        (isViewing?: boolean, isIdling?: boolean) => this.sendActivity(isViewing, isIdling),
        2000,
        true
    );

    constructor(clientId: string, debug = false) {
        const config = getConfig();
        this.client = new SocialSdkClient(clientId);
        this.debug = debug;
        this.manualIdleMode = config.get(CONFIG_KEYS.Status.Idle.Check) === false;

        editor.setStatusBarItem(StatusBarMode.Pending);
        this.client.on("debug", (...data) => {
            if (!this.debug) return;
            logInfo("[003] Debug:", ...data);
        });

        this.client.on("ready", this.onReady.bind(this));
        this.client.on("disconnected", this.onDisconnected.bind(this));
    }

    initialize(extensionPath: string, secrets: SecureSecretStorage, globalState?: Memento): void {
        this.globalState = globalState;
        this.restoreElapsedTime();
        this.client.configure(extensionPath, secrets);
        if (!getConfig().get(CONFIG_KEYS.Enable)) return;

        this.client.login().catch(async (error: Error) => {
            const config = getConfig();

            logError("Encountered following error while trying to login:", error);
            editor.setStatusBarItem(StatusBarMode.Disconnected);
            editor.errorMessageFailedToConnect(config, error);
            await this.client?.destroy();
            logInfo("[002] Destroyed Discord Social SDK client");
        });
    }

    private restoreElapsedTime(): void {
        const saved = this.globalState?.get<unknown>(ELAPSED_TIME_STORAGE_KEY);
        if (!saved || typeof saved !== "object") return;

        const { startTimestamp, savedAt } = saved as PersistedElapsedTime;
        const now = Date.now();
        if (
            !getConfig().get(CONFIG_KEYS.Status.ShowElapsedTime) ||
            !Number.isFinite(startTimestamp) ||
            !Number.isFinite(savedAt) ||
            savedAt > now ||
            now - savedAt > MAX_ELAPSED_TIME_RESUME_GAP_MS
        ) {
            return;
        }

        this.state.startTimestamp = startTimestamp;
        logInfo("Restored Rich Presence elapsed time from the previous VS Code session");
    }

    async persistElapsedTime(): Promise<void> {
        if (!this.globalState) return;

        const rawTimestamp = this.state.startTimestamp;
        const startTimestamp = rawTimestamp instanceof Date ? rawTimestamp.getTime() : rawTimestamp;
        try {
            if (
                !getConfig().get(CONFIG_KEYS.Status.ShowElapsedTime) ||
                typeof startTimestamp !== "number" ||
                !Number.isFinite(startTimestamp)
            ) {
                await this.globalState.update(ELAPSED_TIME_STORAGE_KEY, undefined);
                return;
            }

            await this.globalState.update(ELAPSED_TIME_STORAGE_KEY, {
                startTimestamp,
                savedAt: Date.now()
            } satisfies PersistedElapsedTime);
        } catch (error) {
            logError("Failed to persist Rich Presence elapsed time", error);
        }
    }

    private onReady() {
        logInfo("Successfully connected to Discord Social SDK");
        this.cleanUp();

        if (this.enabled) void this.enable();
        editor.setStatusBarItem(StatusBarMode.Succeeded);
    }

    private onDisconnected() {
        this.cleanUp();
        editor.setStatusBarItem(StatusBarMode.Disconnected);
    }

    private listen() {
        const config = getConfig();

        const fileSwitch = window.onDidChangeActiveTextEditor((e) => {
            logInfo("onDidChangeActiveTextEditor()");
            if (e) {
                this.activityThrottle.reset();
                void this.activityThrottle.callable();
                return;
            }
            setTimeout(() => {
                this.checkIdle(window.state);
            }, 500);
        });
        const fileEdit = workspace.onDidChangeTextDocument((e) => {
            if (e.document !== dataClass.editor?.document) return;
            logInfo("onDidChangeTextDocument()");
            this.activityThrottle.reset();
            void this.activityThrottle.callable();
        });
        const fileSelectionChanged = window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor !== dataClass.editor) return;
            logInfo("onDidChangeTextEditorSelection()");
            this.activityThrottle.reset();
            void this.activityThrottle.callable();
        });
        const debugStart = debug.onDidStartDebugSession(() => {
            void this.activityThrottle.callable();
        });
        const debugEnd = debug.onDidTerminateDebugSession(() => {
            void this.activityThrottle.callable();
        });
        const diagnosticsChange = languages.onDidChangeDiagnostics(() => onDiagnosticsChange());
        const changeWindowState = window.onDidChangeWindowState((e: WindowState) => {
            logInfo("onDidChangeWindowState()");
            this.checkIdle(e);
        });
        const gitInfoChange = dataClass.onDidChangeGitInfo(() => {
            this.activityThrottle.reset();
            void this.activityThrottle.callable();
        });

        // fire checkIdle at least once after loading
        this.checkIdle(window.state);

        if (config.get(CONFIG_KEYS.Status.Problems.Enabled)) this.listeners.push(diagnosticsChange);
        if (config.get(CONFIG_KEYS.Status.Idle.Check)) this.listeners.push(changeWindowState);

        this.listeners.push(fileSwitch, fileEdit, fileSelectionChanged, debugStart, debugEnd, gitInfoChange);
    }

    private checkCanSend(isIdling: boolean): boolean {
        const config = getConfig();
        let userId = this.client.user?.id;
        if (!userId) return false;
        if (isIdling && config.get(CONFIG_KEYS.Status.Idle.DisconnectOnIdle)) return (this.canSendActivity = false);
        let whitelistEnabled = config.get(CONFIG_KEYS.App.WhitelistEnabled);
        if (whitelistEnabled) {
            let whitelist = config.get(CONFIG_KEYS.App.Whitelist);
            if (config.get(CONFIG_KEYS.App.whitelistIsBlacklist))
                if (whitelist!.includes(userId)) return (this.canSendActivity = false);
                else return (this.canSendActivity = true);
            else if (!whitelist!.includes(userId)) return (this.canSendActivity = false);
        }
        return (this.canSendActivity = true);
    }

    private checkIdle(windowState: WindowState) {
        if (!this.enabled) return;

        const config = getConfig();

        if (config.get(CONFIG_KEYS.Status.Idle.Timeout) !== 0) {
            if (windowState.focused && this.idleTimeout) {
                clearTimeout(this.idleTimeout);
                void this.activityThrottle.callable();
            } else if (config.get(CONFIG_KEYS.Status.Idle.Check)) {
                this.idleTimeout = setTimeout(
                    async () => {
                        if (!config.get(CONFIG_KEYS.Status.Idle.Check)) return;

                        if (
                            config.get(CONFIG_KEYS.Status.Idle.DisconnectOnIdle) &&
                            config.get(CONFIG_KEYS.Status.Idle.ResetElapsedTime)
                        ) {
                            delete this.state.startTimestamp;
                        }

                        if (!this.enabled) return;

                        void this.activityThrottle.callable(false, true);
                    },
                    config.get(CONFIG_KEYS.Status.Idle.Timeout)! * 1000
                );
            }
        }
    }

    async login() {
        const { clientId } = getApplicationId(getConfig());
        logInfo("[004] Debug:", `Logging in with client ID "${clientId}"`);
        logInfo("[004] Debug:", "Login - isConnected", this.client.isConnected, "applicationId", this.client.clientId);

        if (this.client.isConnected && this.client.clientId === clientId) return;

        editor.setStatusBarItem(StatusBarMode.Pending);

        if (this.client.clientId !== clientId) await this.updateClientId(clientId);
        else if (!this.client.isConnected) await this.client.login();
    }

    async sendActivity(isViewing = false, isIdling = false): Promise<void> {
        if (!this.enabled) return;
        if (this.manualIdleMode) isIdling = this.manualIdling;
        this.checkCanSend(isIdling);
        this.state = await activity(this.state, isViewing, isIdling);
        this.state.instance = true;
        if (!this.state || Object.keys(this.state).length === 0 || !this.canSendActivity)
            return void this.client.user?.clearActivity(process.pid);
        const filteredButton: GatewayActivityButton[] = [];
        this.state.buttons = (this.state.buttons ?? []).filter((button) => {
            const isValid = validURL(button.url);
            if (!isValid) filteredButton.push(button);
            return isValid;
        });

        if (filteredButton.length > 0)
            logInfo(
                "[005]",
                "Invalid buttons!\n",
                filteredButton.map((button) => JSON.stringify(button, null, 2)).join("\n")
            );

        return this.client.user?.setActivity(this.state, process.pid);
    }

    async disable() {
        this.enabled = false;

        this.cleanUp();
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        if (this.iconTimeout) clearTimeout(this.iconTimeout);

        await this.client.user?.clearActivity(process.pid);
    }

    async enable() {
        logInfo("[004] Debug:", "Enabling Discord Social SDK Rich Presence");

        this.enabled = true;

        await this.login();
        logInfo("[004] Debug:", "Client Should be logged in");
        logInfo("[004] Debug:", `Enable - connected=${this.client.isConnected}`);

        editor.setStatusBarItem(StatusBarMode.Succeeded);

        logInfo("[004] Debug:", "Enabled - isConnected", this.client.isConnected);
        await this.activityThrottle.callable();
        this.cleanUp();
        this.listen();

        if (this.iconTimeout) clearTimeout(this.iconTimeout);
    }

    async updateClientId(clientId: string) {
        if (this.client.clientId === clientId) return;
        await this.client.destroy();
        this.client.clientId = clientId;
        await this.client.login();
        if (this.enabled) await this.sendActivity();
    }

    cleanUp() {
        for (const listener of this.listeners) listener.dispose();
        this.listeners = [];
    }

    async destroy() {
        await this.disable();
        await this.client.destroy();
    }
}
