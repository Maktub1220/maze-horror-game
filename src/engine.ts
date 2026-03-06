import {
  ActionStep,
  ChoiceState,
  GameState,
  LegalAction,
  NO_INSPECT_TARGET_PLAYER_ID,
  ReactionState,
  ResolveChoiceInput,
  ResolveReactionInput,
} from "./models.js";
import { getCardByInstanceId, getCardDefinition, getCurrentPlayer } from "./derivedQueries.js";
import { checkWinConditions as evaluateWinConditions } from "./ruleEvaluators.js";
import {
  advanceTurn,
  applyChoiceSelection,
  resolveCurrentCardEffect,
  runActions,
  startCardResolution,
} from "./actionExecutors.js";

function clonePendingChoice(choice: ChoiceState | null): ChoiceState | null {
  if (!choice) {
    return null;
  }

  return {
    ...choice,
    options: [...choice.options],
    continuation: {
      ...choice.continuation,
      actions: [...choice.continuation.actions],
      context: {
        ...choice.continuation.context,
        choices: { ...choice.continuation.context.choices },
        chosen_key_instance_ids: choice.continuation.context.chosen_key_instance_ids
          ? [...choice.continuation.context.chosen_key_instance_ids]
          : undefined,
      },
    },
  };
}

function clonePendingReaction(reaction: ReactionState | null): ReactionState | null {
  if (!reaction) {
    return null;
  }

  return {
    ...reaction,
    options: reaction.options.map((option) => ({ ...option })),
  };
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      front_face_down_cards: player.front_face_down_cards.map((card) => ({ ...card })),
      front_face_up_cards: player.front_face_up_cards.map((card) => ({ ...card })),
    })),
    board_face_down_cards: state.board_face_down_cards.map((card) => ({ ...card })),
    board_slots: [...state.board_slots],
    removed_from_game: state.removed_from_game.map((card) => ({ ...card })),
    pending_reaction: clonePendingReaction(state.pending_reaction),
    pending_choice: clonePendingChoice(state.pending_choice),
    temporary_collection: state.temporary_collection.map((card) => ({ ...card })),
    death_state: { ...state.death_state },
    winner: state.winner
      ? {
          ...state.winner,
          player_ids: [...state.winner.player_ids],
        }
      : null,
    event_log: state.event_log.map((event) => ({ ...event })),
  };
}

function finalizeResolvedCard(state: GameState): GameState {
  let workingState = evaluateWinConditions(state);
  workingState.current_card_instance_id = null;

  if (
    !workingState.pending_reaction &&
    !workingState.pending_choice &&
    workingState.phase === "playing"
  ) {
    workingState = advanceTurn(workingState);
  }

  return workingState;
}

function rewriteContinuationForSpecialChoice(
  state: GameState,
  pending: ChoiceState,
  choice: ResolveChoiceInput,
): ActionStep[] {
  if (
    pending.choice_id === "choose_target_player_with_face_down_key" &&
    pending.kind === "target_player_with_key" &&
    choice.target_player_id === NO_INSPECT_TARGET_PLAYER_ID
  ) {
    const emptyRoomName = getCardDefinition(state, "empty_room").name;
    return [
      { action: "announce_card_as", value: emptyRoomName },
      { action: "return_card_to_board_face_down" },
    ];
  }

  return pending.continuation.actions;
}

function createReactionState(
  state: GameState,
  playerId: string,
  cardInstanceId: string,
): ReactionState {
  const card = getCardByInstanceId(state, cardInstanceId);
  if (!card) {
    throw new Error(`Card is not on board: ${cardInstanceId}`);
  }

  const emptyRoomName = getCardDefinition(state, "empty_room").name;

  if (card.card_id === "empty_room") {
    return {
      player_id: playerId,
      card_instance_id: card.instance_id,
      card_id: card.card_id,
      card_name: card.name,
      options: [
        {
          id: "declare_empty_room",
          label: `宣称：${emptyRoomName}`,
        },
      ],
    };
  }

  return {
    player_id: playerId,
    card_instance_id: card.instance_id,
    card_id: card.card_id,
    card_name: card.name,
    options: [
      {
        id: "play_as_drawn",
        label: "按规则结算",
      },
    ],
  };
}

