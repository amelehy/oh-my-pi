# Agent Hub

Agent Hub is the interactive TUI for watching and controlling subagents associated with the current session. It combines a live roster, per-agent activity and usage, transcript access, steering, revive, and kill controls. The main agent is not listed because its conversation is the ambient session view.

The Hub also discovers parked subagents from the current session's persisted artifacts when a session is resumed. Advisor transcript files appear as read-only rows.

## Open the Hub

| Input          | Behavior                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `Alt+A`        | Open or close Agent Hub through `app.agents.hub`. This opens the roster even when it is empty. |
| `Ctrl+S`       | Open or close the same Hub through the legacy `app.session.observe` action.                    |
| Double-tap `←` | Open the Hub from an empty main-session editor when the current session has an agent to show.  |

Run `/hotkeys` to see the active chords. Remap either action in `~/.omp/agent/keybindings.yml`:

```yaml
app.agents.hub: Alt+A
app.session.observe: Ctrl+S
```

The double-`←` gesture is not a keybinding action. While focused on a subagent, double-`←` returns to the main session instead of opening the Hub.

## Roster and inspector

The roster updates from the session's agent registry and progress events. Its responsive rows show:

- status (`running`, `idle`, `parked`, or `aborted`), agent identity, parent, and unread IRC count;
- model role, resolved model, and age since last activity;
- assigned task or current activity;
- cost, active time or elapsed span, request count, tool-call count, and tokens.

The header aggregates status and usage across measured agents. The Hub opens on the agent tree, with each subagent nested under the agent that spawned it; press `t` to switch to the operationally ordered flat roster and back. Press `/` to filter agents by id or display name.

On a wide terminal, the selected agent's inspector appears beside the roster. On a narrow terminal, press `Tab` to replace the roster with it. The inspector adds:

- the current tool and arguments, last intent, and retry state;
- context-window use when available;
- parent and child lineage;
- output and patch paths, plus isolated-worktree branch metadata when present.

Metrics depend on the progress or persisted usage data available for that agent. Missing data appears as `usage —` rather than an estimate.

### Roster controls

| Key or input                | Action                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `j` / `k`, `↑` / `↓`, wheel | Select an agent.                                                             |
| `Enter` or click            | Open the selected agent.                                                     |
| `t`                         | Toggle the agent tree and the flat roster.                                   |
| `/`                         | Filter agents by id or display name.                                        |
| `1` / `2`                   | Switch between Agents and Activity sections.                               |
| `Tab`                       | Toggle the inspector on narrow terminals.                                    |
| `PageUp` / `PageDown`       | Scroll an open inspector.                                                    |
| `r`                         | Revive the selected parked agent.                                            |
| `x`                         | Abort a running turn if necessary, then kill and release the selected agent. |
| `Esc`                       | Clear an active filter first, then close the narrow inspector or the Hub.    |

Only `parked` agents can be revived. `x` is immediate; use it only when you intend to discard that agent instance.

## Activity log

Press `2` for the combined activity log; `1` returns to the roster. The log includes responses, tool calls, IRC messages, and lifecycle activity. `Enter` opens the selected entry's agent transcript at that entry when an anchor is available.

- `f` cycles All, Errors, Responses, and Tools filters.
- `s` cycles the scope between all agents, the selected agent, and its subtree.
- `/` searches the activity log.
- `Space` toggles following the newest entry; manual selection pauses following.
- `Esc` clears the search first, then closes the Hub.

## Read and steer a subagent

For a normal local subagent, `Enter` or click focuses the main TUI on that agent's session and closes the Hub. Focusing a parked agent revives it. The transcript, status line, and editor then belong to that subagent:

1. Read its live transcript and tool activity.
2. Type a message and press `Enter` to steer a running turn or prompt an idle agent.
3. Press `Esc` with an empty editor, or double-tap `←`, to return to the main session.

Steering uses the normal prompt path, so the message and response are written to the subagent's persisted session history. While a subagent is focused, `Esc` returns to the main session; it does not interrupt the subagent.

Contexts without a local focusable session use the Hub's full-screen transcript viewer instead. This includes collab guests, advisor rows, and aborted agents; advisor and aborted transcripts are read-only. The viewer incrementally tails the file-backed transcript and provides an input line only when the selected agent can be messaged. Sending there has the same semantics: revive if parked, steer if running, and prompt if idle.

## Pinned agent tree and click to focus

While subagents run, a pinned `Agents` block above the editor shows them live as a tree — sync task calls and detached background spawns alike:

