
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../types';
import { removeUnusedCharactersCommand } from '../removeUnusedCharacters';

const makeProject = (
  overrides: Record<string, unknown> = {},
): Project =>
  ({
    id: 'test-project',
    title: 'Character Cleanup Test',
    setups: [],
    activeSetupId: '',
    scriptLines: [],
    characters: [
      { id: 'alex', canonicalName: 'ALEX', aliases: [] },
      { id: 'ghost', canonicalName: 'GHOST', aliases: [] },
    ],
    ...overrides,
  }) as unknown as Project;

describe('removeUnusedCharactersCommand', () => {
  it('removes an unused character', () => {
    const project = makeProject();

    const result = removeUnusedCharactersCommand(project, {
      characterIds: ['ghost'],
    });

    expect(result.project.characters?.map((c) => c.id)).toEqual(['alex']);
    expect(project.characters?.length).toBe(2);
    expect(result.meta.type).toBe('removeUnusedCharacters');
  });

  it('protects a character appearing in the screenplay', () => {
    const project = makeProject({
      scriptLines: [
        { id: 'line-1', type: 'character', text: 'ALEX' },
        { id: 'line-2', type: 'dialogue', text: 'Hello.' },
      ],
    });

    const result = removeUnusedCharactersCommand(project, {
      characterIds: ['alex'],
    });

    expect(result.project.characters?.some((c) => c.id === 'alex')).toBe(true);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it('protects a character with a cast assignment', () => {
    const project = makeProject({
      people: [
        { id: 'person-1', displayName: 'Sam', kind: 'cast' },
      ],
      castAssignments: [
        { characterId: 'ghost', personId: 'person-1', castNumber: 1 },
      ],
    });

    const result = removeUnusedCharactersCommand(project, {
      characterIds: ['ghost'],
    });

    expect(result.project.characters?.some((c) => c.id === 'ghost')).toBe(true);
  });

  it('protects a character referenced by a script scene', () => {
    const project = makeProject({
      scriptScenes: [
        {
          id: 'scene-1',
          sceneNumber: '1',
          heading: 'INT. HANGAR - DAY',
          characterIds: ['ghost'],
        },
      ],
    });

    const result = removeUnusedCharactersCommand(project, {
      characterIds: ['ghost'],
    });

    expect(result.project.characters?.some((c) => c.id === 'ghost')).toBe(true);
  });

  it('rejects an unknown character ID', () => {
    expect(() =>
      removeUnusedCharactersCommand(makeProject(), {
        characterIds: ['does-not-exist'],
      }),
    ).toThrow(/unknown character/);
  });

  it('refuses cleanup when screenplay data is unavailable', () => {
    const project = makeProject({ scriptLines: undefined });

    expect(() =>
      removeUnusedCharactersCommand(project, {
        characterIds: ['ghost'],
      }),
    ).toThrow(/screenplay data is unavailable/);
  });

  it('supports screenplay lines stored in a legacy setup', () => {
    const project = makeProject({
      scriptLines: undefined,
      activeSetupId: 'setup-1',
      setups: [
        {
          id: 'setup-1',
          scriptLines: [
            { id: 'line-1', type: 'character', text: 'GHOST' },
          ],
        },
      ],
    });

    const result = removeUnusedCharactersCommand(project, {
      characterIds: ['ghost'],
    });

    expect(result.project.characters?.some((c) => c.id === 'ghost')).toBe(true);
  });
});
