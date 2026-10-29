import { PRIVATE_NOTE_LIMIT } from '../../src/core/memory';

export interface Memory { notes: string[]; noteIds?: string[]; nextNoteId?: number; }

// Keep text-only recordings readable; IDs survive edits, compaction and restarts.
export function journalEntries(memory: Memory) {
  memory.notes = memory.notes.slice(-PRIVATE_NOTE_LIMIT);
  const ids = memory.noteIds?.slice(-PRIVATE_NOTE_LIMIT) ?? [];
  const used = new Set<string>();
  let next = Math.max(memory.nextNoteId ?? 1, ...ids.map(id => Number(/^note-(\d+)$/.exec(id)?.[1] ?? 0) + 1));
  memory.noteIds = memory.notes.map((_, index) => {
    const old = ids[index];
    const id = old && !used.has(old) ? old : `note-${next++}`;
    used.add(id);
    return id;
  });
  memory.nextNoteId = next;
  return memory.notes.map((text, index) => ({ id: memory.noteIds![index], text }));
}

export function setJournalNotes(memory: Memory, notes: string[]) {
  const previous = journalEntries(memory);
  memory.noteIds = notes.map(text => previous.find(entry => entry.text === text)?.id ?? `note-${memory.nextNoteId!++}`);
  memory.notes = notes;
  return journalEntries(memory);
}
