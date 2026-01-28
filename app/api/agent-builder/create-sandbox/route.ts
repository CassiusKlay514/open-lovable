import { NextResponse } from "next/server";
import { SandboxFactory } from "@/lib/sandbox/factory";
import type { SandboxState } from "@/types/sandbox";
import { sandboxManager } from "@/lib/sandbox/sandbox-manager";

export const runtime = "nodejs";

declare global {
  var activeSandboxProvider: any;
  var sandboxData: any;
  var existingFiles: Set<string>;
  var sandboxState: SandboxState;
}

export async function POST() {
  try {
    await sandboxManager.terminateAll();

    if (global.activeSandboxProvider) {
      try {
        await global.activeSandboxProvider.terminate();
      } catch (error) {
        console.error("[agent-builder/create-sandbox] Failed to terminate legacy sandbox:", error);
      }
      global.activeSandboxProvider = null;
    }

    if (global.existingFiles) {
      global.existingFiles.clear();
    } else {
      global.existingFiles = new Set<string>();
    }

    const provider = SandboxFactory.create("local");
    const sandboxInfo = await provider.createSandbox();

    await provider.setupViteApp();

    sandboxManager.registerSandbox(sandboxInfo.sandboxId, provider);

    global.activeSandboxProvider = provider;
    global.sandboxData = {
      sandboxId: sandboxInfo.sandboxId,
      url: sandboxInfo.url,
    };

    global.sandboxState = {
      fileCache: {
        files: {},
        lastSync: Date.now(),
        sandboxId: sandboxInfo.sandboxId,
      },
      sandbox: provider,
      sandboxData: {
        sandboxId: sandboxInfo.sandboxId,
        url: sandboxInfo.url,
      },
    };

    return NextResponse.json({
      success: true,
      sandboxId: sandboxInfo.sandboxId,
      url: sandboxInfo.url,
      provider: sandboxInfo.provider,
      message: "Local sandbox created and preview server started",
    });
  } catch (error) {
    console.error("[agent-builder/create-sandbox] Error:", error);
    await sandboxManager.terminateAll();
    if (global.activeSandboxProvider) {
      try {
        await global.activeSandboxProvider.terminate();
      } catch (err) {
        console.error("[agent-builder/create-sandbox] Failed to terminate sandbox:", err);
      }
      global.activeSandboxProvider = null;
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to create sandbox",
        details: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}
