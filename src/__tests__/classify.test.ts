/**
 * classifyTask — ported tests + new coverage per plan §12.1 (100% of 4 categories).
 */

import { describe, it, expect } from 'vitest';
import { classifyTask } from '../core/classify/classify';

describe('classifyTask', () => {
  describe('mechanical', () => {
    it.each([
      'open Chrome',
      'press Ctrl+S',
      'click Save',
      'type hello world',
      'copy',
      'paste',
      'undo',
      'scroll down',
      'refresh',
      'focus Notepad',
    ])('routes %j as mechanical', (task) => {
      const r = classifyTask(task);
      expect(r.kind).toBe('mechanical');
      expect(r.needsVision).toBe(false);
      expect(r.suggestedLayers).toContain('router');
    });
  });

  describe('navigation', () => {
    it.each([
      'go to github.com',
      'navigate to https://example.com',
      'visit www.google.com',
      'browse to docs.anthropic.com',
    ])('routes %j as navigation', (task) => {
      const r = classifyTask(task);
      expect(r.kind).toBe('navigation');
      expect(r.needsVision).toBe(false);
      expect(r.suggestedLayers).toContain('router');
    });
  });

  describe('reasoning', () => {
    it('routes "compose email" as reasoning', () => {
      expect(classifyTask('compose an email to bob@acme.com').kind).toBe('reasoning');
    });
    it('routes "summarize this page" as reasoning', () => {
      expect(classifyTask('summarize this page').kind).toBe('reasoning');
    });
    it('routes "click in the middle of the canvas" as reasoning (positional)', () => {
      const r = classifyTask('click in the middle of the canvas');
      expect(r.kind).toBe('reasoning');
      expect(r.matches).toContain('positional_click');
    });
    it('routes "fill out the form" as reasoning', () => {
      expect(classifyTask('fill out the registration form').kind).toBe('reasoning');
    });
    it('routes "log in" as reasoning', () => {
      expect(classifyTask('log in with my credentials').kind).toBe('reasoning');
    });
  });

  describe('spatial', () => {
    it.each([
      'draw a square',
      'paint the background red',
      'drag the icon to the trash',
      'resize the window',
      'sketch a diagram',
    ])('routes %j as spatial', (task) => {
      const r = classifyTask(task);
      expect(r.kind).toBe('spatial');
      // text-agent still tries; vision is fallback
      expect(r.needsVision).toBe(false);
      expect(r.suggestedLayers).toContain('vision-agent');
    });
  });

  describe('precedence', () => {
    it('spatial beats mechanical when both match', () => {
      // "draw" is spatial, "open" would be mechanical — spatial wins
      const r = classifyTask('open paintbrush then draw a square');
      expect(r.kind).toBe('spatial');
      expect(r.matches[0]).toBe('spatial');
    });

    it('email beats navigation even though email contains .com', () => {
      const r = classifyTask('send email to bob@acme.com');
      expect(r.kind).toBe('reasoning');
      expect(r.matches).toContain('email');
    });
  });

  describe('telemetry', () => {
    it('reports the matching rule name in `matches`', () => {
      const r = classifyTask('open Chrome');
      expect(r.matches.length).toBeGreaterThan(0);
      expect(r.matches[0]).toBe('mechanical_start');
    });

    it('reports multiple matches when rules overlap', () => {
      // "open https://example.com" matches both mechanical_start AND navigation
      const r = classifyTask('open https://example.com');
      expect(r.matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('defaults', () => {
    it('defaults unknown task to reasoning with conservative layers', () => {
      const r = classifyTask('something novel and unprecedented');
      expect(r.kind).toBe('reasoning');
      expect(r.suggestedLayers).toEqual(['router', 'sense', 'text-agent', 'vision-agent']);
      expect(r.matches).toEqual([]);
    });
  });

  describe('timeouts are adaptive', () => {
    it('mechanical has shortest timeout', () => {
      expect(classifyTask('open Chrome').timeoutMs).toBe(30_000);
    });
    it('spatial allows more time', () => {
      expect(classifyTask('draw a circle').timeoutMs).toBe(90_000);
    });
  });
});
