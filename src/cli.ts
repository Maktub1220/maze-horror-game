import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import {
  createInitialGameState,
  flipCard,
  getPlayerPrivateStatus,
  getLegalActions,
  resolvePendingChoice,
  serializeStateForPlayer,
  loadRulesFromFile,
} from "./index.js";
import { GameState, NO_INSPECT_TARGET_PLAYER_ID, ResolveChoiceInput } from "./models.js";

function playerNameById(state: GameState, playerId: string): string {
  return state.players.find((player) => player.id === playerId)?.name ?? playerId;
}

function printHeader(title: string): void {
  console.log("\n" + "=".repeat(18));
  console.log(title);
  console.log("=".repeat(18));
}

function printStateSummary(state: GameState): void {
  const currentPlayer = state.players[state.current_player_index];
  console.log(`回合: ${state.turn_number}`);
  console.log(`当前玩家: ${currentPlayer?.name ?? "N/A"}`);
  console.log(`场上背面牌数量: ${state.board_face_down_cards.filter((c) => !c.face_up).length}`);

  console.log("玩家状态:");
  for (const player of state.players) {
    const downKeys = player.front_face_down_cards.filter(
      (card) => card.card_id === "silver_key" || card.card_id === "killer_key",
    ).length;
    const upItems = player.front_face_up_cards.map((card) => card.card_id).join(", ") || "无";
    console.log(
      `- ${player.name} (${player.id}) | 存活=${player.alive} | 身前背面=${player.front_face_down_cards.length} | 背面钥匙=${downKeys} | 明牌=${upItems}`,
    );
  }
}

function printNewEvents(state: GameState, fromIndex: number): number {
  const next = state.event_log.slice(fromIndex);
  if (next.length === 0) {
    return fromIndex;
  }

  console.log("\n事件:");
  for (const event of next) {
    const playerName = event.player_id ? playerNameById(state, event.player_id) : "系统";
    if (event.type === "announce") {
      console.log(`- [公开] ${playerName}: ${event.value}`);
      continue;
    }
    if (event.type === "announce_as") {
      console.log(`- [伪装宣告] ${playerName}: ${event.value}`);
      continue;
    }
    if (event.type === "peek") {
      console.log(`- [查看] ${playerName} 看到了: ${event.value}`);
      continue;
    }
    if (event.type === "choice_prompt") {
      console.log(`- [选择] ${playerName}: ${event.value}`);
      continue;
    }
    if (event.type === "death_cancelled") {
      console.log(`- [免死] ${playerName}: 抵消 ${event.value}`);
      continue;
    }
    if (event.type === "winner") {
      console.log(`- [胜利] 阵营: ${event.value}`);
      continue;
    }
    console.log(`- [${event.type}] ${playerName}: ${event.value}`);
  }

  return state.event_log.length;
}

async function askIndex(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  maxExclusive: number,
): Promise<number> {
  while (true) {
    const raw = (await rl.question(prompt)).trim();
    if (raw.toLowerCase() === "q") {
      throw new Error("USER_QUIT");
    }
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 0 && index < maxExclusive) {
      return index;
    }
    console.log(`请输入 0 到 ${maxExclusive - 1} 的整数，或输入 q 退出。`);
  }
}

