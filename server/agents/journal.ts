export interface JournalSchedule {
  notes: string[]; turns: number; nextJournalPromptTurn?: number; lastJournalEntryTurn?: number;
}

export function journalReminder(mind: JournalSchedule, random = Math.random): string | undefined {
  const interval = () => mind.notes.length ? 50 : 10 + Math.floor(random() * 11);
  mind.nextJournalPromptTurn ??= mind.turns - 1 + interval();
  if (mind.turns < mind.nextJournalPromptTurn) return undefined;
  mind.nextJournalPromptTurn = mind.turns + interval();
  return mind.notes.length
    ? 'Has your goal or its progress changed enough to save a journal update? Record a useful milestone, blocker, or revised goal; skip it if nothing meaningful changed.'
    : 'Your journal is empty. An unwritten goal may be forgotten: use journal to leave your future self a goal and where to resume. If you have no goal yet, keep exploring until you find one worth pursuing.';
}
