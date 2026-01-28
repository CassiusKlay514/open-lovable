# Moltbot Agent Builder (Local MVP)

This is a local-only wizard that generates a real web app, previews it in the browser, and publishes a Moltbot agent configuration.

## Run locally

```bash
pnpm install
cd open-lovable
pnpm dev
```

Open:

```
http://localhost:3000/agent-builder
```

## Flow

1) **Idée**  
Describe the agent idea, name, goal, and tone.  
Optional: toggle advanced mode to edit the JSON spec.

2) **Test (preview web)**  
A local Vite preview server is started automatically.  
You can click and interact with the generated UI inside the iframe.

3) **Publier**  
The app source is copied to a local publish folder and a Moltbot agent is created.

## What gets created

- Generated app: `open-lovable/.agent-builder/published/<agent-id>`
- Agent workspace: `open-lovable/.agent-builder/workspaces/<agent-id>`
- Moltbot config is updated via the CLI (no API keys in the UI).

## Re-launch locally

```bash
cd open-lovable/.agent-builder/published/<agent-id>
npm install
npm run dev
```

## Run the agent

```bash
cd <repo-root>
pnpm moltbot agent --agent <agent-id> --message "Hello" --local
```

## Notes

- Preview is local only (localhost).
- The wizard uses your existing Moltbot configuration and provider keys from your environment.
