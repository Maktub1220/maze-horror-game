import { GameState, Player, RulesPackage, ShuffleFn } from "./models.js";
import { defaultShuffle } from "./shuffle.js";

function createDeck(rules: RulesPackage) {
  const deck = [] as GameState["temporary_collection"];

  for (const card of rules.cards) {
    for (let i = 0; i < card.count; i += 1) {
      deck.push({
        instance_id: `${card.id}__${i + 1}`,
        card_id: card.id,
        name: card.name,
        owner_player_id: null,
        zone: "board_face_down",
        face_up: false,
      });
    }
  }

  return deck;
}

function createPlayers(playerNames: string[]): Player[] {
  return playerNames.map((name, index) => ({
    id: `p${index + 1}`,
    name,
    alive: true,
    role: "normal",
    front_face_down_cards: [],
    front_face_up_cards: [],
  }));
}

export function createInitialGameState(
  playerNames: string[],
  rules: RulesPackage,
  shuffleFn: ShuffleFn = defaultShuffle,
): GameState {
  if (
    playerNames.length < rules.player_count.min ||
    playerNames.length > rules.player_count.max
  ) {
    throw new Error(
      `Player count must be between ${rules.player_count.min} and ${rules.player_count.max}.`,
    );
  }

  const players = createPlayers(playerNames);
  const deck = createDeck(rules);
  const shuffledDeck = shuffleFn(deck);

  return {
    game_id: rules.game_id,
    version: rules.version,
    phase: "playing",
    players,
    board_face_down_cards: shuffledDeck.map((card) => ({
      ...card,
      owner_player_id: null,
      zone: "board_face_down",
      face_up: false,
    })),
    removed_from_game: [],
    current_player_index: 0,
    current_card_instance_id: null,
    pending_choice: null,
    temporary_collection: [],
    death_state: {
      last_dead_player_id: null,
      death_source: null,
    },
    winner: null,
    turn_number: 1,
    rules_package: rules,
    event_log: [],
    shuffle_fn: shuffleFn,
  };
}
