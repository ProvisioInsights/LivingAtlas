export type JournalEntry = { generation: number; object_id: string; sealed_b64: string };
export type Differential = {
  base_generation: number;
  target_generation: number;
  entries: JournalEntry[];
};

export function computeDifferential(journal: JournalEntry[], baseGeneration: number): Differential {
  const entries = journal
    .filter((e) => e.generation > baseGeneration)
    .sort((a, b) => a.generation - b.generation);
  const target = entries.length ? entries[entries.length - 1]!.generation : baseGeneration;
  return { base_generation: baseGeneration, target_generation: target, entries };
}
