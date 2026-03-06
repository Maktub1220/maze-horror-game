export type PlayerRole = "normal" | "killer";
export type Phase = "setup" | "playing" | "ended";
export type Zone =
  | "board_face_down"
  | "player_front_face_down"
  | "player_front_face_up"
  | "removed_from_game";

export interface ConditionSpec {
  check: string;
  value?: unknown;
}

export interface ActionStep {
  action: string;
  [key: string]: unknown;
}

export interface BranchSpec {
  if?: ConditionSpec;
  then?: ActionStep[];
  else?: ActionStep[];
}

export interface EffectDefinition {
  mode?: "steps" | "branch";
  steps?: ActionStep[];
  branches?: BranchSpec[];
}

export interface PassiveEffect {
  trigger: string;
  condition?: {
    death_source_in?: string[];
  };
  steps: ActionStep[];
}

export interface CardDefinition {
  id: string;
  name: string;
  count: number;
  type: string;
  subtype: string;
  trigger: string;
  can_be_kept: boolean;
  keep_zone: Zone | null;
  visibility_when_kept: "face_down" | "face_up" | null;
  can_bluff_as_empty: boolean;
  tags: string[];
  on_flip?: EffectDefinition;
  passive_effects?: PassiveEffect[];
}

export interface RuleDefinition {
  id: string;
  name: string;
  trigger: string;
  steps?: ActionStep[];
  branches?: BranchSpec[];
  notes?: string[];
}

export interface WinConditionDefinition {
  id: string;
  team: string;
  trigger: string;
  winner_target: string;
}

export interface RuleSetDefinition {
  turn_flow: Array<{ step: number; id: string; action: string }>;
  rule_defs: RuleDefinition[];
  win_conditions: WinConditionDefinition[];
  global_special_rules: Array<Record<string, unknown>>;
}

export interface RulesPackage {
  game_id: string;
  game_name: string;
  version: string;
  total_cards: number;
  player_count: { min: number; max: number };
  setup: Record<string, unknown>;
  board: {
    layout: string;
    zones: Zone[];
  };
  cards: CardDefinition[];
  rules: RuleSetDefinition;
  action_specs: Array<{ id: string; params: string[]; description: string }>;
  state_schema: Record<string, unknown>;
  derived_queries: Array<{ id: string; description: string }>;
}

export interface CardInstance {
  instance_id: string;
  card_id: string;
  name: string;
  owner_player_id: string | null;
  zone: Zone;
  face_up: boolean;
  announced_as?: string;
}

export interface Player {
  id: string;
  name: string;
  alive: boolean;
  role: PlayerRole;
  front_face_down_cards: CardInstance[];
  front_face_up_cards: CardInstance[];
}

export interface EffectContext {
  current_player_id: string;
  current_card_instance_id: string;
  choices: Record<string, string>;
  target_player_id?: string;
  chosen_board_card_instance_id?: string;
  target_player_with_key_id?: string;
  revealed_card_instance_id?: string;
  chosen_key_instance_ids?: string[];
  revealed_escape_all_real?: boolean;
  escape_failed_due_to_fake_key?: boolean;
}

export interface Continuation {
  actions: ActionStep[];
  context: EffectContext;
  source: "card_effect";
}

export type PendingChoiceKind =
  | "option"
  | "target_player"
  | "board_card"
  | "target_player_with_key"
  | "three_keys";

export const NO_INSPECT_TARGET_PLAYER_ID = "__no_inspect__";

export interface ChoiceState {
  choice_id: string;
  player_id: string;
  options: string[];
  selected: string | null;
  kind: PendingChoiceKind;
  continuation: Continuation;
}

export interface DeathState {
  last_dead_player_id: string | null;
  death_source: string | null;
}

export interface WinnerInfo {
  team: string;
  player_ids: string[];
}

export interface EventLogEntry {
  type:
    | "announce"
    | "announce_as"
    | "peek"
    | "choice_prompt"
    | "death_cancelled"
    | "winner";
  value: string;
  player_id?: string;
  card_instance_id?: string;
}

export type ShuffleFn = <T>(items: readonly T[]) => T[];

export interface GameState {
  game_id: string;
  version: string;
  phase: Phase;
  players: Player[];
  board_face_down_cards: CardInstance[];
  removed_from_game: CardInstance[];
  current_player_index: number;
  current_card_instance_id: string | null;
  pending_choice: ChoiceState | null;
  temporary_collection: CardInstance[];
  death_state: DeathState;
  winner: WinnerInfo | null;
  turn_number: number;
  rules_package: RulesPackage;
  event_log: EventLogEntry[];
  shuffle_fn: ShuffleFn;
}

export interface ResolveChoiceInput {
  option?: string;
  target_player_id?: string;
  board_card_instance_id?: string;
  key_instance_ids?: string[];
}

export interface LegalAction {
  type: "flip_card" | "resolve_choice";
  player_id: string;
  card_instance_id?: string;
  choice_id?: string;
  options?: string[];
  kind?: PendingChoiceKind;
}
