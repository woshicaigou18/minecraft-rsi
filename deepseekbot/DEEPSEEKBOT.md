# PCL DeepSeek Minecraft bot

## PCL 自动联机

REA 静态分析确认，PCL 2.12.8.2 的 `McLaunchCustom` 会执行全局
`LaunchAdvanceRun` 设置。已在 `../PCL/Setup.ini` 写入
`start-deepseek-on-pcl.cmd`，原文件备份为 `../PCL/Setup.ini.deepseekbot-backup`。
PCL 启动游戏时会启动桥接脚本。进入单人世界后点“对局域网开放”，桥接脚本
会从 Minecraft 日志取得端口并启动独立的 `deepseek` 玩家。Minecraft 的
游玩操作通过 Mineflayer 进行，PCL 只负责启动时触发脚本。

请先在本目录的 `keys.json` 填入 `DEEPSEEK_API_KEY`，或在启动 PCL 前设置
同名环境变量。然后用 PCL 启动 Minecraft，进入单人世界并选择“对局域网开放”。
若先打开游戏再配置密钥，可以双击 `start-deepseek.cmd` 重试。运行日志位于
`results/pcl-bridge.log` 和 `results/pcl-bot.log`。
分析依据见 [PCL-REA-ANALYSIS.md](PCL-REA-ANALYSIS.md)。
可运行 `node scripts/check-deepseek.mjs` 检查密钥和 API 连通性；该命令不会输出密钥。

## 创造模式建造

`!newAction` 已开启。它可以让 DeepSeek
生成多方块建造动作，并在隔离的 JavaScript compartment 中执行。
在游戏聊天说“切换到创造模式”或“开始生存”，bot 会停止当前动作并尝试切换
自己的实际游戏模式；也可使用 `!setGameMode("creative")` 或
`!setGameMode("survival")`。如服务器拒绝，房主需执行
`/gamemode creative deepseek` 或 `/gamemode survival deepseek`。
可运行 `node scripts/check-bot-state.mjs` 查看当前模式和动作。
生成动作最长运行 10 分钟。

This directory is a Mindcraft `develop` checkout. It includes the complete
`tasks/` tree and the Mineflayer agent code that executes those tasks. The
default profile is `profiles/deepseek.json`; only a DeepSeek key is needed for
chat. DeepSeek does not provide embeddings, so example selection falls back to
word overlap. The bridge reads PCL Minecraft logs for the changing LAN port.

## Start

1. Open a Minecraft Java world in PCL and select **Open to LAN**. The bot is a
   separate Minecraft player, so use a world/server that permits an offline
   account, or configure Microsoft authentication in `settings.js`.
2. Set `DEEPSEEK_API_KEY` in the terminal environment, or put it in an ignored
   `keys.json` copied from `keys.example.json`. Keep the key out of Git.
3. Run `npm install` once. PCL's launch hook starts the bridge automatically.
   To join a world that is already open to LAN, double-click `start-deepseek.cmd`.

List available task definitions with `npm run tasks:list` or
`npm run tasks:list -- --json`. Run one with:

```text
node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs
```

Some construction, cooking, crafting and collaboration tasks require specific
world setup, initial inventories, extra agents, or the upstream evaluation
environment. A task being present in the catalog does not imply it can run in
an arbitrary PCL world.

For the first join test, use the local vanilla 1.21.1 world. Large Forge
modpacks may require a client handshake that Mineflayer cannot provide.

## Minecraft commands

The agent can execute any vanilla, mod or plugin slash command through
`!minecraftCommand("/gamerule keepInventory true")`. This capability has no
command-name allowlist; server permissions and the installed Minecraft version
determine which commands are available. JSON/NBT arguments use escaped double
quotes inside the tool's string argument. Server feedback is returned to the
model; absent feedback is reported as unconfirmed rather than success.

In game, say **开启死亡不掉落**, **关闭死亡不掉落**, **查看死亡不掉落**,
or **执行 /gamerule keepInventory** for direct execution. Other natural-language
requests (time, weather, teleport, give, execute, fill, etc.) use the model's
command tool. If cheats/operator permissions are missing, the world owner must
enable cheats or grant `deepseek` the required permissions.

## Diving

Say **潜水**, **下潜3格，最多8秒**, or **上浮换气** in game. The explicit
tools are `!dive(3, 8)` and `!surface`. The dive starts from the bot's current
water position; it does not teleport into water. The duration includes descent
and holding, with additional time reserved for surfacing.

Intentional descent/holding temporarily yields ordinary auto-floating, while
oxygen, damage, interruption and progress checks remain active. The bot releases
jump to sink using native physics and adjusts jump to hold depth. It surfaces
when the activity duration ends or an early return is needed. Creative mode and
water breathing are recognized. A blocked or timed-out ascent is reported as
unconfirmed/failed, never as a successful return to air.

## Automatic death reflection

Each death captures recent positions, health, oxygen, nearby blocks/entities,
the active action, recent commands/results and the server's death reason.
The death position is frozen before respawn. Self-prompting waits for a bounded
DeepSeek review, then continues the current goal using the revised plan.
Evidence gaps are reported as uncertainty. The review does not automatically
change gamerules, gamemode or the player's goal.

