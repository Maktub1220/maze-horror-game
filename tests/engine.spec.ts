import { describe, expect, it } from "vitest";
import {
  checkWinConditions,
  flipCard,
  getLegalActions,
  resolvePendingChoice,
} from "../src/engine.js";
import { getPlayerPrivateStatus, serializeStateForPlayer } from "../src/playerView.js";
import {
  createDeterministicState,
  findBoardCardInstanceId,
  setCurrentPlayer,
} from "../src/testHelpers.js";
import { GameState, NO_INSPECT_TARGET_PLAYER_ID } from "../src/models.js";

function currentPlayerId(state: GameState): string {
  return state.players[state.current_player_index].id;
}

function flipByCardId(state: GameState, playerId: string, cardId: string, index = 0): GameState {
  const instanceId = findBoardCardInstanceId(state, cardId, index);
  return flipCard(state, playerId, instanceId);
}

function allFaceDownKeyIds(state: GameState): string[] {
  return state.players.flatMap((player) =>
    player.front_face_down_cards
      .filter((card) => card.card_id === "silver_key" || card.card_id === "killer_key")
      .map((card) => card.instance_id),
  );
}

describe("红色的门与杀人鬼的钥匙 - 基础版纯逻辑引擎", () => {
  it("1) 翻到杀人鬼钥匙后玩家变 killer 且伪装为银钥匙", () => {
    let state = createDeterministicState(["A", "B"]);
    const p1 = state.players[0].id;

    state = flipByCardId(state, p1, "killer_key");

    const player = state.players.find((p) => p.id === p1)!;
    expect(player.role).toBe("killer");
    expect(player.front_face_down_cards.some((card) => card.card_id === "killer_key")).toBe(true);

    const killerKey = player.front_face_down_cards.find((card) => card.card_id === "killer_key")!;
    const silverKeyName = state.rules_package.cards.find((card) => card.id === "silver_key")!.name;
    expect(killerKey.announced_as).toBe(silverKeyName);
  });

  it("2) 第四把钥匙触发：收钥匙、移除一张 killer_key、全场重洗", () => {
    let state = createDeterministicState(["A", "B", "C", "D"]);
    const [p1, p2, p3, p4] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "silver_key", 0);
    state = flipByCardId(state, p2, "silver_key", 0);
    state = flipByCardId(state, p3, "silver_key", 0);
    state = flipByCardId(state, p4, "killer_key");

    expect(state.players.every((p) => p.front_face_down_cards.length === 0)).toBe(true);
    expect(state.removed_from_game.filter((card) => card.card_id === "killer_key")).toHaveLength(1);
    expect(state.board_face_down_cards).toHaveLength(15);
    expect(state.players.find((p) => p.id === p4)?.role).toBe("killer");
  });

  it("3) 逃生出口 + 3 把真钥匙时普通玩家胜利", () => {
    let state = createDeterministicState(["A", "B", "C"]);
    const [p1, p2, p3] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "silver_key", 0);
    state = flipByCardId(state, p2, "silver_key", 0);
    state = flipByCardId(state, p3, "silver_key", 0);

    state = flipByCardId(state, p1, "escape_exit");
    expect(state.pending_choice?.choice_id).toBe("start_escape_challenge");

    state = resolvePendingChoice(state, p1, { option: "yes" });
    expect(state.pending_choice?.choice_id).toBe("choose_three_keys_from_all_players");

    state = resolvePendingChoice(state, p1, {
      key_instance_ids: allFaceDownKeyIds(state).slice(0, 3),
    });

    expect(state.phase).toBe("ended");
    expect(state.winner?.team).toBe("non_killers");
    expect(state.winner?.player_ids).toEqual([p1, p2, p3]);
  });

  it("4) 逃生出口 + 假钥匙混入时所有杀人鬼胜利", () => {
    let state = createDeterministicState(["A", "B", "C"]);
    const [p1, p2, p3] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "killer_key");
    state = flipByCardId(state, p2, "silver_key", 0);
    state = flipByCardId(state, p3, "silver_key", 0);

    state = flipByCardId(state, p1, "escape_exit");
    state = resolvePendingChoice(state, p1, { option: "yes" });

    const selected = allFaceDownKeyIds(state).slice(0, 3);
    state = resolvePendingChoice(state, p1, { key_instance_ids: selected });

    expect(state.phase).toBe("ended");
    expect(state.winner?.team).toBe("killer");
    expect(state.winner?.player_ids).toContain(p1);
  });

  it("5) 普通玩家翻到杀人鬼陷阱会死亡并触发死亡重洗", () => {
    let state = createDeterministicState(["A", "B"]);
    const [p1, p2] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "silver_key", 0);
    state = flipByCardId(state, p2, "empty_room", 0);
    state = setCurrentPlayer(state, p1);

    state = flipByCardId(state, p1, "killer_trap");

    expect(state.players.find((p) => p.id === p1)).toBeUndefined();
    expect(state.players).toHaveLength(1);
    expect(state.board_face_down_cards.some((card) => card.card_id === "silver_key")).toBe(true);
    expect(state.death_state.last_dead_player_id).toBe(p1);
  });

  it("6) 防弹背心可抵消陷阱或手枪致死，并移除背心", () => {
    let trapState = createDeterministicState(["A", "B"]);
    const [p1, p2] = trapState.players.map((p) => p.id);

    trapState = flipByCardId(trapState, p1, "bulletproof_vest");
    trapState = flipByCardId(trapState, p2, "empty_room", 0);
    trapState = setCurrentPlayer(trapState, p1);
    trapState = flipByCardId(trapState, p1, "killer_trap");

    expect(trapState.players.find((p) => p.id === p1)?.alive).toBe(true);
    expect(trapState.players.find((p) => p.id === p1)?.front_face_up_cards.some((c) => c.card_id === "bulletproof_vest")).toBe(false);
    expect(trapState.removed_from_game.some((card) => card.card_id === "bulletproof_vest")).toBe(true);

    let pistolState = createDeterministicState(["A", "B"]);
    const [a, b] = pistolState.players.map((p) => p.id);

    pistolState = flipByCardId(pistolState, a, "bulletproof_vest");
    pistolState = flipByCardId(pistolState, b, "pistol");
    pistolState = flipByCardId(pistolState, a, "empty_room", 0);

    pistolState = flipByCardId(pistolState, b, "bullet_room");
    pistolState = resolvePendingChoice(pistolState, b, { option: "yes" });
    pistolState = resolvePendingChoice(pistolState, b, { target_player_id: a });

    expect(pistolState.players.find((p) => p.id === a)?.alive).toBe(true);
    expect(pistolState.removed_from_game.some((card) => card.card_id === "bulletproof_vest")).toBe(true);
  });

  it("7) 杀人鬼翻到杀人鬼陷阱不会死亡", () => {
    let state = createDeterministicState(["A", "B"]);
    const [p1, p2] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "killer_key");
    state = flipByCardId(state, p2, "empty_room", 0);
    state = setCurrentPlayer(state, p1);

    const trapId = findBoardCardInstanceId(state, "killer_trap");
    state = flipCard(state, p1, trapId);

    expect(state.players.some((p) => p.id === p1)).toBe(true);
    expect(state.players.find((p) => p.id === p1)?.alive).toBe(true);
    expect(state.board_face_down_cards.some((card) => card.instance_id === trapId)).toBe(true);
  });

  it("8) 杀人鬼翻到催眠瓦斯可伪装或主动使用效果", () => {
    let pretendState = createDeterministicState(["A", "B"]);
    const [p1, p2] = pretendState.players.map((p) => p.id);

    pretendState = flipByCardId(pretendState, p1, "killer_key");
    pretendState = flipByCardId(pretendState, p2, "empty_room", 0);
    pretendState = setCurrentPlayer(pretendState, p1);

    const gasId = findBoardCardInstanceId(pretendState, "sleep_gas", 0);
    pretendState = flipCard(pretendState, p1, gasId);
    expect(pretendState.pending_choice?.choice_id).toBe("killer_sleep_gas_mode");
    pretendState = resolvePendingChoice(pretendState, p1, { option: "pretend_empty" });

    const gasCard = pretendState.board_face_down_cards.find((card) => card.instance_id === gasId)!;
    expect(gasCard.face_up).toBe(false);

    let useState = createDeterministicState(["A", "B"]);
    const [u1, u2] = useState.players.map((p) => p.id);

    useState = flipByCardId(useState, u1, "killer_key");
    useState = flipByCardId(useState, u2, "empty_room", 0);
    useState = setCurrentPlayer(useState, u1);
    const useGasId = findBoardCardInstanceId(useState, "sleep_gas", 0);
    useState = flipCard(useState, u1, useGasId);
    useState = resolvePendingChoice(useState, u1, { option: "use_effect" });

    expect(useState.players.find((p) => p.id === u1)?.role).toBe("killer");
    expect(useState.players.find((p) => p.id === u1)?.front_face_down_cards).toHaveLength(0);
    expect(useState.board_face_down_cards.some((card) => card.card_id === "killer_key")).toBe(true);
    expect(useState.removed_from_game.some((card) => card.instance_id === useGasId)).toBe(true);
    expect(useState.board_face_down_cards.some((card) => card.instance_id === useGasId)).toBe(false);
  });

  it("8.1) 普通玩家触发催眠瓦斯效果后该牌会被移出游戏", () => {
    let state = createDeterministicState(["A", "B"]);
    const [p1] = state.players.map((p) => p.id);

    const gasId = findBoardCardInstanceId(state, "sleep_gas", 0);
    state = flipCard(state, p1, gasId);

    expect(state.pending_choice).toBeNull();
    expect(state.removed_from_game.some((card) => card.instance_id === gasId)).toBe(true);
    expect(state.board_face_down_cards.some((card) => card.instance_id === gasId)).toBe(false);
  });

  it("9) 持枪玩家翻到有子弹房间可击杀目标并触发重洗", () => {
    let state = createDeterministicState(["A", "B", "C"]);
    const [p1, p2, p3] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "pistol");
    state = flipByCardId(state, p2, "empty_room", 0);
    state = flipByCardId(state, p3, "empty_room", 0);

    state = flipByCardId(state, p1, "bullet_room");
    state = resolvePendingChoice(state, p1, { option: "yes" });
    state = resolvePendingChoice(state, p1, { target_player_id: p2 });

    expect(state.players.find((p) => p.id === p2)).toBeUndefined();
    expect(state.board_face_down_cards.some((card) => card.card_id === "bullet_room")).toBe(true);
  });

  it("10) 看穿违和感翻出 killer_key 后该牌移除但身份保留", () => {
    let state = createDeterministicState(["A", "B"]);
    const [p1, p2] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "killer_key");
    state = flipByCardId(state, p2, "sense_discomfort");

    expect(state.pending_choice?.choice_id).toBe("choose_target_player_with_face_down_key");
    state = resolvePendingChoice(state, p2, { target_player_id: p1 });

    expect(state.players.find((p) => p.id === p1)?.role).toBe("killer");
    expect(state.players.find((p) => p.id === p1)?.front_face_down_cards.some((c) => c.card_id === "killer_key")).toBe(false);
    expect(state.removed_from_game.some((c) => c.card_id === "killer_key")).toBe(true);
  });

  it("10.1) 看穿违和感可选择谁都不看并伪装为空房间放回场上", () => {
    let state = createDeterministicState(["A", "B"]);
    const [p1, p2] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "killer_key");
    state = flipByCardId(state, p2, "sense_discomfort");

    expect(state.pending_choice?.choice_id).toBe("choose_target_player_with_face_down_key");
    expect(state.pending_choice?.options).toContain(NO_INSPECT_TARGET_PLAYER_ID);

    const senseId = state.current_card_instance_id!;
    state = resolvePendingChoice(state, p2, { target_player_id: NO_INSPECT_TARGET_PLAYER_ID });

    expect(state.board_face_down_cards.some((c) => c.instance_id === senseId)).toBe(true);
    expect(state.removed_from_game.some((c) => c.instance_id === senseId)).toBe(false);
    expect(state.players.find((p) => p.id === p1)?.front_face_down_cards.some((c) => c.card_id === "killer_key")).toBe(true);
  });

  it("11) 多个杀人鬼出现后开门失败时所有杀人鬼获胜", () => {
    let state = createDeterministicState(["A", "B"]);
    const [p1, p2] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "killer_key");
    state = flipByCardId(state, p2, "empty_room", 0);

    state = setCurrentPlayer(state, p1);
    state = flipByCardId(state, p1, "sleep_gas", 0);
    state = resolvePendingChoice(state, p1, { option: "use_effect" });

    state = setCurrentPlayer(state, p2);
    state = flipByCardId(state, p2, "killer_key");

    state = flipByCardId(state, p1, "silver_key", 0);
    state = flipByCardId(state, p2, "silver_key", 0);

    state = flipByCardId(state, p1, "escape_exit");
    state = resolvePendingChoice(state, p1, { option: "yes" });
    state = resolvePendingChoice(state, p1, {
      key_instance_ids: allFaceDownKeyIds(state).slice(0, 3),
    });

    expect(state.phase).toBe("ended");
    expect(state.winner?.team).toBe("killer");
    expect(state.winner?.player_ids.sort()).toEqual([p1, p2].sort());
  });

  it("12) 死亡玩家会退出游戏，不再参与后续回合", () => {
    let state = createDeterministicState(["A", "B", "C"]);
    const [p1, p2, p3] = state.players.map((p) => p.id);

    state = setCurrentPlayer(state, p2);
    state = flipByCardId(state, p2, "killer_trap");

    expect(state.players.find((p) => p.id === p2)).toBeUndefined();
    expect(getLegalActions(state, p2)).toHaveLength(0);
    expect(currentPlayerId(state)).not.toBe(p2);

    const checked = checkWinConditions(state);
    expect(checked.players.find((p) => p.id === p2)).toBeUndefined();
    expect(checked.players.some((p) => p.id === p1 || p.id === p3)).toBe(true);
  });

  it("13) 玩家私密视图只显示自己的杀人鬼身份", () => {
    let state = createDeterministicState(["A", "B"]);
    const [p1, p2] = state.players.map((p) => p.id);

    state = flipByCardId(state, p1, "killer_key");

    const p1Private = getPlayerPrivateStatus(state, p1);
    const p2Private = getPlayerPrivateStatus(state, p2);
    expect(p1Private.is_killer).toBe(true);
    expect(p2Private.is_killer).toBe(false);

    const p2View = JSON.parse(serializeStateForPlayer(state, p2)) as GameState & {
      players: Array<GameState["players"][number] & { role: "normal" | "killer" | "hidden" }>;
    };

    expect(p2View.players.find((p) => p.id === p2)?.role).toBe("normal");
    expect(p2View.players.find((p) => p.id === p1)?.role).toBe("hidden");
  });
});
