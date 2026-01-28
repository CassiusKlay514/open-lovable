"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { appConfig } from "@/config/app.config";
import { toast } from "sonner";

type SandboxData = {
  sandboxId: string;
  url: string;
};

type PublishResult = {
  agentId: string;
  publishDir: string;
  workspace: string;
  commands: Record<string, string>;
  warnings?: string[];
};

const steps = ["Idée", "Test", "Publier"] as const;

function buildSpec(params: {
  idea: string;
  name: string;
  goal: string;
  tone: string;
}) {
  return {
    idea: params.idea,
    agentName: params.name,
    objective: params.goal,
    tone: params.tone,
    output: "vite-react",
    preview: "local",
  };
}

function buildPrompt(spec: Record<string, unknown>) {
  return [
    "You are building a complete React + Vite web app for a non-technical user.",
    "Use the existing Vite project structure and generate real UI components.",
    "Focus on clarity, simple navigation, and a polished single-page experience.",
    "Return files using <file path=\"...\"> blocks only.",
    "",
    "Product spec (JSON):",
    JSON.stringify(spec, null, 2),
  ].join("\n");
}

export default function AgentBuilderPage() {
  const [step, setStep] = useState(0);
  const [idea, setIdea] = useState("");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [tone, setTone] = useState("");
  const [advancedEnabled, setAdvancedEnabled] = useState(false);
  const [advancedJson, setAdvancedJson] = useState("");
  const [advancedDirty, setAdvancedDirty] = useState(false);

  const [sandbox, setSandbox] = useState<SandboxData | null>(null);
  const [status, setStatus] = useState("Prêt à générer.");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<"idle" | "running" | "stopped" | "error">(
    "idle",
  );
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const spec = useMemo(
    () =>
      buildSpec({
        idea,
        name,
        goal,
        tone,
      }),
    [idea, name, goal, tone],
  );

  useEffect(() => {
    if (advancedDirty) return;
    setAdvancedJson(JSON.stringify(spec, null, 2));
  }, [spec, advancedDirty]);

  useEffect(() => {
    if (!sandbox) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/sandbox-status");
        const data = await res.json();
        if (data.active && data.healthy) {
          setPreviewStatus("running");
          return;
        }
        if (data.active && !data.healthy) {
          setPreviewStatus("error");
          return;
        }
        setPreviewStatus("stopped");
      } catch {
        setPreviewStatus("error");
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [sandbox]);

  const handleGenerate = async () => {
    if (!idea.trim()) {
      toast.error("Décris ton idée pour démarrer.");
      return;
    }
    if (!name.trim()) {
      toast.error("Ajoute un nom pour l'agent.");
      return;
    }

    let parsedSpec = spec;
    if (advancedEnabled) {
      try {
        parsedSpec = JSON.parse(advancedJson);
      } catch {
        toast.error("Le JSON avancé est invalide.");
        return;
      }
    }

    setIsGenerating(true);
    setStatus("Création du sandbox local...");
    setPublishResult(null);

    try {
      const sandboxRes = await fetch("/api/agent-builder/create-sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const sandboxData = await sandboxRes.json();
      if (!sandboxRes.ok || !sandboxData.success) {
        throw new Error(sandboxData.error || "Impossible de créer le sandbox");
      }
      setSandbox({ sandboxId: sandboxData.sandboxId, url: sandboxData.url });
      setPreviewStatus("running");

      setStatus("Génération de l'app...");

      const prompt = buildPrompt(parsedSpec);
      const response = await fetch("/api/generate-ai-code-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          model: appConfig.ai.defaultModel,
          context: {
            sandboxId: sandboxData.sandboxId,
            recentMessages: [],
            structure: "",
            currentCode: "",
            sandboxUrl: sandboxData.url,
          },
          isEdit: false,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Génération AI impossible.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let generatedCode = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.type === "status" && payload.message) {
              setStatus(payload.message);
            }
            if (payload.type === "complete" && payload.generatedCode) {
              generatedCode = payload.generatedCode;
            }
          } catch {
            // Ignore malformed chunks
          }
        }
      }

      if (!generatedCode) {
        throw new Error("La génération n'a pas produit de code.");
      }

      setIsApplying(true);
      setStatus("Application du code...");

      const applyRes = await fetch("/api/apply-ai-code-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: generatedCode,
          isEdit: false,
          sandboxId: sandboxData.sandboxId,
        }),
      });

      if (!applyRes.ok || !applyRes.body) {
        throw new Error("Impossible d'appliquer le code.");
      }

      const applyReader = applyRes.body.getReader();
      const applyDecoder = new TextDecoder();
      let applyBuffer = "";
      let applyDone = false;

      while (true) {
        const { done, value } = await applyReader.read();
        if (done) break;
        applyBuffer += applyDecoder.decode(value, { stream: true });
        const lines = applyBuffer.split("\n");
        applyBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.type === "step" && payload.message) {
              setStatus(payload.message);
            }
            if (payload.type === "complete") {
              applyDone = true;
            }
          } catch {
            // Ignore malformed chunks
          }
        }
      }

      if (!applyDone) {
        throw new Error("Application incomplète.");
      }

      setStatus("App prête. Tu peux tester.");
      setStep(1);

      if (iframeRef.current) {
        iframeRef.current.src = sandboxData.url;
      }
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Erreur pendant la génération");
      setStatus("Erreur pendant la génération.");
    } finally {
      setIsGenerating(false);
      setIsApplying(false);
    }
  };

  const handlePublish = async () => {
    if (!sandbox) return;
    setStatus("Publication en cours...");

    try {
      const res = await fetch("/api/agent-builder/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId: sandbox.sandboxId,
          agentName: name,
          agentGoal: goal,
          agentTone: tone,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Publication impossible");
      }
      setPublishResult(data as PublishResult);
      setStatus("Agent publié.");
      setStep(2);
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Erreur de publication");
      setStatus("Erreur de publication.");
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <header className="mb-10">
          <p className="text-sm text-neutral-400 uppercase tracking-widest">Moltbot Agent Builder</p>
          <h1 className="text-4xl font-semibold mt-3">Créer, tester, publier une web app d’agent</h1>
          <p className="text-neutral-400 mt-3 max-w-2xl">
            Décris une idée, laisse l’IA générer une web app fonctionnelle, teste-la en local,
            puis publie l’agent Moltbot associé.
          </p>
        </header>

        <div className="flex gap-4 mb-8">
          {steps.map((label, index) => (
            <div
              key={label}
              className={`flex-1 rounded-2xl border px-4 py-3 ${
                step === index
                  ? "border-white bg-white/10"
                  : "border-neutral-800 bg-neutral-900/50"
              }`}
            >
              <p className="text-xs text-neutral-400 uppercase tracking-widest">Étape {index + 1}</p>
              <p className="text-lg mt-1">{label}</p>
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="grid gap-6 md:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-3xl border border-neutral-800 bg-neutral-900/60 p-6 space-y-6">
              <div>
                <label className="text-sm text-neutral-300">Idée</label>
                <textarea
                  className="mt-2 w-full rounded-2xl bg-neutral-950 border border-neutral-800 p-4 text-sm"
                  rows={5}
                  value={idea}
                  onChange={(event) => setIdea(event.target.value)}
                  placeholder="Ex: Un agent qui aide à organiser les rendez-vous et envoie des rappels."
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-sm text-neutral-300">Nom de l’agent</label>
                  <input
                    className="mt-2 w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Ex: PlannerPro"
                  />
                </div>
                <div>
                  <label className="text-sm text-neutral-300">Ton</label>
                  <input
                    className="mt-2 w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm"
                    value={tone}
                    onChange={(event) => setTone(event.target.value)}
                    placeholder="Ex: chaleureux, pro, synthétique"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-neutral-300">Objectif</label>
                <input
                  className="mt-2 w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm"
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="Ex: Automatiser la prise de rendez-vous."
                />
              </div>
              <div className="flex items-center justify-between border-t border-neutral-800 pt-4">
                <div>
                  <p className="text-sm font-medium">Mode avancé</p>
                  <p className="text-xs text-neutral-400">Éditer le JSON qui pilote la génération.</p>
                </div>
                <button
                  className={`rounded-full px-4 py-2 text-xs ${
                    advancedEnabled ? "bg-white text-neutral-950" : "bg-neutral-800 text-white"
                  }`}
                  onClick={() => setAdvancedEnabled((prev) => !prev)}
                  type="button"
                >
                  {advancedEnabled ? "Activé" : "Désactivé"}
                </button>
              </div>
              {advancedEnabled && (
                <textarea
                  className="w-full rounded-2xl bg-neutral-950 border border-neutral-800 p-4 text-xs font-mono"
                  rows={10}
                  value={advancedJson}
                  onChange={(event) => {
                    setAdvancedDirty(true);
                    setAdvancedJson(event.target.value);
                  }}
                />
              )}
              <button
                className="w-full rounded-2xl bg-white text-neutral-950 py-3 font-semibold disabled:opacity-60"
                onClick={handleGenerate}
                disabled={isGenerating || isApplying}
              >
                {isGenerating || isApplying ? "Génération en cours..." : "Générer la web app"}
              </button>
              <p className="text-xs text-neutral-500">{status}</p>
            </div>

            <div className="rounded-3xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-4">
              <h2 className="text-lg font-semibold">Ce qui sera généré</h2>
              <ul className="text-sm text-neutral-300 space-y-2">
                <li>• Web app React + Vite prête pour la preview locale.</li>
                <li>• UI claire et simple pour des non-techs.</li>
                <li>• Agent Moltbot associé au projet.</li>
              </ul>
              <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4 text-xs text-neutral-400">
              <p>
                LLM utilisé:{" "}
                {appConfig.ai.modelDisplayNames[appConfig.ai.defaultModel] ||
                  appConfig.ai.defaultModel}
              </p>
                <p>Sandbox: local</p>
                <p>Preview: http://localhost:port</p>
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="rounded-3xl border border-neutral-800 bg-neutral-900/60 p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold">Preview locale</h2>
                  <p className="text-sm text-neutral-400">
                    Statut: {previewStatus === "running" ? "running" : previewStatus}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-xl border border-neutral-700 px-3 py-2 text-xs"
                    onClick={() => iframeRef.current?.contentWindow?.location.reload()}
                    type="button"
                  >
                    Rafraîchir
                  </button>
                  {sandbox?.url && (
                    <a
                      className="rounded-xl border border-neutral-700 px-3 py-2 text-xs"
                      href={sandbox.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ouvrir
                    </a>
                  )}
                </div>
              </div>
              <div className="rounded-2xl overflow-hidden border border-neutral-800 bg-black h-[540px]">
                {sandbox?.url ? (
                  <iframe ref={iframeRef} src={sandbox.url} className="h-full w-full" />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-neutral-500">
                    Aucune preview disponible.
                  </div>
                )}
              </div>
              <div className="mt-4 flex justify-between items-center">
                <p className="text-xs text-neutral-500">{status}</p>
                <button
                  className="rounded-2xl bg-white text-neutral-950 px-5 py-2 text-sm font-semibold"
                  onClick={() => setStep(2)}
                  type="button"
                >
                  Continuer
                </button>
              </div>
            </div>

            <div className="rounded-3xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-4">
              <h3 className="text-lg font-semibold">Checklist de test</h3>
              <ul className="text-sm text-neutral-300 space-y-2">
                <li>• Naviguer et cliquer dans l’app.</li>
                <li>• Vérifier que l’UI est lisible et claire.</li>
                <li>• Noter ce qui doit être ajusté.</li>
              </ul>
              <p className="text-xs text-neutral-500">
                La preview tourne en local, aucun accès externe n’est requis.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="rounded-3xl border border-neutral-800 bg-neutral-900/60 p-6 space-y-4">
              <h2 className="text-xl font-semibold">Publier l’agent</h2>
              <p className="text-sm text-neutral-400">
                Cela sauvegarde le code généré et ajoute l’agent dans ta config Moltbot locale.
              </p>
              <button
                className="rounded-2xl bg-white text-neutral-950 px-5 py-2 text-sm font-semibold disabled:opacity-60"
                onClick={handlePublish}
                disabled={!sandbox || isGenerating || isApplying}
              >
                Publier maintenant
              </button>

              {publishResult && (
                <div className="mt-4 space-y-4">
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4 text-xs">
                    <p className="text-neutral-400">App sauvegardée:</p>
                    <p className="text-white">{publishResult.publishDir}</p>
                    <p className="text-neutral-400 mt-2">Workspace agent:</p>
                    <p className="text-white">{publishResult.workspace}</p>
                  </div>

                  <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4 text-xs space-y-2">
                    <p className="text-neutral-400">Commandes utiles:</p>
                    {Object.entries(publishResult.commands).map(([label, cmd]) => (
                      <div key={label} className="flex flex-col">
                        <span className="text-neutral-500">{label}</span>
                        <code className="text-white">{cmd}</code>
                      </div>
                    ))}
                  </div>

                  {publishResult.warnings && publishResult.warnings.length > 0 && (
                    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200">
                      {publishResult.warnings.map((warning) => (
                        <p key={warning}>• {warning}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-4">
              <h3 className="text-lg font-semibold">Ce qui est livré</h3>
              <ul className="text-sm text-neutral-300 space-y-2">
                <li>• Code de la web app prêt à relancer.</li>
                <li>• Agent Moltbot configuré localement.</li>
                <li>• Commandes de relance en une ligne.</li>
              </ul>
              <p className="text-xs text-neutral-500">{status}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