Death reports and conditional lessons persist in `results/rrsi/live/deaths.jsonl`,
`death_reflections.jsonl` and `death_guidance.json`. Interrupted reviews resume
after restart. Say **查看死亡反思** to read the latest cause and next plan.
If the model is unavailable, the evidence is retained and a conservative fallback
is recorded. Death lessons are explicitly unverified memory; they feed RRSI's
proposal process and are not counted as measured adopted rules. Actions during
which the bot dies score as failures in live evaluation.

## RRSI experiment

### Player suggestions in Minecraft chat

Tell `deepseek` a general suggestion in normal chat, for example:

> 当你需要烧很多东西的时候，可以试试多造几个熔炉并行去烧。

It acknowledges the suggestion and asks DeepSeek to decide whether to accept
it as an optional, conditional strategy. A one-time request is routed back to
the ordinary chat handler. The
decision appears in game chat. Accepted rules are saved in
`results/rrsi/live/player_guidance.json` and included in later conversation
and code prompts, including after a reconnect. The bot can ignore an accepted
rule when it does not fit the current situation. Reviews are audited in
`results/rrsi/live/player_suggestions.jsonl` and are not claimed as measured
RRSI improvements. Say **查看建议** to list accepted topics or **撤销最近的建议**
to remove the newest accepted rule.

Successful `!smeltItem` actions no longer deliberately exit the bot to refresh
inventory. The agent supervisor retries a few rapid crashes with backoff and
logs the exit reason. A real server disconnect still causes a reconnect.

Movement coordinates, gaze targets and angles are checked for finite values.
Idle gaze uses a default height for entities without height metadata. The
native Mineflayer movement timing is used instead of queuing mutable position
packets. An invalid-movement kick pauses reconnection; three other failures
within five minutes also pause it to prevent repeated join/leave messages.
The PCL bridge and main process have instance locks. Windows launches stay
hidden and the management webpage no longer opens automatically.
An action that does not stop within ten seconds keeps its execution slot;
new actions wait instead of killing the bot or running concurrently. Generated
building and digging loops check the interruption flag on each skill call.
Navigation interruption cancels the current goal immediately, instead of waiting
for the next path node. Underwater safety can swim up during an active path.
Bounded recovery swims toward nearby shore or clears an obstructing vine and
checks the actual result. Repeated failures temporarily increase the route cost
near that location and suppress repeated chat warnings. Waiting at a furnace or
container is not treated as a navigation failure.
Water entry resets the land stall timer. Slow horizontal swimming and underwater
vertical progress are normal movement. Floating, waiting, and digging in water
do not trigger the water movement watchdog; only 12 seconds of continuous movement
input without progress triggers recovery.
Large `searchForBlock` requests scan loaded chunk sections cooperatively and
skip palettes without the target type; they yield to the event loop so Minecraft
keepalives, movement and management heartbeats remain responsive. A temporary
MindServer disconnect reconnects and restores identity without exiting Minecraft.

The sibling `../rrsi` checkout is the official
`google-research/rrsi` implementation. The running Minecraft agent records
action results, inventory changes, durations and DeepSeek token usage. Six new
ordinary actions or two failures trigger reflection, with a two-minute cooldown.
An independent scheduler also checks between actions. The worker uses the official
RRSI edit budget, history and critic precheck, followed by a separate DeepSeek
critic. Approved proposals appear in Minecraft chat. Prompt edits with four
measurable baseline actions in the same activity scope enter a temporary trial.
Four matching subsequent actions evaluate the candidate; unrelated activities
do not count. A trial expires after eight minutes or 24 unrelated actions if
there is insufficient evidence, so it cannot block future learning forever. The active
agent reads trial guidance on every conversation and coding prompt. At the end
of the trial, `live_select.py` uses the official RRSI `aggregate` and
`select_round` functions to adopt or revert the candidate, considering completion,
token cost and comparable production time per item when repeated measurements exist.
Accepted strategies accumulate by topic (up to 24); revisions replace only their
own topic. The prompt retrieves relevant strategies for the current activity.
The live loop also supports executable `skill`, `client_tool` and `config`
artifacts. Scheduled rounds rotate their preferred component; the proposer can
choose another supported component when the evidence warrants it.

### Executable skills, tools and settings

- **skill**: a named reusable workflow with inventory/health/water conditions,
  parameter references and ordered primitive calls. It finishes by executing the
  original tool with the original arguments. It can be called normally through
  its target tool or explicitly through `!runSkill(name, argumentsJson)`.
- **client_tool**: a tool adapter with preparation, failure recovery and at most
  three attempts. Execution stops when interrupted; later workflow steps do not run.
- **config**: real runtime settings for search time slicing, water stall/progress
  thresholds and diving progress/air margins. Values are pinned for each call.

`rrsi_integration/runtime_contract.json` defines 14 workflow primitives, five
tunable settings, and an API for new JavaScript skills. Workflow and adapter
artifacts remain supported alongside source-code skills.

