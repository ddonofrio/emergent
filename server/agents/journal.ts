export interface JournalSchedule {
  notes: string[]; turns: number; nextJournalPromptTurn?: number; lastJournalEntryTurn?: number;
  plan?: unknown;
}

export function journalReminder(mind: JournalSchedule, random = Math.random): string | undefined {
  const interval = () => mind.notes.length ? 50 : 10 + Math.floor(random() * 11);
  mind.nextJournalPromptTurn ??= mind.turns - 1 + interval();
  if (mind.turns < mind.nextJournalPromptTurn) return undefined;
  mind.nextJournalPromptTurn = mind.turns + interval();
  if(mind.plan&&!mind.notes.length)return 'Your journal is empty. Your goal and steps are already saved in your plan. Use journal for useful locations or context beyond the plan; skip it if there is nothing worth keeping.';
  return mind.notes.length
    ? 'Has your goal or its progress changed? Use journal with replace to update outdated notes, including completed or abandoned plans; skip it if nothing meaningful changed.'
    : 'Your journal is empty. An unwritten goal may be forgotten: if you have chosen something to pursue, use journal now to save the goal, progress and a location. Then take a step toward it. Otherwise keep exploring until you find a goal.';
}