async function resolveChoiceFromCli(
  state: GameState,
  rl: ReturnType<typeof createInterface>,
): Promise<ResolveChoiceInput> {
  const pending = state.pending_choice;
  if (!pending) {
    throw new Error("No pending choice");
  }

  console.log(`\n待处理选择: ${pending.choice_id} | 类型: ${pending.kind}`);

  if (pending.kind === "option") {
    pending.options.forEach((option, index) => {
      console.log(`  [${index}] ${option}`);
    });
    const selected = await askIndex(rl, "选择编号: ", pending.options.length);
    return { option: pending.options[selected] };
  }

  if (pending.kind === "target_player" || pending.kind === "target_player_with_key") {
    const options = pending.options;
    options.forEach((playerId, index) => {
      if (playerId === NO_INSPECT_TARGET_PLAYER_ID) {
        console.log(`  [${index}] 谁都不看（伪装为空房间并放回）`);
        return;
      }
      console.log(`  [${index}] ${playerNameById(state, playerId)} (${playerId})`);
    });
    const selected = await askIndex(rl, "选择目标玩家编号: ", options.length);
    return { target_player_id: options[selected] };
  }

  if (pending.kind === "board_card") {
    const options = pending.options;
    options.forEach((instanceId, index) => {
      console.log(`  [${index}] ${instanceId}`);
    });
    const selected = await askIndex(rl, "选择场上背面牌编号: ", options.length);
    return { board_card_instance_id: options[selected] };
  }

  if (pending.kind === "three_keys") {
    const options = pending.options;
    options.forEach((instanceId, index) => {
      console.log(`  [${index}] ${instanceId}`);
    });

    while (true) {
      const raw = (
        await rl.question("输入 3 个编号（用逗号分隔，例如 0,1,2；或 q 退出）: ")
      ).trim();
      if (raw.toLowerCase() === "q") {
        throw new Error("USER_QUIT");
      }

      const parts = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (parts.length !== 3) {
        console.log("必须输入 3 个编号。请重试。");
        continue;
      }

      const indexes = parts.map((part) => Number(part));
      const unique = new Set(indexes);
      const valid =
        indexes.every((idx) => Number.isInteger(idx) && idx >= 0 && idx < options.length) &&
        unique.size === 3;

      if (!valid) {
        console.log("编号不合法或有重复，请重试。");
        continue;
      }

      return {
        key_instance_ids: indexes.map((idx) => options[idx]),
      };
    }
  }

  throw new Error(`Unsupported pending choice kind: ${pending.kind}`);
}

async function run(): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    printHeader("红色的门与杀人鬼的钥匙 - 基础版 CLI");
    console.log("提示: 输入 q 可随时退出。\n");

    const namesRaw = (
      await rl.question("请输入玩家名（逗号分隔，2-6人，例如 A,B,C）: ")
    ).trim();
    if (!namesRaw || namesRaw.toLowerCase() === "q") {
      return;
    }

    const playerNames = namesRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const rulesPath = join(process.cwd(), "rules", "basic-rules.json");
    const rules = loadRulesFromFile(rulesPath);

    let state = createInitialGameState(playerNames, rules);
    let eventCursor = 0;

    while (state.phase === "playing") {
      printHeader("当前局面");
      printStateSummary(state);
      eventCursor = printNewEvents(state, eventCursor);

      if (state.pending_choice) {
        const chooser = playerNameById(state, state.pending_choice.player_id);
        console.log(`\n轮到 ${chooser} 处理选择。`);
        const choiceInput = await resolveChoiceFromCli(state, rl);
        state = resolvePendingChoice(state, state.pending_choice.player_id, choiceInput);
        continue;
      }

      const currentPlayer = state.players[state.current_player_index];
      const privateStatus = getPlayerPrivateStatus(state, currentPlayer.id);
      console.log(
        `\n[仅当前玩家可见] 你的身份: ${privateStatus.is_killer ? "杀人鬼" : "普通玩家"}`,
      );
      const legal = getLegalActions(state, currentPlayer.id).filter(
        (action) => action.type === "flip_card",
      );

      if (legal.length === 0) {
        console.log("没有可执行翻牌动作，游戏提前结束。\n");
        break;
      }

      console.log(`\n${currentPlayer.name} 可翻的背面牌:`);
      legal.forEach((action, index) => {
        console.log(`  [${index}] ${action.card_instance_id}`);
      });

      const raw = (await rl.question("选择翻牌编号（或输入 s 查看完整状态）: ")).trim();
      if (raw.toLowerCase() === "q") {
        break;
      }
      if (raw.toLowerCase() === "s") {
        console.log("\n" + serializeStateForPlayer(state, currentPlayer.id));
        continue;
      }

      const selected = Number(raw);
      if (!Number.isInteger(selected) || selected < 0 || selected >= legal.length) {
        console.log("输入无效，请重试。\n");
        continue;
      }

      const picked = legal[selected].card_instance_id;
      if (!picked) {
        console.log("动作数据异常：未找到牌实例。\n");
        continue;
      }

      state = flipCard(state, currentPlayer.id, picked);
    }

    printHeader("游戏结束");
    if (state.winner) {
      const winners = state.winner.player_ids.map((id) => playerNameById(state, id)).join(", ");
      console.log(`胜利阵营: ${state.winner.team}`);
      console.log(`获胜玩家: ${winners || "(无)"}`);
    } else {
      console.log("未产生明确胜者。");
    }

    printNewEvents(state, eventCursor);
  } catch (error) {
    if (error instanceof Error && error.message === "USER_QUIT") {
      console.log("\n已退出游戏。\n");
      return;
    }

    console.error("运行失败:", error);
  } finally {
    rl.close();
  }
}

void run();
