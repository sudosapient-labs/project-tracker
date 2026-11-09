/* The one definition of start and due values (dates.js): the two stored shapes, reading them in a
   time zone, and reading what people type. India (UTC+05:30) is the usual reader here; New York
   checks the daylight-saving change. */
import { describe, expect, it } from 'vitest';
import * as D from '../dates.js';

const IN = 'Asia/Kolkata';
const NY = 'America/New_York';
// Monday Nov 9 2026, 3:30 PM in India.
const NOW = Date.parse('2026-11-09T10:00:00Z');

describe('the two stored shapes', () => {
  it('knows them, and nothing else is canonical', () => {
    expect(D.isCanonical('2026-11-09')).toBe(true);
    expect(D.isCanonical('2026-11-09T18:29:00.000Z')).toBe(true);
    for (const v of ['2026-02-31', '2026-11-09T18:29Z', '2026-11-09T23:59', '2026-11-09T23:59:00+05:30', '9 Nov', '', null])
      expect(D.isCanonical(v)).toBe(false);
  });

  it('checks API input: keeps a day, turns a zoned date-time into UTC, refuses one without a zone', () => {
    expect(D.checkWhen('2026-11-09')).toEqual({ ok: true, value: '2026-11-09' });
    expect(D.checkWhen('2026-11-09T23:59+05:30')).toEqual({ ok: true, value: '2026-11-09T18:29:00.000Z' });
    expect(D.checkWhen('2026-11-09T18:29:00Z')).toEqual({ ok: true, value: '2026-11-09T18:29:00.000Z' });
    expect(D.checkWhen('2026-11-09T23:59')).toMatchObject({ ok: false, error: expect.stringMatching(/time zone/) });
    expect(D.checkWhen('2026-02-31')).toMatchObject({ ok: false, error: 'That date doesn’t exist' });
    expect(D.checkWhen('2026-11-09T24:00Z')).toMatchObject({ ok: false });
    expect(D.checkWhen('tomorrow')).toMatchObject({ ok: false });
  });
});

describe('reading a value in a time zone', () => {
  // 2:00 AM on Nov 10 in India is still Nov 9 in UTC: the day slice(0, 10) would get wrong.
  const early = '2026-11-09T20:30:00.000Z';

  it('gives the reader’s day and time', () => {
    expect(D.dayOf(early, IN)).toBe('2026-11-10');
    expect(D.dayOf(early, 'UTC')).toBe('2026-11-09');
    expect(D.timeOf(early, IN)).toBe('02:00');
    expect(D.dayOf('2026-11-09', NY)).toBe('2026-11-09');
    expect(D.timeOf('2026-11-09', IN)).toBe('');
    expect(D.dayOf(NOW, IN)).toBe('2026-11-09');
  });

  it('labels it for people', () => {
    expect(D.label(early, IN)).toBe('2026-11-10 02:00');
    expect(D.label(early, IN, { time: '12' })).toBe('2026-11-10 2:00 AM');
    expect(D.label(early, IN, { style: 'short', time: '12' })).toBe('Nov 10, 2:00 AM');
    expect(D.label('2026-11-09', IN, { style: 'short' })).toBe('Nov 9');
    expect(D.label(null, IN)).toBe('');
  });

  it('counts an all-day value as its whole day, in the reader’s zone', () => {
    expect(D.instant('2026-11-09', IN)).toBe(Date.parse('2026-11-08T18:30:00Z'));
    expect(D.instant('2026-11-09', IN, true)).toBe(Date.parse('2026-11-09T18:30:00Z') - 1);
    expect(D.isOverdue('2026-11-09', IN, Date.parse('2026-11-09T18:29:59Z'))).toBe(false);
    expect(D.isOverdue('2026-11-09', IN, Date.parse('2026-11-09T18:30:00Z'))).toBe(true);
    expect(D.isOverdue('2026-11-09T12:00:00.000Z', IN, Date.parse('2026-11-09T12:00:01Z'))).toBe(true);
    expect(D.isOverdue(null, IN)).toBe(false);
  });

  it('orders by the moment due: an all-day value after that day’s times, no value last', () => {
    const vals = [null, '2026-11-10', '2026-11-10T20:00:00.000Z', '2026-11-10T03:00:00.000Z'];
    expect([...vals].sort((a, b) => D.compareDue(a, b, IN))).toEqual(['2026-11-10T03:00:00.000Z', '2026-11-10', '2026-11-10T20:00:00.000Z', null]);
    expect([...vals].sort((a, b) => D.compareDue(a, b, 'UTC'))).toEqual(['2026-11-10T03:00:00.000Z', '2026-11-10T20:00:00.000Z', '2026-11-10', null]);
  });

  it('moves a value by days keeping its wall-clock time, across a daylight-saving change', () => {
    expect(D.shiftDays('2026-11-09', 7, IN)).toBe('2026-11-16');
    expect(D.shiftDays('2026-11-09T18:29:00.000Z', 7, IN)).toBe('2026-11-16T18:29:00.000Z');
    // 10:00 AM in New York on Mar 7 (EST) and a week later (EDT) are an hour apart in UTC.
    const next = D.shiftDays('2026-03-07T15:00:00.000Z', 7, NY);
    expect(next).toBe('2026-03-14T14:00:00.000Z');
    expect(D.timeOf(next, NY)).toBe('10:00');
  });

  it('turns a wall-clock day and time into the stored UTC value', () => {
    expect(D.fromWallClock('2026-11-09', '23:59', IN)).toBe('2026-11-09T18:29:00.000Z');
    expect(D.fromWallClock('2026-07-01', '09:00', NY)).toBe('2026-07-01T13:00:00.000Z');
  });
});

