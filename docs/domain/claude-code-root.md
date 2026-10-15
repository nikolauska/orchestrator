# Claude Code as the root session

Claude Code can run the root session instead of OMP. Workers are OMP agents unless you ask for Claude Code workers, so the [requirements](platform-support.md) for whichever agents you use still apply. Start it from this repository:

```sh
bun run claude
```

This loads the orchestrator MCP server from `mcp/claude-code.json` and enables it as a Claude Code [channel](https://code.claude.com/docs/en/channels-reference), which is how worker results wake an idle session. Channels are a research preview: a custom channel needs `--dangerously-load-development-channels`, which asks for confirmation at startup, and Team or Enterprise organizations must enable channels. The flag has no effect with `claude -p`. Without the channel, the tools still work but nothing wakes the session; read missed results with `workers events`.

Workers can also be Claude Code agents: ask for one, for example "use a Claude Code worker on opus". Claude Code workers currently run only on the local machine and need Herdr's Claude integration (`herdr integration install claude`). They start with the approved permission settings in `.omp/claude-worker-settings.json`. See the [Task tool](task-tool.md#worker-agents) for details.

The server is deliberately not in a project `.mcp.json`: OMP also loads that file, and an OMP session would then start a second supervisor.