### Writing and adding genuinely new skills

On skill rounds, RRSI can design a missing capability, write its own JavaScript
algorithm and tests, and register a **new** `!skill_<name>` command with new
parameters and documentation. Say **学习新技能：具体能力** or use
`!learnSkill("description")` to request one; autonomous skill rounds use gameplay
failures and missing capabilities without needing that request.

Each new version has `skills/<artifact-id>/skill.js`, `manifest.json`, `tests.json`
and `evaluation.json` under `results/rrsi/live/`. The source is a real
`async function run(api, args)`, not a list of existing commands. It may use loops,
calculations, observations, movement controls, all exported native Minecraft
skills, slash commands and individual furnace operations. In particular, it can
load separate furnaces and later collect their outputs while the furnaces burn
concurrently in the world. Only one furnace window is operated at a time.

Generated code runs in a separate worker thread and SES compartment. Minecraft
operations cross a serialized API, while CPU deadlines/cancellation terminate
the worker. The parent keeps action ownership until in-flight game operations
stop and then cleans up controls/windows. Source-file hashes detect unreviewed
changes. These controls do not make third-party or native Minecraft code
infallible; they keep generated JavaScript loops off the heartbeat thread.

A new capability does not borrow unrelated actions as a fake baseline. Passing
simulated tests and independent review makes it available as a **probationary**
skill, separately from the main RRSI trial. The host verifies postconditions
(inventory gains, navigation, surfacing, building, or truthful observations)
against actual game state on each invocation. Four real invocations, at least
75% verified success and no worker fault/death permit retention. This is a
capability check, not evidence of improvement over a paired incumbent. Unused
new skills do not block other RRSI experiments. Errors/deaths quarantine the
version; the source, tests and reports remain available for future revisions.

Each candidate is versioned under `results/rrsi/live/artifacts/`. An isolated
Node subprocess checks signatures, bounded execution, cancellation, resource
variation, recovery and preservation of normal behavior. A failed preflight may
be repaired once using the failure report. A separate model critic then reviews
the candidate. These fixtures are simulations, not measurements in Minecraft.

After four comparable baseline actions, a passing candidate is hot loaded for
the target tool. Only actions tagged with the actual candidate ID/variant count
toward its four-action live evaluation. Successful versions are atomically
promoted to `active_extensions.json`; rejected, expired or quarantined candidates
stop applying without a bot restart. Exceptions and deaths quarantine a version
and restore its predecessor (or the built-in implementation). Executions and
primitive call traces are in `extension_executions.jsonl`. Completion regressions,
zero-success windows and deaths block executable promotion, even if tokens fall.
Online world-state comparisons remain noisy proxies; repeatable paired Minecraft
benchmarks provide stronger evidence of improvement.

Say **查看可执行改进**, **查看技能改进**, **查看工具改进**, or
**撤销最近的运行改进**. **改进状态** separates prompt rules and executable
versions; **撤销改进** restores the built-in implementations and removes learned
prompt guidance. Rollback affects subsequent invocations; it cannot undo world
changes already made by a running action.

You can manage this entirely in Minecraft chat: say **提出改进**, **改进状态**,
or **撤销改进**. Say **查看策略** to see retained rules. The ordinary auto-trigger works without these messages.
The bot also has `!improveHarness`, `!improvementStatus`, and
`!revertImprovement` actions so it can respond to natural requests to improve.
The online selector currently uses a fixed 0.20 score noise band; it is a
conservative heuristic for the four-action window, not a calibrated benchmark.
Trial data and decisions are in `results/rrsi/live/`. Status distinguishes proposed,
trial and retained rules. This online action-completion score
is only a proxy: changing tasks and world state can affect it. Saying **你刚才做错了**
or **你刚才做对了** records your verdict on the latest action and overrides its
completion score in the trial. The score does not independently judge the
quality of a finished build.
It does not establish improvement on a repeatable benchmark.

`rrsi_integration/experiment.py` uses the official score aggregation and
candidate selection code on measured Mindcraft task runs. Use it for a stronger
comparison in a repeatable benchmark world with paired candidate trials.

For each trial, set `DEEPSEEK_USAGE_LOG` to a fresh JSONL path before launching
`node main.js --task_path ... --task_id ...`. The bot writes token totals only
to that path. After the task exits, record its score and cost:

```text
python rrsi_integration/experiment.py record --task-file tasks/basic/single_agent.json --task-id gather_oak_logs --history bots/deepseek/memory.json --usage results/trial-1-usage.jsonl --report results/baseline.json
```

Repeat each task `k` times for both the incumbent and candidate. Use separate
reports and fresh usage logs. Then apply the RRSI rule with a noise band
estimated from repeated baseline trials:

```text
python rrsi_integration/experiment.py compare --incumbent results/baseline.json --candidate results/candidate.json --k 2 --delta 0.05 --component prompt
```

Missing trials score zero. The comparison reports the mean reward, mean token
cost and the official RRSI selection decision. The result is evidence for a
specific task file and world setup, not a claim that the bot improved in every
Minecraft environment.
