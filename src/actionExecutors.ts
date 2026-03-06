import {
  ActionStep,
  BranchSpec,
  CardInstance,
  ChoiceState,
  EffectContext,
  EffectDefinition,
  GameState,
  NO_INSPECT_TARGET_PLAYER_ID,
  PendingChoiceKind,
  RuleDefinition,
} from "./models.js";
import {
  alivePlayers,
  findCardInstanceAnywhere,
  getCardByInstanceId,
  getCardDefinition,
  getCurrentPlayer,
  getPlayerById,
  isKeyCard,
} from "./derivedQueries.js";
import { emitEvent, playerLabel } from "./events.js";
import { checkWinConditions, evaluateCheck, resolveWinnerTarget } from "./ruleEvaluators.js";

function cloneContext(context: EffectContext): EffectContext {
  return {
    ...context,
    choices: { ...context.choices },
    chosen_key_instance_ids: context.chosen_key_instance_ids
      ? [...context.chosen_key_instance_ids]
      : undefined,
  };
}

function removeCardByInstanceId(cards: CardInstance[], instanceId: string): CardInstance | undefined {
  const index = cards.findIndex((card) => card.instance_id === instanceId);
  if (index < 0) {
    return undefined;
  }

  const [card] = cards.splice(index, 1);
  return card;
}

function findBoardSlotIndex(state: GameState, instanceId: string): number {
  return state.board_slots.findIndex((slot) => slot === instanceId);
}

function clearBoardSlotForInstance(state: GameState, instanceId: string): number {
  const slotIndex = findBoardSlotIndex(state, instanceId);
  if (slotIndex >= 0) {
    state.board_slots[slotIndex] = null;
  }
  return slotIndex;
}

function placeCardOnBoard(
  state: GameState,
  card: CardInstance,
  preferredSlotIndex?: number,
): void {
  const existingBoardIndex = state.board_face_down_cards.findIndex(
    (item) => item.instance_id === card.instance_id,
  );
  if (existingBoardIndex >= 0) {
    state.board_face_down_cards.splice(existingBoardIndex, 1);
  }
  clearBoardSlotForInstance(state, card.instance_id);

  const boardCard: CardInstance = {
    ...card,
    owner_player_id: null,
    zone: "board_face_down",
    face_up: false,
  };
  state.board_face_down_cards.push(boardCard);

  if (typeof preferredSlotIndex === "number" && preferredSlotIndex >= 0) {
    while (state.board_slots.length <= preferredSlotIndex) {
      state.board_slots.push(null);
    }
    state.board_slots[preferredSlotIndex] = boardCard.instance_id;
    return;
  }

  const firstEmptyIndex = state.board_slots.findIndex((slot) => slot === null);
  if (firstEmptyIndex >= 0) {
    state.board_slots[firstEmptyIndex] = boardCard.instance_id;
    return;
  }

  state.board_slots.push(boardCard.instance_id);
}

function formatBoardSlotLabel(state: GameState, instanceId: string): string {
  const slotIndex = state.board_slots.findIndex((slot) => slot === instanceId);
  if (slotIndex < 0) {
    return "未知房间";
  }
  return `未知房间 #${slotIndex + 1}`;
}

function removeCardFromAllZones(state: GameState, instanceId: string): CardInstance | undefined {
  const boardIndex = state.board_face_down_cards.findIndex(
    (card) => card.instance_id === instanceId,
  );
  if (boardIndex >= 0) {
    const [fromBoard] = state.board_face_down_cards.splice(boardIndex, 1);
    clearBoardSlotForInstance(state, instanceId);
    return fromBoard;
  }

  const fromTemp = removeCardByInstanceId(state.temporary_collection, instanceId);
  if (fromTemp) return fromTemp;

  const fromRemoved = removeCardByInstanceId(state.removed_from_game, instanceId);
  if (fromRemoved) return fromRemoved;

  for (const player of state.players) {
    const fromDown = removeCardByInstanceId(player.front_face_down_cards, instanceId);
    if (fromDown) return fromDown;

    const fromUp = removeCardByInstanceId(player.front_face_up_cards, instanceId);
    if (fromUp) return fromUp;
  }

  return undefined;
}