export function flipCard(
  state: GameState,
  playerId: string,
  cardInstanceId: string,
): GameState {
  if (state.phase !== "playing") {
    throw new Error("Game is not in playing phase");
  }

  if (state.pending_reaction || state.pending_choice) {
    throw new Error("Cannot flip while reaction/choice is pending");
  }

  const currentPlayer = getCurrentPlayer(state);
  if (!currentPlayer || currentPlayer.id !== playerId) {
    throw new Error("Only current player can flip a card");
  }

  if (!currentPlayer.alive) {
    throw new Error("Current player is not alive");
  }

  const card = getCardByInstanceId(state, cardInstanceId);
  if (!card) {
    throw new Error("Card must be a board face-down card");
  }

  if (card.face_up) {
    throw new Error("Card is already face up");
  }

  const workingState = cloneState(state);
  const start = startCardResolution(workingState, cardInstanceId);
  start.state.pending_reaction = createReactionState(start.state, playerId, cardInstanceId);
  return start.state;
}

export function resolvePendingReaction(
  state: GameState,
  playerId: string,
  reaction: ResolveReactionInput,
): GameState {
  if (!state.pending_reaction) {
    throw new Error("No pending reaction to resolve");
  }

  if (state.pending_reaction.player_id !== playerId) {
    throw new Error("Only the current reacting player can resolve this reaction");
  }

  const reactionId = String(reaction.reaction_id ?? "").trim();
  if (!reactionId) {
    throw new Error("reaction_id is required");
  }

  let workingState = cloneState(state);
  const pending = workingState.pending_reaction;
  if (!pending) {
    throw new Error("Pending reaction disappeared unexpectedly");
  }

  if (!pending.options.some((option) => option.id === reactionId)) {
    throw new Error(`Invalid reaction: ${reactionId}`);
  }

  workingState.pending_reaction = null;

  const context = {
    current_player_id: pending.player_id,
    current_card_instance_id: pending.card_instance_id,
    choices: {},
  };

  if (reactionId === "declare_empty_room") {
    const emptyRoomName = getCardDefinition(workingState, "empty_room").name;
    workingState = runActions(
      workingState,
      [
        { action: "announce_card_as", value: emptyRoomName },
        { action: "return_card_to_board_face_down" },
      ],
      context,
    );
  } else {
    workingState = resolveCurrentCardEffect(workingState, context);
  }

  if (workingState.pending_reaction || workingState.pending_choice) {
    return workingState;
  }

  return finalizeResolvedCard(workingState);
}

export function resolvePendingChoice(
  state: GameState,
  playerId: string,
  choice: ResolveChoiceInput,
): GameState {
  if (state.pending_reaction) {
    throw new Error("Resolve reaction before resolving choice");
  }

  if (!state.pending_choice) {
    throw new Error("No pending choice to resolve");
  }

  if (state.pending_choice.player_id !== playerId) {
    throw new Error("Only the prompted player can resolve this choice");
  }

  let workingState = cloneState(state);
  const pending = workingState.pending_choice;
  if (!pending) {
    throw new Error("Pending choice disappeared unexpectedly");
  }

  const context = applyChoiceSelection(pending, choice);
  workingState.pending_choice = null;

  const continuationActions = rewriteContinuationForSpecialChoice(
    workingState,
    pending,
    choice,
  );
  workingState = runActions(workingState, continuationActions, context);

  if (workingState.pending_reaction || workingState.pending_choice) {
    return workingState;
  }

  return finalizeResolvedCard(workingState);
}

export function getLegalActions(state: GameState, playerId: string): LegalAction[] {
  if (state.phase !== "playing") {
    return [];
  }

  if (state.pending_reaction) {
    if (state.pending_reaction.player_id !== playerId) {
      return [];
    }

    return [
      {
        type: "resolve_reaction",
        player_id: playerId,
        reaction_options: state.pending_reaction.options.map((option) => ({ ...option })),
      },
    ];
  }

  if (state.pending_choice) {
    if (state.pending_choice.player_id !== playerId) {
      return [];
    }

    return [
      {
        type: "resolve_choice",
        player_id: playerId,
        choice_id: state.pending_choice.choice_id,
        options: [...state.pending_choice.options],
        kind: state.pending_choice.kind,
      },
    ];
  }

  const currentPlayer = getCurrentPlayer(state);
  if (!currentPlayer || currentPlayer.id !== playerId || !currentPlayer.alive) {
    return [];
  }

  return state.board_face_down_cards
    .filter((card) => !card.face_up)
    .map((card) => ({
      type: "flip_card" as const,
      player_id: playerId,
      card_instance_id: card.instance_id,
    }));
}

export function checkWinConditions(state: GameState): GameState {
  const workingState = cloneState(state);
  return evaluateWinConditions(workingState);
}

export function serializeState(state: GameState): string {
  const { shuffle_fn, ...serializable } = state;
  return JSON.stringify(serializable, null, 2);
}
