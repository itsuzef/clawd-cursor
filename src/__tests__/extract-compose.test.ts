/**
 * Tests for extractComposeFields — the deterministic field parser that
 * lets the compose-send playbook run with zero LLM. Pure-function tests:
 * no platform, no I/O.
 *
 * Test discipline: every shape we want the playbook to recognize gets a
 * positive case; every shape we want it to REFUSE (no recipient,
 * ambiguous body) gets a negative case so the playbook falls through
 * to the agent ladder instead of dispatching wrong mail.
 */

import { describe, it, expect } from 'vitest';
import { extractComposeFields } from '../tools/playbooks/extract-compose';

describe('extractComposeFields — recipient', () => {
  it('finds plain email anywhere in the task', () => {
    expect(extractComposeFields('send mail to bob@example.com').recipient).toBe('bob@example.com');
    expect(extractComposeFields('email amraldabbas19@gmail.com about Q3').recipient).toBe('amraldabbas19@gmail.com');
    expect(extractComposeFields('first.last+tag@sub.example.co.uk now').recipient).toBe('first.last+tag@sub.example.co.uk');
  });

  it('returns empty string when no well-formed address present', () => {
    expect(extractComposeFields('send a thoughtful note').recipient).toBe('');
    expect(extractComposeFields('email bob @ example dot com').recipient).toBe('');
  });
});

describe('extractComposeFields — subject', () => {
  it('extracts quoted subject (single/double/curly)', () => {
    expect(extractComposeFields("email a@b.com with subject 'Q3 review'").subject).toBe('Q3 review');
    expect(extractComposeFields('email a@b.com with subject "Hi there"').subject).toBe('Hi there');
    expect(extractComposeFields('email a@b.com subject \u201cTeam Update\u201d').subject).toBe('Team Update');
  });

  it('extracts unquoted subject up to a clause keyword', () => {
    const r = extractComposeFields('send email to a@b.com subject Hello there introducing yourself');
    expect(r.subject).toBe('Hello there');
  });

  it('returns empty when no subject specified', () => {
    expect(extractComposeFields('email a@b.com').subject).toBe('');
  });
});

describe('extractComposeFields — body', () => {
  it('expands "introducing yourself" to a polite default', () => {
    const r = extractComposeFields('send email to bob@example.com introducing yourself');
    expect(r.body).toMatch(/AI assistant/i);
    expect(r.body.length).toBeGreaterThan(20);
  });

  it('extracts quoted body verbatim', () => {
    const r = extractComposeFields('email a@b.com with body "Please review by Friday"');
    expect(r.body).toBe('Please review by Friday');
  });

  it('returns empty when neither pattern nor shortcut matches', () => {
    expect(extractComposeFields('email a@b.com about the meeting').body).toBe('');
  });
});

describe('extractComposeFields — integration', () => {
  it("parses Amr's actual task end-to-end", () => {
    const r = extractComposeFields(
      "compose and send an email to amraldabbas19@gmail.com with the subject 'Introduction' introducing yourself as an AI assistant",
    );
    expect(r.recipient).toBe('amraldabbas19@gmail.com');
    expect(r.subject).toBe('Introduction');
    expect(r.body).toMatch(/AI assistant/i);
  });
});