function getCurrentCard(state: GameState): CardInstance {
  if (!state.current_card_instance_id) {
    throw new Error("No current card instance in state");
  }

  const card = findCardInstanceAnywhere(state, state.current_card_instance_id);
  if (!card) {
    throw new Error(`Current card not found: ${state.current_card_instance_id}`);
  }

  return card;
}

function addPendingChoice(
  state: GameState,
  context: EffectContext,
  choiceId: string,
  options: string[],
  kind: PendingChoiceKind,
): void {
  state.pending_choice = {
    choice_id: choiceId,
    player_id: context.current_player_id,
    options,
    selected: null,
    kind,
    continuation: {
      actions: [],
      context: cloneContext(context),
      source: "card_effect",
    },
  };
}

export function appendPendingContinuation(state: GameState, actions: ActionStep[]): GameState {
  if (!state.pending_choice || actions.length === 0) {
    return state;
  }

  state.pending_choice = {
    ...state.pending_choice,
    continuation: {
      ...state.pending_choice.continuation,
      actions: [...state.pending_choice.continuation.actions, ...actions],
    },
  };

  return state;
}

function collectPlayerFrontCards(state: GameState, playerId: string): void {
  const player = getPlayerById(state, playerId);
  if (!player) return;

  const collected = [...player.front_face_down_cards, ...player.front_face_up_cards].map((card) => ({
    ...card,
    owner_player_id: null,
    face_up: false,
    zone: "board_face_down" as const,
  }));

  player.front_face_down_cards = [];
  player.front_face_up_cards = [];
  state.temporary_collection.push(...collected);
}

function collectBoardCards(state: GameState): void {
  const collected = state.board_face_down_cards.map((card) => ({
    ...card,
    owner_player_id: null,
    face_up: false,
    zone: "board_face_down" as const,
  }));

  state.board_face_down_cards = [];
  state.board_slots = [];
  state.temporary_collection.push(...collected);
}

function redistributeCollectionToBoard(state: GameState): void {
  state.board_face_down_cards = state.temporary_collection.map((card) => ({
    ...card,
    owner_player_id: null,
    face_up: false,
    zone: "board_face_down",
  }));
  state.board_slots = state.board_face_down_cards.map((card) => card.instance_id);
  state.temporary_collection = [];
}

function setWinner(state: GameState, winnerTarget: string): void {
  const winner = resolveWinnerTarget(state, winnerTarget);
  state.winner = winner;
  state.phase = "ended";
  emitEvent(state, {
    type: "winner",
    value: winner.team,
    text: `胜利阵营：${winner.team}`,
    visibility: "public",
    payload: { player_ids: winner.player_ids },
  });
}

function runDeathResolution(state: GameState, context: EffectContext): GameState {
  return runRuleById(state, "death_resolution", context);
}

function tryUseBulletproofVest(
  state: GameState,
  targetPlayerId: string,
  deathSource: string,
): boolean {
  if (!["killer_trap", "pistol"].includes(deathSource)) {
    return false;
  }

  const player = getPlayerById(state, targetPlayerId);
  if (!player) return false;

  const vestIndex = player.front_face_up_cards.findIndex(
    (card) => card.card_id === "bulletproof_vest",
  );
  if (vestIndex < 0) {
    return false;
  }

  const [vest] = player.front_face_up_cards.splice(vestIndex, 1);
  state.removed_from_game.push({
    ...vest,
    owner_player_id: null,
    zone: "removed_from_game",
    face_up: true,
  });

  emitEvent(state, {
    type: "death_cancelled",
    value: deathSource,
    text: `${playerLabel(state, targetPlayerId)} 的防弹背心抵消了 ${deathSource}`,
    actor_player_id: targetPlayerId,
    target_player_id: targetPlayerId,
    target_card_id: "bulletproof_vest",
    visibility: "public",
    payload: { death_source: deathSource },
  });

  return true;
}

function applyKillAttempt(
  state: GameState,
  context: EffectContext,
  source: string,
): GameState {
  const targetPlayerId = context.target_player_id ?? context.current_player_id;
  const targetPlayer = getPlayerById(state, targetPlayerId);
  if (!targetPlayer || !targetPlayer.alive) {
    return state;
  }

  if (tryUseBulletproofVest(state, targetPlayerId, source)) {
    return state;
  }

  targetPlayer.alive = false;
  state.death_state = {
    last_dead_player_id: targetPlayerId,
    death_source: source,
  };
  emitEvent(state, {
    type: "player_died",
    value: source,
    text: `${playerLabel(state, targetPlayerId)} 死亡（来源：${source}）`,
    actor_player_id: context.current_player_id,
    target_player_id: targetPlayerId,
    visibility: "public",
    payload: { death_source: source },
  });

  return runDeathResolution(state, context);
}

