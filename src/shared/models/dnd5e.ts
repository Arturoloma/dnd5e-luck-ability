export interface LuckAbilityEntry {
  label: string;
  abbreviation: string;
  fullKey: string;
  type: string;
  defaults: { value: number; max: number };
  improvement: boolean;
}

export interface DND5eConfig {
  DND5E: {
    abilities: Record<string, LuckAbilityEntry>;
  };
}
