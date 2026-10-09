import { describe, expect, it } from 'vitest';
import {
  campaignNameIssues,
  campaignNameMaxLength,
  MAX_CAMPAIGN_NAME_LENGTH,
  renderCampaignName,
  uniqueCampaignName,
} from './naming';

const PATTERN = '{adType} | {block} | {group} | {target}';

describe('renderCampaignName', () => {
  it('setzt die Platzhalter ein', () => {
    expect(
      renderCampaignName(PATTERN, {
        adType: 'SP',
        block: 'EXACT1',
        group: 'Flaschen',
        target: 'trinkflasche 1l',
      }),
    ).toBe('SP | EXACT1 | Flaschen | trinkflasche 1l');
  });

  it('lässt leere Platzhalter samt Trenner davor weg', () => {
    expect(renderCampaignName(PATTERN, { adType: 'SP', block: 'AUTO', group: 'Flaschen' })).toBe(
      'SP | AUTO | Flaschen',
    );
    expect(renderCampaignName('{client}-{adType}_{block}', { adType: 'SD', block: 'RT-BUY' })).toBe(
      'SD_RT-BUY',
    );
  });

  it('lässt Klammern und anderen festen Text stehen, nur Trenner fallen weg', () => {
    expect(
      renderCampaignName('{adType} ({country}) {block}', { adType: 'SP', country: 'DE' }),
    ).toBe('SP (DE)');
    expect(
      renderCampaignName('{adType} [{country}] {block}', { adType: 'SP', block: 'AUTO' }),
    ).toBe('SP [] AUTO');
  });

  it('fasst Leerraum in Werten zusammen und lässt festen Text stehen', () => {
    expect(
      renderCampaignName('PB {adType} / {group}', { adType: 'SB', group: '  Große   Becher ' }),
    ).toBe('PB SB / Große Becher');
  });
});

describe('campaignNameIssues', () => {
  it('meldet leere, zu lange Namen und Steuerzeichen', () => {
    expect(campaignNameIssues('SP | AUTO | Flaschen')).toEqual([]);
    expect(campaignNameIssues('   ')).toEqual(['empty']);
    expect(campaignNameIssues('x'.repeat(MAX_CAMPAIGN_NAME_LENGTH + 1))).toEqual(['tooLong']);
    expect(campaignNameIssues('SP\tAUTO')).toEqual(['invalidCharacters']);
  });

  it('nimmt nur die Zeichen an, die Amazon für Namen nennt (Limits-Seite, 2026-10-09)', () => {
    expect(
      campaignNameIssues("SP | EXACT1 | Größe XL (2er) - Café & Co. / 50 $ @ [a]_{b}~`'\\"),
    ).toEqual([]);
    expect(campaignNameIssues('Łódź Ærø Œuvre ß ÿ')).toEqual(['invalidCharacters']);
    expect(campaignNameIssues('Łódź Œuvre ß ÿ')).toEqual([]);
    for (const name of ['SP · AUTO', 'Rabatt 20%', 'Neu!', '#1', 'a < b', 'Emoji 🙂']) {
      expect(campaignNameIssues(name), name).toEqual(['invalidCharacters']);
    }
  });

  it('erlaubt Vendoren nur 116 Zeichen', () => {
    expect(campaignNameMaxLength('seller')).toBe(128);
    expect(campaignNameMaxLength('vendor')).toBe(116);
    expect(campaignNameMaxLength('agency')).toBe(128);
    expect(campaignNameIssues('x'.repeat(117), 116)).toEqual(['tooLong']);
    expect(campaignNameIssues('x'.repeat(116), 116)).toEqual([]);
  });
});

describe('uniqueCampaignName', () => {
  it('lässt freie Namen unverändert und zählt bei vergebenen hoch (ohne Groß/Klein)', () => {
    expect(uniqueCampaignName('SP | AUTO | Flaschen', [])).toBe('SP | AUTO | Flaschen');
    expect(uniqueCampaignName('SP | AUTO | Flaschen', ['sp | auto | flaschen'])).toBe(
      'SP | AUTO | Flaschen 2',
    );
    expect(
      uniqueCampaignName('SP | AUTO | Flaschen', [
        'SP | AUTO | Flaschen',
        'SP | AUTO | Flaschen 2',
      ]),
    ).toBe('SP | AUTO | Flaschen 3');
  });

  it('kürzt den Namen, damit die Nummer in die Höchstlänge passt', () => {
    const long = 'x'.repeat(MAX_CAMPAIGN_NAME_LENGTH);
    const result = uniqueCampaignName(long, [long]);
    expect(result).toHaveLength(MAX_CAMPAIGN_NAME_LENGTH);
    expect(result.endsWith(' 2')).toBe(true);
  });

  it('kürzt auf die Höchstlänge des Kontos', () => {
    const long = 'x'.repeat(116);
    expect(uniqueCampaignName(long, [long], 116)).toHaveLength(116);
  });
});
