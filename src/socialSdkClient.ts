import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { SetActivity } from "@xhayper/discord-rpc";
import { logError, logInfo } from "./logger";

const REFRESH_TOKEN_KEY = "vscord.socialSdk.refreshToken";

export interface SecureSecretStorage {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
}

interface SocialSdkUser {
    id: string;
    setActivity(activity: SetActivity, pid?: number): Promise<void>;
    clearActivity(pid?: number): Promise<void>;
}

export class SocialSdkClient extends EventEmitter {
    clientId: string;
    isConnected = false;
    user: SocialSdkUser | undefined;

    private child: ChildProcessWithoutNullStreams | undefined;
    private readyPromise: Promise<void> | undefined;
    private readyResolve: (() => void) | undefined;
    private readyReject: ((error: Error) => void) | undefined;
    private authStarted = false;
    private destroying = false;

    private extensionPath: string | undefined;
    private secrets: SecureSecretStorage | undefined;

    constructor(clientId: string) {
        super();
        this.clientId = clientId;
    }

    configure(extensionPath: string, secrets: SecureSecretStorage): void {
        this.extensionPath = extensionPath;
        this.secrets = secrets;
    }

    async login(): Promise<void> {
        if (this.isConnected) return;
        if (!this.extensionPath || !this.secrets) {
            throw new Error("Discord Social SDK client has not been initialized by the VS Code extension.");
        }

        const readyPromise = this.waitForReady();
        try {
            this.startHost();
            if (!this.authStarted) {
                this.authStarted = true;
                const key = `${REFRESH_TOKEN_KEY}.${this.clientId}`;
                const refreshToken = await this.secrets.get(key);
                this.send(refreshToken ? `REFRESH\t${this.encode(refreshToken)}` : "AUTHORIZE");
            }
        } catch (error) {
            this.authStarted = false;
            this.failLogin(error instanceof Error ? error : new Error(String(error)));
        }
        return readyPromise;
    }

    async destroy(): Promise<void> {
        const child = this.child;
        if (!child) return;

        this.destroying = true;
        this.user = undefined;
        this.isConnected = false;
        this.readyPromise = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
        child.stdin.write("CLEAR\n");
        child.stdin.write("EXIT\n");
        child.stdin.end();

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                child.kill();
                resolve();
            }, 2000);
            child.once("close", () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        if (this.child === child) this.child = undefined;
        this.destroying = false;
        this.authStarted = false;
    }

    private waitForReady(): Promise<void> {
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        return this.readyPromise;
    }

    private startHost(): void {
        if (this.child && this.child.exitCode === null && !this.child.killed) return;
        if (process.platform !== "win32" || process.arch !== "x64") {
            throw new Error("The bundled Discord Social SDK host currently supports Windows x64 only.");
        }
        if (!this.extensionPath) {
            throw new Error("Discord Social SDK client has no extension installation path.");
        }

        const hostPath = join(this.extensionPath, "native", "bin", "win32-x64", "vscord-social-sdk-host.exe");
        const child = spawn(hostPath, [this.clientId], {
            cwd: join(this.extensionPath, "native", "bin", "win32-x64"),
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        });
        this.child = child;

        const output = createInterface({ input: child.stdout });
        output.on("line", (line) => {
            void this.handleHostMessage(line).catch((error: unknown) => {
                this.failLogin(error instanceof Error ? error : new Error(String(error)));
            });
        });
        child.stderr.on("data", (chunk: Buffer) => {
            const message = chunk.toString("utf8").trim();
            if (message) logError("Discord Social SDK host:", message);
        });
        child.on("error", (error) => this.failLogin(error));
        child.on("exit", (code, signal) => {
            if (this.child !== child) return;
            this.child = undefined;
            this.user = undefined;
            this.isConnected = false;
            this.authStarted = false;
            if (!this.destroying) {
                this.failLogin(new Error(`Discord Social SDK host exited (${signal ?? code ?? "unknown"}).`));
                this.emit("disconnected");
            }
        });
    }

    private async handleHostMessage(line: string): Promise<void> {
        const [event, ...fields] = line.split("\t");
        switch (event) {
            case "STARTED":
                logInfo("Started Discord Social SDK host.");
                break;
            case "READY": {
                const userId = fields[0] ?? "";
                this.user = {
                    id: userId,
                    setActivity: (activity) => this.setActivity(activity),
                    clearActivity: () => this.clearActivity()
                };
                this.isConnected = true;
                this.readyResolve?.();
                this.readyResolve = undefined;
                this.readyReject = undefined;
                this.emit("ready");
                break;
            }
            case "TOKENS": {
                const [accessToken, refreshToken] = fields;
                if (!accessToken || !refreshToken) {
                    this.failLogin(new Error("Discord returned an incomplete OAuth token response."));
                    this.send("TOKEN_STORE_FAILED");
                    break;
                }
                try {
                    await this.secrets?.store(`${REFRESH_TOKEN_KEY}.${this.clientId}`, refreshToken);
                    this.send("TOKENS_STORED");
                } catch (error) {
                    logError("Could not securely store the Discord Social SDK refresh token:", error);
                    this.send("TOKEN_STORE_FAILED");
                    this.failLogin(new Error("VS Code could not securely store the Discord refresh token."));
                }
                break;
            }
            case "AUTH_REQUIRED":
                await this.secrets?.delete(`${REFRESH_TOKEN_KEY}.${this.clientId}`);
                this.send("AUTHORIZE");
                break;
            case "AUTH_ERROR":
                this.authStarted = false;
                this.failLogin(new Error(fields.join("\t") || "Discord authorization failed."));
                break;
            case "ERROR":
            case "PRESENCE_ERROR":
                this.failLogin(new Error(fields.join("\t") || "Discord Social SDK error."));
                logError("Discord Social SDK:", fields.join(" "));
                break;
            case "DISCONNECTED":
                this.user = undefined;
                this.isConnected = false;
                this.authStarted = false;
                this.readyPromise = undefined;
                this.readyResolve = undefined;
                this.readyReject = undefined;
                this.emit("disconnected");
                break;
            default:
                if (line) this.emit("debug", line);
        }
    }

    private setActivity(activity: SetActivity): Promise<void> {
        const buttons = activity.buttons ?? [];
        const startTimestamp = activity.startTimestamp instanceof Date
            ? activity.startTimestamp.getTime()
            : activity.startTimestamp ?? 0;
        const fields = [
            "PRESENCE",
            this.encode(activity.details),
            this.encode(activity.state),
            this.encode(activity.largeImageKey),
            this.encode(activity.largeImageText),
            this.encode(activity.smallImageKey),
            this.encode(activity.smallImageText),
            String(startTimestamp),
            this.encode(buttons[0]?.label),
            this.encode(buttons[0]?.url),
            this.encode(buttons[1]?.label),
            this.encode(buttons[1]?.url)
        ];
        this.send(fields.join("\t"));
        return Promise.resolve();
    }

    private clearActivity(): Promise<void> {
        this.send("CLEAR");
        return Promise.resolve();
    }

    private send(command: string): void {
        if (!this.child || this.child.stdin.destroyed) {
            throw new Error("Discord Social SDK host is not running.");
        }
        this.child.stdin.write(`${command}\n`);
    }

    private encode(value: string | number | undefined): string {
        return value === undefined ? "" : Buffer.from(String(value), "utf8").toString("base64");
    }

    private failLogin(error: Error): void {
        this.readyReject?.(error);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        this.readyPromise = undefined;
    }
}