```
 Agents  ⣟ 3 running  ✔ 2 done                                  $0.218 · ⌃S hub
  ├─ ⣟ Alpha: Run sleep 40 command and reply done                    37s · $0.058
  │    └ bash: Sleeping 40 seconds · 35.3s
  ├─ ⣟ Bravo: Spawn two parallel subagents to run sleep              37s · $0.071
  │  │ └ wait: Waiting for background work
  │  ├─ ✔ BravoOne: Run sleep 30 command with timeout                33s · $0.056
  │  └─ ✔ BravoTwo: Run sleep 30 command with timeout                33s · $0.014
  └─ ⣟ Charlie: Run sleep commands and read hosts file               37s · $0.019
       └ bash: Sleeping twenty-five seconds · 20.6s
```

- **Tree**: each agent sits under the agent that spawned it, named relative to its parent.
- **Status**: a spinner while running, then `✔` done, `✘` failed, or `⊘` aborted. The header counts each outcome and totals the wave's spend; the hub key on the right opens Agent Hub for the full inspector.
- **Activity**: under each running agent, what it is doing right now — its current tool call with a one-line detail (and the elapsed time once a call runs longer than five seconds), the last call and how it ended between calls, a pending retry, or that it is still starting or thinking. Turn these rows off with `display.subagentLivePreview: false`.
- **Metrics**: active time and spend per agent, right-aligned when the terminal is wide enough.

Finished agents stay listed with their outcome while their wave — siblings from the same `task` call, or the rest of the same top-level agent's subtree — still has an agent running, so progress reads as "2 of 5 done" instead of rows vanishing. The block clears once no subagent is active.

The tree stays short: collapsed (`display.pinnedAgents: collapsed`, the default) it shows a few agents — running ones first, each with the agents above it, then failures — plus an expander naming what it hides; `full` lists every agent, and `off` hides the block. Clicking the expander toggles between the two while `tui.mouse` is on.

Enable `tui.mouse` to click live subagent cards and agent-tree rows directly in the main session, without opening the Hub first. A click focuses that card's most recent agent (a tree row focuses its exact agent); focusing a parked agent revives it. Hovering a live target lights it up first, so you can see what a click will open.

Only rows currently in the live viewport are clickable — retired transcript rows live in terminal scrollback, where clicks cannot map back to content. Enabling capture changes terminal gestures while on: text selection becomes Shift+drag and wheel scroll becomes Shift+wheel. Off by default.

## Persisted agents and advisors

Opening the Hub for a persisted session scans that session's artifact tree. Historical subagent JSONL files become parked rows; a killed agent's tombstone keeps it aborted. Nested subagents retain their parent/child lineage. Output and patch artifacts are attached to the corresponding inspector row.

Advisor transcript files (`__advisor*.jsonl`) appear as `advisor`-kind rows under their owning session. They are observability records, not peers:

- their transcripts can be opened and followed;
- they cannot be messaged;
- they cannot be revived;
- they cannot be killed.

Collab does not replicate advisor rows or serve their transcripts to guests; the host also rejects advisor chat, revive, and kill requests by id.

## Related surfaces

Agent Hub is the human-facing live session view. Adjacent commands and internal URLs serve narrower purposes:

`/agents` is a separate agent-definition/settings hub, not the live roster. It manages discovered agents, enable/disable state, model overrides, prewalk, and advisor selection.

- `/jobs` prints a snapshot of running and recently settled asynchronous tool jobs. It does not replace the per-agent transcript or control view. `/jobs kill <id>|all` cancels running jobs from the command line.
- `history://<id>` gives the coding agent a concise transcript for a live/parked subagent or a retained on-disk transcript.
- `agent://<id>` resolves a subagent's saved final output artifact; it is not the live transcript. Before that artifact exists, a registered agent resolves to its status, the `yield` payloads it has submitted so far, and its latest assistant text.
- `write agent://<id>` steers or follows up with a normal subagent; `agent://all` broadcasts to visible live peers. Messaging a parked subagent revives it. `read history://` lists registered agents and retained on-disk transcripts, refreshing the caller root's persisted roster first, the same as `history://<id>` lookups.
- `read proc://` lists background jobs and project services; `read proc://<id>` inspects status/output without consuming delivery.

Advisor rows are intentionally excluded from the agent-facing peer roster, `history://` index, and `agent://` messaging workflows.

See also [Task Agent Discovery and Selection](./task-agent-discovery.md), [Collaboration](./collab.md), and [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.md).