function evaluateBranches(
  state: GameState,
  context: EffectContext,
  branches: BranchSpec[],
): GameState {
  for (const branch of branches) {
    if (branch.if) {
      const conditionMatched = evaluateCheck(
        state,
        context,
        branch.if.check,
        branch.if.value,
      );
      if (conditionMatched) {
        return runActions(state, branch.then ?? [], context);
      }
      continue;
    }

    if (branch.else) {
      return runActions(state, branch.else, context);
    }
  }

  return state;
}

function executeAction(state: GameState, step: ActionStep, context: EffectContext): GameState {
  switch (step.action) {
    case "announce_sleep_gas_shuffle": {
      emitEvent(state, {
        type: "announce",
        value: "sleep_gas_shuffle",
        text: "触发催眠瓦斯、所有卡牌打乱",
        actor_player_id: context.current_player_id,
        target_card_instance_id: context.current_card_instance_id,
        target_card_id: "sleep_gas",
        visibility: "public",
      });
      return state;
    }

    case "announce_card": {
      const currentCard = getCurrentCard(state);
      emitEvent(state, {
        type: "announce",
        value: String(step.value ?? ""),
        text: `${playerLabel(state, context.current_player_id)} 宣告：${String(step.value ?? "")}`,
        actor_player_id: context.current_player_id,
        target_card_instance_id: context.current_card_instance_id,
        target_card_id: currentCard.card_id,
        visibility: "public",
      });
      return state;
    }

    case "announce_card_as": {
      const currentCard = getCurrentCard(state);
      currentCard.announced_as = String(step.value ?? "");
      emitEvent(state, {
        type: "announce_as",
        value: String(step.value ?? ""),
        text: `${playerLabel(state, context.current_player_id)} 宣告：${String(step.value ?? "")}`,
        actor_player_id: context.current_player_id,
        target_card_instance_id: context.current_card_instance_id,
        target_card_id: currentCard.card_id,
        visibility: "public",
      });
      return state;
    }

    case "return_card_to_board_face_down": {
      const currentCardId = context.current_card_instance_id;
      const preferredSlotIndex = findBoardSlotIndex(state, currentCardId);
      const currentCard = removeCardFromAllZones(state, currentCardId) ?? getCurrentCard(state);
      placeCardOnBoard(state, currentCard, preferredSlotIndex);
      return state;
    }

    case "move_card_to_player_front": {
      const currentCardId = context.current_card_instance_id;
      const currentCard = removeCardFromAllZones(state, currentCardId) ?? getCurrentCard(state);
      const player = getPlayerById(state, context.current_player_id);
      if (!player) return state;

      const faceUp = Boolean(step.face_up);
      currentCard.owner_player_id = player.id;
      currentCard.face_up = faceUp;
      currentCard.zone = faceUp ? "player_front_face_up" : "player_front_face_down";

      if (faceUp) {
        player.front_face_up_cards.push(currentCard);
        const cardDef = getCardDefinition(state, currentCard.card_id);
        if (cardDef.type === "item") {
          emitEvent(state, {
            type: "item_equipped",
            value: currentCard.card_id,
            text: `${playerLabel(state, player.id)} 装备了 ${currentCard.name}`,
            actor_player_id: player.id,
            target_player_id: player.id,
            target_card_instance_id: currentCard.instance_id,
            target_card_id: currentCard.card_id,
            visibility: "public",
          });
        }
      } else {
        player.front_face_down_cards.push(currentCard);
      }
      return state;
    }

    case "set_player_role": {
      const player = getPlayerById(state, context.current_player_id);
      if (player) {
        player.role = String(step.role) as "normal" | "killer";
      }
      return state;
    }

    case "run_rule": {
      return runRuleById(state, String(step.rule_id), context);
    }

    case "prompt_choice": {
      addPendingChoice(
        state,
        context,
        String(step.choice_id),
        (step.options as string[]) ?? [],
        "option",
      );
      return state;
    }

    case "resolve_choice": {
      const choiceId = String(step.choice_id);
      const selected = context.choices[choiceId];
      if (!selected) {
        throw new Error(`Choice not resolved: ${choiceId}`);
      }

      const branches = (step.branches as Record<string, ActionStep[]>) ?? {};
      const selectedActions = branches[selected] ?? [];
      return runActions(state, selectedActions, context);
    }

    case "collect_current_player_front_cards": {
      collectPlayerFrontCards(state, context.current_player_id);
      return state;
    }

    case "collect_all_board_cards": {
      collectBoardCards(state);
      return state;
    }

    case "shuffle_collection": {
      state.temporary_collection = state.shuffle_fn(state.temporary_collection);
      return state;
    }

    case "redistribute_collection_to_board_face_down": {
      redistributeCollectionToBoard(state);
      return state;
    }

    case "choose_target_player": {
      if (context.target_player_id) {
        return state;
      }

      const options = alivePlayers(state)
        .map((player) => player.id)
        .filter((id) => id !== context.current_player_id);

      addPendingChoice(state, context, "choose_target_player", options, "target_player");
      return state;
    }

    case "attempt_kill_player": {
      return applyKillAttempt(state, context, String(step.source));
    }

    case "collect_current_card": {
      const currentCard = removeCardFromAllZones(state, context.current_card_instance_id);
      if (!currentCard) return state;

      state.temporary_collection.push({
        ...currentCard,
        owner_player_id: null,
        face_up: false,
        zone: "board_face_down",
      });
      return state;
    }

    case "collect_last_dead_player_front_cards": {
      const deadPlayerId = state.death_state.last_dead_player_id;
      if (!deadPlayerId) return state;

      collectPlayerFrontCards(state, deadPlayerId);
      return state;
    }

    case "choose_board_face_down_card": {
      if (context.chosen_board_card_instance_id) {
        return state;
      }

      const options = state.board_face_down_cards
        .filter((card) => !card.face_up)
        .map((card) => card.instance_id)
        .filter((id) => id !== context.current_card_instance_id);

      addPendingChoice(state, context, "choose_board_face_down_card", options, "board_card");
      return state;
    }

    case "peek_chosen_card": {
      if (!context.chosen_board_card_instance_id) {
        throw new Error("No selected board card for peek action");
      }

      const card = getCardByInstanceId(state, context.chosen_board_card_instance_id);
      if (!card) {
        throw new Error("Selected board card not found");
      }
      const slotLabel = formatBoardSlotLabel(state, card.instance_id);

      emitEvent(state, {
        type: "peek_started",
        value: card.instance_id,
        text: `${playerLabel(state, context.current_player_id)} 翻看了 ${slotLabel}`,
        actor_player_id: context.current_player_id,
        target_card_instance_id: card.instance_id,
        visibility: "public",
        payload: {
          slot_label: slotLabel,
        },
      });

      emitEvent(state, {
        type: "peek",
        value: card.name,
        text: `${playerLabel(state, context.current_player_id)} 查看到：${card.name}`,
        actor_player_id: context.current_player_id,
        target_card_instance_id: card.instance_id,
        target_card_id: card.card_id,
        visibility: "actor_only",
      });
      return state;
    }

    case "return_peeked_card_to_board_face_down": {
      const selected = context.chosen_board_card_instance_id;
      if (!selected) return state;

      const card = getCardByInstanceId(state, selected);
      if (!card) return state;
      const slotLabel = formatBoardSlotLabel(state, card.instance_id);
      card.face_up = false;
      emitEvent(state, {
        type: "peek_returned",
        value: card.instance_id,
        text: `${playerLabel(state, context.current_player_id)} 将 ${slotLabel} 放回场上`,
        actor_player_id: context.current_player_id,
        target_card_instance_id: card.instance_id,
        visibility: "public",
        payload: {
          slot_label: slotLabel,
        },
      });
      return state;
    }

    case "move_this_card_to_removed_from_game": {
      const currentCard = removeCardFromAllZones(state, context.current_card_instance_id);
      if (!currentCard) return state;

      state.removed_from_game.push({
        ...currentCard,
        owner_player_id: null,
        face_up: true,
        zone: "removed_from_game",
      });
      return state;
    }

    case "choose_target_player_with_face_down_key": {
      if (context.target_player_with_key_id) {
        return state;
      }

      const targetOptions = alivePlayers(state)
        .filter((player) =>
          player.front_face_down_cards.some((card) => isKeyCard(state, card.card_id)),
        )
        .map((player) => player.id)
        .filter((id) => id !== context.current_player_id);
      const options = [...targetOptions, NO_INSPECT_TARGET_PLAYER_ID];

      addPendingChoice(
        state,
        context,
        "choose_target_player_with_face_down_key",
        options,
        "target_player_with_key",
      );
      return state;
    }

    case "choose_one_face_down_key_of_target": {
      if (context.chosen_target_key_instance_id) {
        return state;
      }

      const targetPlayer = getPlayerById(state, context.target_player_with_key_id ?? "");
      if (!targetPlayer) return state;

      const options = targetPlayer.front_face_down_cards
        .filter((card) => isKeyCard(state, card.card_id))
        .map((card) => card.instance_id);

      addPendingChoice(
        state,
        context,
        "choose_one_face_down_key_of_target",
        options,
        "target_player_key",
      );
      return state;
    }

    case "reveal_selected_face_down_key_of_target": {
      const targetPlayer = getPlayerById(state, context.target_player_with_key_id ?? "");
      if (!targetPlayer) return state;

      const selectedId = context.chosen_target_key_instance_id;
      if (!selectedId) {
        throw new Error("No selected target key for reveal action");
      }

      const keyIndex = targetPlayer.front_face_down_cards.findIndex(
        (card) => card.instance_id === selectedId && isKeyCard(state, card.card_id),
      );
      if (keyIndex < 0) {
        throw new Error("Selected target key not found");
      }

      const [revealedCard] = targetPlayer.front_face_down_cards.splice(keyIndex, 1);
      revealedCard.face_up = true;
      revealedCard.zone = "player_front_face_up";
      targetPlayer.front_face_up_cards.push(revealedCard);
      context.revealed_card_instance_id = revealedCard.instance_id;

      const isKillerKey = revealedCard.card_id === "killer_key";
      emitEvent(state, {
        type: "key_inspection_result",
        value: revealedCard.card_id,
        text: isKillerKey ? "发现杀人鬼钥匙并移除" : "发现银钥匙",
        actor_player_id: context.current_player_id,
        target_player_id: targetPlayer.id,
        target_card_instance_id: revealedCard.instance_id,
        target_card_id: revealedCard.card_id,
        visibility: "public",
      });
      return state;
    }

    case "reveal_one_face_down_key_of_target": {
      const targetPlayer = getPlayerById(state, context.target_player_with_key_id ?? "");
      if (!targetPlayer) return state;

      const keyIndex = targetPlayer.front_face_down_cards.findIndex((card) =>
        isKeyCard(state, card.card_id),
      );
      if (keyIndex < 0) return state;

      const [revealedCard] = targetPlayer.front_face_down_cards.splice(keyIndex, 1);
      revealedCard.face_up = true;
      revealedCard.zone = "player_front_face_up";
      targetPlayer.front_face_up_cards.push(revealedCard);
      context.revealed_card_instance_id = revealedCard.instance_id;
      return state;
    }

    case "if_revealed_card_matches": {
      const revealed = context.revealed_card_instance_id
        ? findCardInstanceAnywhere(state, context.revealed_card_instance_id)
        : undefined;

      if (revealed && revealed.card_id === String(step.card_id)) {
        return runActions(state, (step.then as ActionStep[]) ?? [], context);
      }
      return state;
    }

    case "move_revealed_card_to_removed_from_game": {
      if (!context.revealed_card_instance_id) return state;
      const revealed = removeCardFromAllZones(state, context.revealed_card_instance_id);
      if (!revealed) return state;

      state.removed_from_game.push({
        ...revealed,
        owner_player_id: null,
        zone: "removed_from_game",
        face_up: true,
      });
      return state;
    }

    case "reveal_current_card": {
      const card = getCurrentCard(state);
      card.face_up = true;
      return state;
    }

    case "choose_three_keys_from_all_players": {
      if (context.chosen_key_instance_ids && context.chosen_key_instance_ids.length === 3) {
        return state;
      }

      const options = state.players.flatMap((player) =>
        player.front_face_down_cards
          .filter((card) => isKeyCard(state, card.card_id))
          .map((card) => card.instance_id),
      );

      if (options.length === 3) {
        context.chosen_key_instance_ids = [...options];
        return state;
      }

      addPendingChoice(state, context, "choose_three_keys_from_all_players", options, "three_keys");
      return state;
    }

    case "reveal_chosen_keys": {
      const chosen = context.chosen_key_instance_ids ?? [];
      context.revealed_escape_all_real = chosen.every((instanceId) => {
        const card = findCardInstanceAnywhere(state, instanceId);
        return !!card && card.card_id === "silver_key";
      });
      context.escape_failed_due_to_fake_key = !context.revealed_escape_all_real;
      return state;
    }

    case "set_winner": {
      if (String(step.value) === "all_killers" && context.escape_failed_due_to_fake_key) {
        emitEvent(state, {
          type: "announce",
          value: "escape_failed_killer_win",
          text: "逃离失败、杀人鬼获胜",
          actor_player_id: context.current_player_id,
          visibility: "public",
        });
      }
      setWinner(state, String(step.value));
      return state;
    }

    case "collect_all_player_front_keys_face_down": {
      for (const player of state.players) {
        const keep: CardInstance[] = [];
        for (const card of player.front_face_down_cards) {
          if (isKeyCard(state, card.card_id)) {
            state.temporary_collection.push({
              ...card,
              owner_player_id: null,
              face_up: false,
              zone: "board_face_down",
            });
          } else {
            keep.push(card);
          }
        }
        player.front_face_down_cards = keep;
      }
      return state;
    }

    case "remove_one_card_by_id_from_collection": {
      const cardId = String(step.value);
      const index = state.temporary_collection.findIndex((card) => card.card_id === cardId);
      if (index >= 0) {
        const [removed] = state.temporary_collection.splice(index, 1);
        state.removed_from_game.push({
          ...removed,
          owner_player_id: null,
          zone: "removed_from_game",
          face_up: true,
        });
      }
      return state;
    }

    case "add_remaining_collection_to_board_collection": {
      return state;
    }

    case "collect_dead_player_front_cards": {
      const deadPlayerId = state.death_state.last_dead_player_id;
      if (!deadPlayerId) return state;
      collectPlayerFrontCards(state, deadPlayerId);
      return state;
    }

    case "remove_last_dead_player_from_game": {
      const deadPlayerId = state.death_state.last_dead_player_id;
      if (!deadPlayerId) return state;
      const deadPlayerName = playerLabel(state, deadPlayerId);

      const deadIndex = state.players.findIndex((player) => player.id === deadPlayerId);
      if (deadIndex < 0) return state;

      if (deadIndex < state.current_player_index) {
        state.current_player_index -= 1;
      }

      state.players.splice(deadIndex, 1);
      emitEvent(state, {
        type: "player_eliminated",
        value: deadPlayerId,
        text: `${deadPlayerName} 已出局`,
        target_player_id: deadPlayerId,
        visibility: "public",
      });

      if (state.current_player_index >= state.players.length) {
        state.current_player_index = 0;
      }

      return state;
    }

    case "cancel_death": {
      return state;
    }

    case "create_deck_from_card_counts": {
      state.board_face_down_cards = [];
      state.board_slots = [];
      state.temporary_collection = [];
      let sequence = 1;
      for (const cardDef of state.rules_package.cards) {
        for (let i = 0; i < cardDef.count; i += 1) {
          state.temporary_collection.push({
            instance_id: `c_${sequence}`,
            card_id: cardDef.id,
            name: cardDef.name,
            owner_player_id: null,
            zone: "board_face_down",
            face_up: false,
          });
          sequence += 1;
        }
      }
      return state;
    }

    case "shuffle_deck": {
      state.temporary_collection = state.shuffle_fn(state.temporary_collection);
      return state;
    }

    case "move_all_cards_to_board_face_down": {
      state.board_face_down_cards = state.temporary_collection.map((card) => ({
        ...card,
        owner_player_id: null,
        zone: "board_face_down",
        face_up: false,
      }));
      state.board_slots = state.board_face_down_cards.map((card) => card.instance_id);
      state.temporary_collection = [];
      return state;
    }

    case "set_all_players_role": {
      const role = String(step.role) as "normal" | "killer";
      for (const player of state.players) {
        player.role = role;
      }
      return state;
    }

    case "set_all_players_alive": {
      const alive = Boolean(step.value);
      for (const player of state.players) {
        player.alive = alive;
      }
      return state;
    }

    case "set_current_player_index": {
      state.current_player_index = Number(step.value) || 0;
      return state;
    }

    case "check_all_win_conditions": {
      return checkWinConditions(state);
    }

    case "advance_turn_to_next_alive_player": {
      if (state.players.length === 0) return state;
      const fromPlayerId = state.players[state.current_player_index]?.id;
      let next = state.current_player_index;
      let guard = 0;
      do {
        next = (next + 1) % state.players.length;
        guard += 1;
      } while (!state.players[next]?.alive && guard <= state.players.length + 1);

      state.current_player_index = next;
      state.turn_number += 1;
      const toPlayerId = state.players[next]?.id;
      emitEvent(state, {
        type: "turn_advanced",
        value: `${fromPlayerId ?? ""}->${toPlayerId ?? ""}`,
        text: `回合切换：${playerLabel(state, fromPlayerId)} -> ${playerLabel(state, toPlayerId)}`,
        actor_player_id: fromPlayerId,
        target_player_id: toPlayerId,
        visibility: "public",
        payload: {
          from_turn: state.turn_number - 1,
          to_turn: state.turn_number,
        },
      });
      return state;
    }

    case "current_player_flips_one_board_face_down_card":
    case "resolve_current_card_effect": {
      return state;
    }

    case "__execute_branches": {
      return evaluateBranches(state, context, (step.branches as BranchSpec[]) ?? []);
    }

    default:
      throw new Error(`Unsupported action: ${step.action}`);
  }
}

