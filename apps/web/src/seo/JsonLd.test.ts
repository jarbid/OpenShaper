import { describe, expect, it } from 'vitest';
import { jsonLdRoot } from './JsonLd';

const software = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'x' };
const site = { '@context': 'https://schema.org', '@type': 'WebSite', name: 'x' };

describe('jsonLdRoot', () => {
  it('leaves a single entity alone', () => {
    expect(jsonLdRoot(software)).toEqual(software);
  });

  // The whole point: a bare array root has no '@context', and in-page scrapers
  // that read it without checking the shape crash on the undefined.
  it('always produces a root object carrying @context', () => {
    for (const data of [software, [software], [software, site]]) {
      expect(Array.isArray(jsonLdRoot(data))).toBe(false);
      expect(jsonLdRoot(data)['@context']).toBe('https://schema.org');
    }
  });

  it('hoists a shared @context onto the graph wrapper', () => {
    expect(jsonLdRoot([software, site])).toEqual({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'SoftwareApplication', name: 'x' },
        { '@type': 'WebSite', name: 'x' },
      ],
    });
  });

  it('keeps a member @context that differs from the wrapper', () => {
    const other = { '@context': 'https://example.org/ns', '@type': 'Thing' };
    expect(jsonLdRoot([software, other])).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'SoftwareApplication', name: 'x' }, other],
    });
  });
});
