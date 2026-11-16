
import type { Project } from '../../types';
import type { CommandResult } from './types';
import { commandTimestamp } from './types';
import { buildUsageIndex, usageCountFor } from '../usage';
import { buildCharacterCatalog } from '../script/logic';

export interface RemoveUnusedCharactersInput {
  characterIds: string[];
}

const normalizeName = (name: string): string =>
  name.replace(/\s+/g, ' ').trim().toLowerCase();

export const removeUnusedCharactersCommand = (
  project: Project,
  input: RemoveUnusedCharactersInput,
): CommandResult => {
  if (!Array.isArray(input.characterIds)) {
    throw new Error('removeUnusedCharacters: characterIds must be an array.');
  }
  const characters = project.characters ?? [];
  const activeSetup =
    project.setups.find((setup) => setup.id === project.activeSetupId) ??
    project.setups[0];

  const screenplayLines =
    project.scriptLines ?? activeSetup?.scriptLines;

  if (!Array.isArray(screenplayLines)) {
    throw new Error(
      'removeUnusedCharacters: screenplay data is unavailable; cleanup cancelled.',
    );
  }

  const knownIds = new Set(characters.map((character) => character.id));
  const requestedIds = new Set(input.characterIds);

  for (const id of requestedIds) {
    if (typeof id !== 'string' || !knownIds.has(id)) {
      throw new Error(
        `removeUnusedCharacters: unknown character "${id}".`,
      );
    }
  }

  // Rebuild the screenplay catalog from the project itself.
  // Never trust caller-provided active-character IDs.
  const scriptCharacters = buildCharacterCatalog(screenplayLines);

  const activeNames = new Set(
    scriptCharacters.flatMap((character) =>
      [character.canonicalName, ...character.aliases].map(normalizeName),
    ),
  );

  const usageIndex = buildUsageIndex(project);
  const removedIds = new Set<string>();
  const protectedNames: string[] = [];

  for (const character of characters) {
    if (!requestedIds.has(character.id)) continue;

    const names = [
      character.canonicalName,
      ...character.aliases,
    ].map(normalizeName);

    const appearsInScript = names.some((name) => activeNames.has(name));

    const hasProductionReferences =
      usageCountFor(usageIndex, 'character', character.id) > 0;

    if (appearsInScript || hasProductionReferences) {
      protectedNames.push(character.canonicalName);
      continue;
    }

    removedIds.add(character.id);
  }

  return {
    project: {
      ...project,
      characters: characters.filter(
        (character) => !removedIds.has(character.id),
      ),
    },
    meta: {
      type: 'removeUnusedCharacters',
      timestamp: commandTimestamp(),
      description: `Remove ${removedIds.size} unused character${removedIds.size === 1 ? '' : 's'}`,
    },
    ...(protectedNames.length > 0
      ? {
          warnings: [
            `Protected characters: ${protectedNames.join(', ')}`,
          ],
        }
      : {}),
  };
};