export function runActions(
  state: GameState,
  actions: ActionStep[],
  context: EffectContext,
): GameState {
  let workingState = state;

  for (let i = 0; i < actions.length; i += 1) {
    const step = actions[i];
    workingState = executeAction(workingState, step, context);

    if (workingState.pending_choice) {
      const remaining = actions.slice(i + 1);
      return appendPendingContinuation(workingState, remaining);
    }

    if (workingState.phase === "ended") {
      return workingState;
    }
  }

  return workingState;
}

export function runEffectDefinition(
  state: GameState,
  effect: EffectDefinition | undefined,
  context: EffectContext,
): GameState {
  if (!effect) {
    return state;
  }

  if (effect.mode === "steps") {
    return runActions(state, effect.steps ?? [], context);
  }

  if (effect.mode === "branch") {
    return evaluateBranches(state, context, effect.branches ?? []);
  }

  if (effect.steps) {
    return runActions(state, effect.steps, context);
  }

  return state;
}

function findRuleDefinition(state: GameState, ruleId: string): RuleDefinition {
  const rule = state.rules_package.rules.rule_defs.find((item) => item.id === ruleId);
  if (!rule) {
    throw new Error(`Rule definition not found: ${ruleId}`);
  }
  return rule;
}

export function runRuleById(state: GameState, ruleId: string, context: EffectContext): GameState {
  const rule = findRuleDefinition(state, ruleId);

  let workingState = state;
  if (rule.steps) {
    workingState = runActions(workingState, rule.steps, context);
    if (workingState.pending_choice && rule.branches && rule.branches.length > 0) {
      return appendPendingContinuation(workingState, [
        { action: "__execute_branches", branches: rule.branches },
      ]);
    }
  }

  if (workingState.pending_choice || workingState.phase === "ended") {
    return workingState;
  }

  if (rule.branches) {
    workingState = evaluateBranches(workingState, context, rule.branches);
  }

  return workingState;
}

