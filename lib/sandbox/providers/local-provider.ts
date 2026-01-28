import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

import { appConfig } from "@/config/app.config";
import { SandboxProvider, type SandboxInfo, type CommandResult } from "../types";

type DevProcess = ReturnType<typeof spawn>;

const DEFAULT_EXCLUDES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".vercel",
]);

function makeSandboxId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function findAvailablePort(start: number, range: number) {
  for (let i = 0; i <= range; i += 1) {
    const port = start + i;
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error(`No available ports in range ${start}-${start + range}`);
}

function toCommandResult(stdout: string, stderr: string, exitCode: number | null): CommandResult {
  const code = exitCode ?? 1;
  return {
    stdout,
    stderr,
    exitCode: code,
    success: code === 0,
  };
}

export class LocalProvider extends SandboxProvider {
  private workspaceDir: string | null = null;
  private port: number | null = null;
  private devProcess: DevProcess | null = null;

  private resolveWorkspace() {
    if (!this.workspaceDir) throw new Error("Sandbox workspace not initialized");
    return this.workspaceDir;
  }

  private resolvePath(targetPath: string) {
    const workspace = this.resolveWorkspace();
    const resolved = path.resolve(workspace, targetPath);
    if (!resolved.startsWith(workspace)) {
      throw new Error("Invalid sandbox path");
    }
    return resolved;
  }

  async createSandbox(): Promise<SandboxInfo> {
    const root = path.resolve(
      process.cwd(),
      appConfig.localSandbox.rootDir || ".agent-builder/sandboxes",
    );
    await ensureDir(root);

    const sandboxId = makeSandboxId();
    const workspaceDir = path.join(root, sandboxId);
    await ensureDir(workspaceDir);

    const port = await findAvailablePort(
      appConfig.localSandbox.basePort,
      appConfig.localSandbox.portRange,
    );

    const url = `http://127.0.0.1:${port}`;
    const info: SandboxInfo = {
      sandboxId,
      url,
      provider: "local",
      createdAt: new Date(),
      rootDir: workspaceDir,
    };

    this.workspaceDir = workspaceDir;
    this.port = port;
    this.sandboxInfo = info;

    return info;
  }

  async runCommand(command: string): Promise<CommandResult> {
    const cwd = this.resolveWorkspace();

    return await new Promise<CommandResult>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        resolve(toCommandResult(stdout, stderr, code));
      });
      child.on("error", (error) => {
        resolve(toCommandResult(stdout, String(error), 1));
      });
    });
  }

  async writeFile(targetPath: string, content: string): Promise<void> {
    const resolved = this.resolvePath(targetPath);
    await ensureDir(path.dirname(resolved));
    await fs.writeFile(resolved, content, "utf-8");
  }

  async readFile(targetPath: string): Promise<string> {
    const resolved = this.resolvePath(targetPath);
    return await fs.readFile(resolved, "utf-8");
  }

  async listFiles(directory?: string): Promise<string[]> {
    const base = directory ? this.resolvePath(directory) : this.resolveWorkspace();
    const results: string[] = [];

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (DEFAULT_EXCLUDES.has(entry.name)) continue;
          await walk(path.join(dir, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        const fullPath = path.join(dir, entry.name);
        const relative = path.relative(this.resolveWorkspace(), fullPath);
        results.push(relative);
      }
    };

    await walk(base);
    return results;
  }

  async installPackages(packages: string[]): Promise<CommandResult> {
    if (!packages.length) return toCommandResult("", "", 0);
    const quoted = packages.map((pkg) => `"${pkg}"`).join(" ");
    return await this.runCommand(`npm install ${quoted}`);
  }

  async setupViteApp(): Promise<void> {
    const workspace = this.resolveWorkspace();
    const port = this.port ?? appConfig.localSandbox.basePort;

    const packageJsonPath = path.join(workspace, "package.json");
    const hasPackageJson = await fileExists(packageJsonPath);

    if (!hasPackageJson) {
      const packageJson = {
        name: "agent-app",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "vite",
          build: "vite build",
          preview: "vite preview",
        },
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
        },
        devDependencies: {
          "@vitejs/plugin-react": "^4.0.0",
          autoprefixer: "^10.4.16",
          postcss: "^8.4.31",
          tailwindcss: "^3.3.0",
          vite: "^4.3.9",
        },
      };

      await this.writeFile("package.json", JSON.stringify(packageJson, null, 2));
      await this.writeFile(
        "vite.config.ts",
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.VITE_PORT || ${port});

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    hmr: true,
    allowedHosts: ["localhost", "127.0.0.1"],
  },
});`,
      );

      await this.writeFile(
        "tailwind.config.js",
        `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};`,
      );

      await this.writeFile(
        "postcss.config.js",
        `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};`,
      );

      await this.writeFile(
        "index.html",
        `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agent App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
      );

      await this.writeFile(
        "src/main.jsx",
        `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`,
      );

      await this.writeFile(
        "src/App.jsx",
        `export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-semibold mb-3">Agent app ready</h1>
        <p className="text-slate-300">Describe your idea to generate a UI.</p>
      </div>
    </main>
  );
}`,
      );

      await this.writeFile(
        "src/index.css",
        `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: system-ui, sans-serif;
}`,
      );
    }

    const nodeModulesPath = path.join(workspace, "node_modules");
    if (!fsSync.existsSync(nodeModulesPath)) {
      await this.runCommand("npm install");
    }

    await this.startDevServer();
  }

  async restartViteServer(): Promise<void> {
    await this.stopDevServer();
    await this.startDevServer();
  }

  async terminate(): Promise<void> {
    await this.stopDevServer();
  }

  isAlive(): boolean {
    return Boolean(this.devProcess && !this.devProcess.killed);
  }

  getSandboxUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  getSandboxInfo(): SandboxInfo | null {
    return this.sandboxInfo;
  }

  getWorkspaceDir(): string | null {
    return this.workspaceDir;
  }

  private async startDevServer() {
    if (this.devProcess) return;
    const workspace = this.resolveWorkspace();
    const port = this.port ?? appConfig.localSandbox.basePort;

    const logPath = path.join(workspace, "vite.log");
    const logStream = fsSync.createWriteStream(logPath, { flags: "a" });

    const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env: {
        ...process.env,
        VITE_PORT: String(port),
        BROWSER: "none",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    child.on("exit", () => {
      this.devProcess = null;
      logStream.end();
    });

    this.devProcess = child;

    await new Promise((resolve) =>
      setTimeout(resolve, appConfig.localSandbox.devServerStartupDelay),
    );
  }

  private async stopDevServer() {
    if (!this.devProcess?.pid) return;
    const pid = this.devProcess.pid;

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    this.devProcess = null;
  }
}
