import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sandboxManager } from "@/lib/sandbox/sandbox-manager";

export const runtime = "nodejs";

const EXCLUDES = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel"]);

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "agent";
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyDir(src: string, dest: string) {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDES.has(entry.name)) continue;
      await copyDir(path.join(src, entry.name), path.join(dest, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.copyFile(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

async function uniqueDir(baseDir: string, name: string) {
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = path.join(baseDir, `${name}${suffix}`);
    if (!fsSync.existsSync(candidate)) {
      await ensureDir(candidate);
      return candidate;
    }
    attempt += 1;
  }
}

async function runCommand(cmd: string, args: string[], cwd: string) {
  return await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    proc.on("error", (error: Error) => {
      resolve({ stdout, stderr: String(error), exitCode: 1 });
    });
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sandboxId = typeof body?.sandboxId === "string" ? body.sandboxId : "";
    const agentName = typeof body?.agentName === "string" ? body.agentName.trim() : "";
    const agentGoal = typeof body?.agentGoal === "string" ? body.agentGoal.trim() : "";
    const agentTone = typeof body?.agentTone === "string" ? body.agentTone.trim() : "";

    if (!sandboxId || !agentName) {
      return NextResponse.json(
        { error: "sandboxId and agentName are required" },
        { status: 400 },
      );
    }

    const provider =
      sandboxManager.getProvider(sandboxId) || sandboxManager.getActiveProvider();
    const workspace = provider?.getWorkspaceDir?.();
    if (!workspace) {
      return NextResponse.json(
        { error: "Local sandbox workspace not available" },
        { status: 400 },
      );
    }

    const publishRoot = path.resolve(process.cwd(), ".agent-builder", "published");
    await ensureDir(publishRoot);
    const slug = slugify(agentName);
    const publishDir = await uniqueDir(publishRoot, slug);

    await copyDir(workspace, publishDir);

    const agentWorkspaceRoot = path.resolve(process.cwd(), ".agent-builder", "workspaces");
    await ensureDir(agentWorkspaceRoot);
    const agentWorkspace = path.join(agentWorkspaceRoot, slug);
    await ensureDir(agentWorkspace);

    const repoRoot = path.resolve(process.cwd(), "..");

    const addResult = await runCommand(
      "pnpm",
      ["moltbot", "agents", "add", agentName, "--non-interactive", "--workspace", agentWorkspace, "--json"],
      repoRoot,
    );

    let agentId = slug;
    let addWarning: string | null = null;

    if (addResult.exitCode === 0) {
      try {
        const parsed = JSON.parse(addResult.stdout.trim());
        if (parsed?.agentId) agentId = String(parsed.agentId);
      } catch (error) {
        addWarning = "Agent created but JSON output could not be parsed.";
      }
    } else if (addResult.stderr.includes("already exists")) {
      addWarning = "Agent already exists; using existing configuration.";
    } else {
      return NextResponse.json(
        {
          error: "Failed to create Moltbot agent",
          details: addResult.stderr || addResult.stdout,
        },
        { status: 500 },
      );
    }

    const identityArgs = [
      "moltbot",
      "agents",
      "set-identity",
      "--agent",
      agentId,
      "--name",
      agentName,
    ];
    if (agentTone) {
      identityArgs.push("--theme", agentTone);
    }
    const identityResult = await runCommand("pnpm", identityArgs, repoRoot);

    const commands = {
      previewApp: `cd ${publishDir} && npm install && npm run dev`,
      runAgent: `pnpm moltbot agent --agent ${agentId} --message "Hello" --local`,
      listAgents: `pnpm moltbot agents list`,
    };

    return NextResponse.json({
      success: true,
      agentId,
      agentName,
      agentGoal,
      agentTone,
      publishDir,
      workspace: agentWorkspace,
      commands,
      warnings: [
        addWarning,
        identityResult.exitCode !== 0 ? identityResult.stderr || "Failed to set identity" : null,
      ].filter(Boolean),
    });
  } catch (error) {
    console.error("[agent-builder/publish] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish failed" },
      { status: 500 },
    );
  }
}