export function applyChoiceSelection(
  pendingChoice: ChoiceState,
  userChoice: {
    option?: string;
    target_player_id?: string;
    board_card_instance_id?: string;
    target_key_instance_id?: string;
    key_instance_ids?: string[];
  },
): EffectContext {
  const context = cloneContext(pendingChoice.continuation.context);

  switch (pendingChoice.kind) {
    case "option": {
      if (!userChoice.option) {
        throw new Error(`Choice ${pendingChoice.choice_id} requires option`);
      }
      if (!pendingChoice.options.includes(userChoice.option)) {
        throw new Error(`Invalid option '${userChoice.option}' for choice ${pendingChoice.choice_id}`);
      }
      context.choices[pendingChoice.choice_id] = userChoice.option;
      return context;
    }

    case "target_player": {
      if (!userChoice.target_player_id) {
        throw new Error("Target player is required");
      }
      if (!pendingChoice.options.includes(userChoice.target_player_id)) {
        throw new Error("Invalid target player");
      }
      context.target_player_id = userChoice.target_player_id;
      return context;
    }

    case "board_card": {
      if (!userChoice.board_card_instance_id) {
        throw new Error("Board card instance id is required");
      }
      if (!pendingChoice.options.includes(userChoice.board_card_instance_id)) {
        throw new Error("Invalid board card target");
      }
      context.chosen_board_card_instance_id = userChoice.board_card_instance_id;
      return context;
    }

    case "target_player_with_key": {
      if (!userChoice.target_player_id) {
        throw new Error("Target player with key is required");
      }
      if (!pendingChoice.options.includes(userChoice.target_player_id)) {
        throw new Error("Invalid target player with key");
      }
      context.target_player_with_key_id = userChoice.target_player_id;
      return context;
    }

    case "target_player_key": {
      if (!userChoice.target_key_instance_id) {
        throw new Error("Target key instance id is required");
      }
      if (!pendingChoice.options.includes(userChoice.target_key_instance_id)) {
        throw new Error("Invalid target key instance");
      }
      context.chosen_target_key_instance_id = userChoice.target_key_instance_id;
      return context;
    }

    case "three_keys": {
      const ids = userChoice.key_instance_ids ?? [];
      if (ids.length !== 3) {
        throw new Error("Exactly three key instance ids are required");
      }
      for (const id of ids) {
        if (!pendingChoice.options.includes(id)) {
          throw new Error(`Invalid key instance in selection: ${id}`);
        }
      }
      context.chosen_key_instance_ids = [...ids];
      return context;
    }

    default:
      return context;
  }
}

