# dsh-go-auto-effort

给 [dsh-go](https://github.com/ccch1mneyyy/dsh-go)（DeepSeek Harness 手机端）写的原生插件：**发消息时按内容自动选择模型的思考档位**，不用每次手动点“低 / 标准 / 高”。

纯本地规则，不额外调模型，不联网；只从当前模型真正支持的档位里选。

## 功能

- 输入框上方状态条：`自动思考 · 档位`
- 点开面板：当前档位、最近一次判断、判断依据、模型可用档位、一键开关
- 寒暄自动关思考，复杂问题自动拉高，`继续` 沿用上一轮
- 支持所有暴露 reasoning efforts 的 provider / model；不支持思考的模型自动跳过
- 不额外调用模型，没有额外 token 消耗和网络延迟

## 环境

- dsh-go App **1.3.0+**（状态条 / 面板依赖原生桥）
- DSH **0.2.2-rc.1**（`engines.dsh` 允许 `>=0.2.1-rc.2 <0.3.0-0`）
- 无第三方依赖

## 安装

```sh
git clone https://github.com/DeepSea0329/dsh-go-auto-effort.git \
  "$DSH_HOME/dsh-go/plugins/local-auto-effort"

dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-auto-effort"
```

手机本机引擎使用的 profile 是 `web`。安装完成后，到 App 的「引擎」页重启一次引擎（或等热加载），打开对话即可在输入框上方看到状态条。

更新：

```sh
git -C "$DSH_HOME/dsh-go/plugins/local-auto-effort" pull
```

然后重启引擎（`lib/` 下的代码改动需要重启才生效）。

卸载：

```sh
dsh plugin --profile web remove local-auto-effort
rm -rf "$DSH_HOME/dsh-go/plugins/local-auto-effort"
```

## 使用

- **状态条**：显示当前思考档位，例如 `自动思考 · 标准`；点击打开面板。
- **面板**：显示当前档位、最近一次判断和依据、模型支持的档位，以及“关闭自动 / 开启自动”开关。
- **关闭自动**：关闭后插件不再改动模型选择器里的档位，完全按你手动选的来。

## 判断规则

| 消息内容 | 自动档位 |
| --- | --- |
| 你好 / 谢谢 / 晚安 / 在吗 | 关闭（模型支持 `off` 时）；否则最低档 |
| 好的 / 收到 / 可以 / 嗯 | 轻 |
| 日常短问题、翻译、总结 | 轻 |
| 写代码、改代码、解释实现 | 标准 |
| 报错、排查、设计、长文、复杂问题 | 深入 / 最高 |
| 继续 / 接着 / 然后呢 | 沿用上一轮 |

规则是启发式的，按关键词、长度、代码块、问题数量、多步骤等信号打分；面板里能看到每条消息的“依据”和分数。

## 原理

Harness 在每步准备（`agent/pre-step`）之前就把本步的 `modelSelection` 定下来了。插件在用户消息进入收件箱、驱动被唤醒之前拿到内容：

1. 监听 `agent/inbox/inserted`，只处理 `source.kind === "user"` 的消息；
2. 用本地规则把消息归到 `trivial / light / normal / deep`；
3. 通过 `ctx.llm.resolveModelInfo(provider, model)` 读取模型真实支持的 `reasoning.efforts`；
4. 在 `queueMicrotask` 里调用 `agent.model.select()`，赶在 `agent/pre-step` 固定选择之前写入档位。

因此：

- 只会在模型支持的档位里选，不会把不支持的 effort 发出去；
- 不额外调模型，纯字符串处理；
- 改的是当前会话的模型选择（App 的模型选择器会同步显示），不是单条消息的隐藏参数。

## 开发

```sh
npm test          # node:test，覆盖分类和档位映射
```

调参入口都在 `lib/index.js`：

- `RE_GREETING` / `RE_ACK` / `RE_CONTINUE`：寒暄、确认、延续
- `RE_COMPLEX` / `RE_BUILD` / `RE_WHY` / `RE_DESIGN`：复杂度信号
- 长度、问号数量、多步骤的加分阈值
- `PREFERENCE`：轻 / 标准 / 深入分别优先映射到哪些档位

改完运行 `npm test`，再按上面的方式重启引擎。

也可以用 dsh-go 插件检查器自检：

```sh
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" . --load --lang zh
```

## 限制

- 启发式判断，不理解语义；判断错了可以在面板里看到依据，欢迎提 issue 补充关键词。
- 会修改当前会话的思考档位；你手动选的档位会在下一条消息被自动判断覆盖，除非在面板里关闭自动。
- 不同 provider 的档位 id 和数量不同（`off/low/high/max`、`low/medium/high` 等），映射按相对档位选择。
- 状态条 / 面板只在 dsh-go 原生界面出现；自动选档逻辑本身不依赖 UI。
- 本项目与 DeepSeek、dsh-go 官方无隶属关系。

## English

A native dsh-go plugin that picks the model's reasoning effort from each message using local heuristics — no extra model call, no network. It only chooses efforts the current model actually advertises.

```sh
git clone https://github.com/DeepSea0329/dsh-go-auto-effort.git \
  "$DSH_HOME/dsh-go/plugins/local-auto-effort"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-auto-effort"
```

Restart the engine, open a chat, and use the strip above the composer. Tap it for the panel and the auto on/off switch. Requires dsh-go 1.3.0+.

## License

MIT
