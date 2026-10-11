import { describe, expect, it } from 'vitest';
import {
  campaignNameIssues,
  campaignNameMaxLength,
  MAX_CAMPAIGN_NAME_LENGTH,
  renderCampaignName,
  suggestBlockFromName,
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
    // Nur Ziffern wäre in der Bulk-Datei von einer echten ID nicht zu unterscheiden.
    expect(campaignNameIssues('2026')).toEqual(['onlyDigits']);
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

describe('suggestBlockFromName', () => {
  const blocks = [
    { key: 'SP-KW-EXACT', code: 'EXACT', adProduct: 'SP' },
    { key: 'SP-KW-EXACT-SINGLE', code: 'EXACT1', adProduct: 'SP' },
    { key: 'SP-PAT', code: 'PAT', adProduct: 'SP' },
    { key: 'SP-PAT-EXPANDED-SELF', code: 'PAT-EXP', adProduct: 'SP' },
    { key: 'SD-PAT', code: 'PAT', adProduct: 'SD' },
  ] as const;

  it('findet das Kürzel als eigenes Wort im Namen, nur unter Bausteinen des Anzeigentyps', () => {
    expect(suggestBlockFromName('SP | EXACT1 | Flaschen | trinkflasche 1l', 'SP', blocks)).toBe(
      'SP-KW-EXACT-SINGLE',
    );
    expect(suggestBlockFromName('SD | PAT | Flaschen', 'SD', blocks)).toBe('SD-PAT');
    expect(suggestBlockFromName('sp_exact_flaschen', 'SP', blocks)).toBe('SP-KW-EXACT');
  });

  it('nimmt das längere Kürzel, wenn eines im anderen steckt', () => {
    expect(suggestBlockFromName('SP | PAT-EXP | Flaschen', 'SP', blocks)).toBe(
      'SP-PAT-EXPANDED-SELF',
    );
  });

  it('nimmt bei mehreren Kürzeln das vorderste (das Schema nennt den Baustein vor Gruppe und Ziel)', () => {
    expect(suggestBlockFromName('SP | PAT | Exact Fit Hüllen', 'SP', blocks)).toBe('SP-PAT');
  });

  it('schlägt nichts vor, wenn kein Kürzel als Wort vorkommt', () => {
    expect(suggestBlockFromName('Sommer Kampagne Exakte Begriffe', 'SP', blocks)).toBeNull();
    expect(suggestBlockFromName('SP | EXACT | Flaschen', 'SB', blocks)).toBeNull();
    expect(suggestBlockFromName(null, 'SP', blocks)).toBeNull();
  });
});