export function advanceTurn(state: GameState): GameState {
  if (state.phase === "ended" || state.players.length === 0) {
    return state;
  }

  const aliveCount = state.players.filter((player) => player.alive).length;
  if (aliveCount === 0) {
    return state;
  }

  const fromPlayerId = state.players[state.current_player_index]?.id;
  let next = state.current_player_index;
  let guard = 0;
  do {
    next = (next + 1) % state.players.length;
    guard += 1;
  } while (!state.players[next].alive && guard <= state.players.length + 1);
  const toPlayerId = state.players[next]?.id;
  const nextState = {
    ...state,
    current_player_index: next,
    turn_number: state.turn_number + 1,
  };
  emitEvent(nextState, {
    type: "turn_advanced",
    value: `${fromPlayerId ?? ""}->${toPlayerId ?? ""}`,
    text: `回合切换：${playerLabel(nextState, fromPlayerId)} -> ${playerLabel(nextState, toPlayerId)}`,
    actor_player_id: fromPlayerId,
    target_player_id: toPlayerId,
    visibility: "public",
    payload: {
      from_turn: state.turn_number,
      to_turn: state.turn_number + 1,
    },
  });
  return nextState;
}

export function startCardResolution(
  state: GameState,
  cardInstanceId: string,
): { state: GameState; context: EffectContext } {
  const card = getCardByInstanceId(state, cardInstanceId);
  if (!card) {
    throw new Error(`Card is not on board: ${cardInstanceId}`);
  }

  card.face_up = true;
  state.current_card_instance_id = cardInstanceId;

  const currentPlayer = getCurrentPlayer(state);
  if (!currentPlayer) {
    throw new Error("No current player found");
  }

  const context: EffectContext = {
    current_player_id: currentPlayer.id,
    current_card_instance_id: cardInstanceId,
    choices: {},
  };
  emitEvent(state, {
    type: "card_flipped",
    value: cardInstanceId,
    text: `${playerLabel(state, currentPlayer.id)} 翻开了一张牌`,
    actor_player_id: currentPlayer.id,
    target_card_instance_id: cardInstanceId,
    target_card_id: card.card_id,
    visibility: "public",
  });

  return { state, context };
}

export function resolveCurrentCardEffect(state: GameState, context: EffectContext): GameState {
  const currentCard = getCurrentCard(state);
  const cardDef = getCardDefinition(state, currentCard.card_id);
  return runEffectDefinition(state, cardDef.on_flip, context);
}