describe('reading what people type', () => {
  const read = s => D.parseWhen(s, IN, NOW);

  it('reads days, with or without a time', () => {
    expect(read('today')).toBe('2026-11-09');
    expect(read('today 11:59pm')).toBe('2026-11-09T18:29:00.000Z');
    expect(read('today at 23:59')).toBe('2026-11-09T18:29:00.000Z');
    expect(read('tomorrow 2am')).toBe('2026-11-09T20:30:00.000Z');
    expect(read('fri')).toBe('2026-11-13');
    expect(read('Friday 5pm')).toBe('2026-11-13T11:30:00.000Z');
    expect(read('monday')).toBe('2026-11-09'); // today counts
    expect(read('+3d')).toBe('2026-11-12');
    expect(read('2w')).toBe('2026-11-23');
    expect(read('next week')).toBe('2026-11-16');
    expect(read('2026-11-20')).toBe('2026-11-20');
    expect(read('2026-11-20 09:30')).toBe('2026-11-20T04:00:00.000Z');
    expect(read('2026-11-20T09:30')).toBe('2026-11-20T04:00:00.000Z');
    expect(read('5pm')).toBe('2026-11-09T11:30:00.000Z');
    expect(read('noon')).toBe('2026-11-09T06:30:00.000Z');
  });

  it('takes a date-time with a zone as it is', () => {
    expect(read('2026-11-20T09:30:00+05:30')).toBe('2026-11-20T04:00:00.000Z');
    expect(read('2026-11-20T04:00:00Z')).toBe('2026-11-20T04:00:00.000Z');
  });

  it('gives null for what it can’t read', () => {
    for (const s of ['', 'soon', '2026-02-31', '2026-11-20 25:00', 'fri 13pm', 'today at']) expect(read(s)).toBe(null);
  });
});

describe('time zones', () => {
  it('knows an IANA zone and nothing else', () => {
    for (const tz of ['Asia/Kolkata', 'Asia/Dubai', 'America/New_York', 'UTC', 'Asia/Calcutta']) expect(D.validZone(tz)).toBe(tz);
    // Offsets don't follow daylight saving; the rest isn't a zone at all.
    for (const v of ['+05:30', '-04:00', 'Mars/Olympus', 'IST but longer than any zone name could ever be', '', null, undefined, 5, {}])
      expect(D.validZone(v)).toBe(null);
    expect(D.validZone('x'.repeat(65))).toBe(null);
  });
  it('gives today’s name for an old one, and checks it the same way', () => {
    expect(D.modernZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(D.modernZone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(D.modernZone('Asia/Dubai')).toBe('Asia/Dubai');
    expect(D.modernZone('+05:30')).toBe(null);
    expect(D.modernZone('Nowhere/Special')).toBe(null);
  });
  it('answers the same however many zones it has been asked about', () => {
    for (let i = 0; i < 1100; i++) D.validZone(`Nowhere/Place_${i}`);
    expect(D.validZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(D.validZone('Nowhere/Place_1050')).toBe(null);
    expect(D.validZone('Asia/Singapore')).toBe('Asia/Singapore');
  });
});
