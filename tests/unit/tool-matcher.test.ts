import { describe, it, expect } from 'vitest';
import { ToolMatcher } from '../../src/api/tools/tool-matcher.js';
import type { OpenAITool } from '../../src/api/types.js';

function tool(name: string): OpenAITool {
  return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } } as OpenAITool;
}

describe('ToolMatcher', () => {
  it('is empty for no tools and matches nothing', () => {
    const matcher = new ToolMatcher([]);
    expect(matcher.size).toBe(0);
    expect(matcher.match('anything')).toBeNull();
  });

  it('matches exact names', () => {
    const matcher = new ToolMatcher([tool('get_weather'), tool('search')]);
    expect(matcher.match('get_weather')).toEqual({ name: 'get_weather', exact: true, distance: 0 });
  });

  it('is case and separator insensitive for exact matches', () => {
    const matcher = new ToolMatcher([tool('get_weather')]);
    expect(matcher.match('Get-Weather')?.exact).toBe(true);
    expect(matcher.match('GET_WEATHER')?.exact).toBe(true);
  });

  it('fuzzy-matches small typos within tolerance', () => {
    const matcher = new ToolMatcher([tool('get_weather')]);
    const result = matcher.match('get_weathr');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('get_weather');
    expect(result?.exact).toBe(false);
  });

  it('does not match unrelated names', () => {
    const matcher = new ToolMatcher([tool('get_weather'), tool('search')]);
    expect(matcher.match('delete_database')).toBeNull();
    expect(matcher.match('Alice')).toBeNull();
  });

  it('does not fuzzy-match very short names to avoid accidental collisions', () => {
    const matcher = new ToolMatcher([tool('ls')]);
    expect(matcher.match('cd')).toBeNull();
  });

  it('picks the closest of several near candidates', () => {
    const matcher = new ToolMatcher([tool('get_weather'), tool('get_wealth')]);
    const result = matcher.match('get_wether');
    expect(result?.name).toBe('get_weather');
  });
});
