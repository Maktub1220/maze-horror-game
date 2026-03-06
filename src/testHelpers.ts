import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInitialGameState } from "./gameStateFactory.js";
import { GameState, RulesPackage } from "./models.js";
import { deterministicShuffle } from "./shuffle.js";

export function loadDefaultRules(): RulesPackage {
  const filePath = join(process.cwd(), "rules", "basic-rules.json");
  const raw = readFileSync(filePath, { encoding: "utf8" });
  return JSON.parse(raw) as RulesPackage;
}

export function createDeterministicState(playerNames: string[]): GameState {
  return createInitialGameState(playerNames, loadDefaultRules(), deterministicShuffle);
}

export function cloneTestState(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      front_face_down_cards: player.front_face_down_cards.map((card) => ({ ...card })),
      front_face_up_cards: player.front_face_up_cards.map((card) => ({ ...card })),
    })),
    board_face_down_cards: state.board_face_down_cards.map((card) => ({ ...card })),
    removed_from_game: state.removed_from_game.map((card) => ({ ...card })),
    temporary_collection: state.temporary_collection.map((card) => ({ ...card })),
    death_state: { ...state.death_state },
    pending_choice: state.pending_choice
      ? {
          ...state.pending_choice,
          options: [...state.pending_choice.options],
          continuation: {
            ...state.pending_choice.continuation,
            actions: [...state.pending_choice.continuation.actions],
            context: {
              ...state.pending_choice.continuation.context,
              choices: { ...state.pending_choice.continuation.context.choices },
              chosen_key_instance_ids: state.pending_choice.continuation.context.chosen_key_instance_ids
                ? [...state.pending_choice.continuation.context.chosen_key_instance_ids]
                : undefined,
            },
          },
        }
      : null,
    winner: state.winner
      ? {
          ...state.winner,
          player_ids: [...state.winner.player_ids],
        }
      : null,
    event_log: state.event_log.map((event) => ({ ...event })),
  };
}

export function withBoardOrder(state: GameState, cardIds: string[]): GameState {
  const cloned = cloneTestState(state);
  const used = new Set<string>();
  const ordered = [] as GameState["board_face_down_cards"];

  for (const cardId of cardIds) {
    const card = cloned.board_face_down_cards.find(
      (c) => c.card_id === cardId && !used.has(c.instance_id),
    );
    if (!card) {
      throw new Error(`Board card not found for id: ${cardId}`);
    }
    used.add(card.instance_id);
    ordered.push(card);
  }

  const rest = cloned.board_face_down_cards.filter((card) => !used.has(card.instance_id));
  cloned.board_face_down_cards = [...ordered, ...rest];
  return cloned;
}

export function findBoardCardInstanceId(state: GameState, cardId: string, index = 0): string {
  const card = state.board_face_down_cards.filter((item) => item.card_id === cardId)[index];
  if (!card) {
    throw new Error(`Board card instance not found for ${cardId}[${index}]`);
  }
  return card.instance_id;
}

export function setCurrentPlayer(state: GameState, playerId: string): GameState {
  const cloned = cloneTestState(state);
  const index = cloned.players.findIndex((player) => player.id === playerId);
  if (index < 0) {
    throw new Error(`Player not found: ${playerId}`);
  }
  cloned.current_player_index = index;
  return cloned;
}
